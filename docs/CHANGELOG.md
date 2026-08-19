# CHANGELOG — pi-rewind

## [0.1.0] — 2026-08-18

首个完整功能版本。提交锚定：`d66176f`（baseline）..`ae4b740`（Critical 修复），15 commits。

### Added
- 备份引擎 `src/snapshot.ts`：`SnapshotEngine`（`trackEdit` 编辑前备份、`makeSnapshot` 每用户消息快照、`applySnapshot` 恢复、`diffStats` 差异统计、`cleanOrphans` 孤儿备份清理、`hydrate` 重启重建）。
- 备份存储：`~/.pi/agent/pi-rewind/backups/{sha256(path)16}@v{N}`，全局扁平（跨会话共享），版本号扫磁盘防覆盖，目录 `0o700`，快照上限 100（LRU）。
- 会话集成 `src/session.ts`：可回退用户消息过滤、`navigate` 跳点注入、`parentId=null` 首条消息边界。
- `/rewind` 命令 `src/command.ts`：交互（select+confirm）与非交互（`--last/--at/--dry-run/--confirm/--code-only/--conversation-only`）双模式。
- 事件接线 `index.ts`：`message_end` setImmediate 时序取 leaf、`tool_execution_start` await 备份、`pi.appendEntry` 落盘、`navigateTree` 跳点、`setEditorText` 回填、全 handler try/catch。
- 测试：29 单测+集成（契约 C1-C16）+ 事件流 harness + RPC 端到端脚本。

### Changed
- （无，首版）

### Fixed
- `backup:null` 快照卡死：`makeSnapshot` 重评估磁盘 + `trackEdit` 幂等判断着色 `backup !== null`，修复恢复误删文件（`ae4b740`）。
- C7 未记录路径回退：恢复 v1 三分支（undefined 跳过 / null 删除 / 有内容恢复）。
- `tool_execution_start` fire-and-forget 竞态回归：恢复 await 语义。
- `/rewind --at` 空值静默匹配：拒绝空值。
- `setEditorText` misjudgment：改用真实 `ctx.ui.setEditorText`。

### Security
- 恢复侧元数据校验：备份名白名单 `^[0-9a-f]{16}@v\d+$` + `assertSafeKey` key 逃逸拒绝。
- 符号链接写穿防护：恢复目标为 symlink 先 `unlink`。
- 备份目录 `mkdir mode 0o700`。
