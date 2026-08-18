// src/command.ts
import { SnapshotEngine } from "./snapshot.js";
import { SessionEntry, getSelectableUserEntries, runSessionRestore, RestoreContext } from "./session.js";
import { UserMessageRef } from "./types.js";

export interface RewindOptions {
  target: { kind: "last" } | { kind: "at"; value: string };
  mode: "code" | "conversation" | "both";
  confirm: boolean;
  dryRun: boolean;
}

export interface RewindDeps {
  engine: SnapshotEngine;
  entries: SessionEntry[];
  ctx: RestoreContext;
  select?: (items: string[], prompt: string) => Promise<number | undefined>;
  confirm?: (prompt: string) => Promise<boolean>;
  ctxOutput?: (s: string) => void;
}

export function parseArgv(args: string): RewindOptions {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const opts: RewindOptions = { target: { kind: "last" }, mode: "both", confirm: false, dryRun: false };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === "--last") opts.target = { kind: "last" };
    else if (p === "--at") opts.target = { kind: "at", value: parts[++i] ?? "" };
    else if (p === "--dry-run") opts.dryRun = true;
    else if (p === "--confirm") opts.confirm = true;
    else if (p === "--code-only") opts.mode = "code";
    else if (p === "--conversation-only") opts.mode = "conversation";
  }
  return opts;
}

async function resolveTarget(
  deps: RewindDeps,
  opts: RewindOptions,
): Promise<{ ref: UserMessageRef; snap: ReturnType<SnapshotEngine["getSnapshotById"]> } | undefined> {
  const refs = getSelectableUserEntries(deps.entries);
  if (refs.length === 0) return undefined;
  let ref: UserMessageRef | undefined;
  if (opts.target.kind === "at") {
    // --at 支持两种寻址：数字=第 N 条可回退用户消息（1 起）；非数字=entryId 前缀
    const value = opts.target.value;
    if (!value || !value.trim()) return undefined; // 缺值（如 `/rewind --at` 漏填）→ 不可解析，走「无可回退」提示，不静默匹配
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1) {
      ref = refs[n - 1];
    } else {
      ref = refs.find((r) => r.entryId === value || r.entryId.startsWith(value));
    }
  } else {
    ref = refs.at(-1);
  }
  if (!ref) return undefined;
  return { ref, snap: deps.engine.getSnapshotById(ref.entryId) };
}

export async function executeRewind(deps: RewindDeps, opts: RewindOptions): Promise<void> {
  const targeted = await resolveTarget(deps, opts);
  if (!targeted) {
    deps.ctx.ui.notify("无可回退的用户消息。", "warning");
    return;
  }
  const { ref, snap } = targeted;
  const stats = snap ? await deps.engine.diffStats(snap) : undefined;
  const out = deps.ctxOutput ?? ((s: string) => deps.ctx.ui.notify(s, "info"));

  if (opts.dryRun) {
    out(JSON.stringify({ type: "rewind-preview", entryId: ref.entryId, text: ref.text.slice(0, 80), stats: stats ?? null }));
    return;
  }

  let confirmed = opts.confirm;
  if (!confirmed && deps.select && deps.confirm) {
    const items = await refsToMenu(deps);
    const idx = await deps.select(items, "Rewind to which point? (↑/↓ 选择, Enter 确认)");
    if (idx === undefined) { out(JSON.stringify({ type: "rewind-cancelled" })); return; }
    const menuRefs = getSelectableUserEntries(deps.entries);
    const chosen = menuRefs[idx];
    if (!chosen) return;
    const chosenSnap = deps.engine.getSnapshotById(chosen.entryId);
    const chosenStats = chosenSnap ? await deps.engine.diffStats(chosenSnap) : undefined;
    const has = !!chosenStats && (chosenStats.insertions + chosenStats.deletions + chosenStats.filesChanged.length) > 0;
    confirmed = await deps.confirm(
      `恢复至「${chosen.text.slice(0, 50)}」？` + (has ? ` 文件变化 +${chosenStats!.insertions} -${chosenStats!.deletions}` : " 无代码变化") +
      (has ? "\n⚠ bash/手动编辑的改动不受影响，不会被回滚。" : ""),
    );
    if (!confirmed) { out(JSON.stringify({ type: "rewind-cancelled" })); return; }
    await applyRestore(deps, chosen, chosenSnap, opts, out);
    return;
  }

  // 非交互（或已有确认）：应用到 last/at 目标
  if (!confirmed) {
    out(JSON.stringify({ type: "rewind-preview", entryId: ref.entryId, text: ref.text.slice(0, 80), stats: stats ?? null, note: "pass --confirm to apply" }));
    return;
  }
  await applyRestore(deps, ref, snap, opts, out);
}

async function refsToMenu(deps: RewindDeps): Promise<string[]> {
  const refs = getSelectableUserEntries(deps.entries);
  return Promise.all(refs.map(async (r) => {
    const snap = deps.engine.getSnapshotById(r.entryId);
    const stats = snap ? await deps.engine.diffStats(snap) : undefined;
    const diff = stats && stats.filesChanged.length > 0 ? ` +${stats.insertions} -${stats.deletions} (${stats.filesChanged.length}f)` : " 无代码变化";
    return `${r.text.slice(0, 50).replace(/\n/g, " ")}${diff}`;
  }));
}

async function applyRestore(
  deps: RewindDeps,
  ref: UserMessageRef,
  snap: ReturnType<SnapshotEngine["getSnapshotById"]>,
  opts: RewindOptions,
  out: (s: string) => void,
): Promise<void> {
  const result: { changed?: string[]; errors?: { path: string; error: string }[] } = {};
  if (snap && (opts.mode === "code" || opts.mode === "both")) {
    const res = await deps.engine.applySnapshot(snap);
    result.changed = res.changed;
    result.errors = res.errors;
  }
  if (opts.mode === "conversation" || opts.mode === "both") {
    await runSessionRestore(deps.ctx, ref);
  }
  out(JSON.stringify({
    type: "rewind-done",
    entryId: ref.entryId,
    mode: opts.mode,
    changedFiles: result.changed ?? [],
    errors: result.errors ?? [],
    sessionRestored: opts.mode !== "code",
  }));
}
