// src/session.ts
import type { UserMessageRef } from "./types.js";

export type { UserMessageRef } from "./types.js";

export interface SessionEntry {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role: string; content: unknown };
  customType?: string;
  data?: unknown;
}

export interface RestoreContext {
  navigate: (targetId: string | null) => Promise<{ cancelled: boolean }>;
  sessionManager: {
    getLeafEntry(): { id: string } | undefined;
    getEntries(): SessionEntry[];
  };
  ui: {
    setEditorText(text: string): void;
    notify(msg: string, level: "info" | "warning" | "error"): void;
  };
}

// 命令输出/合成消息注入标签（pi 内部常量，接线时校准）
const NON_USER_TEXT_MARKERS = [
  "<bash-stdout>",
  "<bash-stderr>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<task-notification>",
  "<tick>",
  "<teammate-message>",
];

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const last = content[content.length - 1] as { type?: string; text?: string } | undefined;
    if (last?.type === "text" && last.text) return last.text.trim();
  }
  return "";
}

export function getSelectableUserEntries(entries: SessionEntry[]): UserMessageRef[] {
  const refs: UserMessageRef[] = [];
  for (const e of entries) {
    if (e.type !== "message" || e.message?.role !== "user") continue;
    const text = extractText(e.message.content);
    if (!text) continue;
    if (NON_USER_TEXT_MARKERS.some((m) => text.includes(m))) continue;
    refs.push({ entryId: e.id, text, parentId: e.parentId });
  }
  return refs;
}

export async function runSessionRestore(ctx: RestoreContext, ref: UserMessageRef): Promise<void> {
  if (ref.parentId !== null) {
    const result = await ctx.navigate(ref.parentId);
    if (result.cancelled) return; // session_before_tree 钩子取消，不改动会话
  } else {
    // 首条消息：navigateTree 只收 string，无 API 表达回滚至空会话
    ctx.ui.notify("这是首条消息，未跳转会话；如需重新开始请 /tree 选择根节点或 /new。", "info");
  }
  if (ref.text) ctx.ui.setEditorText(ref.text);
  ctx.ui.notify("会话已跳转，输入框已回填原提示，可编辑后回车发起新分支。", "info");
}
