import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoContinue } from "../.opencode/plugins/auto-continue.ts"

let home

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "auto-continue-opencode-"))
  process.env.AUTO_CONTINUE_HOME = home
  process.env.AC_PAD_SEC = "0"
  process.env.AC_SEND_OPENCODE = "exit 0"
})

afterEach(() => {
  delete process.env.AUTO_CONTINUE_HOME
  delete process.env.AC_PAD_SEC
  delete process.env.AC_SEND_OPENCODE
  rmSync(home, { recursive: true, force: true })
})

test("registers a slash command without overwriting user config", async () => {
  const hooks = await AutoContinue({
    directory: process.cwd(),
    client: { tui: { showToast: async () => {} } },
  })
  const config = { command: { review: { template: "review" } } }
  await hooks.config(config)
  expect(config.command.review.template).toBe("review")
  expect(config.command["auto-continue"].template).toBe("$ARGUMENTS")
})

test("queues the exact OpenCode session and short-circuits the model turn", async () => {
  const toasts = []
  const hooks = await AutoContinue({
    directory: process.cwd(),
    client: { tui: { showToast: async ({ body }) => toasts.push(body) } },
  })
  const output = { parts: [{ type: "text", text: "template" }] }
  await expect(hooks["command.execute.before"]({
    command: "auto-continue",
    sessionID: "ses_exact_123",
    arguments: "keep $PATH and `quotes` intact",
  }, output)).rejects.toThrow("sending now to opencode")

  const queue = JSON.parse(readFileSync(join(home, "queue.json"), "utf8"))
  expect(queue).toHaveLength(1)
  expect(queue[0].harness).toBe("opencode")
  expect(queue[0].session).toBe("ses_exact_123")
  expect(queue[0].prompt).toBe("keep $PATH and `quotes` intact")
  expect(output.parts[0].text).toContain("sending now to opencode")
  expect(toasts[0].variant).toBe("success")
})

test("empty command is handled locally", async () => {
  const hooks = await AutoContinue({
    directory: process.cwd(),
    client: { tui: { showToast: async () => {} } },
  })
  await expect(hooks["command.execute.before"]({
    command: "auto-continue",
    sessionID: "ses_exact_123",
    arguments: "   ",
  }, { parts: [] })).rejects.toThrow("Usage: /auto-continue <prompt>")
})
