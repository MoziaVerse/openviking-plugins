import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

type RuntimeConfig = {
  endpoint: string
  apiKey: string
  account?: string
  user?: string
  peerId?: string
}

type OpenVikingResponse<T = unknown> = {
  status: string
  result?: T
  error?: string | { message?: string; code?: string }
}

function readJsonFile(filePath: string | undefined): Record<string, any> {
  if (!filePath) return {}
  try {
    if (!fs.existsSync(filePath)) return {}
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return {}
  }
}

function loadRuntimeConfig(): RuntimeConfig {
  const cliConfigPath =
    process.env.OPENVIKING_CLI_CONFIG_FILE ||
    path.join(os.homedir(), ".openviking", "ovcli.conf")
  const cliConfig = readJsonFile(cliConfigPath)

  const endpoint =
    process.env.OPENVIKING_URL ||
    process.env.OPENVIKING_BASE_URL ||
    cliConfig.url ||
    cliConfig.endpoint ||
    cliConfig.base_url ||
    ""
  const apiKey =
    process.env.OPENVIKING_API_KEY ||
    process.env.OPENVIKING_BEARER_TOKEN ||
    cliConfig.api_key ||
    cliConfig.apiKey ||
    cliConfig.key ||
    ""

  const config: RuntimeConfig = {
    endpoint: String(endpoint).replace(/\/+$/, ""),
    apiKey: String(apiKey),
    account: process.env.OPENVIKING_ACCOUNT || cliConfig.account,
    user: process.env.OPENVIKING_USER || cliConfig.user,
    peerId: process.env.OPENVIKING_PEER_ID || cliConfig.peer_id || cliConfig.peerId,
  }

  assert.ok(config.endpoint, "OPENVIKING_URL or OPENVIKING_CLI_CONFIG_FILE.url is required")
  assert.ok(config.apiKey, "OPENVIKING_API_KEY or OPENVIKING_CLI_CONFIG_FILE.api_key is required")
  return config
}

function safeSessionId(value: string): string {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_")
}

function deriveOpenVikingSessionId(opencodeSessionId: string): string {
  return `oc-${safeSessionId(opencodeSessionId)}`
}

function buildHeaders(config: RuntimeConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    "X-API-Key": config.apiKey,
  }
  if (config.account) headers["X-OpenViking-Account"] = config.account
  if (config.user) headers["X-OpenViking-User"] = config.user
  if (config.peerId) headers["X-OpenViking-Actor-Peer"] = config.peerId
  return headers
}

function unwrap<T>(response: OpenVikingResponse<T>): T {
  if (response.status !== "ok") {
    const error = typeof response.error === "string" ? response.error : response.error?.message || response.error?.code
    throw new Error(error || "OpenViking request failed")
  }
  return response.result as T
}

async function healthCheck(config: RuntimeConfig): Promise<void> {
  const response = await fetch(`${config.endpoint}/health`, {
    method: "GET",
    headers: buildHeaders(config),
    signal: AbortSignal.timeout(5000),
  })
  assert.ok(response.ok, `OpenViking health check failed: ${response.status}`)
}

async function requestJson<T>(
  config: RuntimeConfig,
  method: "GET" | "POST",
  endpoint: string,
  body?: unknown,
  timeoutMs = 30000,
): Promise<T> {
  const response = await fetch(`${config.endpoint}${endpoint}`, {
    method,
    headers: buildHeaders(config),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) {
    const error = data?.error?.message || data?.error || text
    throw new Error(`OpenViking ${method} ${endpoint} failed (${response.status}): ${error}`)
  }
  return unwrap<T>(data)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForCommittedSession(config: RuntimeConfig, sessionId: string): Promise<any> {
  const startedAt = Date.now()
  let latest: any = null
  while (Date.now() - startedAt < 90000) {
    latest = await requestJson<any>(
      config,
      "GET",
      `/api/v1/sessions/${encodeURIComponent(sessionId)}?auto_create=false`,
    )
    if ((latest.commit_count ?? 0) >= 1) return latest
    await sleep(3000)
  }
  return latest
}

const runtimeConfig = loadRuntimeConfig()
const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ov-opencode-real-"))

process.env.OPENVIKING_URL = runtimeConfig.endpoint
process.env.OPENVIKING_API_KEY = runtimeConfig.apiKey
if (runtimeConfig.account) process.env.OPENVIKING_ACCOUNT = runtimeConfig.account
if (runtimeConfig.user) process.env.OPENVIKING_USER = runtimeConfig.user
if (runtimeConfig.peerId) process.env.OPENVIKING_PEER_ID = runtimeConfig.peerId
process.env.OPENVIKING_OPENCODE_STATE_DIR = stateDir

const marker = `ov-real-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const sessionID = `real-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const ovSessionId = deriveOpenVikingSessionId(sessionID)

const userMessage =
  `请记住这个安全测试偏好：OpenCode Docker real smoke marker 是 ${marker}。` +
  "这是用于验证 OpenCode 插件在 Docker 中写入真实 OpenViking 服务的测试数据。"
const assistantMessage = `已记录真实 Docker smoke test marker：${marker}。`

const fakeClient = {
  session: {
    async messages() {
      return {
        data: [
          {
            info: { id: `msg-user-${marker}`, role: "user" },
            parts: [{ type: "text", text: userMessage }],
          },
          {
            info: { id: `msg-assistant-${marker}`, role: "assistant" },
            parts: [{ type: "text", text: assistantMessage }],
          },
        ],
      }
    },
  },
}

const { default: OpenVikingMemoryPlugin } = await import("../openviking-memory.ts")
const hooks = await OpenVikingMemoryPlugin({
  client: fakeClient,
  project: { id: "real-smoke-project", name: "real-smoke" },
  directory: "/workspace",
  worktree: "/workspace",
  experimental_workspace: { register() {} },
  serverUrl: new URL("http://127.0.0.1:4096"),
  $: undefined,
} as any)

try {
  assert.equal(typeof hooks.event, "function", "event hook should be registered")
  assert.equal(typeof hooks["chat.message"], "function", "chat.message hook should be registered")
  assert.equal(typeof hooks["experimental.session.compacting"], "function", "compacting hook should be registered")
  assert.equal(hooks.tool, undefined, "Codex-aligned plugin should not expose custom tools")

  await healthCheck(runtimeConfig)

  await hooks.event!({
    event: {
      id: `evt-stream-message-${marker}`,
      type: "message.updated",
      properties: { info: { id: `msg-stream-${marker}`, sessionID, role: "user" } },
    } as any,
  })
  await hooks.event!({
    event: {
      id: `evt-stream-part-${marker}`,
      type: "message.part.updated",
      properties: { part: { sessionID, messageID: `msg-stream-${marker}`, type: "text", text: marker } },
    } as any,
  })

  const recallOutput = {
    message: { id: `msg-recall-${marker}`, role: "user" },
    parts: [{ id: `part-recall-${marker}`, type: "text", text: `OpenViking Docker smoke marker ${marker}`, messageID: `msg-recall-${marker}` }],
  }
  await hooks["chat.message"]!({ sessionID, messageID: `msg-recall-${marker}` }, recallOutput as any)

  await hooks.event!({
    event: {
      id: `evt-idle-${marker}`,
      type: "session.idle",
      properties: { sessionID },
    } as any,
  })

  const sessionInfoBefore = await requestJson<any>(
    runtimeConfig,
    "GET",
    `/api/v1/sessions/${encodeURIComponent(ovSessionId)}?auto_create=false`,
  )
  assert.equal(sessionInfoBefore.session_id, ovSessionId)
  assert.ok(
    (sessionInfoBefore.message_count ?? sessionInfoBefore.total_message_count ?? 0) >= 2,
    "real session should contain captured messages after session.idle",
  )

  const contextBefore = await requestJson<any>(
    runtimeConfig,
    "GET",
    `/api/v1/sessions/${encodeURIComponent(ovSessionId)}/context?token_budget=128000`,
  )
  assert.match(JSON.stringify(contextBefore), new RegExp(marker), "real session context should contain the smoke marker")

  const compactOutput = { context: [] as string[] }
  await hooks["experimental.session.compacting"]!({ sessionID }, compactOutput)
  assert.match(compactOutput.context.join("\n"), new RegExp(ovSessionId), "compacting should report committed session")

  const sessionInfoAfter = await waitForCommittedSession(runtimeConfig, ovSessionId)
  assert.equal(sessionInfoAfter.session_id, ovSessionId)
  assert.ok((sessionInfoAfter.commit_count ?? 0) >= 1, "real session should be committed after compacting")

  const sessions = await requestJson<any[]>(
    runtimeConfig,
    "GET",
    "/api/v1/sessions",
  )
  assert.ok(
    sessions.some((session) => session.session_id === ovSessionId),
    "real session should be visible in OpenViking session list",
  )

  console.log(JSON.stringify({
    ok: true,
    endpoint: runtimeConfig.endpoint,
    account: runtimeConfig.account ?? null,
    user: runtimeConfig.user ?? null,
    opencode_session_id: sessionID,
    openviking_session_id: ovSessionId,
    marker,
    session_uri: sessionInfoAfter.uri ?? `viking://user/${runtimeConfig.user}/sessions/${ovSessionId}`,
    message_count_before_commit: sessionInfoBefore.message_count ?? null,
    total_message_count_after_commit: sessionInfoAfter.total_message_count ?? null,
    commit_count_after_commit: sessionInfoAfter.commit_count ?? null,
  }, null, 2))
} finally {
  await hooks.dispose?.()
  await fs.promises.rm(stateDir, { recursive: true, force: true })
}
