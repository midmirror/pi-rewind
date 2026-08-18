import { mkdtemp, mkdir, writeFile, readFile, rm, stat, access, chmod, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SnapshotEngine, backupFile, toTrackingKey } from "../src/snapshot.js";

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-"));
  const backupDir = join(cwd, ".backups");
  await mkdir(backupDir, { recursive: true });
  return async () => rm(cwd, { recursive: true, force: true });
}

describe("trackEdit", () => {
  it("C1: 备份内容 == 编辑前磁盘内容", async () => {
    const cleanup = await fixture();
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
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
    await rm(cwd, { recursive: true, force: true });
    await cleanup();
  });

  it("C2+C3: 同快照内重复编辑不重复备份（v1 单调）", async () => {
    const cleanup = await fixture();
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
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
    await rm(cwd, { recursive: true, force: true });
    await cleanup();
  });

  it("C15: 跨会话版本隔离——新引擎对同文件不覆盖旧会话备份", async () => {
    const cleanup = await fixture();
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
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
    await rm(cwd, { recursive: true, force: true });
    await cleanup();
  });

  it("C4: 源文件不存在 → backup:null 无异常", async () => {
    const cleanup = await fixture();
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    await mkdir(backupDir, { recursive: true });
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);

    await engine.trackEdit(join(cwd, "nope.ts"));
    const desc = engine.getLatest()!.files[toTrackingKey(cwd, join(cwd, "nope.ts"))!];
    expect(desc!.backup).toBeNull();
    await rm(cwd, { recursive: true, force: true });
    await cleanup();
  });

  it("C11: .git/ 下与超大文件不跟踪", async () => {
    const cleanup = await fixture();
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
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
    await rm(cwd, { recursive: true, force: true });
    await cleanup();
  });

  it("C12+C14: 相对 key 与特殊字符路径", async () => {
    const cleanup = await fixture();
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
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
    await rm(cwd, { recursive: true, force: true });
    await cleanup();
  });
});

describe("makeSnapshot", () => {
  it("C2: 内容变才写新版本，无变化复用", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    await mkdir(join(cwd, "src"), { recursive: true });
    const file = join(cwd, "src/x.ts");
    await writeFile(file, "X1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engine.trackEdit(file); // v1

    await writeFile(file, "X2\n");
    const s2 = await engine.makeSnapshot("m2");
    expect(s2.files[toTrackingKey(cwd, file)]!.backup).toMatch(/@v2$/);

    const s3 = await engine.makeSnapshot("m3"); // 内容未变
    expect(s3.files[toTrackingKey(cwd, file)]!.backup).toBe(s2.files[toTrackingKey(cwd, file)]!.backup);
    await rm(cwd, { recursive: true, force: true });
  });

  it("C10: 超过上限淘汰最旧（101 快照→100）", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    await mkdir(join(cwd, "src"), { recursive: true });
    const file = join(cwd, "src/y.ts");
    await writeFile(file, "Y\n");
    const engine = new SnapshotEngine({ backupDir, cwd, maxSnapshots: 100 });
    engine.hydrate([]);
    for (let i = 1; i <= 101; i++) {
      await engine.makeSnapshot(`m${i}`);
    }
    // 引擎内部快照数上限
    expect(engine.snapshotsList.length).toBe(100);
    // 最旧的 seq=1 已淘汰
    const seqs = engine.getSnapshotSeqs();
    expect(seqs).not.toContain(1);
    await rm(cwd, { recursive: true, force: true });
  });
});

describe("applySnapshot", () => {
  it("场景A C5: 多轮编辑恢复到中间状态", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    await mkdir(join(cwd, "src"), { recursive: true });
    const file = join(cwd, "src/a.ts");
    await writeFile(file, "A1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engine.trackEdit(file);                       // v1 = A1
    await writeFile(file, "A2\n");
    const s2 = await engine.makeSnapshot("m2");         // v2 = A2
    await writeFile(file, "A3\n");

    const res = await engine.applySnapshot(s2);
    expect(res.errors).toEqual([]);
    expect(await readFile(file, "utf-8")).toBe("A2\n");
    await rm(cwd, { recursive: true, force: true });
  });

  it("场景B/C C6: 快照期新建文件被删、删除的文件被复原", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    await mkdir(join(cwd, "src"), { recursive: true });
    const engine = new SnapshotEngine({ backupDir, cwd });
    const b = join(cwd, "src/b.ts");
    await writeFile(b, "B1\n");
    // m1 快照必须先 trackEdit 挂载 b.ts（makeSnapshot 只遍历 prev.files）
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engine.trackEdit(b);
    await engine.makeSnapshot("m1");

    // m2 前：删 b.ts、建 c.ts（c 首次编辑，trackEdit 挂到当前快照）
    await rm(b);
    await writeFile(join(cwd, "src/c.ts"), "C1\n");
    await engine.trackEdit(join(cwd, "src/c.ts"));
    await engine.makeSnapshot("m2");

    // 恢复到 m1：c.ts 应消失（C6），b.ts 恢复 v1（C6/C7）
    const res = await engine.applySnapshot(engine.getSnapshotById("m1")!);
    expect(res.errors).toEqual([]);
    expect(await fileExists(join(cwd, "src/c.ts"))).toBe(false);
    expect(await readFile(b, "utf-8")).toBe("B1\n");
    await rm(cwd, { recursive: true, force: true });
  });

  it("场景D C7: 跨快照回退到未改动的文件版本", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    await mkdir(join(cwd, "src"), { recursive: true });
    const file = join(cwd, "src/d.ts");
    await writeFile(file, "D1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engine.trackEdit(file);       // 首次编辑建 v1 = D1 —— 挂到 m1 快照
    await writeFile(file, "D2\n");
    const s2 = await engine.makeSnapshot("m2");  // v2 = D2
    await writeFile(file, "D3\n");
    // 恢复 s2：tracked 记录 v2，回退 v2（D2）
    const res = await engine.applySnapshot(s2);
    expect(res.errors).toEqual([]);
    expect(await readFile(file, "utf-8")).toBe("D2\n");
    await rm(cwd, { recursive: true, force: true });
  });

  it("C8: 权限位保留", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/exec.sh");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "#!/bin/sh\n");
    await chmod(file, 0o755);
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engine.trackEdit(file);
    await writeFile(file, "#!/bin/sh\necho hi\n");
    const s2 = await engine.makeSnapshot("m2");
    await engine.applySnapshot(s2);
    const st = await stat(file);
    expect(st.mode & 0o777).toBe(0o755);
    await rm(cwd, { recursive: true, force: true });
  });

  it("安全: 恢复目标为符号链接时不写穿（先 unlink 再写）", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    const real = join(cwd, "src/real-target.ts");
    const link = join(cwd, "src/link.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(real, "ORIGINAL\n");
    await symlink(real, link);
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engine.trackEdit(link); // 备份时链接→复制目标内容
    const desc = engine.getLatest()!.files[toTrackingKey(cwd, link)]!;
    expect(desc.backup).toBeDefined();
    // 恢复：目标仍是 symlink → 必须先 unlink，否则写穿 real-target
    await engine.applySnapshot(engine.getSnapshotById("m1")!);
    const st = await lstat(link);
    expect(st.isSymbolicLink()).toBe(false); // 链接被替换为普通文件
    expect(await readFile(real, "utf-8")).toBe("ORIGINAL\n"); // 未被写穿
    await rm(cwd, { recursive: true, force: true });
  });

  it("安全: 篡改的备份名/逃逸 key 被拒绝", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    const file = join(cwd, "src/ok.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(file, "KEEP\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engine.trackEdit(file);
    // 构造恶意快照：backup 名非 {hash}@vN 格式 → 拒绝
    const evil = {
      ...engine.getLatest()!,
      files: { ...engine.getLatest()!.files, "src/../../etc/passwd": { backup: "/etc/passwd" } },
    };
    const res = await engine.applySnapshot(evil);
    expect(res.errors.length).toBeGreaterThan(0);
    await rm(cwd, { recursive: true, force: true });
  });

  it("C13: 单文件备份损坏不中断其他文件", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    await mkdir(join(cwd, "src"), { recursive: true });
    const a = join(cwd, "src/a.ts");
    const b = join(cwd, "src/b.ts");
    await writeFile(a, "A1\n");
    await writeFile(b, "B1\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engine.trackEdit(a);
    await engine.trackEdit(b);
    await writeFile(a, "A2\n");
    await writeFile(b, "B2\n");
    const s2 = await engine.makeSnapshot("m2");
    // 损坏 a 的备份
    const aDesc = s2.files[toTrackingKey(cwd, a)]!;
    if (aDesc.backup) await rm(join(backupDir, aDesc.backup));

    const res = await engine.applySnapshot(s2);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors[0]!.path).toContain("a.ts");
    expect(await readFile(b, "utf-8")).toBe("B2\n"); // b 正常恢复（s2 时点 b=B2，非受损文件 a 不影响 b）
    await rm(cwd, { recursive: true, force: true });
  });
});
