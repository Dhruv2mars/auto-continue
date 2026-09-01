#!/usr/bin/env node
import { main } from "../core/cli.mjs";

const [eventArg, harnessArg] = process.argv.slice(2);
const harness =
  process.env.AUTO_CONTINUE_HARNESS ||
  harnessArg ||
  (process.env.ZCODE_SESSION_ID || process.env.ZCODE_PLUGIN_ID
    ? "zcode"
    : process.env.CODEX_SESSION_ID || process.env.CODEX_PLUGIN_ROOT
      ? "codex"
      : "claude");

main([harness, eventArg || "stop"]).then(() => process.exit(0)).catch(() => process.exit(0));
