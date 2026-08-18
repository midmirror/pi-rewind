# pi-rewind Critical 修复报告：backup:null 永久卡死

基线 HEAD: `8cbc52a`（28 PASS + E2E 通过，但携带此 Critical bug）

## 根因

1. `makeSnapshot`（src/snapshot.ts）：对 `desc.backup === null` 的记录直接复用 `files[key] = desc`，从不重新检查磁盘现状。
2. `trackEdit`：`if (latest.files[key]) return;` 用真值判断，忽略 `.backup` 是否为 `null` —— 一旦某 key 记录过 `{ backup: null }`（哪怕对象本身为真值），此后所有编辑都被误判为“已跟踪”而跳过备份。

叠加效果：write 新文件前触发 `trackEdit`（文件不存在 → `{backup:null}`）之后该路径永久卡死 null，真实内容永不再被备份；`applySnapshot` 对 `backup:null` 语义是删除文件——恢复到该文件已创建之后的任意快照点会误删已创建的文件内容。违反 spec §6.1「变化才写新版本」与 C2/C6/C7。

## 修复

### 1. `makeSnapshot` null 分支重评估磁盘（src/snapshot.ts）
`desc.backup === null` 时不再直接复用，改为 `stat` 目标文件：
- 存在 → 用 `backupFile`（版本号经 `maxExistingVersion` 扫描，首次为 v1）写入真实备份，`files[key] = { backup: name }`。
- 仍不存在 → 保持 `{ backup: null }`。

### 2. `trackEdit` 幂等判断改为区分 null（src/snapshot.ts）
```
const existing = latest.files[key];
if (existing !== undefined && existing.backup !== null) return;
```
仅「已跟踪且非 null」才跳过。null 记录继续走备份流程：文件现在存在则产出真实备份并更新记录；仍不存在则 `backupFile` 返回 null，记录保持幂等。

注：初版实现用 `latest.files[key]?.backup !== null`，对未跟踪 key（`undefined`）会误判为「非 null」而错误跳过首次备份，测试跑出 4 个既有 case 失败（C1/C2+C3/等），已改为显式区分 `undefined` vs `{backup:null}` 后全绿。

### 3. Minor：index.ts 路径拼接
`${cwd}/${path}` → `path.join(cwd, path)`，并将局部变量 `path`（字符串）改名为 `filePath`，避免遮蔽 `node:path` 模块导入。

### 4. 新增回归测试（test/snapshot.test.ts，`makeSnapshot` describe 内）
场景链「null→创建→二次编辑→恢复」：
- hydrate 空快照 u1（c.ts 不存在）→ trackEdit(c.ts) → 断言记录为 `backup:null`
- 模拟 write：writeFile(c.ts,"C1") → makeSnapshot("u2") → **断言 u2.files[c.ts].backup 非 null，内容 == "C1"**（关键断言：null 被推进为 v1）
- trackEdit 再次调用（此时已非 null）→ 断言幂等跳过，backup 不变
- 模拟 edit：writeFile(c.ts,"C2") → makeSnapshot("u3") → 断言 backup 为 v2
- applySnapshot(u2) → 断言磁盘 c.ts == "C1"（不删除）
- applySnapshot(u1) → 断言磁盘 c.ts 不存在（u1 时刻确实不存在 → 删除正确）

## 验证结果

- `npx vitest run`：29 PASS（28 原有 + 1 新增），0 FAIL。
- `npm run typecheck`：`tsc --noEmit` 无输出，通过。
- `npm run e2e`：`E2E PASS: a.ts==A2 (恢复至末轮起始), c.ts removed`，通过，行为与修复前一致（该 E2E 场景未触发 null 卡死路径，回归安全）。

## diffStats 0/0 观察（按要求核实，未回避）

E2E preview 输出：
```
"stats":{"filesChanged":["src/a.ts"],"insertions":0,"deletions":0}
```
修复前后**结果相同**，均为 `0/0`。用独立脚本（tsx 直跑 SnapshotEngine，脱离 CLI/RPC）复现等价场景（trackEdit→write→makeSnapshot(u2)→再编辑→diffStats(u2)），diffStats 正确返回 `{"insertions":1,"deletions":1}`——证明 `diffStats` 本身逻辑无误，且**不与本次 backup:null bug 同源**。

真实原因：E2E 脚本用 `/rewind --last --dry-run` 作为 prompt 发送，RPC 场景下这条 `/rewind` 命令本身被记为一条新的用户消息（`getSelectableUserEntries` 无法区分斜杠命令与普通用户消息），`--last` 解析取的是**该 `/rewind` 消息对应的快照点**，即命令发出前一刻的状态——此时距上一次真实代码编辑（`A2→A3`/新建 `c.ts`）之间可能已无新增变化被 diffStats 判定（取决于该快照与当前磁盘态的比对基准恰好一致），导致预览统计为 0/0。这是 `getSelectableUserEntries`/`--last` 目标解析层面的既有行为，不属于本次 Critical 修复范围，需要单独立项核实（若需修复，应在 `NON_USER_TEXT_MARKERS` 层面排除斜杠命令消息，或 `--last` 语义改为跳过命令消息取更早的真实用户消息）。

## 未做变更

未改动 `applySnapshot`/`restoreTo`/`diffStats` 主逻辑本体（仅 `makeSnapshot` null 分支与 `trackEdit` 幂等判断），未触碰 spec 之外范围。
