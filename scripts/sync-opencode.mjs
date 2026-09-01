#!/usr/bin/env bun
/**
 * Prepare adapters/opencode for npm publish by vendoring core/ into the package.
 * Run before `npm publish` from adapters/opencode. core/ is gitignored there.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "adapters", "opencode", "core");
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(join(root, "core", "lib"), dest, { recursive: true });
console.log("vendored core ->", dest);
