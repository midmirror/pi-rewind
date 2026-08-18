// src/snapshot.ts
import { createHash } from "node:crypto";
import { copyFile, chmod, mkdir, stat, readdir, rm, readFile, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ApplyResult, BackupDesc, DiffStats, SnapshotMeta } from "./types.js";

const MAX_SNAPSHOTS_DEFAULT = 100;
const MAX_FILE_SIZE_DEFAULT = 50 * 1024 * 1024;

export function toTrackingKey(cwd: string, filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  if (filePath === cwd || filePath.startsWith(cwd + "/") || filePath.startsWith(cwd + "\\")) {
    return relative(cwd, filePath);
  }
  return filePath;
}

export function toAbsolutePath(cwd: string, key: string): string {
  return isAbsolute(key) ? key : join(cwd, key);
}

function backupFileName(filePath: string, version: number): string {
  const hash = createHash("sha256").update(filePath).digest("hex").slice(0, 16);
  return `${hash}@v${version}`;
}

function isInsideGitDir(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  return norm.split("/").includes(".git");
}

/** 复制文件到备份目录，保留权限位。源缺失返回 null（彼时不存在的标记），非异常。 */
export async function backupFile(
  filePath: string,
  backupDir: string,
  version: number,
): Promise<string | null> {
  let srcStats;
  try {
    srcStats = await stat(filePath);
  } catch {
    return null; // 源不存在 → null 标记
  }
  const name = backupFileName(filePath, version);
  const target = join(backupDir, name);
  try {
    await copyFile(filePath, target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(backupDir, { recursive: true, mode: 0o700 }); // 备份目录 0700（含用户密钥代码）
    await copyFile(filePath, target);
  }
  await chmod(target, srcStats.mode);
  return name;
}

/** 备份文件名白名单：仅接受本引擎生成的 {16hex}@vN 形式，拒绝任何被篡改的名字。 */
const BACKUP_NAME_RE = /^[0-9a-f]{16}@v\d+$/;

/**
 * 校验跟踪 key 未逃逸 cwd（绝对路径 key 视为合法，同 toTrackingKey 的语义：
 * cwd 外的文件本就以绝对路径作 key）。防御构造 "../" 逃逸的相对 key。
 */
function assertSafeKey(cwd: string, key: string, abs: string): void {
  if (isAbsolute(key)) return;
  const resolved = resolve(cwd, key);
  const cwdResolved = resolve(cwd);
  if (resolved !== cwdResolved && !resolved.startsWith(cwdResolved + "/")) {
    throw new Error(`unsafe key: ${key}`);
  }
}

/** 读取文件为字符串；失败（缺失/权限等）返回 null，供内容比对时统一处理。 */
async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return null;
  }
}

/** 备份目录中该文件现存版本最大值；无则 0。 */
async function maxExistingVersion(backupDir: string, filePath: string): Promise<number> {
  const prefix = backupFileName(filePath, 0).split("@v")[0] + "@v";
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch {
    return 0;
  }
  let max = 0;
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const m = n.match(/@v(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export class SnapshotEngine {
  private snapshots: SnapshotMeta[] = [];
  private seqCounter = 0;
  private referencedBackups = new Set<string>();
  readonly backupDir: string;
  readonly cwd: string;
  readonly maxSnapshots: number;
  readonly maxFileSizeBytes: number;

  constructor(opts: {
    backupDir: string;
    cwd: string;
    maxSnapshots?: number;
    maxFileSizeBytes?: number;
  }) {
    this.backupDir = opts.backupDir;
    this.cwd = opts.cwd;
    this.maxSnapshots = opts.maxSnapshots ?? MAX_SNAPSHOTS_DEFAULT;
    this.maxFileSizeBytes = opts.maxFileSizeBytes ?? MAX_FILE_SIZE_DEFAULT;
  }

  hydrate(snapshots: SnapshotMeta[]): void {
    this.snapshots = [...snapshots];
    this.seqCounter = snapshots.reduce((m, s) => Math.max(m, s.seq), 0);
  }

  getLatest(): SnapshotMeta | undefined {
    return this.snapshots.at(-1);
  }

  /** 只读快照列表（调试/测试可见，不得外部可变）。 */
  get snapshotsList(): SnapshotMeta[] {
    return this.snapshots;
  }

  /**
   * 若同一 referencedMessageId 对应多个快照记录（如 hydrate 种子后又用相同 id 调 makeSnapshot），
   * 返回最早那个——后续与该 id 同名的新记录可能因 trackEdit 总是变变“当前最后一个快照”
   * 而被下一次编辑污染，最早那个才是该 id 当时真实的状态。
   */
  getSnapshotById(referencedMessageId: string): SnapshotMeta | undefined {
    return this.snapshots.find((s) => s.referencedMessageId === referencedMessageId);
  }

  getSnapshotSeqs(): number[] {
    return this.snapshots.map((s) => s.seq);
  }

  /** 当前存活快照引用的备份名集合（Task4 cleanOrphans 依赖，本任务仅维护）。 */
  get orphanedBackups(): ReadonlySet<string> {
    return this.referencedBackups;
  }

  async trackEdit(filePath: string): Promise<void> {
    const key = toTrackingKey(this.cwd, filePath);
    const latest = this.snapshots.at(-1);
    if (!latest) return; // 尚无快照，无从挂载（首个用户消息的快照会先建）
    if (latest.files[key]) return; // 已在最近快照跟踪

    let sizeOver = false;
    if (this.maxFileSizeBytes > 0) {
      try {
        const st = await stat(filePath);
        sizeOver = st.size > this.maxFileSizeBytes;
      } catch {
        // 源缺失 → sizeOver 保持 false，交给 backupFile 记 null
      }
    }
    if (isInsideGitDir(filePath) || sizeOver) return;

    // 版本号以磁盘为准（C15）：扫描备份目录现存同文件 hash 的最大 v，防跨会话覆盖
    const nextVersion = await maxExistingVersion(this.backupDir, filePath) + 1;
    const backupName = await backupFile(filePath, this.backupDir, nextVersion);
    // 自包含更新：复制最近快照并加入新路径（appendEntry 语义，见 spec §6.2）
    const updated: SnapshotMeta = {
      ...latest,
      files: { ...latest.files, [key]: { backup: backupName } },
    };
    this.snapshots[this.snapshots.length - 1] = updated;
  }

  /**
   * 对最近快照的全部跟踪文件做 mtime/size/内容比对，仅变化的文件写新版本；
   * 未变化的文件复用原 BackupDesc（含 backup:null 的情形）。产出的快照自包含，
   * 追加入列表并按 maxSnapshots 淘汰最旧（含孤儿备份记账，Task4 cleanOrphans 消费）。
   */
  async makeSnapshot(referencedMessageId: string): Promise<SnapshotMeta> {
    const prev = this.snapshots.at(-1);
    const files: Record<string, BackupDesc> = {};
    if (prev) {
      await Promise.all(
        Object.entries(prev.files).map(async ([key, desc]) => {
          const abs = toAbsolutePath(this.cwd, key);
          if (desc.backup === null) {
            files[key] = desc;
            return;
          }
          const bakPath = join(this.backupDir, desc.backup);
          let changed = false;
          try {
            const [cur, bak] = await Promise.all([stat(abs), stat(bakPath)]);
            if (cur.mode !== bak.mode || cur.size !== bak.size) {
              changed = true;
            } else if (cur.mtimeMs > bak.mtimeMs) {
              // mtime 早于备份时间可短路跳过内容比对（同 CC checkOriginFileChanged 语义）；
              // 否则仍需读内容确认（mtime 更新但内容可能相同）
              const [c, b] = await Promise.all([readFileSafe(abs), readFileSafe(bakPath)]);
              changed = c !== b;
            }
          } catch {
            // 源或备份缺失（如源被删除）→ 视为变化，交由下方分支处理
            changed = true;
          }
          if (!changed) {
            files[key] = desc;
            return;
          }
          // 源文件可能已被删除：backupFile 对缺失源返回 null，语义与 trackEdit 一致
          const m = desc.backup.match(/@v(\d+)$/);
          const version = m ? Number(m[1]) + 1 : 1;
          const name = await backupFile(abs, this.backupDir, version);
          files[key] = { backup: name };
        }),
      );
    }
    const meta: SnapshotMeta = {
      referencedMessageId,
      seq: this.seqCounter + 1,
      timestamp: Date.now(),
      files,
    };
    this.seqCounter = meta.seq;
    this.snapshots.push(meta);
    this.prune();
    return meta;
  }

  /**
   * 恢复到给定快照：对"引擎全历史跟踪过的 key"与"目标快照自身记录的 key"的并集逐一处理——
   * 快照 files 按设计单调累积（一旦某 key 被 trackEdit/makeSnapshot 记录，后续快照的 files
   * 均会带上该 key），因此 meta.files 中缺失某 key 只可能意味着"该文件在 meta 对应时刻尚未被
   * 跟踪"——此时正确动作是删除（若现在存在），而非回退到任意版本（C6，场景 B/C 验证）。
   * 目标快照自身携带但引擎历史未曾出现的 key（如外部构造/篡改的 meta）与已跟踪 key 一视同
   * 处理：先做 assertSafeKey + 备份名白名单校验，防绕过 collectAllTrackedKeys 的注入。
   * 单文件失败记入 errors，不中断其他文件（C13）。
   */
  async applySnapshot(meta: SnapshotMeta): Promise<ApplyResult> {
    const result: ApplyResult = { changed: [], errors: [] };
    const trackedKeys = this.collectAllTrackedKeys();
    for (const key of Object.keys(meta.files)) trackedKeys.add(key);
    await Promise.all(
      Array.from(trackedKeys).map(async (key) => {
        const abs = toAbsolutePath(this.cwd, key);
        try {
          assertSafeKey(this.cwd, key, abs);
        } catch (err) {
          result.errors.push({ path: key, error: err instanceof Error ? err.message : String(err) });
          return;
        }
        const desc = meta.files[key];
        // 未在 meta 中记录 → 目标时刻尚未跟踪 → 视为彼时不存在（backup:null 语义）
        await this.restoreTo(abs, desc ?? { backup: null }, result);
      }),
    );
    return result;
  }

  /** 全历史出现过的所有跟踪 key 的并集（跨全部快照，用于 applySnapshot 兜底回退）。 */
  private collectAllTrackedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const s of this.snapshots) for (const k of Object.keys(s.files)) keys.add(k);
    return keys;
  }

  /**
   * 将单个跟踪 key 恢复到给定 BackupDesc 描述的版本：
   * - backup:null → 删除磁盘文件（C6）
   * - backup 名非法（篡改/不匹配白名单）→ 记错误，不触碰磁盘
   * - 有差异才覆盖（C5，mtime 不变路径省略写盘）
   * - 恢复目标当前为符号链接时先 unlink，防写穿链接指向的真实文件
   */
  private async restoreTo(abs: string, desc: BackupDesc, result: ApplyResult): Promise<void> {
    if (desc.backup !== null && !BACKUP_NAME_RE.test(desc.backup)) {
      result.errors.push({ path: abs, error: `invalid backup name: ${desc.backup}` });
      return;
    }
    if (desc.backup === null) {
      try {
        await rm(abs, { force: true });
        result.changed.push(abs);
      } catch (err) {
        result.errors.push({ path: abs, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const bakPath = join(this.backupDir, desc.backup);
    // 符号链接防护优先于差异短路：目标若为链接必须复制覆盖（消除链接），
    // 即便内容/大小/mtime 恰好与备份一致也不能因“无差异”而跳过（否则链接残留、写穿风险仍在）。
    let targetIsSymlink = false;
    try {
      const lst = await lstat(abs);
      targetIsSymlink = lst.isSymbolicLink();
    } catch {
      // 目标不存在
    }
    let differs = true;
    if (!targetIsSymlink) {
      try {
        const [cur, bak] = await Promise.all([stat(abs), stat(bakPath)]);
        if (cur.mode === bak.mode && cur.size === bak.size) {
          if (cur.mtimeMs < bak.mtimeMs) {
            differs = false;
          } else {
            const [c, b] = await Promise.all([readFileSafe(abs), readFileSafe(bakPath)]);
            differs = c !== b;
          }
        }
      } catch {
        // 任一侧缺失（目标不存在/备份缺失）→ 视为不同，走复制（备份缺失会在 copyFile 处报错并隔离）
        differs = true;
      }
    }
    if (!differs && !targetIsSymlink) return;
    if (targetIsSymlink) await rm(abs, { force: true });
    try {
      try {
        await copyFile(bakPath, abs);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        await mkdir(dirname(abs), { recursive: true });
        await copyFile(bakPath, abs);
      }
      const st = await stat(bakPath);
      await chmod(abs, st.mode);
      result.changed.push(abs);
    } catch (err) {
      result.errors.push({ path: abs, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 快照数超上限时淘汰最旧的多余快照，并重算现存快照引用的备份名集合。 */
  private prune(): void {
    if (this.snapshots.length <= this.maxSnapshots) return;
    this.snapshots = this.snapshots.slice(-this.maxSnapshots);
    const referenced = new Set<string>();
    for (const s of this.snapshots) {
      for (const d of Object.values(s.files)) if (d.backup) referenced.add(d.backup);
    }
    this.referencedBackups = referenced;
  }

  async diffStats(meta: SnapshotMeta): Promise<DiffStats | undefined> {
    throw new Error("Not implemented in Task 4");
  }
}
