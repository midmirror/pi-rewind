import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffLines } from "diff";
import { SnapshotEngine } from "./src/snapshot.js";

const cwd = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
const backupDir = join(cwd, ".backups");
const a = join(cwd, "src/a.ts");
const deleted = join(cwd, "src/old.ts");
await mkdir(join(cwd, "src"), { recursive: true });
await writeFile(a, "line1\nline2\nline3\n");
await writeFile(deleted, "gone\n");
const engine = new SnapshotEngine({ backupDir, cwd });
engine.hydrate([{ referencedMessageId: "m1", seq: 1, timestamp: 1, files: {} }]);
await engine.trackEdit(a);
await engine.trackEdit(deleted);
const m1 = await engine.makeSnapshot("m1");

console.log("m1.files:", JSON.stringify(m1.files, null, 2));

await writeFile(a, "line1\nline2-changed\nline3\nline4\n");
await rm(deleted);

const stats = await engine.diffStats(m1);
console.log("stats:", stats);

const aBak = m1.files["src/a.ts"]?.backup;
const delBak = m1.files["src/old.ts"]?.backup;
console.log("aBak:", aBak);
console.log("delBak:", delBak);

if (aBak) {
  const aBakContent = await readFile(join(backupDir, aBak), "utf-8");
  const d = diffLines(aBakContent, "line1\nline2-changed\nline3\nline4\n");
  console.log("a diff:", d);
}

if (delBak) {
  const delBakContent = await readFile(join(backupDir, delBak), "utf-8");
  console.log("delBakContent:", delBakContent);
}

await rm(cwd, { recursive: true, force: true });
