# AGENTS.md — pi-rewind

pi 编码代理（@earendil-works/pi-coding-agent）的扩展：为会话提供文件快照与代码回滚（`/rewind`）。编辑类工具（edit/write）执行前备份文件，每个用户消息建快照，可恢复到任意历史点时同时/分别回滚代码与会话。参考实现为 Claude Code 的 rewind（`utils/fileHistory.ts`）。

## Commands

- `npm test` — Vitest 单测+集成（src 引擎 + 会话集成 + 事件流 harness）
- `npm run typecheck` — `tsc --noEmit`
- `npm run e2e` — 真实 pi RPC 进程 + LLM 驱动的端到端（`scripts/e2e-rpc.mjs`）
- 全部门禁收尾本地跑一遍：`npm test && npm run typecheck && npm run e2e`

## Must-know（改了会坏）

- **备份存储全局扁平**：`~/.pi/agent/pi-rewind/backups/{sha256(绝对路径)前16位}@v{N}`。备份名不含会话，跨会话/fork 天然共享；因此**版本号必须扫磁盘现存文件的最大 v+1**（见 [决策：全局扁平备份](docs/decisions/2026-08-18-全局扁平备份目录.md)），否则新会话会重算 v1 覆盖旧备份。
- **路径 key 语义**：`SnapshotMeta.files` 的 key = cwd 内相对路径、cwd 外绝对路径（同 CC `maybeShortenFilePath`）。恢复前 `assertSafeKey` 校验 key 逃逸 + `BACKUP_NAME_RE` 校验备份名，违反即拒绝该文件。
- **`backup:null` 是「彼时不存在」的标记，不是死状态**：`makeSnapshot` 遇到 null 记录必须重评估磁盘（文件被创建就补建 v1 备份），`trackEdit` 幂等判断须写 `existing.backup !== null` 才跳过。曾因 null 卡死导致恢复误删文件（见 [决策：C7 回退语义](docs/decisions/2026-08-18-C7-未记录路径回退语义.md)与 [复盘](docs/EXPERIENCE.md#1-null-快照卡死导致恢复误删文件)）。
- **pi 事件语义**（与直觉相反）：
  - `message_end` 的扩展 emit **先于**该消息 entry 落库（`agent-session.js` 中 `appendMessage` 在 extension emit 之后）——取用户消息 entry 须 `setImmediate` 延后并校验 sessionId 未变。
  - `tool_execution_start` 是 **await 语义**（工具执行等待 handler 完成）——依赖此保证「备份先于编辑写盘」无竞态，**禁止改 fire-and-forget**。
  - 事件/命令上下文的 `sessionManager` 是 `ReadonlySessionManager`：跳点用 `ctx.navigateTree(targetId)`，写入用 `pi.appendEntry(customType, data)`，编辑器回填用 `ctx.ui.setEditorText(text)`（三者均在 `types.d.ts` 存在）。
- 扩展是**源目录即部署**：`index.ts` 直接为 pi 加载入口（软链到真实目录），无构建。`node_modules` 在扩展目录内，pi 从其解析 `diff`。
- 存储位置：`~/.pi/agent/extensions/pi-rewind`（软链指向 `~/.agents/agent-configs/pi/extensions/pi-rewind`）。加载验证：持久化 RPC 会话里发 `/rewind --dry-run`，若输出「无可回退」而非 LLM 回复即已注册。

## Docs 索引

- [HANDOFF（交付状态）](docs/HANDOFF.md) — 工作背景 / 已完成快照 / 未完成路线图
- [CHANGELOG（版本流水）](docs/CHANGELOG.md)
- [EXPERIENCE（踩坑）](docs/EXPERIENCE.md)
- [决策记录](docs/decisions/)
- [escalation / 人工回验清单](docs/e2e-checklist.md)
- 设计 spec 与实施计划存于 `/Users/mellow/Documents/Code/pi-work/docs/superpowers/`（pi-work 非 git 仓库，未纳入本仓库版本控制）
