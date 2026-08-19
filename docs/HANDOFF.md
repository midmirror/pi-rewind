# HANDOFF — pi-rewind

## 工作背景

给 pi 编码代理做文件快照/回滚扩展（`/rewind`）。动机：cc 支持的 rewind（会话+代码双回滚）在 pi 缺代码回滚。方案：独立扩展 `~/.pi/agent/extensions/pi-rewind/`，含纯引擎 SnapshotEngine + 会话集成 + `/rewind` 命令。参考实现 CC `utils/fileHistory.ts`。设计 spec / 实施计划存 `/Users/mellow/Documents/Code/pi-work/docs/superpowers/`。

## 已完成（快照）

- **v0.1.0 全功能实现**（2026-08-18）：备份引擎 trackEdit/makeSnapshot/applySnapshot/diffStats/cleanOrphans；`/rewind` 交互 + 非交互参数模式；pi 事件接线（`message_end` setImmediate 时序、`tool_execution_start` await 备份、`pi.appendEntry` 落盘、`navigateTree` 跳点、`setEditorText` 回填）。
- **质量门禁**（2026-08-18）：29 单测+集成 PASS、typecheck 0 错误、真实 RPC E2E 通过 ×2（`a.ts==A2`、`c.ts removed`）。经 8 任务 Subagent-Driven + 四路审查 + 最终全分支审查（含 1 个 Critical 数据丢失 bug 修复）。
- **契约完整实现**（2026-08-18）：C1-C16 全覆盖（备份=编辑前内容 / 版本递增 / 幂等 / null / 有差异才覆盖 / 删除 / v1 三分支回退 / 权限 / diffStats / LRU100+孤儿清理 / `.git`>50MB 跳过 / key 相对化 / 单文件失败隔离 / 特殊字符 / 跨会话版本隔离 / 元数据校验）。

## 未完成（路线图，目标 v0.2.0）

- **diffStats 预览精度**：`/rewind --dry-run` 在 LLM 驱动场景可能显示 0/0（快照=磁盘现状时合法，但可能误导「有没有代码变化」的直觉）。恢复正确性不受影响（E2E 实证）。改进方向：UI 从「差异」改为「展示目标快照时刻文件列表」，或在命令消息处理上区分真实用户消息与 `/rewind` 自身。见 [EXPERIENCE#2](EXPERIENCE.md#2-rewind-dry-run-预览统计可能显示-00)。
- **人工 TUI 回验**：`docs/e2e-checklist.md` 六项（菜单 diff 显示、bash 改动不受影响、fork 恢复、重启持久化）尚未在真实交互 TUI 会话中逐项过一遍。
- **Windows 路径**：key / 绝对路径判断 / `${cwd}/${path}` 拼接假设 POSIX 分隔符，未在 Windows 实测（`path.join` 已用于 index.ts 拼接，其余需验证）。
- **npm 化发布**（可选）：当前源目录即部署；如需分享再拆 npm 包 + manifest（package.json 尚无 `pi` 字段扩展声明路径）。
