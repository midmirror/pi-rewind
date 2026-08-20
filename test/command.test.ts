import { describe, it, expect } from "vitest";
import { parseArgv, executeRewind } from "../src/command.js";
import { SnapshotEngine } from "../src/snapshot.js";
import { SessionEntry } from "../src/session.js";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContext } from "./harness.js";

function userEntry(id: string, parentId: string | null, text: string, timestamp?: string): SessionEntry {
  return { id, parentId, type: "message", timestamp, message: { role: "user", content: [{ type: "text", text }] } };
}

describe("parseArgv", () => {
  it("解析各参数组合", () => {
    expect(parseArgv("--last --confirm --code-only")).toEqual({
      target: { kind: "last" }, mode: "code", confirm: true, dryRun: false,
    });
    expect(parseArgv("--at 3 --dry-run")).toEqual({
      target: { kind: "at", value: "3" }, mode: "both", confirm: false, dryRun: true,
    });
    expect(parseArgv("")).toEqual({
      target: { kind: "last" }, mode: "both", confirm: false, dryRun: false,
    });
  });

  it("--at 漏填值时 value 为空字符串（resolveTarget 层负责拒绝）", () => {
    expect(parseArgv("--at")).toEqual({
      target: { kind: "at", value: "" }, mode: "both", confirm: false, dryRun: false,
    });
  });
});

describe("executeRewind", () => {
  it("非交互+确认：代码恢复执行并输出 JSON 行", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    const m1 = await engine.makeSnapshot("u1"); // 首个快照（files={}，尚无跟踪文件）
    await engine.trackEdit(file); // 模拟 tool_execution_start：编辑前挂载 a.ts=A1 到 u1 快照
    await writeFile(file, "A2\n");
    const lines: string[] = [];
    const entries: SessionEntry[] = [
      userEntry("u1", null, "改 a.ts"),
      userEntry("u2", "u1", "再改 a.ts"),
    ];
    const { ctx } = makeContext(entries);

    await executeRewind(
      { engine, entries, ctx, ctxOutput: (s) => lines.push(s) },
      { target: { kind: "at", value: "u1" }, mode: "code", confirm: true, dryRun: false },
    );
    expect(await readFile(file, "utf-8")).toBe("A1\n");
    expect(lines.some((l) => l.includes("rewind-done"))).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });

  it("--at 空值不静默匹配第一条消息，不执行恢复", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    await engine.makeSnapshot("u1");
    await engine.trackEdit(file);
    await writeFile(file, "A2\n");
    const lines: string[] = [];
    const entries: SessionEntry[] = [userEntry("u1", null, "改 a.ts")];
    const { ctx } = makeContext(entries);
    await executeRewind(
      { engine, entries, ctx, ctxOutput: (s) => lines.push(s) },
      { target: { kind: "at", value: "" }, mode: "code", confirm: true, dryRun: false },
    );
    expect(await readFile(file, "utf-8")).toBe("A2\n"); // 未执行恢复，磁盘内容不变
    expect(lines.some((l) => l.includes("rewind-done"))).toBe(false);
    await rm(cwd, { recursive: true, force: true });
  });

  it("无 --confirm 的非交互调用只预览", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    await engine.makeSnapshot("u1");
    await writeFile(file, "A2\n");
    const lines: string[] = [];
    const entries: SessionEntry[] = [userEntry("u1", null, "改 a.ts")];
    const { ctx } = makeContext(entries);
    await executeRewind(
      { engine, entries, ctx, ctxOutput: (s) => lines.push(s) },
      { target: { kind: "last" }, mode: "both", confirm: false, dryRun: false },
    );
    expect(await readFile(file, "utf-8")).toBe("A2\n"); // 未执行
    expect(lines.some((l) => l.includes("rewind-preview"))).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });

  it("交互模式走 select/confirm", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    await engine.makeSnapshot("u1");
    await engine.trackEdit(file); // 模拟 tool_execution_start：编辑前挂载 a.ts=A1 到 u1 快照
    await writeFile(file, "A2\n");
    const entries: SessionEntry[] = [userEntry("u1", null, "改 a.ts")];
    const { ctx, editorText } = makeContext(entries);
    const selected: string[] = [];
    await executeRewind(
      {
        engine, entries, ctx,
        select: async (items) => { selected.push(...items); return 0; },
        confirm: async () => true,
      },
      { target: { kind: "last" }, mode: "both", confirm: false, dryRun: false },
    );
    expect(selected.length).toBeGreaterThan(0);
    expect(await readFile(file, "utf-8")).toBe("A1\n");
    expect(editorText.length).toBeGreaterThan(0); // 会话回填
    await rm(cwd, { recursive: true, force: true });
  });

  it("--at 非数字 entryId 前缀寻址", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "pre", seq: 1, timestamp: 1, files: {} }]);
    await engine.makeSnapshot("msg-alpha");
    await engine.trackEdit(file);         // msg-alpha.files[key]=v1(A1)
    await writeFile(file, "A2\n");
    await engine.makeSnapshot("msg-beta"); // msg-beta.files[key]=v2(A2)
    await writeFile(file, "A3\n");
    const entries: SessionEntry[] = [
      userEntry("msg-alpha", null, "改 a.ts"),
      userEntry("msg-beta", "msg-alpha", "再改 a.ts"),
    ];
    const { ctx } = makeContext(entries);
    await executeRewind(
      { engine, entries, ctx },
      { target: { kind: "at", value: "msg-b" }, mode: "code", confirm: true, dryRun: false },
    );
    expect(await readFile(file, "utf-8")).toBe("A2\n"); // 命中 msg-beta 快照(v2=A2)
    await rm(cwd, { recursive: true, force: true });
  });

  it("--conversation-only: 只回滚会话不动代码", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "CUR\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    const entries: SessionEntry[] = [
      userEntry("u1", null, "改 a.ts"),
      userEntry("u2", "u1", "再改"),
    ];
    const { ctx, editorText, navigations } = makeContext(entries);
    await executeRewind(
      { engine, entries, ctx },
      { target: { kind: "at", value: "u2" }, mode: "conversation", confirm: true, dryRun: false },
    );
    expect(await readFile(file, "utf-8")).toBe("CUR\n"); // 代码未动
    expect(navigations).toEqual(["u1"]);                  // 导航到 u2 的 parent
    expect(editorText.join("\n")).toContain("再改");      // 文本回填
    await rm(cwd, { recursive: true, force: true });
  });

  it("命令级 --dry-run: 只预览不执行", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    await engine.makeSnapshot("u1");
    await engine.trackEdit(file);
    await writeFile(file, "A2\n");
    const entries: SessionEntry[] = [userEntry("u1", null, "改 a.ts")];
    const lines: string[] = [];
    const { ctx } = makeContext(entries);
    await executeRewind(
      { engine, entries, ctx, ctxOutput: (s) => lines.push(s) },
      { target: { kind: "last" }, mode: "both", confirm: false, dryRun: true },
    );
    expect(lines.some((l) => l.includes("rewind-preview"))).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("A2\n"); // 未执行
    await rm(cwd, { recursive: true, force: true });
  });

  it("回归#7: 回退点无快照（被淘汰）时显式报错而非伪装成功", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const engine = new SnapshotEngine({ backupDir, cwd });
    // 引擎只有 unreferenced 快照；u1 无对应快照 → getSnapshotById 返回 undefined
    engine.hydrate([{ referencedMessageId: "other", seq: 1, timestamp: 1, files: {} }]);
    const entries: SessionEntry[] = [userEntry("u1", null, "改 a.ts")];
    const lines: string[] = [];
    const { ctx } = makeContext(entries);
    await executeRewind(
      { engine, entries, ctx, ctxOutput: (s) => lines.push(s) },
      { target: { kind: "last" }, mode: "code", confirm: true, dryRun: false },
    );
    const done = lines.find((l) => l.includes("rewind-done"));
    expect(done).toBeDefined();
    expect(done!).toContain("(snapshot)"); // 显式提示快照缺失，非空 errors
    await rm(cwd, { recursive: true, force: true });
  });

  it("菜单差异标注为语义格式：增N行/删M行/K文件", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    await engine.makeSnapshot("u1");
    await engine.trackEdit(file);   // u1 快照挂 v1=A1
    await writeFile(file, "A2\n");
    await engine.makeSnapshot("u2"); // v2=A2
    await writeFile(file, "A3\n");
    const entries: SessionEntry[] = [
      userEntry("u1", null, "改 a.ts"),
      userEntry("u2", "u1", "再改"),
    ];
    const { ctx } = makeContext(entries);
    const selected: string[] = [];
    await executeRewind(
      {
        engine, entries, ctx,
        select: async (items: string[]) => { selected.push(...items); return 0; },
        confirm: async () => true,
      },
      { target: { kind: "last" }, mode: "both", confirm: false, dryRun: false },
    );
    // u2 快照(v2=A2) vs 磁盘(A3)：增1行/删1行/1文件；u1 快照(v1=A1) vs A3：增1行/删2行? ——
    // 内容差异由 diffLines 决定，这里只断言格式符合「[增/删/文件]」三段语义，不锁具体行数
    for (const s of selected) {
      expect(s).toMatch(/\[增\d+行\/删\d+行\/\d+文件\]/);
    }
    await rm(cwd, { recursive: true, force: true });
  });

  it("交互菜单检查点倒序：最近的在上方", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    await engine.makeSnapshot("u1");
    await engine.trackEdit(file);
    await writeFile(file, "A2\n");
    await engine.makeSnapshot("u2");
    await writeFile(file, "A3\n");
    const entries: SessionEntry[] = [
      userEntry("u1", null, "改 a.ts"),
      userEntry("u2", "u1", "再改"),
    ];
    const { ctx } = makeContext(entries);
    const selected: string[] = [];
    await executeRewind(
      {
        engine, entries, ctx,
        select: async (items: string[]) => { selected.push(...items); return 0; },
        confirm: async () => true,
      },
      { target: { kind: "last" }, mode: "both", confirm: false, dryRun: false },
    );
    // 菜单倒序：u2（最近）在上，u1 在下；选中 idx 0 即最近的 u2 → 回滚到 v2=A2
    expect(selected[0]).toContain("再改");
    expect(selected[1]).toContain("改 a.ts");
    expect(await readFile(file, "utf-8")).toBe("A2\n");
    await rm(cwd, { recursive: true, force: true });
  });

  it("菜单按时间戳倒序：时间新在上方，与 seq 无关", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    // u1 时间新但 seq 小（先入引擎），u2 时间旧但 seq 大 → 排序应时间优先
    engine.hydrate([{ referencedMessageId: "u1", seq: 1, timestamp: 3000, files: {} }]);
    await engine.makeSnapshot("u1");
    await engine.trackEdit(file);
    await writeFile(file, "A2\n");
    await engine.makeSnapshot("u2");
    await writeFile(file, "A3\n");
    const entries: SessionEntry[] = [
      userEntry("u1", null, "先发", "2026-08-20T10:05:00.000Z"),
      userEntry("u2", "u1", "后发", "2026-08-20T10:06:00.000Z"),
    ];
    const { ctx } = makeContext(entries);
    const selected: string[] = [];
    await executeRewind(
      {
        engine, entries, ctx,
        select: async (items: string[]) => { selected.push(...items); return 0; },
        confirm: async () => true,
      },
      { target: { kind: "last" }, mode: "both", confirm: false, dryRun: false },
    );
    // 时间倒序：u2（后发）在上；即使 u2 seq 更大，也保持时间序
    expect(selected[0]).toContain("后发");
    expect(selected[1]).toContain("先发");
    // 菜单行带时间前缀 `[MM-DD HH:MM] `
    expect(selected[0]).toMatch(/^\[\d{2}-\d{2} \d{2}:\d{2}\] /);
    await rm(cwd, { recursive: true, force: true });
  });

  it("无时间戳时回退 seq 倒序（时间分辨率不足也保序）", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rw-cmd-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    await engine.makeSnapshot("u1");
    await engine.trackEdit(file);
    await writeFile(file, "A2\n");
    await engine.makeSnapshot("u2");
    await writeFile(file, "A3\n");
    const entries: SessionEntry[] = [
      userEntry("u1", null, "改 a.ts"),
      userEntry("u2", "u1", "再改"),
    ];
    const { ctx } = makeContext(entries);
    const selected: string[] = [];
    await executeRewind(
      {
        engine, entries, ctx,
        select: async (items: string[]) => { selected.push(...items); return 0; },
        confirm: async () => true,
      },
      { target: { kind: "last" }, mode: "both", confirm: false, dryRun: false },
    );
    // 无时间戳 → timestamp=0 全部相等 → seq 倒序（u2 seq 2 > u1 seq 1）
    expect(selected[0]).toContain("再改");
    expect(selected[1]).toContain("改 a.ts");
    await rm(cwd, { recursive: true, force: true });
  });
});
