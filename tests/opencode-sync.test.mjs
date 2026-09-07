/**
 * Vendored-artifact drift guard: adapters/opencode/core/ is a sync-on-publish
 * copy of core/lib (gitignored, so a stale working-tree copy silently ships
 * to users following the README install path). Prove the vendored files are
 * byte-identical to core/lib.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "core", "lib");
const dst = join(root, "adapters", "opencode", "core");

describe("vendored opencode core matches core/lib", () => {
  test("every core/lib file is byte-identical in the vendored copy", () => {
    for (const f of readdirSync(src)) {
      if (!statSync(join(src, f)).isFile()) continue;
      const a = readFileSync(join(src, f), "utf8");
      let b = null;
      try {
        b = readFileSync(join(dst, f), "utf8");
      } catch {}
      expect(b, `adapters/opencode/core/${f} missing — run bun run sync-opencode`).toBe(a);
    }
  });
});
