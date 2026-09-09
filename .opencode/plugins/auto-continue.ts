/**
 * OpenCode adapter for auto-continue.
 *
 * OpenCode's V1 plugin hook is the one place that sees the current session ID
 * before a slash command is submitted.  The command is handled locally here;
 * it must not become another model turn after the account has hit its limit.
 */
import { spawn } from "node:child_process"

const COMMAND = "auto-continue"

function runQueue({ directory, sessionID, prompt }) {
  return new Promise((resolveResult) => {
    const env = {
      ...process.env,
      AC_HARNESS: "opencode",
      AC_SESSION: sessionID,
      AUTO_CONTINUE_HARNESS: "opencode",
      AUTO_CONTINUE_SESSION: sessionID,
    }
    // `bun link` installs ac on PATH, so this also works when the plugin is
    // copied to OpenCode's global plugin directory.
    const child = spawn(process.env.AUTO_CONTINUE_AC || "ac", ["add", prompt], {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", (error) => resolveResult({ ok: false, text: error.message }))
    child.on("close", (code) => {
      const text = (code === 0 ? stdout : stderr || stdout).trim()
      resolveResult({ ok: code === 0, text: text || `ac exited with code ${code}` })
    })
  })
}

export const AutoContinue = async ({ client, directory }) => ({
  config: async (config) => {
    config.command ??= {}
    config.command[COMMAND] ??= {
      template: "$ARGUMENTS",
      description: "Queue a prompt for this OpenCode session and send it after the limit resets",
    }
  },

  "command.execute.before": async (input, output) => {
    if (input.command !== COMMAND) return

    const prompt = input.arguments.trim()
    if (!prompt) {
      output.parts = [{ type: "text", text: "Usage: /auto-continue <prompt>" }]
      throw new Error("Usage: /auto-continue <prompt>")
    }

    const result = await runQueue({ directory, sessionID: input.sessionID, prompt })
    const message = result.ok ? result.text : `auto-continue: ${result.text}`
    output.parts = [{ type: "text", text: message }]

    // V1 has no noReply/cancelled field. Throwing is the documented practical
    // short-circuit: it stops SessionPrompt.command() before it calls the LLM.
    // The TUI may log the sentinel as a command error on OpenCode >= 1.17.5;
    // the toast below keeps the normal path visible to the user.
    try {
      await client.tui.showToast({
        body: {
          message,
          variant: result.ok ? "success" : "error",
          duration: 6000,
        },
        query: { directory },
      })
    } catch {
      // Headless `opencode run` has no TUI consumer. The hook still handled it.
    }
    throw new Error(message)
  },
})
