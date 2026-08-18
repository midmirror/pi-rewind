// test/harness.ts
import type { SessionEntry } from "../src/session.js";

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
