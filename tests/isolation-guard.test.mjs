/**
 * Isolation guard: no test or sim may touch the real ~/.auto-continue.
 * Snaps the real home's mtime at module load and asserts it unchanged at
 * process exit. Any leak (a spawned hook child with a missing env var, a
 * stray watcher) bumps a child mtime inside ~/.auto-continue and fails here.
 */
import { afterAll, beforeAll } from "bun:test";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";

const realHome = join(homedir(), ".auto-continue");

function snapshot() {
  const out = { root: null, entries: new Map() };
  try {
    out.root = statSync(realHome).mtimeMs;
    for (const dir of ["state", "queue"]) {
      try {
        for (const f of readdirSync(join(realHome, dir))) {
          if (f.includes(".tmp")) continue;
          out.entries.set(`${dir}/${f}`, statSync(join(realHome, dir, f)).mtimeMs);
        }
      } catch {}
    }
  } catch {}
  return out;
}

let before;

beforeAll(() => {
  before = snapshot();
});

afterAll(() => {
  if (!before) return;
  const after = snapshot();
  const changed = [];
  if (after.root !== before.root) changed.push(`~/.auto-continue mtime ${before.root} -> ${after.root}`);
  for (const [f, m] of after.entries) {
    if (!before.entries.has(f)) changed.push(`~/.auto-continue/${f} created`);
    else if (before.entries.get(f) !== m) changed.push(`~/.auto-continue/${f} modified`);
  }
  if (changed.length) {
    throw new Error(
      `ISOLATION VIOLATION — tests touched the real ~/.auto-continue:\n  ${changed.slice(0, 10).join("\n  ")}`,
    );
  }
});
