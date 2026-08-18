// scripts/e2e-rpc.mjs
// 用法: node scripts/e2e-rpc.mjs
// 启动真实 pi RPC 子进程（加载本扩展 + 隔离会话目录 + 临时工作目录），
// 三连 prompt 驱动 edit/write，再 /rewind --last --confirm 恢复，断言磁盘字节。
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// RPC 帧只按 \n 分段（协议要求），下方手动 split，不用 readline

const cwd = await mkdtemp(join(tmpdir(), "pi-rw-e2e-"));
await mkdir(join(cwd, "src"), { recursive: true });
await writeFile(join(cwd, "src/a.ts"), "A1\n");

// --no-session（in-memory 会话）+ --no-approve（跳过 project-trust 阻塞）：
// E2E 不验证重启持久化（那是人工回验清单 5 项），无需 --session-dir
const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "-e", `${process.env.HOME}/.pi/agent/extensions/pi-rewind/index.ts`, "--no-approve"], {
  cwd,
  env: { ...process.env },
  stdio: ["pipe", "pipe", "inherit"],
});

// JSONL 帧：仅按 \n 分割（RPC 协议要求）
let buffer = "";
const events = [];
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}
function waitFor(predicate, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const hit = events.find(predicate);
      if (hit) { clearInterval(timer); resolve(hit); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error(`timeout waiting for ${predicate}`)); }
    }, 200);
  });
}

try {
  send({ type: "prompt", message: "把 src/a.ts 文件第一行改为 A2（用 edit 工具，保留换行）" });
  await waitFor((e) => e.type === "agent_settled");
  send({ type: "prompt", message: "把 src/a.ts 内容改为 A3，并新建文件 src/c.ts 内容 C1（都用 edit/write 工具）" });
  await waitFor((e) => e.type === "agent_settled");

  // 非交互恢复：回到第一个用户消息 u1（--at 用 entryId 前缀，此处按顺序第 1 个用户消息）
  // 先列出可选点（dry-run 预览）
  // RPC 下 notify 无顶层事件帧：extension_ui_request.method==="notify"，message 在 payload 里
  const isNotify = (e, fragment) =>
    e.type === "extension_ui_request" && e.method === "notify" &&
    JSON.stringify(e.payload ?? e).includes(fragment);

  send({ type: "prompt", message: "/rewind --last --dry-run" });
  const preview = await waitFor((e) => isNotify(e, "rewind-preview"));
  console.log("PREVIEW:", JSON.stringify(preview));

  // --confirm 必带：RPC hasUI=true 且 select/confirm 阻塞等待应答，无 --confirm 会挂起
  send({ type: "prompt", message: "/rewind --last --confirm --code-only" });
  await waitFor((e) => isNotify(e, "rewind-done"), 30_000);

  // --last 语义：恢复到最后一次用户消息发送前 = 第二轮 prompt 发出时的磁盘快照。
  // 快照发生在 message_end→setImmediate 后，早于本轮的 edit/write → a.ts 应为 A2（第一轮结果）
  const a = await readFile(join(cwd, "src/a.ts"), "utf-8");
  let cExists = true;
  try { await readFile(join(cwd, "src/c.ts")); } catch { cExists = false; }

  if (a !== "A2\n") throw new Error(`E2E FAIL: a.ts expected A2 (last-turn start state), got ${JSON.stringify(a)}`);
  if (cExists) throw new Error("E2E FAIL: c.ts (created in last turn) should have been removed");
  console.log("E2E PASS: a.ts==A2 (恢复至末轮起始), c.ts removed");
} finally {
  child.kill("SIGTERM");
  await rm(cwd, { recursive: true, force: true });
}
process.exit(0);
