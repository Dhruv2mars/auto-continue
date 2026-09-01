#!/usr/bin/env node
import { main } from "../core/cli.mjs";

const harness =
  process.env.AUTO_CONTINUE_HARNESS ||
  (process.env.ZCODE_PLUGIN_ROOT && !process.env.CLAUDE_PLUGIN_ROOT ? "zcode" : "claude");

const event = process.argv[2] || "stop";
main([harness, event]).then(() => process.exit(0)).catch(() => process.exit(0));
