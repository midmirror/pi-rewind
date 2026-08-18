import { mkdtemp, mkdir, writeFile, readFile, rm, stat, access, chmod, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { diffLines } from "diff";
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

  it("Critical: backup:null 卡死修复——null→创建→二次编辑→恢复全链路", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    await mkdir(join(cwd, "src"), { recursive: true });
    const file = join(cwd, "src/c.ts");
    const key = toTrackingKey(cwd, file);
    const engine = new SnapshotEngine({ backupDir, cwd });

    // u1: 空快照，c.ts 尚不存在
    engine.hydrate([{ referencedMessageId: "u1", seq: 1, timestamp: 1, files: {} }]);
    const u1 = engine.getLatest()!;

    // write 前触发 trackEdit：文件不存在 → 记录 backup:null（旧 bug 会在此永久卡死）
    await engine.trackEdit(file);
    expect(engine.getLatest()!.files[key]?.backup).toBeNull();

    // 模拟 write 工具落盘
    await writeFile(file, "C1");
    const u2 = await engine.makeSnapshot("u2");

    // 关键断言：null 被 makeSnapshot 重评估推进为 v1，而非继续复用 null
    expect(u2.files[key]?.backup).not.toBeNull();
    expect(u2.files[key]!.backup).toMatch(/@v1$/);
    const u2BakContent = await readFile(join(backupDir, u2.files[key]!.backup!), "utf-8");
    expect(u2BakContent).toBe("C1");

    // 模拟二次编辑：trackEdit 幂等判断需放行（已跟踪但此刻已非 null）——
    // 此处 latest.files[key].backup 已是 v1，非 null，trackEdit 应跳过（不重复备份 C1 版本）
    await engine.trackEdit(file);
    expect(engine.getLatest()!.files[key]!.backup).toBe(u2.files[key]!.backup);

    await writeFile(file, "C2");
    const u3 = await engine.makeSnapshot("u3");
    expect(u3.files[key]!.backup).toMatch(/@v2$/);

    // 恢复 u2：应还原为 C1，不得因残留 null 语义误删
    await engine.applySnapshot(u2);
    expect(await readFile(file, "utf-8")).toBe("C1");

    // 恢复 u1：u1 时点 c.ts 确实不存在 → 正确删除
    await engine.applySnapshot(u1);
    expect(await fileExists(file)).toBe(false);

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

    // m2 前：删 b.ts、建 c.ts（c 首次编辑；trackEdit 必须先于 writeFile——模拟真实工具
    // 执行前备份：c.ts 此刻尚不存在 → 记录 v1=backup:null，而非误将创建后内容当 v1）
    await rm(b);
    await engine.trackEdit(join(cwd, "src/c.ts"));
    await writeFile(join(cwd, "src/c.ts"), "C1\n");
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
    expect(res.errors[0]!.path).toContain("etc/passwd"); // 被拒的具体路径，而非仅计数
    await rm(cwd, { recursive: true, force: true });
  });

  it("场景E C7: 快照后首次编辑的路径回退到未记录该路径的快照,应恢复为v1内容(非删除)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    await mkdir(join(cwd, "src"), { recursive: true });
    const file = join(cwd, "src/e.ts");
    await writeFile(file, "A\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    const s1 = await engine.makeSnapshot("m1"); // S1：e.ts 此刻尚未被任何快照跟踪，s1.files 无该 key

    await engine.trackEdit(file); // S1 之后首次编辑：v1 = 编辑前内容 "A\n"
    await writeFile(file, "B\n");
    await engine.makeSnapshot("m2"); // v2 = "B\n"
    await writeFile(file, "C\n");
    await engine.makeSnapshot("m3"); // 磁盘当前内容 "C\n"，与恢复目标无关

    // 恢复到 S1：e.ts 未在 S1 中记录 → findFirstVersion 回退全历史首个记录 v1="A\n"（非删除）
    const res = await engine.applySnapshot(s1);
    expect(res.errors).toEqual([]);
    expect(await readFile(file, "utf-8")).toBe("A\n");
    await rm(cwd, { recursive: true, force: true });
  });

  it("C6: 快照显式记录 backup:null,磁盘现存文件应被删除", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    await mkdir(join(cwd, "src"), { recursive: true });
    const file = join(cwd, "src/f.ts");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engine.trackEdit(file); // file 尚不存在 → 显式记录 backup:null
    const s1 = engine.getLatest()!;
    expect(s1.files[toTrackingKey(cwd, file)]?.backup).toBeNull();

    await writeFile(file, "LATER\n"); // 快照之后磁盘才出现该文件
    const res = await engine.applySnapshot(s1);
    expect(res.errors).toEqual([]);
    expect(await fileExists(file)).toBe(false);
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

describe("diffStats", () => {
  it("C9: 新增/修改/删除三种情况与 diffLines 直算一致", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
    const backupDir = join(cwd, ".backups");
    const a = join(cwd, "src/a.ts");
    const deleted = join(cwd, "src/old.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(a, "line1\nline2\nline3\n");
    await writeFile(deleted, "gone\n");
    const engine = new SnapshotEngine({ backupDir, cwd });
    engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
    await engine.trackEdit(a);       // 挂载 a
    await engine.trackEdit(deleted); // 挂载 deleted
    const m1 = await engine.makeSnapshot("m1");

    await writeFile(a, "line1\nline2-changed\nline3\nline4\n");
    await rm(deleted);

    const stats = await engine.diffStats(m1);
    expect(stats).toBeDefined();
    expect(stats!.filesChanged.sort()).toEqual(["src/a.ts", "src/old.ts"].sort());
    // 手算期望：a 相对 m1 是 -1 +2；old 是 -1
    const aBak = m1.files["src/a.ts"]!.backup!;
    const aBakContent = await readFile(join(backupDir, aBak), "utf-8");
    const d = diffLines(aBakContent, "line1\nline2-changed\nline3\nline4\n");
    let expIns = 0, expDel = 0;
    for (const c of d) { if (c.added) expIns += c.count ?? 0; if (c.removed) expDel += c.count ?? 0; }
    // 添加 deleted 文件的 diff
    const delBak = m1.files["src/old.ts"]!.backup!;
    const delBakContent = await readFile(join(backupDir, delBak), "utf-8");
    const dd = diffLines(delBakContent, ""); // 磁盘当前为空
    for (const c of dd) { if (c.added) expIns += c.count ?? 0; if (c.removed) expDel += c.count ?? 0; }
    expect(stats!.insertions).toBe(expIns);
    expect(stats!.deletions).toBe(expDel);
    expect(stats!.insertions + stats!.deletions).toBeGreaterThan(0);
    await rm(cwd, { recursive: true, force: true });
  });
});
