# EXPERIENCE — pi-rewind 踩坑

编号 1..N，新条目追加不重排；过时条目删除线 + 日期。引用带标题链接，禁止裸编号。

## 1. null 快照卡死导致恢复误删文件

`backup:null` 是「该文件彼时不存在」的标记。曾把 null 当**死状态**：`makeSnapshot` 对 null 记录直接沿用、`trackEdit` 幂等用 `if (latest.files[key]) return`（真值判断）。叠加后：write 工具新建文件（trackEdit 先触发 → null 记录）→ 该路径**永久卡死 null**，后续编辑不再备份 → 恢复「文件已创建」后的任意快照点**误删文件**（应还原内容）。

- 修复：`makeSnapshot` 对 null 记录**每次重评估磁盘**（存在 → 补建 v1 备份；仍不存在 → 保持 null）；`trackEdit` 幂等判断改为 `existing.backup !== null` 才跳过。
- 教训：表示「不存在」的哨兵值在快照系统里必须时时与磁盘比对，不能靠「键存在」近似「已跟踪且有效」。最终 review 的独立复现脚本抓住的正是测试未覆盖的「null→创建→二次编辑」链。

## 2. /rewind --dry-run 预览统计可能显示 0/0

`--dry-run` 对「末轮」的 diff 统计在 LLM 驱动场景可能输出 `filesChanged:["a.ts"], +0/-0`。成因两种：a) 快照时刻恰好 = 磁盘现状（`/rewind` 自身不改文件，合法）；b) LLM 一次性完成多轮编辑导致快照语义滞后。恢复正确性不受影响（E2E 断言通过），但菜单 `+N/-N` 会误导「有无代码变化」的判断。

- 处置：先确认恢复正确，再当展示精度问题处理；人工回验（[e2e-checklist](./e2e-checklist.md) 第 1 项）观察真实菜单。
- 教训：预览统计与恢复是两条独立路径，测试必须分别验证，不能因恢复正确就忽略预览偏差。

## 3. pi 的 message_end 扩展 emit 先于 entry 落库

pi 的 `agent-session.js` 里 `_emitExtensionEvent`（扩展 message_end）在 `message_end` 分支的 `appendMessage`（entry 落库）**之前**。若直接 `getLeafEntry()` 拿用户消息 id，拿到的是旧 leaf（首条消息为 null）→ 快照 referencedMessageId 错连/跳过快照。

- 解法：handler 内 `setImmediate` 延后到下一宏任务取 leaf（appendMessage 同步执行，必然已完成）+ 用 `getSessionId()` 校验会话未切换。
- 判断先行：实现前读事件触发源码的**顺序**，别假设「事件触发时状态已就绪」。

## 4. tool_execution_start 是 await 语义——是特性不是负担

pi 对 `tool_execution_start` 的扩展 emit 是 `await`（工具执行等待 handler 完成）。这是「备份先于编辑写盘」无竞态的**设计基础**。曾把它「优化」成 fire-and-forget→ 备份与编辑竞态，大文件下 v1 可能记录编辑后内容，恢复静默错误。

- 教训：把 await 语义当资源是回归源头。读源码确认 emit 是否 await 再决定手写异步。

## 5. pi 扩展上下文是只读面

事件/命令上下文的 `sessionManager` 是 `ReadonlySessionManager`（Pick 白名单：getCwd/getEntries/getLeafEntry/getBranch 等读方法）。`branch`/`appendCustomEntry` 不在其上，运行必 TypeError。

- 正确工具：跳点 `ctx.navigateTree(targetId)`；写 entry `pi.appendEntry(customType, data)`；编辑器回填 `ctx.ui.setEditorText(text)`（`types.d.ts` ~L131，**真实存在**——曾有误判为不存在而改用对话框，回填语义降级）。
- 教训：以 `node_modules` 下的 `.d.ts` 为准核实 API，别凭文档印象或实现者转述。API 存在性争议先 grep 类型定义。

## 6. 全局扁平备份目录 → 版本号必须扫磁盘

备份名只有 `{hash}@vN` 不含会话维——跨会话/fork 天然共享是收益，但版本号若只按本引擎内存快照算，新会话对同一路径会重算 v1 **覆盖旧会话备份**，旧分支快照引用被篡改。CC 按 sessionId 分目录正是防此。

- 解法：`maxExistingVersion` 扫备份目录现存文件的最大 v+1。
- 教训：任何「全局共享名空间」都要问「并发/跨实例的版本唯一性谁保证」。

## 7. 扩展加载与软链目录排查

`~/.pi/agent/extensions` 是软链 → `~/.agents/agent-configs/pi/extensions`（pi 的 agentDir = `~/.pi/agent`，loader 对软链目录 `entry.isSymbolicLink()` 有处理，遍历正常）。"重启没加载"实测为误报——自动发现正常。

- 判定法：持久化 RPC 会话里 `prompt "/rewind --dry-run"`，输出「无可回退」= 命令已注册；`agent_start:false` = 未被丢给 LLM。`get_commands` 在 RPC 下不可靠（`--no-session` 返回 0），不要用它判定加载。
- 教训：加载问题用「命令是否被拦截」实测，而非命令列表 API。
