#!/usr/bin/env node
import { main } from "../core/cli.mjs";
import { detectHarness } from "../core/lib/harness.mjs";

const [eventArg, harnessArg] = process.argv.slice(2);
const harness =
  process.env.AUTO_CONTINUE_HARNESS || harnessArg || detectHarness();

main([harness, eventArg || "stop"]).then(() => process.exit(0)).catch(() => process.exit(0));
