// src/types.ts
/** 备份描述：backup 为备份文件名（相对备份目录），null 表示该文件彼时不存在 */
export interface BackupDesc {
  backup: string | null;
}

/** 快照元数据：自包含，持久化为 pi-rewind-snapshot custom entry 的 data */
export interface SnapshotMeta {
  /** 快照关联的用户消息 entry id（恢复目标） */
  referencedMessageId: string;
  /** 全局递增序号，LRU 淘汰用 */
  seq: number;
  timestamp: number;
  /** 跟踪文件的 key → 版本描述。key = cwd 内相对路径，cwd 外绝对路径 */
  files: Record<string, BackupDesc>;
}

export interface DiffStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

export interface ApplyResult {
  changed: string[];
  errors: { path: string; error: string }[];
}

/** 事件流驱动时传递的用户消息 entry 标识（integration test / session 层共用） */
export interface UserMessageRef {
  entryId: string;
  text: string;
  /** 该消息的父 entry id（恢复时 branch 的目标） */
  parentId: string | null;
}
