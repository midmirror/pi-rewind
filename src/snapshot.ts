// src/snapshot.ts
import { createHash } from "node:crypto";
import { copyFile, chmod, mkdir, stat, readdir, rm, readFile, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { diffLines } from "diff";
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
  } catch (err: unknown) {
    // 仅源不存在（ENOENT）才记 null 标记；EACCES 等其它错误必须向上抛，由调用方隔离，否则
    // 存在但不可读的文件会被误记为「彼时不存在」，恢复时 rm 误删真实文件（Critical 锚点）。
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
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

/**
 * 防父链符号链接写穿：相对 key 的目标父目录经 realpath 后若逃出 cwd（cwd 内存在指向外部的
 * 目录链接，如 dotfiles 方案把 ~/.ssh、~/.config 链接进 cwd），则拒绝恢复/删除，避免覆写或
 * 删除链接指向的真实外部文件。绝对 key（cwd 外文件）为设计内合法（toTrackingKey 语义），跳过。
 */
async function assertNoParentSymlink(cwd: string, key: string, abs: string): Promise<void> {
  if (isAbsolute(key)) return;
  let realDir: string;
  try {
    realDir = await realpath(dirname(abs));
  } catch {
    return; // 目录尚不存在，交由 copyFile 递归创建，无写穿风险
  }
  const realCwd = await realpath(cwd);
  const rel = relative(realCwd, realDir);
  if (rel === "" || rel === ".") return; // realDir == realCwd
  if (!rel.startsWith("..")) return;      // 无 `..` 前缀 → 仍在 cwd 内，安全
  throw new Error(`parent dir escapes cwd via symlink: ${key}`);
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

  /**
   * 编辑前挂载文件到当前快照（首次编辑即备份编辑前内容）。
   * @returns true=快照实际被修改（应 appendEntry 持久化）；false=无变化（幂等/越过）不应落盘。
   *         用于避免「每次编辑都 append 整份 latest」造成重启 hydrate 后重复条目
   *         挤占 maxSnapshots 淘汰预算（见决策：仅变更才落盘）。
   */
  async trackEdit(filePath: string): Promise<boolean> {
    const key = toTrackingKey(this.cwd, filePath);
    const latest = this.snapshots.at(-1);
    if (!latest) return false; // 尚无快照，无从挂载（首个用户消息的快照会先建）
    // 幂等跳过条件：已跟踪且非 null。null 记录（彼时文件不存在）必须继续走备份流程重评估，
    // 否则文件被创建后 null 状态永久卡死，恢复该点之后的快照会误删已创建文件（Critical 修复）。
    // 注意：未跟踪（undefined）不能命中这个跳过条件，否则失去首次备份。
    const existing = latest.files[key];
    if (existing !== undefined && existing.backup !== null) return false;

    let sizeOver = false;
    if (this.maxFileSizeBytes > 0) {
      try {
        const st = await stat(filePath);
        sizeOver = st.size > this.maxFileSizeBytes;
      } catch {
        // 源缺失 → sizeOver 保持 false，交给 backupFile 记 null
      }
    }
    if (isInsideGitDir(filePath) || sizeOver) return false;

    // 版本号以磁盘为准（C15）：扫描备份目录现存同文件 hash 的最大 v，防跨会话覆盖
    const nextVersion = await maxExistingVersion(this.backupDir, filePath) + 1;
    const backupName = await backupFile(filePath, this.backupDir, nextVersion);
    // 自包含更新：复制最近快照并加入新路径（appendEntry 语义，见 spec §6.2）
    const updated: SnapshotMeta = {
      ...latest,
      files: { ...latest.files, [key]: { backup: backupName } },
    };
    this.snapshots[this.snapshots.length - 1] = updated;
    return true;
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
          const overSize = await this.isOverSize(abs);
          if (overSize) {
            // 超大文件：不重读/重备份，沿用 desc（避免大文件全量入堆拖慢快照）
            files[key] = desc;
            return;
          }
          try {
            if (desc.backup === null) {
              // null 记录不可直接沿用：磁盘现状可能已变化（文件后来被创建）。
              // 重新评估磁盘：存在 → 补建真实备份（版本号以 maxExistingVersion 扫描为准，通常 v1）；
              // 仍不存在 → 保持 null（Critical 修复：防止 null 永久卡死导致恢复时误删文件）。
              const nextVersion = (await maxExistingVersion(this.backupDir, abs)) + 1;
              const name = await backupFile(abs, this.backupDir, nextVersion);
              files[key] = { backup: name };
              return;
            }
            const bakPath = join(this.backupDir, desc.backup);
            let changed = false;
            try {
              const [cur, bak] = await Promise.all([stat(abs), stat(bakPath)]);
              if (cur.mode !== bak.mode || cur.size !== bak.size) {
                changed = true;
              } else if (cur.mtimeMs < bak.mtimeMs) {
                // mtime 早于备份时间可短路跳过（同 CC checkOriginFileChanged：只有早于备份才确定未变）；
                // 相等或更新都无法保证内容未变，必须读内容确认（否则保留 mtime 的写入会被漏检）
                changed = false;
              } else {
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
            // 版本号以磁盘为准（C15）且须大于当前 desc 版本：防跨会话覆盖他人备份，也防退化
            const m = desc.backup.match(/@v(\d+)$/);
            const descV = m ? Number(m[1]) : 1;
            const nextVersion = (await maxExistingVersion(this.backupDir, abs)) + 1;
            const version = Math.max(descV + 1, nextVersion);
            const name = await backupFile(abs, this.backupDir, version);
            files[key] = { backup: name };
          } catch {
            // 单文件备份失败（如 EACCES/源突然被删）→ 沿用 desc，保留跟踪不丢，不中断整条快照（C13）
            files[key] = desc;
          }
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
   * 恢复到给定快照（spec §6.3/§10.1 三分支约束）：对"引擎全历史跟踪过的 key"与"目标快照自身
   * 记录的 key"的并集逐一处理。
   * - 目标快照 meta.files 中记录该 key → 直接按该记录恢复（restoreTo）。
   * - 目标快照未记录该 key（desc undefined）→ 查该路径全历史首个记录 v1 = findFirstVersion(key)：
   *   - v1 === undefined（该路径从未被任何快照跟踪）→ 跳过，不触碰磁盘
   *   - v1.backup === null（彼时该路径不存在）→ 删除磁盘文件
   *   - v1.backup 有文件名 → 恢复为 v1 备份内容
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
          await assertNoParentSymlink(this.cwd, key, abs);
          const desc = meta.files[key];
          if (desc !== undefined) {
            await this.restoreTo(abs, desc, result);
            return;
          }
          // 目标快照未记录该路径 → 回退全历史首个记录（v1，三分支见上方文档）
          const v1 = this.findFirstVersion(key);
          if (v1 === undefined) return; // 该路径从未被任何快照跟踪 → 跳过，不触碰磁盘
          await this.restoreTo(abs, v1, result);
        } catch (err) {
          // 单文件恢复失败隔离（C13）：含 symlink unlink、copyFile、rm 等任意异常，不中断其他文件
          result.errors.push({ path: key, error: err instanceof Error ? err.message : String(err) });
        }
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
   * 该 key 全历史首个记录（v1）：按 snapshots 数组顺序（最早 → 最新）查找首个含该 key 的记录。
   * trackEdit 从 v1 起、makeSnapshot 单调递增继承，故首个出现即 v1。
   * 未找到（该路径从未被任何快照跟踪）返回 undefined。
   */
  private findFirstVersion(key: string): BackupDesc | undefined {
    for (const s of this.snapshots) {
      const d = s.files[key];
      if (d !== undefined) return d;
    }
    return undefined;
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
    // fire-and-forget 必须接 .catch：rm 可因 EACCES/EPERM reject，未处理则 Node≥15 默认 unhandledRejection 崩进程
    void this.cleanOrphans().catch((e) => {
      console.error(`[pi-rewind] cleanOrphans failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  async diffStats(meta: SnapshotMeta): Promise<DiffStats | undefined> {
    const filesChanged: string[] = [];
    let insertions = 0;
    let deletions = 0;
    const keys = new Set([...Object.keys(meta.files), ...this.collectAllTrackedKeys()]);
    await Promise.all(
      Array.from(keys).map(async (key) => {
        try {
          // 逐键容错 + 与 restoreTo 对称的白名单校验，防单个不安全 key 弄挂整个 /rewind 预览
          const abs = toAbsolutePath(this.cwd, key);
          assertSafeKey(this.cwd, key, abs);
          await assertNoParentSymlink(this.cwd, key, abs);
          const desc = meta.files[key];
          const v1 = desc === undefined ? this.findFirstVersion(key) : undefined;
          if (desc === undefined && v1 === undefined) return;
          const target: string | null =
            desc === undefined ? (v1 as { backup: string | null }).backup : desc.backup;
          if (target !== null && !BACKUP_NAME_RE.test(target)) return;
          // 超大文件跳过，避免整读入堆 + diffLines(O(ND)) 阻塞事件循环
          if (await this.isOverSize(abs)) return;
          if (target !== null && (await this.isOverSize(join(this.backupDir, target)))) return;
          const [curContent, bakContent] = await Promise.all([
            readFileSafe(abs),
            target === null ? null : readFileSafe(join(this.backupDir, target)),
          ]);
          if (curContent === null && bakContent === null) return;
          // 内容相同（含两者为 null）不计为变化——filesChanged 必须只在确有差异时累加
          if (curContent === bakContent) return;
          filesChanged.push(key);
          const changes = diffLines(bakContent ?? "", curContent ?? "");
          for (const c of changes) {
            if (c.added) insertions += c.count ?? 0;
            if (c.removed) deletions += c.count ?? 0;
          }
        } catch {
          // 单 key 失败跳过，不中断其它 key 的统计
        }
      }),
    );
    return { filesChanged, insertions, deletions };
  }

  /** 磁盘清理：删除不被任何现存快照引用的备份文件（prune 后调用） */
  private async cleanOrphans(): Promise<void> {
    const referenced = new Set<string>();
    for (const s of this.snapshots) {
      for (const d of Object.values(s.files)) if (d.backup) referenced.add(d.backup);
    }
    let names: string[];
    try {
      names = await readdir(this.backupDir);
    } catch {
      return;
    }
    await Promise.all(
      names
        // 只删本引擎生成的备份名，绝不触碰备份目录内其它文件（BACKUP_NAME_RE 白名单）
        .filter((n) => BACKUP_NAME_RE.test(n) && !referenced.has(n))
        .map(async (n) => {
          try {
            await rm(join(this.backupDir, n), { force: true });
          } catch (e) {
            console.error(`[pi-rewind] remove orphan backup failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
    );
  }

  /** maxFileSizeBytes 上限检查；超限返回 true（跳过读取/重备份，防大文件全量入堆）。 */
  private async isOverSize(abs: string): Promise<boolean> {
    if (this.maxFileSizeBytes <= 0) return false;
    try {
      const st = await stat(abs);
      return st.size > this.maxFileSizeBytes;
    } catch {
      return false; // 源缺失等 → 交由具体分支处理
    }
  }
}
