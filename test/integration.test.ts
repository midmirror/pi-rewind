import { describe, it, expect } from "vitest";
import { makeContext } from "./harness.js";
import { getSelectableUserEntries, runSessionRestore } from "../src/session.js";
import type { SessionEntry } from "../src/session.js";

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return { id, parentId, type: "message", message: { role: "user", content: [{ type: "text", text }] } };
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
    await runSessionRestore(ctx, { entryId: "u2", text: "second prompt", parentId: "a1" });
    expect(navigations).toEqual(["a1"]);
    expect(getLeafId()).toBe("a1");
    expect(editorText).toEqual(["second prompt"]);
  });

  it("首条消息 parentId=null：不导航，提示手动 /tree", async () => {
    const entries: SessionEntry[] = [userEntry("u1", null, "only prompt")];
    const { ctx, navigations, notifications } = makeContext(entries);
    await runSessionRestore(ctx, { entryId: "u1", text: "only prompt", parentId: null });
    expect(navigations).toEqual([]); // 未导航
    expect(notifications.some((n) => n.includes("/tree"))).toBe(true);
  });
});
