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
try { event = JSON.parse(input); } catch {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

if (event.hook_event_name === "sessionStart") {
  console.log(JSON.stringify({
    env: {
      AUTO_CONTINUE_HARNESS: "cursor",
      AUTO_CONTINUE_SESSION: event.session_id,
    },
  }));
  process.exit(0);
}

const marker = "AUTO_CONTINUE_REQUEST\n";
const raw = event.prompt?.match(/^\s*\/auto-continue(?:\s+|$)([\s\S]*)$/i);
if (!event.prompt?.startsWith(marker) && !raw) {
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}

const prompt = (raw ? raw[1] : event.prompt.slice(marker.length)).trim();
if (!prompt) {
  console.log(JSON.stringify({ continue: false, user_message: "Usage: /auto-continue <prompt>" }));
  process.exit(0);
}

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const result = spawnSync(process.execPath, [join(root, "bin/ac.mjs"), "add", prompt], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AUTO_CONTINUE_HARNESS: "cursor",
  },
  encoding: "utf8",
});
const message = (result.stdout || result.stderr || "Unable to queue prompt").trim();
console.log(JSON.stringify({ continue: false, user_message: message }));
process.exit(result.status ?? 1);
