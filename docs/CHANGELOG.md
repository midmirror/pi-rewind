# CHANGELOG — pi-rewind

## [0.2.0] — 2026-08-19

Review 强化版：四路只读 sub-agent 审查（意图回归 / 安全隐私 / 性能可靠 / 契约覆盖）+ 修复全部 H/M 登记问题，测试 29→41。参考实现 `claude-code-source/utils/fileHistory.ts` 语义对齐。

### Fixed
- **makeSnapshot 变化分支版本号不扫盘**（C15 漏洞）：changed 分支一度按 `desc @vN+1` 取版本，与 `trackEdit`/null 分支的 `maxExistingVersion` 扫描不一致——全局扁平共享备份目录下可覆盖他人备份。统一 `version = max(descV+1, 磁盘最大v+1)`。
- **trackEdit 后无条件 appendEntry**：幂等 / `.git` / 超大文件跳过时仍落盘整份最新快照，重启 hydrate 后重复条目挤占 `maxSnapshots(100)` 淘汰预算，旧消息静默失去恢复点。改为 `trackEdit` 返回是否实际变更，仅真时落盘。
- **单文件失败未隔离**（C13 缺口）：`applySnapshot` 回调只对 `assertSafeKey` try/catch，symlink unlink 等裸 `await` 异常会拒绝整个 `Promise.all` → 单文件失败中断整个 rewind。恢复/快照逐文件整体 try/catch。
- **`backupFile` 任意错误归 null**：`stat` 的 EACCES 等非缺失错误被误记「彼时不存在」，恢复时删除真实文件。仅 `ENOENT` 归 null，其余上抛由调用方隔离。
- **diffStats 防御不对称**：`assertSafeKey` 无 try 弄挂整个 `/rewind --dry-run`；`target` 未过备份名白名单。逐键容错 + 白名单对齐 `restoreTo`。
- **mtime 相等跳过内容比对**：`cur.mtimeMs > bak.mtimeMs` 才比对、相等直接判未变——保留 mtime 的写入（rsync / `cp -p` / patch）内容变了却漏检。统一为 CC 语义（`<` 跳、相等仍比对）。
- **回退点无快照静默伪装成功**：`snap` 缺失时 `applySnapshot` 被跳过但输出像「无代码变化」的成功。改为显式 `(snapshot)` 错误提示（含已被 LRU 淘汰的场景）。
- **cleanOrphans 无 catch + 无白名单**：`void cleanOrphans()` 的 `rm` reject 成 unhandledRejection 可崩进程（Node≥15）；过滤器只按引用集过滤、不校验 `BACKUP_NAME_RE`。接 `.catch` + 白名单。
- **diffStats 把无变化文件计入 filesChanged**：`filesChanged.push` 在相等判断之前 → `--dry-run` / 确认弹窗误报「有变化」。移到判断后。
- **50MB 上限只在 trackEdit 生效**：makeSnapshot/diffStats 不查 size，超大文件整读入堆 + `diffLines` 阻塞事件循环。`isOverSize` 下沉两条路径。
- **父链 symlink 写穿**：恢复只查最终组件 `lstat`，中间目录 symlink（dotfiles 布局）可写穿 cwd 外真实文件。新增 `assertNoParentSymlink`（realpath 父链校验）。
- **备份目录权限不强制**：`mkdir mode 0o700` 仅新建生效，已存在目录残留 0755 会暴露全部被编辑源码/凭据。init 幂等 `chmod(backupDir, 0o700)`。

### Security
- 恢复 / 预览路径父链 symlink 写穿防护。
- 备份目录权限幂等修正。

### Changed
- `package.json` version `0.1.0` → `0.2.0`。
- `test/harness.ts` `onToolExecStart` 对齐新接线：仅 `trackEdit` 实际变更才落盘 entry。

### Tests
- 12 新增：跨会话 makeSnapshot 版本扫描、trackEdit 返回值、mtime 相等、cleanOrphans 白名单/引用保留、hydrate 往返、`--at` entryId 前缀寻址、`--conversation-only`、命令级 `--dry-run`、无快照显式报错、navigate-cancel、父链 symlink 写穿拒绝、diffStats 无变化不计。

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
