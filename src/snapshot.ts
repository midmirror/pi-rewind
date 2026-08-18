// src/snapshot.ts
import { createHash } from "node:crypto";
import { copyFile, chmod, mkdir, stat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
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

  // 以下方法在 Task 3/4 实现
  async makeSnapshot(referencedMessageId: string): Promise<SnapshotMeta> {
    throw new Error("Not implemented in Task 2");
  }

  async applySnapshot(meta: SnapshotMeta): Promise<ApplyResult> {
    throw new Error("Not implemented in Task 3");
  }

  async diffStats(meta: SnapshotMeta): Promise<DiffStats | undefined> {
    throw new Error("Not implemented in Task 4");
  }
}
