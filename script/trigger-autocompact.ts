import fs from "node:fs/promises"
import path from "node:path"

function arg(key: string) {
  const list = process.argv.slice(2)
  const i = list.indexOf(key)
  if (i === -1) return
  return list[i + 1]
}

function num(key: string, fallback: number) {
  const value = arg(key)
  if (!value) return fallback
  const next = Number.parseInt(value, 10)
  return Number.isFinite(next) ? next : fallback
}

function auth(): Record<string, string> {
  const pass = process.env.OPENCODE_SERVER_PASSWORD
  if (!pass) return {}
  const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
  }
}

function url(base: string, route: string, dir?: string) {
  const next = new URL(route, base)
  if (dir) next.searchParams.set("directory", dir)
  return next
}

async function api(base: string, route: string, init: RequestInit = {}, dir?: string) {
  const hdrs: Record<string, string> = {
    ...auth(),
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  }
  const res = await fetch(url(base, route, dir), { ...init, headers: hdrs })
  if (res.ok) return res
  throw new Error(`${init.method ?? "GET"} ${route} failed: ${res.status} ${await res.text()}`)
}

async function wait(base: string, timeout: number) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const ok = await fetch(new URL("/global/health", base), { headers: auth() })
      .then((res) => res.ok)
      .catch(() => false)
    if (ok) return
    await Bun.sleep(500)
  }
  throw new Error(`Timed out waiting for ${base}`)
}

async function main() {
  const base = arg("--base-url") ?? process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096"
  const timeout = num("--timeout", 180_000)
  const need = num("--usable", 1024)
  const picked = arg("--provider") ?? process.env.OPENCODE_AUTOCOMPACT_PROVIDER ?? "github-copilot"
  const chosen = arg("--model") ?? process.env.OPENCODE_AUTOCOMPACT_MODEL
  const root = path.resolve(import.meta.dir, "..")
  const logs = process.env.OPENCODE_MITM_DIR
    ? path.join(process.env.OPENCODE_MITM_DIR, "probe")
    : path.join(root, "logs", "autocompact")
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  const dir = arg("--dir") ?? path.join(logs, stamp, "project")

  await fs.mkdir(dir, { recursive: true })
  await wait(base, timeout)

  // fetch providers without priming per-directory config cache
  const providers = (await api(base, "/provider").then((res) => res.json())) as {
    all: Array<{
      id: string
      models: Record<string, { id: string; limit: { context: number; input?: number; output: number } }>
    }>
    default: Record<string, string>
  }
  const info = providers.all.find((item) => item.id === picked)
  if (!info) {
    throw new Error(`Provider not found: ${picked}`)
  }

  const model = chosen ?? "gpt-4o"

  const cfg = info.models[model]
  if (!cfg) {
    throw new Error(`Model not found: ${picked}/${model}`)
  }

  const limit = cfg.limit.input ?? cfg.limit.context
  const reserved = limit > need ? limit - need : 0
  await Bun.write(
    path.join(dir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        compaction: {
          auto: true,
          prune: false,
          reserved,
        },
      },
      null,
      2,
    ),
  )

  const title = `mitm auto compaction ${stamp}`
  const session = (await api(
    base,
    "/session",
    {
      method: "POST",
      body: JSON.stringify({ title }),
    },
    dir,
  ).then((res) => res.json())) as { id: string }
  const size = num("--size", Math.max(need * 4, 4000))
  const text = [
    "Auto compaction probe.",
    "Reply with a very short acknowledgement.",
    "",
    "payload:",
    "token ".repeat(size),
  ].join("\n")

  console.log(`base=${base}`)
  console.log(`dir=${dir}`)
  console.log(`provider=${picked}`)
  console.log(`model=${model}`)
  console.log(`limit=${limit}`)
  console.log(`reserved=${reserved}`)
  console.log(`session=${session.id}`)

  await api(
    base,
    `/session/${session.id}/prompt_async`,
    {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: {
          providerID: picked,
          modelID: model,
        },
        parts: [
          {
            type: "text",
            text,
          },
        ],
      }),
    },
    dir,
  ).then((r) => r.body?.cancel())

  const end = Date.now() + timeout
  while (Date.now() < end) {
    const list = (await api(base, `/session/${session.id}/message?limit=200`, {}, dir).then((res) =>
      res.json(),
    )) as Array<{
      info: {
        id: string
        role: "user" | "assistant"
        parentID?: string
        summary?: boolean
        error?: unknown
      }
      parts: Array<{
        type: string
        auto?: boolean
        text?: string
        synthetic?: boolean
      }>
    }>

    const compact = list.find(
      (msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction" && part.auto === true),
    )
    const summary = list.find((msg) => msg.info.role === "assistant" && msg.info.summary)
    const follow = list.find(
      (msg) => msg.info.role === "user" && msg.parts.length > 0 && msg.parts.every((part) => part.synthetic === true),
    )
    const next = follow
      ? list.find((msg) => msg.info.role === "assistant" && msg.info.parentID === follow.info.id)
      : undefined
    const fail = list.find((msg) => msg.info.role === "assistant" && msg.info.error)

    console.log(
      JSON.stringify({
        messages: list.length,
        compact: !!compact,
        summary: !!summary,
        follow: !!follow,
        next: !!next,
        fail: !!fail,
      }),
    )

    if (compact && summary && follow && next) {
      console.log("auto compaction triggered")
      return
    }

    await Bun.sleep(1000)
  }

  throw new Error(`Timed out waiting for auto compaction in session ${session.id}`)
}

await main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err)
  process.exit(1)
})
process.exit(0)
