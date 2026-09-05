import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  ackDraining,
  clear,
  drainHead,
  enqueue,
  list,
  peekHead,
  restoreDraining,
  MAX_PROMPT_LEN,
} from "../core/lib/queue.mjs";

let home;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ac-queue-"));
  process.env.AUTO_CONTINUE_HOME = home;
});

afterEach(() => {
  delete process.env.AUTO_CONTINUE_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("queue FIFO", () => {
  test("enqueue/list preserves order", async () => {
    await enqueue("s1", "first");
    await enqueue("s1", "second");
    await enqueue("s1", "third");
    const items = await list("s1");
    expect(items.map((i) => i.prompt)).toEqual(["first", "second", "third"]);
    expect(typeof items[0].queuedAt).toBe("number");
  });

  test("peekHead returns head without removing", async () => {
    await enqueue("s1", "a");
    await enqueue("s1", "b");
    const head = await peekHead("s1");
    expect(head.prompt).toBe("a");
    expect((await list("s1")).length).toBe(2);
  });

  test("peekHead on empty returns null", async () => {
    expect(await peekHead("nope")).toBeNull();
  });

  test("clear empties and returns count", async () => {
    await enqueue("s1", "a");
    await enqueue("s1", "b");
    expect(await clear("s1")).toBe(2);
    expect(await list("s1")).toEqual([]);
    expect(await clear("s1")).toBe(0);
  });
});

describe("drain lifecycle", () => {
  test("drainHead moves head to .draining", async () => {
    await enqueue("s1", "a");
    await enqueue("s1", "b");
    const head = await drainHead("s1");
    expect(head.prompt).toBe("a");
    expect((await list("s1")).map((i) => i.prompt)).toEqual(["b"]);
    const draining = JSON.parse(
      await readFile(join(home, "queue", "s1.draining"), "utf8"),
    );
    expect(draining.prompt).toBe("a");
  });

  test("drainHead on empty returns null", async () => {
    expect(await drainHead("empty")).toBeNull();
  });

  test("restoreDraining prepends back to head", async () => {
    await enqueue("s1", "a");
    await enqueue("s1", "b");
    const head = await drainHead("s1");
    const restored = await restoreDraining("s1");
    expect(restored.prompt).toBe(head.prompt);
    expect((await list("s1")).map((i) => i.prompt)).toEqual(["a", "b"]);
  });

  test("ackDraining deletes pending item", async () => {
    await enqueue("s1", "a");
    await enqueue("s1", "b");
    const head = await drainHead("s1");
    const acked = await ackDraining("s1");
    expect(acked.prompt).toBe(head.prompt);
    expect((await list("s1")).map((i) => i.prompt)).toEqual(["b"]);
    // Second ack is a no-op
    expect(await ackDraining("s1")).toBeNull();
  });

  test("drainHead refuses while .draining pending", async () => {
    await enqueue("s1", "a");
    await enqueue("s1", "b");
    await drainHead("s1");
    await expect(drainHead("s1")).rejects.toThrow();
  });

  test("crash-restore converges (draining + full queue dedupes)", async () => {
    const item = await enqueue("s1", "a");
    // Simulate crash between draining-write and queue-write: .draining
    // exists but head was never removed from the queue file.
    await writeFile(join(home, "queue", "s1.draining"), JSON.stringify(item));
    const restored = await restoreDraining("s1");
    expect(restored.prompt).toBe("a");
    expect((await list("s1")).map((i) => i.prompt)).toEqual(["a"]);
  });

  test("crash leftover stray .draining (queue already advanced) restores sanely", async () => {
    await enqueue("s1", "a");
    const head = await drainHead("s1");
    // Only way to reach here: queue advanced, .draining remains. Restore puts it back.
    const restored = await restoreDraining("s1");
    expect(restored.prompt).toBe(head.prompt);
    expect((await list("s1")).map((i) => i.prompt)).toEqual(["a"]);
  });

  test("draining-first order: .draining holds head while queue holds rest", async () => {
    await enqueue("s1", "a");
    await enqueue("s1", "b");
    await enqueue("s1", "c");
    const head = await drainHead("s1");
    expect(head.prompt).toBe("a");
    const draining = JSON.parse(
      await readFile(join(home, "queue", "s1.draining"), "utf8"),
    );
    expect(draining.prompt).toBe("a");
    expect(draining.queuedAt).toBe(head.queuedAt);
    // Queue no longer holds the drained head.
    expect((await list("s1")).map((i) => i.prompt)).toEqual(["b", "c"]);
    // Crash between draining-write and queue-rewrite = duplicate, and
    // restore dedupes back to the full queue.
    const full = [head, ...(await list("s1"))];
    await writeFile(join(home, "queue", "s1.json"), JSON.stringify(full));
    const restored = await restoreDraining("s1");
    expect(restored.prompt).toBe("a");
    expect((await list("s1")).map((i) => i.prompt)).toEqual(["a", "b", "c"]);
  });

  test("corrupt .draining recovers: drainHead proceeds, restore/ack return null", async () => {
    await enqueue("s1", "a");
    await enqueue("s1", "b");
    await writeFile(join(home, "queue", "s1.draining"), "{not json");
    // restore/ack treat corrupt draining as absent and clean it up.
    expect(await restoreDraining("s1")).toBeNull();
    await writeFile(join(home, "queue", "s1.draining"), "{not json");
    expect(await ackDraining("s1")).toBeNull();
    // drainHead unlinks the corrupt file and drains normally.
    await writeFile(join(home, "queue", "s1.draining"), "[1,2,");
    const head = await drainHead("s1");
    expect(head.prompt).toBe("a");
    expect((await list("s1")).map((i) => i.prompt)).toEqual(["b"]);
  });

  test("corrupt queue quarantined aside, enqueue writes fresh", async () => {
    await enqueue("s1", "a");
    await writeFile(join(home, "queue", "s1.json"), "{corrupt!!!");
    expect(await list("s1")).toEqual([]);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(home, "queue"));
    expect(files.some((f) => f.startsWith("s1.json.corrupt-"))).toBe(true);
    // Enqueue after corruption writes a fresh queue (no silent merge).
    const item = await enqueue("s1", "fresh");
    expect(item.prompt).toBe("fresh");
    expect((await list("s1")).map((i) => i.prompt)).toEqual(["fresh"]);
  });

  test("restore dedupes only head match: distinct same-ms duplicates survive", async () => {
    const first = await enqueue("s1", "same");
    // Second distinct enqueue stamped with the same ms.
    const items = JSON.parse(
      await readFile(join(home, "queue", "s1.json"), "utf8"),
    );
    items.push({ prompt: "same", queuedAt: first.queuedAt });
    await writeFile(join(home, "queue", "s1.json"), JSON.stringify(items));
    const head = await drainHead("s1");
    expect(head.prompt).toBe("same");
    // Simulate crash: draining written, queue rewrite lost -> full queue still
    // holds both copies. Restore must dedupe one, keeping the other.
    const full = [head, ...(await list("s1"))];
    await writeFile(join(home, "queue", "s1.json"), JSON.stringify(full));
    await writeFile(join(home, "queue", "s1.draining"), JSON.stringify(head));
    const restored = await restoreDraining("s1");
    expect(restored.prompt).toBe("same");
    const after = await list("s1");
    expect(after).toHaveLength(2);
    expect(after.map((i) => i.prompt)).toEqual(["same", "same"]);
  });

  test("clear counts draining item too", async () => {
    await enqueue("s1", "a");
    await enqueue("s1", "b");
    await drainHead("s1");
    expect(await clear("s1")).toBe(2);
    expect(await list("s1")).toEqual([]);
  });
});

describe("validation", () => {
  test("empty/whitespace prompt rejected", async () => {
    await expect(enqueue("s1", "")).rejects.toThrow();
    await expect(enqueue("s1", "   \n\t ")).rejects.toThrow();
    expect(await list("s1")).toEqual([]);
  });

  test("overlong prompt rejected", async () => {
    await expect(enqueue("s1", "x".repeat(MAX_PROMPT_LEN + 1))).rejects.toThrow();
    expect(await list("s1")).toEqual([]);
  });

  test("max-length prompt accepted", async () => {
    await enqueue("s1", "x".repeat(MAX_PROMPT_LEN));
    expect((await list("s1")).length).toBe(1);
  });

  test("hostile session id sanitized", async () => {
    await enqueue("../../etc/evil!", "hi");
    expect(await list("../../etc/evil!")).toHaveLength(1);
    expect(await list(".._.._etc_evil_")).toHaveLength(1);
  });
});
