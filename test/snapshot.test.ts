import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SnapshotEngine, backupFile, toTrackingKey } from "../src/snapshot.js";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-"));
  const backupDir = join(cwd, ".backups");
  await mkdir(backupDir, { recursive: true });
  return async () => rm(cwd, { recursive: true, force: true });
}

describe("trackEdit", () => {
  it("C1: 备份内容 == 编辑前磁盘内容", async () => {
    const cleanup = await fixture();
    const tmpDir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const cwd = tmpDir;
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/a.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "content-A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);

    await engine.trackEdit(file);
    const latest = engine.getLatest()!;
    const desc = latest.files[toTrackingKey(cwd, file)];
    expect(desc).toBeDefined();
    expect(desc!.backup).toMatch(/^[0-9a-f]{16}@v1$/);
    const bak = await readFile(join(backupDir, desc!.backup!), "utf-8");
    expect(bak).toBe("content-A1\n");
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("C2+C3: 同快snapshot내重复편집불重复備份（v1 單调）", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const cwd = tmpDir;
    const backupDir = join(cwd, ".backups");
    await mkdir(backupDir, { recursive: true });
    const file = join(cwd, "src/b.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "B1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);

    await engine.trackEdit(file); // v1
    const s1 = engine.getLatest()!;
    expect(s1.files[toTrackingKey(cwd, file)]?.backup).toMatch(/@v1$/);

    await engine.trackEdit(file); // 幂等：仍 v1
    const s1b = engine.getLatest()!;
    expect(s1b.files[toTrackingKey(cwd, file)]?.backup).toBe(s1.files[toTrackingKey(cwd, file)]?.backup);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("C15: 跨会话版本隔离——新引擎对同文件不覆盖旧会话备份", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const cwd = tmpDir;
    const backupDir = join(cwd, ".backups");
    await mkdir(backupDir, { recursive: true });
    const file = join(cwd, "src/cross.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "V1\n");
    // 会话 A
    const engineA = new SnapshotEngine({ backupDir, cwd });
    engineA.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engineA.trackEdit(file);            // 磁盘无现存备份 → v1
    const vA = engineA.getLatest()!.files[toTrackingKey(cwd, file)]!.backup!;
    expect(vA).toMatch(/@v1$/);

    // 模拟内容变化后会话 B（重启/新 fork）
    await writeFile(file, "V2\n");
    const engineB = new SnapshotEngine({ backupDir, cwd });
    engineB.hydrate([{ referencedMessageId: "n1", seq: 1, timestamp: 1, files: {} }]);
    await engineB.trackEdit(file);            // 磁盘已有 v1 → 必须 v2
    const vB = engineB.getLatest()!.files[toTrackingKey(cwd, file)]!.backup!;
    expect(vB).toMatch(/@v2$/);
    // 会话 A 的 v1 引用仍指向原内容（未被覆盖）
    const vAContent = await readFile(join(backupDir, vA), "utf-8");
    const vBContent = await readFile(join(backupDir, vB), "utf-8");
    expect(vAContent).toBe("V1\n");
    expect(vBContent).toBe("V2\n");
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("C4: 源文件不存在 → backup:null 无异常", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const cwd = tmpDir;
    const backupDir = join(cwd, ".backups");
    await mkdir(backupDir, { recursive: true });
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);

    await engine.trackEdit(join(cwd, "nope.ts"));
    const desc = engine.getLatest()!.files[toTrackingKey(cwd, join(cwd, "nope.ts"))!];
    expect(desc!.backup).toBeNull();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("C11: .git/ 下与超大文件不跟踪", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const cwd = tmpDir;
    const backupDir = join(cwd, ".backups");
    await mkdir(backupDir, { recursive: true });
    const engine = new SnapshotEngine({ backupDir, cwd, maxFileSizeBytes: 10 });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);

    const gitFile = join(cwd, ".git/config");
    await mkdir(join(cwd, ".git"), { recursive: true });
    await writeFile(gitFile, "x");
    await engine.trackEdit(gitFile);
    expect(engine.getLatest()!.files[toTrackingKey(cwd, gitFile)]).toBeUndefined();

    const big = join(cwd, "big.log");
    await writeFile(big, "this-is-more-than-10-bytes");
    await engine.trackEdit(big);
    expect(engine.getLatest()!.files[toTrackingKey(cwd, big)]).toBeUndefined();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("C12+C14: 相对 key 与特殊字符路径", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const cwd = tmpDir;
    const backupDir = join(cwd, ".backups");
    await mkdir(backupDir, { recursive: true });
    
    expect(toTrackingKey(cwd, join(cwd, "src/a.ts"))).toBe("src/a.ts");
    const weird = join(cwd, "notes/中文 文件.txt");
    expect(toTrackingKey(cwd, weird)).toBe("notes/中文 文件.txt");
    await mkdir(join(cwd, "notes"), { recursive: true });
    await writeFile(weird, "w");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engine.trackEdit(weird);
    expect(engine.getLatest()!.files["notes/中文 文件.txt"]).toBeDefined();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
