#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const input = await new Promise((resolve) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { text += chunk; });
  process.stdin.on("end", () => resolve(text));
});

let event;
try { event = JSON.parse(input); } catch { process.exit(0); }

const match = event.prompt?.match(/^\s*(?:\/|\$)auto-continue(?:\s+|$)([\s\S]*)$/i);
if (!match) process.exit(0);

const prompt = match[1].trim();
if (!prompt) {
  console.error("Usage: /auto-continue <prompt>");
  process.exit(2);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync(process.execPath, [join(root, "bin/ac.mjs"), "add", prompt], {
  cwd: event.cwd || process.cwd(),
  env: {
    ...process.env,
    AUTO_CONTINUE_HARNESS: "codex",
    AUTO_CONTINUE_SESSION: event.session_id || "",
  },
  encoding: "utf8",
});
const message = (result.stdout || result.stderr || "Unable to queue prompt").trim();
console.error(message);
process.exit(result.status === 0 ? 2 : 1);
