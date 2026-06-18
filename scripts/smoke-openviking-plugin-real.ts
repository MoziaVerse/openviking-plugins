import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

type RuntimeConfig = {
  endpoint: string
  apiKey: string
  account?: string
  user?: string
  agent?: string
  sessionIdTemplate: string
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
    agent: process.env.OPENVIKING_AGENT_ID || process.env.OPENVIKING_AGENT || cliConfig.agent || cliConfig.agent_id || "opencode",
    sessionIdTemplate: process.env.OPENVIKING_SESSION_ID_TEMPLATE || "{user}-{tool}-{session}",
  }

  assert.ok(config.endpoint, "OPENVIKING_URL or OPENVIKING_CLI_CONFIG_FILE.url is required")
  assert.ok(config.apiKey, "OPENVIKING_API_KEY or OPENVIKING_CLI_CONFIG_FILE.api_key is required")
  return config
}

function safeSessionComponent(value: string | undefined, fallback: string): string {
  const normalized = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return normalized || fallback
}

function deriveOpenVikingSessionId(opencodeSessionId: string, config: RuntimeConfig): string {
  const user = safeSessionComponent(config.user || config.account, "user")
  const account = safeSessionComponent(config.account, "default")
  const agent = safeSessionComponent(config.agent, "opencode")
  const session = safeSessionComponent(opencodeSessionId, "unknown")
  return config.sessionIdTemplate
    .replaceAll("{account}", account)
    .replaceAll("{user}", user)
    .replaceAll("{tool}", "opencode")
    .replaceAll("{agent}", agent)
    .replaceAll("{session}", session)
}

function buildHeaders(config: RuntimeConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    "X-API-Key": config.apiKey,
  }
  if (config.account) headers["X-OpenViking-Account"] = config.account
  if (config.user) headers["X-OpenViking-User"] = config.user
  if (config.agent) headers["X-OpenViking-Agent"] = config.agent
  return headers
}

function unwrap<T>(response: OpenVikingResponse<T>): T {
  if (response.status !== "ok") {
    const error = typeof response.error === "string" ? response.error : response.error?.message || response.error?.code
    throw new Error(error || "OpenViking request failed")
  }
  return response.result as T
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

function createToolContext(sessionID: string, timeoutMs = 240000) {
  return {
    sessionID,
    messageID: "real-smoke-tool-message",
    agent: "opencode",
    directory: "/workspace",
    worktree: "/workspace",
    abort: AbortSignal.timeout(timeoutMs),
    metadata() {},
    async ask() {},
  }
}

function parseJsonOrNull(text: string): any | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const runtimeConfig = loadRuntimeConfig()

process.env.OPENVIKING_URL = runtimeConfig.endpoint
process.env.OPENVIKING_API_KEY = runtimeConfig.apiKey
if (runtimeConfig.account) process.env.OPENVIKING_ACCOUNT = runtimeConfig.account
if (runtimeConfig.user) process.env.OPENVIKING_USER = runtimeConfig.user
if (runtimeConfig.agent) process.env.OPENVIKING_AGENT_ID = runtimeConfig.agent
process.env.OPENVIKING_SESSION_ID_TEMPLATE = runtimeConfig.sessionIdTemplate

const marker = `ov-real-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const sessionID = `real-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const ovSessionId = deriveOpenVikingSessionId(sessionID, runtimeConfig)

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
  assert.ok(hooks.tool?.openviking_health, "openviking_health tool should be registered")
  assert.ok(hooks.tool?.memcommit, "memcommit tool should be registered")

  const healthText = await hooks.tool.openviking_health.execute({}, createToolContext(sessionID))
  assert.match(String(healthText), /healthy/i, "real OpenViking health check should pass")

  await hooks.event!({
    event: {
      id: `evt-created-${marker}`,
      type: "session.created",
      properties: { sessionID, info: { id: sessionID } },
    } as any,
  })

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
    "real session should contain captured messages before commit",
  )

  const contextBefore = await requestJson<any>(
    runtimeConfig,
    "GET",
    `/api/v1/sessions/${encodeURIComponent(ovSessionId)}/context?token_budget=128000`,
  )
  assert.match(JSON.stringify(contextBefore), new RegExp(marker), "real session context should contain the smoke marker")

  const commitText = await hooks.tool.memcommit.execute({}, createToolContext(sessionID, 300000))
  assert.doesNotMatch(String(commitText), /^Error:/, "memcommit should not fail")
  const commitResult = parseJsonOrNull(String(commitText))

  const sessionInfoAfter = await requestJson<any>(
    runtimeConfig,
    "GET",
    `/api/v1/sessions/${encodeURIComponent(ovSessionId)}?auto_create=false`,
  )
  assert.equal(sessionInfoAfter.session_id, ovSessionId)
  assert.ok(
    (sessionInfoAfter.commit_count ?? 0) >= 1 || commitResult?.status === "accepted" || commitResult?.status === "completed",
    "real session should be committed or accepted for background commit",
  )

  const sessions = await requestJson<any[]>(
    runtimeConfig,
    "GET",
    "/api/v1/sessions",
  )
  assert.ok(
    sessions.some((session) => session.session_id === ovSessionId),
    "real session should be visible in OpenViking session list",
  )

  const searchText = await hooks.tool.openviking_find.execute(
    { query: marker, limit: 5, min_score: 0 },
    createToolContext(sessionID),
  )
  assert.doesNotMatch(String(searchText), /^Error:/, "real OpenViking search should be callable")

  console.log(JSON.stringify({
    ok: true,
    endpoint: runtimeConfig.endpoint,
    account: runtimeConfig.account ?? null,
    user: runtimeConfig.user ?? null,
    agent: runtimeConfig.agent ?? null,
    opencode_session_id: sessionID,
    openviking_session_id: ovSessionId,
    marker,
    session_uri: sessionInfoAfter.uri ?? `viking://user/${runtimeConfig.user}/sessions/${ovSessionId}`,
    message_count_before_commit: sessionInfoBefore.message_count ?? null,
    total_message_count_after_commit: sessionInfoAfter.total_message_count ?? null,
    commit_count_after_commit: sessionInfoAfter.commit_count ?? null,
    commit_result: commitResult,
  }, null, 2))
} finally {
  await hooks.dispose?.()
}
