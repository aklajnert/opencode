#!/usr/bin/env bun

import path from "path"
import { parseArgs } from "util"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "test-autocompaction": { type: "boolean", default: false },
    hostname: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "4096" },
    "proxy-port": { type: "string", default: "8080" },
    "web-port": { type: "string", default: "8081" },
    dir: { type: "string" },
    opencode: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
})

if (values.help) {
  console.log(`
Usage: bun script/mitm-capture.ts [options]

Options:
  --test-autocompaction   start the auto-compaction probe (headless server mode)
  --hostname <host>       opencode server hostname  [default: 127.0.0.1]
  --port <port>           opencode server port      [default: 4096]
  --proxy-port <port>     mitm proxy port           [default: 8080]
  --web-port <port>       mitm web UI port          [default: 8081]
  --dir <path>            project directory         [default: cwd]
  --opencode <path>       path to opencode binary   [default: use bun run dev]
  --provider <id>         provider for probe        [default: github-copilot]
  --model <id>            model ID for probe        [default: provider default]
  -h, --help              show this help

Environment:
  OPENCODE_MITM_IMAGE     docker image  [default: mitmproxy/mitmproxy:latest]
  OPENCODE_MITM_INSECURE  set to 1 to disable TLS verification (fallback)

Output:
  logs/mitm/<timestamp>/flows.jsonl      one JSON record per request/response
  logs/mitm/<timestamp>/flows.mitm       binary mitmproxy dump (loadable in mitmweb)
  logs/mitm/<timestamp>/mitmproxy.log    mitmproxy container stdout
  logs/mitm/<timestamp>/opencode.log     opencode server log (--test-autocompaction mode)
  logs/mitm/<timestamp>/probe.log        auto-compaction probe log (--test-autocompaction mode)
`)
  process.exit(0)
}

const root = path.resolve(import.meta.dir, "..")
const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, -1)
const dir = path.join(root, "logs", "mitm", ts)
const cert = path.join(dir, "certs")
const name = `opencode-mitm-${ts}`
const img = process.env.OPENCODE_MITM_IMAGE ?? "mitmproxy/mitmproxy:latest"
const ca = path.join(cert, "mitmproxy-ca-cert.pem")
const host = values.hostname!
const srv = values.port!
const proxyPort = values["proxy-port"]!
const webPort = values["web-port"]!
const webToken = crypto.randomUUID().replace(/-/g, "")
const proj = values.dir ?? process.cwd()
const binary = values.opencode
const bunBin = process.execPath

function opencodeCmd(...args: string[]) {
  if (binary) return [binary, ...args]
  return [bunBin, "run", "dev", "--", ...args]
}

async function need(cmd: string) {
  const ok = await Bun.$`which ${cmd}`.quiet().nothrow()
  if (ok.exitCode !== 0) {
    console.error(`Missing required command: ${cmd}`)
    process.exit(1)
  }
}

await need("docker")

await Bun.$`mkdir -p ${dir} ${cert}`.quiet()

console.log(`Logs:    ${dir}`)
console.log(`Project: ${proj}`)

await Bun.$`docker run --rm -d \
  --name ${name} \
  -p ${proxyPort}:8080 \
  -p ${webPort}:8081 \
  -v ${cert}:/home/mitmproxy/.mitmproxy \
  -v ${dir}:/logs \
  ${img} \
  mitmweb \
  --listen-host 0.0.0.0 \
  --listen-port 8080 \
  --web-host 0.0.0.0 \
  --web-port 8081 \
  --set web_password=${webToken} \
  --set flow_detail=4 \
  --set termlog_verbosity=debug \
  -w /logs/flows.mitm`.quiet()

const dockerLog = Bun.spawn(["docker", "logs", "-f", name], {
  stdout: Bun.file(path.join(dir, "mitmproxy.log")),
  stderr: "pipe",
})

let caReady = false
for (let i = 0; i < 60; i++) {
  if (await Bun.file(ca).exists()) {
    caReady = true
    break
  }
  await Bun.sleep(1000)
}

if (!caReady) {
  console.error(`mitmproxy CA was not created: ${ca}`)
  await Bun.$`docker rm -f ${name}`.quiet().nothrow()
  process.exit(1)
}

await Bun.write(
  path.join(dir, "README.txt"),
  [
    "opencode mitm session",
    "",
    `proxy:   http://127.0.0.1:${proxyPort}`,
    `web:     http://127.0.0.1:${webPort}`,
    `server:  http://${host}:${srv}`,
    `project: ${proj}`,
    "",
    "files:",
    "  flows.jsonl          one JSON record per intercepted request/response",
    "  flows.mitm           binary mitmproxy dump (loadable in mitmweb)",
    "  mitmproxy.log        docker container stdout",
    "  opencode.log         opencode server log (--test-autocompaction mode)",
    "  probe.log            auto-compaction probe log (--test-autocompaction mode)",
    "  opencode.typescript  terminal capture (interactive mode, if 'script' exists)",
  ].join("\n") + "\n",
)

// Flow polling — replaces mitm-log.py; uses mitmweb REST API GET /flows
const flowsPath = path.join(dir, "flows.jsonl")
const seenReq = new Set<string>()
const seenRes = new Set<string>()
const records: string[] = []

function toHdrs(list: [string, string][]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of list) out[k.toLowerCase()] = v
  return out
}

function textBody(content: string | null | undefined, list: [string, string][]): string | null {
  if (!content) return null
  const ct = list.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? ""
  if (
    !ct.startsWith("text/") &&
    !ct.includes("json") &&
    !ct.includes("xml") &&
    !ct.includes("javascript") &&
    !ct.includes("x-www-form-urlencoded")
  )
    return null
  const text = Buffer.from(content, "base64").toString("utf8")
  return text.length > 4000 ? `${text.slice(0, 4000)}\n...[truncated]` : text
}

async function pollFlows() {
  const res = await fetch(`http://127.0.0.1:${webPort}/flows`, {
    headers: { Authorization: `Bearer ${webToken}` },
  }).catch(() => null)
  if (!res?.ok) return
  const flows = (await res.json()) as Array<{
    id: string
    timestamp_created: number
    request?: {
      method: string
      scheme: string
      host: string
      port: number
      path: string
      headers: [string, string][]
      content: string | null
    }
    response?: {
      status_code: number
      reason: string
      headers: [string, string][]
      content: string | null
      timestamp_end?: number
    } | null
  }>
  let changed = false
  for (const flow of flows) {
    const req = flow.request
    if (!req) continue
    const url = `${req.scheme}://${req.host}:${req.port}${req.path}`
    if (!seenReq.has(flow.id)) {
      seenReq.add(flow.id)
      records.push(
        JSON.stringify({
          kind: "request",
          id: flow.id,
          ts: flow.timestamp_created,
          method: req.method,
          scheme: req.scheme,
          host: req.host,
          port: req.port,
          path: req.path,
          url,
          headers: toHdrs(req.headers ?? []),
          body: textBody(req.content, req.headers ?? []),
        }),
      )
      changed = true
    }
    if (flow.response && !seenRes.has(flow.id)) {
      seenRes.add(flow.id)
      records.push(
        JSON.stringify({
          kind: "response",
          id: flow.id,
          ts: flow.response.timestamp_end,
          method: req.method,
          host: req.host,
          path: req.path,
          url,
          status: flow.response.status_code,
          reason: flow.response.reason,
          headers: toHdrs(flow.response.headers ?? []),
          body: textBody(flow.response.content, flow.response.headers ?? []),
        }),
      )
      changed = true
    }
  }
  if (changed) await Bun.write(flowsPath, records.join("\n") + "\n")
}

const flowPoller = setInterval(pollFlows, 2000)

let probeProc: ReturnType<typeof Bun.spawn> | undefined
let serverProc: ReturnType<typeof Bun.spawn> | undefined

async function cleanup() {
  clearInterval(flowPoller)
  await pollFlows()
  probeProc?.kill()
  serverProc?.kill()
  dockerLog.kill()
  await Bun.$`docker rm -f ${name}`.quiet().nothrow()
}

process.on("SIGINT", async () => {
  await cleanup()
  process.exit(0)
})
process.on("SIGTERM", async () => {
  await cleanup()
  process.exit(0)
})

const proxyEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  PATH: `${path.dirname(bunBin)}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
  HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
  HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
  http_proxy: `http://127.0.0.1:${proxyPort}`,
  https_proxy: `http://127.0.0.1:${proxyPort}`,
  NO_PROXY: process.env.NO_PROXY ?? "127.0.0.1,localhost,::1",
  no_proxy: process.env.NO_PROXY ?? "127.0.0.1,localhost,::1",
  NODE_EXTRA_CA_CERTS: ca,
  SSL_CERT_FILE: ca,
  OPENCODE_MITM_DIR: dir,
}

if (process.env.OPENCODE_MITM_INSECURE === "1") {
  proxyEnv.NODE_TLS_REJECT_UNAUTHORIZED = "0"
}

console.log(`mitm web UI:   http://127.0.0.1:${webPort}`)
console.log(`CA cert:       ${ca}`)
console.log(`flows.jsonl:   ${path.join(dir, "flows.jsonl")}`)

if (values["test-autocompaction"]) {
  const opencodelog = path.join(dir, "opencode.log")
  const probelog = path.join(dir, "probe.log")
  console.log(`Server log:    ${opencodelog}`)
  console.log(`Probe log:     ${probelog}`)

  serverProc = Bun.spawn(
    opencodeCmd("serve", "--hostname", host, "--port", srv, "--print-logs", "--log-level", "DEBUG"),
    {
      cwd: root,
      env: proxyEnv,
      stdout: Bun.file(opencodelog),
      stderr: Bun.file(opencodelog),
    },
  )

  const probeArgs = [bunBin, "./script/trigger-autocompact.ts", "--base-url", `http://${host}:${srv}`]
  if (values.provider) probeArgs.push("--provider", values.provider)
  probeArgs.push("--model", values.model ?? "gpt-4o")
  probeProc = Bun.spawn(probeArgs, {
    cwd: root,
    env: { ...proxyEnv, OPENCODE_MITM_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  })

  // Tee probe output to both the log file and the terminal so failures are visible
  const probeLog = Bun.file(probelog).writer()
  async function tee(stream: ReadableStream<Uint8Array> | null, tag: "stdout" | "stderr") {
    if (!stream) return
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      probeLog.write(value)
      process[tag].write(value)
    }
  }
  tee(probeProc.stdout, "stdout")
  tee(probeProc.stderr, "stderr")

  console.log(`Auto-compaction probe started (PID ${probeProc.pid})`)
  console.log(`Server log:    tail -f ${opencodelog}`)
  console.log("Waiting for probe to complete...")

  const code = await probeProc.exited
  await probeLog.end()
  await cleanup()
  process.exit(code)
}

console.log(`\nStarting opencode in interactive mode. Press Ctrl+C to stop.\n`)

const hasScript = await Bun.$`which script`
  .quiet()
  .nothrow()
  .then((r) => r.exitCode === 0)

const cmd = opencodeCmd(proj, "--hostname", host, "--port", srv, "--print-logs", "--log-level", "DEBUG")

if (hasScript) {
  const transcript = path.join(dir, "opencode.typescript")
  await Bun.$`script -qefc ${cmd.join(" ")} ${transcript}`.env(proxyEnv).cwd(root).nothrow()
} else {
  console.log('"script" command not found, logging to opencode.log instead.')
  serverProc = Bun.spawn(cmd, {
    cwd: root,
    env: proxyEnv,
    stdout: "inherit",
    stderr: "inherit",
  })
  await serverProc.exited
}

await cleanup()
