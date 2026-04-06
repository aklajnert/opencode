import { describe, expect, mock, test } from "bun:test"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { CopilotAuthPlugin } from "../../src/plugin/github-copilot/copilot"

type ChatInput = Parameters<NonNullable<Hooks["chat.headers"]>>[0]
type ChatOutput = Parameters<NonNullable<Hooks["chat.headers"]>>[1]

function model() {
  return {
    providerID: "github-copilot",
    api: {
      npm: "@ai-sdk/github-copilot",
    },
  } as ChatInput["model"]
}

function incoming(input?: Partial<ChatInput>): ChatInput {
  return {
    sessionID: "session",
    agent: "build",
    model: model(),
    provider: {} as ChatInput["provider"],
    message: {
      id: "message",
      sessionID: "session",
    } as ChatInput["message"],
    ...input,
  }
}

async function plugin(input?: { message?: () => Promise<unknown>; session?: () => Promise<unknown> }) {
  const client = {
    session: {
      message: mock(input?.message ?? (() => Promise.resolve({ data: { parts: [] } }))),
      get: mock(input?.session ?? (() => Promise.resolve({ data: {} }))),
    },
  }

  const hooks = await CopilotAuthPlugin({
    client: client as unknown as PluginInput["client"],
    directory: "/tmp",
    project: {} as PluginInput["project"],
    worktree: "/tmp",
    serverUrl: new URL("http://localhost:4096"),
    $: Bun.$,
  })

  return { hooks, client }
}

describe("plugin.github-copilot", () => {
  test("marks compaction agent requests as agent initiated", async () => {
    const { hooks, client } = await plugin({
      message: () => Promise.reject(new Error("should not fetch message")),
    })
    const output: ChatOutput = { headers: {} }

    await hooks["chat.headers"]?.(
      incoming({
        agent: "compaction",
      }),
      output,
    )

    expect(output.headers["x-initiator"]).toBe("agent")
    expect(client.session.message).not.toHaveBeenCalled()
    expect(client.session.get).not.toHaveBeenCalled()
  })

  test("marks synthetic-only follow-up messages as agent initiated", async () => {
    const { hooks } = await plugin({
      message: () =>
        Promise.resolve({
          data: {
            parts: [{ type: "text", synthetic: true }],
          },
        }),
    })
    const output: ChatOutput = { headers: {} }

    await hooks["chat.headers"]?.(incoming(), output)

    expect(output.headers["x-initiator"]).toBe("agent")
  })

  test("marks auto-compaction marker messages as agent initiated", async () => {
    const { hooks } = await plugin({
      message: () =>
        Promise.resolve({
          data: {
            parts: [
              {
                type: "text",
                text: "[auto-compaction-followup]",
                synthetic: true,
              },
              {
                type: "text",
                text: "Continue if you have next steps",
                synthetic: true,
              },
            ],
          },
        }),
    })
    const output: ChatOutput = { headers: {} }

    await hooks["chat.headers"]?.(incoming(), output)

    expect(output.headers["x-initiator"]).toBe("agent")
  })

  test("does not override normal top-level user messages", async () => {
    const { hooks } = await plugin({
      message: () =>
        Promise.resolve({
          data: {
            parts: [{ type: "text", text: "hello" }],
          },
        }),
      session: () => Promise.resolve({ data: {} }),
    })
    const output: ChatOutput = { headers: {} }

    await hooks["chat.headers"]?.(incoming(), output)

    expect(output.headers["x-initiator"]).toBeUndefined()
  })
})
