import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContext, makeEventHarness } from "./harness.js";
import { getSelectableUserEntries, runSessionRestore } from "../src/session.js";
import type { SessionEntry } from "../src/session.js";

function userEntry(id: string, parentId: string | null, text: string, timestamp?: string): SessionEntry {
  return { id, parentId, type: "message", timestamp, message: { role: "user", content: [{ type: "text", text }] } };
}
function assistantEntry(id: string, parentId: string): SessionEntry {
  return { id, parentId, type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } };
}

describe("session integration", () => {
  it("可回退消息过滤：排除非文本/命令输出/自定义消息", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", null, "hello"),
      assistantEntry("a1", "u1"),
      { id: "cmd1", parentId: "a1", type: "message", message: { role: "user", content: [{ type: "text", text: "<bash-stdout>ls</bash-stdout>" }] } },
      { id: "u2", parentId: "a1", type: "message", message: { role: "user", content: [{ type: "text", text: "改代码" }] } },
      { id: "cx1", parentId: "u2", type: "custom", customType: "pi-rewind-snapshot", data: {} },
    ];
    const refs = getSelectableUserEntries(entries);
    expect(refs.map((r) => r.entryId)).toEqual(["u1", "u2"]);
  });

  it("恢复=导航至选中消息的 parent + 文本回填编辑器", async () => {
    const entries: SessionEntry[] = [
      userEntry("u1", null, "first prompt"),
      assistantEntry("a1", "u1"),
      userEntry("u2", "a1", "second prompt"),
    ];
    const { ctx, getLeafId, editorText, navigations } = makeContext(entries);
    await runSessionRestore(ctx, { entryId: "u2", text: "second prompt", parentId: "a1", timestamp: 0 });
    expect(navigations).toEqual(["a1"]);
    expect(getLeafId()).toBe("a1");
    expect(editorText).toEqual(["second prompt"]);
  });

  it("首条消息 parentId=null：不导航，提示手动 /tree", async () => {
    const entries: SessionEntry[] = [userEntry("u1", null, "only prompt")];
    const { ctx, navigations, notifications } = makeContext(entries);
    await runSessionRestore(ctx, { entryId: "u1", text: "only prompt", parentId: null, timestamp: 0 });
    expect(navigations).toEqual([]); // 未导航
    expect(notifications.some((n) => n.includes("/tree"))).toBe(true);
  });

  it("navigate 被取消（session_before_tree 钩子）：不导航不改动会话", async () => {
    const entries: SessionEntry[] = [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1"),
      userEntry("u2", "a1", "second"),
    ];
    const editorText: string[] = [];
    const notifications: string[] = [];
    const navigations: unknown[] = [];
    const ctx = {
      navigate: async (targetId: string | null) => {
        navigations.push(targetId);
        return { cancelled: true }; // 模拟 session_before_tree 取消
      },
      sessionManager: {
        getLeafEntry: () => entries.at(-1) as { id: string } | undefined,
        getEntries: () => entries as never,
      },
      ui: {
        setEditorText: (t: string) => editorText.push(t),
        notify: (m: string) => notifications.push(m),
      },
    };
    await runSessionRestore(ctx, { entryId: "u2", text: "second", parentId: "a1", timestamp: 0 });
    expect(navigations).toEqual(["a1"]); // 尝试导航
    expect(editorText).toEqual([]);      // 取消后不回填
    expect(notifications).toEqual([]);   // 取消后不发跳转确认
  });
});

describe("event flow", () => {
  it("消息→编辑→恢复全链路", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-ev-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "V1\n");
    const h = makeEventHarness({ cwd, backupDir });

    await h.onMessageEndUser("u1"); // 快照1：a.ts=V1（此时未 trackEdit，files 为空或缺 a.ts）
    await h.onToolExecStart("edit", { path: file }); // 编辑前备份 v1
    await writeFile(file, "V2\n"); // 模拟 edit 落盘
    await h.onMessageEndUser("u2"); // 快照2：a.ts=V2（此时已 trackEdit v1，快照包含 a.ts 备份）
    await h.onToolExecStart("write", { path: file });
    await writeFile(file, "V3\n");

    // 恢复到 u1
    const snap1 = h.entriesStore
      .getEntries()
      .find((e) => e.customType === "pi-rewind-snapshot" && (e.data as any).referencedMessageId === "u1");
    expect(snap1).toBeDefined();
    await h.engine.applySnapshot(snap1!.data as any);
    expect(await readFile(file, "utf-8")).toBe("V1\n");
    
    // 快照 2 的 files 自包含：trackEdit 后的版本备份
    const snap2 = h.entriesStore
      .getEntries()
      .find((e) => e.customType === "pi-rewind-snapshot" && (e.data as any).referencedMessageId === "u2");
    expect(snap2).toBeDefined();
    expect(Object.keys((snap2!.data as any).files).length).toBeGreaterThan(0);
    // snap2 a.ts 应包含备份版本号（u1 快照后 trackEdit 生成 v1，u2 快照时内容变 V2 再 trackEdit 生成 v2）
    expect((snap2!.data as any).files["src/a.ts"]).toBeDefined();
    const snap2FileBackup = (snap2!.data as any).files["src/a.ts"].backup;
    expect(snap2FileBackup).toMatch(/@v\d+$/);
    // 实际版本为 v2：编辑后内容变，trackEdit 生成新版本；v1 在 u1 快照时已备份
    expect(snap2FileBackup).toMatch(/@v2$/);
    
    await rm(cwd, { recursive: true, force: true });
  });
});
