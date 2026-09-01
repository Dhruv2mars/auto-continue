import { chmod, mkdir, readFile, writeFile, readdir, stat, rename, appendFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export function homeDir() {
  return process.env.AUTO_CONTINUE_HOME || join(homedir(), ".auto-continue");
}

export function sessionKey(sessionId) {
  return String(sessionId || "default").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function statePath(sessionId) {
  return join(homeDir(), "state", `${sessionKey(sessionId)}.json`);
}

export async function loadState(sessionId) {
  try {
    const raw = await readFile(statePath(sessionId), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.continues !== "number") throw new Error("bad state");
    return { ...parsed, continues: parsed.continues ?? 0, updatedAt: parsed.updatedAt ?? 0 };
  } catch {
    return { continues: 0, updatedAt: 0 };
  }
}

export async function saveState(sessionId, state) {
  const path = statePath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  await chmod(dirname(path), 0o700).catch(() => {});
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }));
  await rename(tmp, path);
  return path;
}

export async function appendLog(entry) {
  const path = join(homeDir(), "log.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await chmod(dirname(path), 0o700).catch(() => {});
  await appendFile(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

export async function pruneStates(maxAgeMs = 7 * 24 * 3600 * 1000) {
  const dir = join(homeDir(), "state");
  let removed = 0;
  try {
    const files = await readdir(dir);
    const now = Date.now();
    for (const f of files) {
      const p = join(dir, f);
      const s = await stat(p);
      if (now - s.mtimeMs > maxAgeMs) {
        await unlink(p);
        removed++;
      }
    }
  } catch {}
  return removed;
}
