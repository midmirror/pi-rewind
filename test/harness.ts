// test/harness.ts
import type { SessionEntry } from "../src/session.js";
import { SnapshotEngine } from "../src/snapshot.js";

export function makeContext(entries: SessionEntry[]) {
  let leafId = entries.at(-1)?.id ?? null;
  const editorText: string[] = [];
  const notifications: string[] = [];
  const navigations: (string | null)[] = [];
  const ctx = {
    navigate: async (targetId: string | null) => {
      navigations.push(targetId);
      leafId = targetId;
      return { cancelled: false };
    },
    sessionManager: {
      getLeafEntry() {
        return entries.find((e) => e.id === leafId);
      },
      getEntries() {
        return entries;
      },
    },
    ui: {
      setEditorText(text: string) {
        editorText.push(text);
      },
      notify(msg: string) {
        notifications.push(msg);
      },
    },
  };
  return { ctx, getLeafId: () => leafId, editorText, notifications, navigations };
}

export interface FakeSessionEntry {
  id: string;
  parentId: string | null;
  type: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
}

export function makeEventHarness(opts: { cwd: string; backupDir: string }) {
  const cwd = opts.cwd;
  const engine = new SnapshotEngine({ backupDir: opts.backupDir, cwd });
  const entries: FakeSessionEntry[] = [];
  let leafId: string | null = null;
  const entriesStore = {
    appendCustomEntry(customType: string, data: unknown): string {
      const id = `e${entries.length + 1}`;
      entries.push({ id, parentId: leafId, type: "custom", customType, data });
      leafId = id;
      return id;
    },
    getEntries: () => entries,
    getLeafEntry: () => entries.find((e) => e.id === leafId),
    getCwd: () => cwd,
    branch(id: string | null) {
      leafId = id;
    },
  };
  const toolTracked: string[] = [];
  return {
    engine,
    entriesStore,
    async onMessageEndUser(messageId: string) {
      // 模拟真实时序（H1）：真正的 handler 用 setImmediate 等到落库完成后取 leaf；
      // 此处等价建模——先 push entry 并更新 leaf（落库完成），再建快照（此时可拿到正确 id）
      entries.push({ id: messageId, parentId: leafId, type: "message", message: { role: "user" } });
      leafId = messageId;
      const meta = await engine.makeSnapshot(messageId);
      entriesStore.appendCustomEntry("pi-rewind-snapshot", meta);
      return meta;
    },
    async onToolExecStart(toolName: string, args: { path: string }) {
      if (toolName === "edit" || toolName === "write") {
        const changed = await engine.trackEdit(args.path);
        if (changed) {
          toolTracked.push(args.path);
          // 对齐 index.ts 接线：仅当快照实际被修改才落盘 entry
          const latest = engine.getLatest();
          if (latest) entriesStore.appendCustomEntry("pi-rewind-snapshot", latest);
        }
      }
    },
    getToolTracked: () => toolTracked,
    getLeafId: () => leafId,
  };
}
