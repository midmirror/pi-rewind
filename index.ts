// index.ts — pi-rewind 扩展入口
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { SnapshotEngine } from "./src/snapshot.js";
import type { SessionEntry as RewindSessionEntry, RestoreContext } from "./src/session.js";
import { executeRewind, parseArgv } from "./src/command.js";
import type { RewindDeps } from "./src/command.js";
import type { SnapshotMeta } from "./src/types.js";

const CUSTOM_TYPE = "pi-rewind-snapshot";

export default function init(pi: ExtensionAPI) {
  let engine: SnapshotEngine | null = null;
  let sessionId: string | undefined;

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const backupDir = `${home}/.pi/agent/pi-rewind/backups`;
  // mkdir 的 mode 仅对「新建」目录生效；已存在目录（旧版本/umask 残留）必须显式 chmod 修正，
  // 否则备份目录可能残留 0755，本机其他用户可读全部被编辑源码/凭据（隐私锚点）。
  void (async () => {
    try {
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      await chmod(backupDir, 0o700);
    } catch {
      /* best-effort */
    }
  })();

  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    engine = new SnapshotEngine({ backupDir, cwd: ctx.sessionManager.getCwd() });
    const snapshots: SnapshotMeta[] = [];
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && (entry as { customType?: string }).customType === CUSTOM_TYPE) {
        snapshots.push((entry as { data?: unknown }).data as SnapshotMeta);
      }
    }
    engine.hydrate(snapshots);
  });

  pi.on("session_shutdown", () => {
    engine = null;
    sessionId = undefined;
  });

  // message_end 先于 appendMessage 完成落库触发（pi 运行时时序），故延后到下一
  // 宏任务再取 leaf id，确保 sessionManager.getLeafEntry() 已经是刚发出的这条用户消息。
  // 会话可能在 setImmediate 排队期间被切换/关闭，用捕获的 sessionId 校验后丢弃过期回调。
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "user" || !engine) return;
    const capturedSession = sessionId;
    const capturedEngine = engine;
    setImmediate(() => {
      void (async () => {
        try {
          if (sessionId !== capturedSession) return;
          const leaf = ctx.sessionManager.getLeafEntry();
          if (!leaf) return;
          const meta = await capturedEngine.makeSnapshot(leaf.id);
          pi.appendEntry(CUSTOM_TYPE, meta);
        } catch (err) {
          console.error(`[pi-rewind] snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    });
  });

  // 编辑/写入前挂载文件到当前快照（首次编辑即备份编辑前内容）。落盘 appendEntry
  // 让重启后的 hydrate 拿到该文件的跟踪记录；失败不得中断工具执行。
  // await 语义是设计基础：pi 的 tool_execution_start 是 await 触发（工具执行会
  // 等待此 handler 完成），spec 依赖此保证「备份先于编辑写盘完成、无竞态」。
  // 不可改为 fire-and-forget，否则 stat+copyFile 与工具写盘竞态，大文件下可能
  // 备份到编辑后内容，恢复时静默错误。
  pi.on("tool_execution_start", async (event, ctx) => {
    if (!engine) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const filePath = (event.args as { path?: unknown } | undefined)?.path;
    if (typeof filePath !== "string" || filePath.length === 0) return;
    const cwd = ctx.sessionManager.getCwd();
    const abs =
      filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath) ? filePath : path.join(cwd, filePath);
    try {
      const changed = await engine.trackEdit(abs);
      // 仅当快照实际被修改才落盘：幂等/sizeOver/.git 跳过时不 emit，避免重复条目
      // 在重启 hydrate 后挤占 maxSnapshots 淘汰预算（旧消息失去恢复点）。
      if (changed) {
        const latest = engine.getLatest();
        if (latest) pi.appendEntry(CUSTOM_TYPE, latest);
      }
    } catch (err) {
      console.error(`[pi-rewind] trackEdit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  pi.registerCommand("rewind", {
    description:
      "回退代码/会话到之前的用户消息。用法: /rewind [--last|--at <序号|entryId>] [--code-only|--conversation-only] [--confirm] [--dry-run]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!engine) {
        ctx.ui.notify("pi-rewind 未就绪（会话未启动）", "error");
        return;
      }
      const opts = parseArgv(args);

      // 偏差记录：brief 中 RestoreContext.navigate 由顶层 pi.navigateTree 提供，但
      // ExtensionAPI 上不存在 navigateTree —— 该方法只挂在命令 handler 收到的
      // ExtensionCommandContext 上（见 types.d.ts 第 274 行 navigateTree(targetId, options)）。
      // 这里从 ctx（命令上下文）取用，而非从顶层 pi 对象取用。
      const restoreCtx: RestoreContext = {
        navigate: async (targetId: string | null) => {
          if (targetId === null) return { cancelled: false };
          return ctx.navigateTree(targetId);
        },
        sessionManager: {
          getLeafEntry: () => ctx.sessionManager.getLeafEntry() as { id: string } | undefined,
          getEntries: () => ctx.sessionManager.getEntries() as unknown as RewindSessionEntry[],
        },
        ui: {
          // 使用 ExtensionUIContext.setEditorText 把目标消息文本写回主输入编辑器，
          // 用户可编辑后回车重发形成新分支（spec §7）。
          setEditorText: (text: string) => ctx.ui.setEditorText(text),
          notify: (msg: string, level: "info" | "warning" | "error") => ctx.ui.notify(msg, level),
        },
      };

      const deps: RewindDeps = {
        engine,
        entries: ctx.sessionManager.getEntries() as unknown as RewindSessionEntry[],
        ctx: restoreCtx,
        ctxOutput: (s: string) => ctx.ui.notify(s, "info"),
      };
      if (ctx.hasUI) {
        deps.select = async (items: string[], prompt: string) => {
          const choice = await ctx.ui.select(prompt, items);
          if (choice === undefined) return undefined;
          return items.indexOf(choice);
        };
        deps.confirm = async (prompt: string) => ctx.ui.confirm("Rewind", prompt);
      }

      try {
        await executeRewind(deps, opts);
      } catch (err) {
        ctx.ui.notify(`/rewind 执行失败: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
