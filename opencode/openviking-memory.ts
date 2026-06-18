/**
 * OpenViking Memory Plugin for OpenCode
 *
 * Codex-aligned behavior only:
 * - chat.message: auto-recall before the model answers.
 * - session.idle: append completed user/assistant turns to OpenViking.
 * - experimental.session.compacting: catch up and commit before compaction.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import fs from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

type Role = "user" | "assistant"

interface OpenVikingConfig {
  baseUrl: string
  apiKey: string
  account: string
  user: string
  peerId: string
  timeoutMs: number
  captureTimeoutMs: number
  autoRecall: boolean
  recallLimit: number
  scoreThreshold: number
  minQueryLength: number
  captureAssistantTurns: boolean
  captureMaxLength: number
  autoCommitOnCompact: boolean
  debug: boolean
  debugLogPath: string
}

interface OpenVikingResponse<T = unknown> {
  status?: string
  result?: T
  error?: string | { code?: string; message?: string }
}

interface SearchItem {
  uri: string
  score?: number
  title?: string
  abstract?: string
  overview?: string
  content?: string
  category?: string
  level?: number
}

interface SessionState {
  opencodeSessionId: string
  ovSessionId: string | null
  capturedMessageIds: string[]
  createdAt: number
  lastUpdatedAt: number
}

const pluginFilePath = fileURLToPath(import.meta.url)
const pluginFileDir = path.dirname(pluginFilePath)
const DEFAULT_STATE_DIR = path.join(homedir(), ".openviking", "opencode-plugin-state")
const DEFAULT_LOG_PATH = path.join(homedir(), ".openviking", "logs", "opencode-hooks.log")

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function num(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function boolEnv(name: string): boolean | undefined {
  const value = process.env[name]
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (["0", "false", "no"].includes(normalized)) return false
  if (["1", "true", "yes"].includes(normalized)) return true
  return undefined
}

function readJson(filePath: string): Record<string, any> {
  try {
    if (!fs.existsSync(filePath)) return {}
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return {}
  }
}

function loadConfig(): OpenVikingConfig {
  const pluginConfig = readJson(path.join(pluginFileDir, "openviking-config.json"))
  const cliConfigPath = process.env.OPENVIKING_CLI_CONFIG_FILE || path.join(homedir(), ".openviking", "ovcli.conf")
  const cliConfig = readJson(cliConfigPath)

  const baseUrl = str(
    process.env.OPENVIKING_URL ||
      process.env.OPENVIKING_BASE_URL ||
      cliConfig.url ||
      cliConfig.endpoint ||
      cliConfig.base_url ||
      pluginConfig.endpoint ||
      pluginConfig.baseUrl,
    "http://127.0.0.1:1933",
  ).replace(/\/+$/, "")

  const timeoutMs = Math.max(1000, Math.floor(num(process.env.OPENVIKING_TIMEOUT_MS, num(pluginConfig.timeoutMs, 15000))))
  const captureTimeoutMs = Math.max(
    1000,
    Math.floor(num(process.env.OPENVIKING_CAPTURE_TIMEOUT_MS, num(pluginConfig.captureTimeoutMs, Math.max(timeoutMs * 2, 30000)))),
  )

  return {
    baseUrl,
    apiKey: str(
      process.env.OPENVIKING_BEARER_TOKEN ||
        process.env.OPENVIKING_API_KEY ||
        cliConfig.api_key ||
        cliConfig.apiKey ||
        pluginConfig.apiKey ||
        pluginConfig.api_key,
    ),
    account: str(process.env.OPENVIKING_ACCOUNT || cliConfig.account || pluginConfig.account),
    user: str(process.env.OPENVIKING_USER || cliConfig.user || pluginConfig.user),
    peerId: str(process.env.OPENVIKING_PEER_ID || pluginConfig.peerId || pluginConfig.peer_id),
    timeoutMs,
    captureTimeoutMs,
    autoRecall: boolEnv("OPENVIKING_AUTO_RECALL") ?? pluginConfig.autoRecall?.enabled ?? pluginConfig.autoRecall !== false,
    recallLimit: Math.max(1, Math.floor(num(process.env.OPENVIKING_RECALL_LIMIT, num(pluginConfig.recallLimit, pluginConfig.autoRecall?.limit ?? 6)))),
    scoreThreshold: Math.min(
      1,
      Math.max(0, num(process.env.OPENVIKING_SCORE_THRESHOLD, num(pluginConfig.scoreThreshold, pluginConfig.autoRecall?.scoreThreshold ?? 0.35))),
    ),
    minQueryLength: Math.max(1, Math.floor(num(process.env.OPENVIKING_MIN_QUERY_LENGTH, num(pluginConfig.minQueryLength, 3)))),
    captureAssistantTurns: boolEnv("OPENVIKING_CAPTURE_ASSISTANT_TURNS") ?? pluginConfig.captureAssistantTurns !== false,
    captureMaxLength: Math.max(200, Math.floor(num(process.env.OPENVIKING_CAPTURE_MAX_LENGTH, num(pluginConfig.captureMaxLength, 24000)))),
    autoCommitOnCompact: boolEnv("OPENVIKING_AUTO_COMMIT_ON_COMPACT") ?? pluginConfig.autoCommitOnCompact !== false,
    debug: boolEnv("OPENVIKING_DEBUG") ?? pluginConfig.debug === true,
    debugLogPath: str(process.env.OPENVIKING_DEBUG_LOG || pluginConfig.debugLogPath, DEFAULT_LOG_PATH),
  }
}

function createLogger(config: OpenVikingConfig) {
  async function log(event: string, data?: Record<string, unknown>) {
    if (!config.debug) return
    try {
      await mkdir(path.dirname(config.debugLogPath), { recursive: true })
      await fs.promises.appendFile(
        config.debugLogPath,
        JSON.stringify({ ts: new Date().toISOString(), scope: "opencode", event, data }) + "\n",
        "utf8",
      )
    } catch {
      // Debug logging must never affect hook behavior.
    }
  }

  async function logError(event: string, error: unknown, data?: Record<string, unknown>) {
    const message = error instanceof Error ? error.message : String(error)
    await log(event, { error: message, ...data })
  }

  return { log, logError }
}

function buildHeaders(config: OpenVikingConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`
    headers["X-API-Key"] = config.apiKey
  }
  if (config.account) headers["X-OpenViking-Account"] = config.account
  if (config.user) headers["X-OpenViking-User"] = config.user
  if (config.peerId) headers["X-OpenViking-Actor-Peer"] = config.peerId
  return headers
}

async function fetchJson<T>(
  config: OpenVikingConfig,
  endpoint: string,
  init: RequestInit = {},
  timeoutMs = config.timeoutMs,
): Promise<T | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${config.baseUrl}${endpoint}`, {
      ...init,
      headers: { ...buildHeaders(config), ...(init.headers ?? {}) },
      signal: controller.signal,
    })
    const body = await response.json().catch(() => null) as OpenVikingResponse<T> | T | null
    if (!response.ok || !body || (typeof body === "object" && "status" in body && body.status === "error")) {
      return null
    }
    if (typeof body === "object" && "result" in body) return body.result as T
    return body as T
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function safeId(value: string | undefined): string {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_")
}

function deriveOvSessionId(opencodeSessionId: string, config: OpenVikingConfig): string {
  const user = safeId(config.user || config.account || "opencode")
  return `${user}-opencode-${safeId(opencodeSessionId)}`
}

function stateDir(): string {
  return process.env.OPENVIKING_OPENCODE_STATE_DIR || DEFAULT_STATE_DIR
}

function statePath(opencodeSessionId: string): string {
  return path.join(stateDir(), `${safeId(opencodeSessionId)}.json`)
}

function defaultState(opencodeSessionId: string): SessionState {
  const now = Date.now()
  return {
    opencodeSessionId,
    ovSessionId: null,
    capturedMessageIds: [],
    createdAt: now,
    lastUpdatedAt: now,
  }
}

async function loadState(opencodeSessionId: string): Promise<SessionState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(opencodeSessionId), "utf8"))
    return {
      ...defaultState(opencodeSessionId),
      ...parsed,
      capturedMessageIds: Array.isArray(parsed.capturedMessageIds) ? parsed.capturedMessageIds : [],
    }
  } catch {
    return defaultState(opencodeSessionId)
  }
}

async function saveState(state: SessionState): Promise<void> {
  await mkdir(stateDir(), { recursive: true })
  const next = { ...state, lastUpdatedAt: Date.now() }
  const finalPath = statePath(state.opencodeSessionId)
  const tmpPath = `${finalPath}.tmp`
  await writeFile(tmpPath, JSON.stringify(next), "utf8")
  await rename(tmpPath, finalPath)
}

function resolveOvSessionId(state: SessionState, config: OpenVikingConfig): string {
  if (!state.ovSessionId) state.ovSessionId = deriveOvSessionId(state.opencodeSessionId, config)
  return state.ovSessionId
}

function normalizeClientMessages(response: any): any[] {
  const data = response?.data ?? response
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.messages)) return data.messages
  if (Array.isArray(data?.result)) return data.result
  return []
}

async function fetchOpenCodeSessionMessages(client: any, sessionId: string): Promise<any[]> {
  const attempts = [
    () => client.session.messages({ path: { id: sessionId } }),
    () => client.session.messages({ path: { sessionID: sessionId } }),
    () => client.session.messages({ sessionID: sessionId }, { throwOnError: true }),
    () => client.session.messages({ sessionId }, { throwOnError: true }),
    () => client.session.messages({ sessionID: sessionId }),
    () => client.session.messages({ sessionId }),
  ]
  for (const attempt of attempts) {
    try {
      const messages = normalizeClientMessages(await attempt())
      if (messages.length > 0) return messages
    } catch {
      // Try the next SDK shape.
    }
  }
  return []
}

function extractMessageId(message: any, index: number): string {
  return String(message?.info?.id ?? message?.id ?? message?.messageID ?? message?.messageId ?? `message-${index}`)
}

function extractMessageRole(message: any): Role | null {
  const role = message?.info?.role ?? message?.role
  return role === "user" || role === "assistant" ? role : null
}

function sanitizeCapturedText(text: string): string {
  return text
    .replace(/<\/?openviking-context\b[^>]*>/gi, "openviking context marker")
    .replace(/<\/?relevant-memor(?:y|ies)\b[^>]*>/gi, "legacy memory wrapper")
    .trim()
}

function extractMessageText(message: any, maxLength: number): string {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const texts: string[] = []
  for (const part of parts) {
    if (!part || part.synthetic) continue
    if (part.type !== "text" || typeof part.text !== "string") continue
    const text = sanitizeCapturedText(part.text)
    if (text) texts.push(text)
  }
  const joined = texts.join("\n\n").trim()
  return joined.length > maxLength ? joined.slice(0, maxLength) : joined
}

async function appendTurn(config: OpenVikingConfig, ovSessionId: string, role: Role, content: string): Promise<boolean> {
  const body: Record<string, unknown> = { role, content }
  if (config.peerId) body.peer_id = config.peerId
  const result = await fetchJson(
    config,
    `/api/v1/sessions/${encodeURIComponent(ovSessionId)}/messages`,
    { method: "POST", body: JSON.stringify(body) },
    config.captureTimeoutMs,
  )
  return result !== null
}

async function captureSessionMessages(
  input: PluginInput,
  config: OpenVikingConfig,
  sessionId: string,
  logger: ReturnType<typeof createLogger>,
): Promise<{ state: SessionState; appended: number }> {
  const state = await loadState(sessionId)
  const ovSessionId = resolveOvSessionId(state, config)
  const captured = new Set(state.capturedMessageIds)
  const messages = await fetchOpenCodeSessionMessages(input.client, sessionId)
  let appended = 0

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const messageId = extractMessageId(message, index)
    if (captured.has(messageId)) continue
    const role = extractMessageRole(message)
    if (!role) continue
    if (role === "assistant" && !config.captureAssistantTurns) continue
    const text = extractMessageText(message, config.captureMaxLength)
    if (!text) continue
    const ok = await appendTurn(config, ovSessionId, role, text)
    if (!ok) break
    captured.add(messageId)
    state.capturedMessageIds.push(messageId)
    appended += 1
  }

  await saveState(state)
  await logger.log("capture", { sessionId, ovSessionId, appended })
  return { state, appended }
}

function extractPromptText(output: { parts?: any[] }): string {
  const texts: string[] = []
  for (const part of output.parts ?? []) {
    if (part?.type !== "text" || typeof part.text !== "string") continue
    if (part.synthetic) continue
    if (part.text.includes("<openviking-context")) continue
    texts.push(part.text)
  }
  return texts.join(" ").trim()
}

function resolveOutputMessageId(hookInput: { messageID?: string }, output: { message?: { id?: string }; parts?: any[] }): string | undefined {
  return hookInput.messageID || output.message?.id || output.parts?.find((part) => typeof part?.messageID === "string")?.messageID
}

function clampScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

const PREFERENCE_QUERY_RE = /prefer|preference|favorite|favourite|like|偏好|喜欢|爱好|更倾向/i
const TEMPORAL_QUERY_RE = /when|what time|date|day|month|year|yesterday|today|tomorrow|last|next|什么时候|何时|哪天|几月|几年|昨天|今天|明天/i
const QUERY_TOKEN_RE = /[a-z0-9一-龥]{2,}/gi
const STOPWORDS = new Set(["what", "when", "where", "which", "who", "why", "how", "the", "and", "for", "with", "from", "that", "this", "your", "you"])

function rankMemory(item: SearchItem, query: string): number {
  const tokens = (query.toLowerCase().match(QUERY_TOKEN_RE) ?? []).filter((token) => !STOPWORDS.has(token))
  const haystack = `${item.uri} ${item.abstract ?? ""} ${item.overview ?? ""}`.toLowerCase()
  const matched = tokens.slice(0, 8).filter((token) => haystack.includes(token)).length
  const overlap = tokens.length ? Math.min(0.2, (matched / Math.min(tokens.length, 4)) * 0.2) : 0
  const category = (item.category ?? "").toLowerCase()
  const uri = item.uri.toLowerCase()
  const leaf = item.level === 2 || uri.endsWith(".md") ? 0.12 : 0
  const pref = PREFERENCE_QUERY_RE.test(query) && (category === "preferences" || uri.includes("/preferences/")) ? 0.08 : 0
  const event = TEMPORAL_QUERY_RE.test(query) && (category === "events" || uri.includes("/events/")) ? 0.1 : 0
  return clampScore(item.score) + overlap + leaf + pref + event
}

async function searchScope(config: OpenVikingConfig, query: string, targetUri: string, bucket: "memories" | "skills"): Promise<SearchItem[]> {
  const result = await fetchJson<Record<string, SearchItem[]>>(
    config,
    "/api/v1/search/find",
    {
      method: "POST",
      body: JSON.stringify({
        query,
        target_uri: targetUri,
        limit: Math.max(config.recallLimit * 2, 10),
        score_threshold: 0,
      }),
    },
  )
  return result?.[bucket] ?? []
}

async function readContent(config: OpenVikingConfig, uri: string): Promise<string | null> {
  const result = await fetchJson<string>(config, `/api/v1/content/read?uri=${encodeURIComponent(uri)}`)
  return typeof result === "string" && result.trim() ? result.trim() : null
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`
}

async function buildRecallContext(config: OpenVikingConfig, query: string): Promise<string> {
  if (query.length < config.minQueryLength) return ""
  const [memories, skills] = await Promise.all([
    searchScope(config, query, "viking://user/memories", "memories"),
    searchScope(config, query, "viking://user/skills", "skills"),
  ])

  const seen = new Set<string>()
  const picked = [...memories, ...skills]
    .filter((item) => {
      if (!item?.uri || seen.has(item.uri)) return false
      seen.add(item.uri)
      return clampScore(item.score) >= config.scoreThreshold || item.level === 2 || item.uri.endsWith(".md")
    })
    .sort((a, b) => rankMemory(b, query) - rankMemory(a, query))
    .slice(0, config.recallLimit)

  if (picked.length === 0) return ""

  const lines = ['<openviking-context source="auto-recall" format="digest">']
  for (const item of picked) {
    const content = await readContent(config, item.uri)
    const body = truncate(content || item.abstract || item.overview || item.content || "", 1200)
    if (!body) continue
    const title = item.title ? `${item.title}\n` : ""
    lines.push(`<memory uri="${item.uri}" score="${clampScore(item.score).toFixed(3)}">`)
    lines.push(`${title}${body}`.trim())
    lines.push("</memory>")
  }
  lines.push("</openviking-context>")
  return lines.length > 2 ? lines.join("\n") : ""
}

async function commitSession(config: OpenVikingConfig, ovSessionId: string): Promise<boolean> {
  const result = await fetchJson(
    config,
    `/api/v1/sessions/${encodeURIComponent(ovSessionId)}/commit`,
    { method: "POST", body: JSON.stringify({}) },
    Math.max(config.captureTimeoutMs, 180000),
  )
  return result !== null
}

export const OpenVikingMemoryPlugin = async (input: PluginInput): Promise<Hooks> => {
  const config = loadConfig()
  const logger = createLogger(config)

  await logger.log("init", { baseUrl: config.baseUrl, user: config.user, account: config.account })

  return {
    event: async ({ event }) => {
      if (event?.type !== "session.idle") return
      const eventAny = event as any
      const sessionId = eventAny?.properties?.info?.id ?? event.properties.sessionID ?? eventAny?.properties?.sessionId
      if (!sessionId) return
      try {
        await captureSessionMessages(input, config, sessionId, logger)
      } catch (error) {
        await logger.logError("session_idle_failed", error, { sessionId })
      }
    },

    "chat.message": async (hookInput, output) => {
      if (!config.autoRecall) return
      try {
        const query = extractPromptText(output)
        const context = await buildRecallContext(config, query)
        if (!context) return
        output.parts.unshift({
          id: `prt-ov-recall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: "text",
          sessionID: hookInput.sessionID,
          messageID: resolveOutputMessageId(hookInput, output),
          text: context,
          synthetic: true,
        } as any)
        await logger.log("recall", { count: (context.match(/<memory /g) ?? []).length })
      } catch (error) {
        await logger.logError("recall_failed", error)
      }
    },

    "experimental.session.compacting": async (hookInput, output) => {
      if (!config.autoCommitOnCompact) return
      const sessionId = hookInput.sessionID
      if (!sessionId) return
      try {
        const { state } = await captureSessionMessages(input, config, sessionId, logger)
        const ovSessionId = state.ovSessionId
        if (!ovSessionId) return
        const ok = await commitSession(config, ovSessionId)
        if (!ok) {
          await saveState(state)
          return
        }
        state.ovSessionId = null
        await saveState(state)
        output.context.push(`OpenViking session ${ovSessionId} is committed`)
        await logger.log("compact_commit", { sessionId, ovSessionId })
      } catch (error) {
        await logger.logError("compact_failed", error, { sessionId })
      }
    },
  }
}

export default OpenVikingMemoryPlugin
