/**
 * OpenViking Memory Plugin for OpenCode
 *
 * Exposes OpenViking's semantic memory capabilities as tools for AI agents.
 * Supports user profiles, preferences, entities, events, cases, and patterns.
 * 
 * Contributed by: littlelory@convolens.net
 * GitHub: https://github.com/convolens
 * We are building Enterprise AI assistant for consumer brands，with process awareness and memory,
 * Serving product development to pre-launch lifecycle
 * Copyright 2026 Convolens.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as path from "path"
import { homedir } from "os"
import { fileURLToPath } from "url"

const z = tool.schema
const pluginFilePath = fileURLToPath(import.meta.url)
const pluginFileDir = path.dirname(pluginFilePath)

// ============================================================================
// Session State Management
// ============================================================================

interface SessionMapping {
  ovSessionId: string
  createdAt: number
  capturedMessages: Set<string>  // Track captured message IDs to avoid duplicates
  messageRoles: Map<string, "user" | "assistant">  // Track message ID → role mapping
  pendingMessages: Map<string, string>  // Track message ID → content for messages waiting for completion
  sendingMessages: Set<string>  // Track message IDs currently being sent to avoid duplicate writes
  lastCommitTime?: number
  commitInFlight?: boolean
  commitTaskId?: string
  commitStartedAt?: number
  pendingCleanup?: boolean
}

// Persisted format for session mapping (for disk storage)
interface SessionMappingPersisted {
  ovSessionId: string
  createdAt: number
  capturedMessages: string[]  // Set → Array
  messageRoles: [string, "user" | "assistant"][]  // Map → Array of tuples
  pendingMessages: [string, string][]  // Map → Array of tuples
  lastCommitTime?: number
  commitInFlight?: boolean
  commitTaskId?: string
  commitStartedAt?: number
  pendingCleanup?: boolean
}

// Session map file format
interface SessionMapFile {
  version: 1
  sessions: Record<string, SessionMappingPersisted>  // opencodeSessionId → mapping
  lastSaved: number  // timestamp
}

// Map: OpenCode session ID → OpenViking session ID
const sessionMap = new Map<string, SessionMapping>()

// Buffer for messages that arrive before session mapping is established
interface BufferedMessage {
  messageId: string
  content?: string
  role?: "user" | "assistant"
  timestamp: number
}
const sessionMessageBuffer = new Map<string, BufferedMessage[]>()  // sessionId → messages
const MAX_BUFFERED_MESSAGES_PER_SESSION = 100
const BUFFERED_MESSAGE_TTL_MS = 15 * 60 * 1000
const BUFFER_CLEANUP_INTERVAL_MS = 30 * 1000
let lastBufferCleanupAt = 0

// ============================================================================
// Logging
// ============================================================================

let logFilePath: string | null = null
let pluginDataDir: string | null = null

function ensurePluginDataDir(): string | null {
  const pluginDir = pluginFileDir
  try {
    fs.mkdirSync(pluginDir, { recursive: true })
    return pluginDir
  } catch (error) {
    console.error("Failed to ensure plugin directory:", error)
    return null
  }
}

function initLogger() {
  const pluginDir = ensurePluginDataDir()
  if (!pluginDir) return
  pluginDataDir = pluginDir
  logFilePath = path.join(pluginDir, "openviking-memory.log")
}

function safeStringify(obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== "object") return obj

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => safeStringify(item))
  }

  // Handle objects
  const result: any = {}
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key]
      if (typeof value === "function") {
        result[key] = "[Function]"
      } else if (typeof value === "object" && value !== null) {
        try {
          result[key] = safeStringify(value)
        } catch {
          result[key] = "[Circular or Non-serializable]"
        }
      } else {
        result[key] = value
      }
    }
  }
  return result
}

function log(level: "INFO" | "WARN" | "ERROR" | "DEBUG", toolName: string, message: string, data?: any) {
  if (!logFilePath) return

  const timestamp = new Date().toISOString()
  const logEntry = {
    timestamp,
    level,
    tool: toolName,
    message,
    ...(data && { data: safeStringify(data) }),
  }

  try {
    const logLine = JSON.stringify(logEntry) + "\n"
    fs.appendFileSync(logFilePath, logLine, "utf-8")
  } catch (error) {
    console.error("Failed to write to log file:", error)
  }
}

// ============================================================================
// Session Map Persistence
// ============================================================================

let sessionMapPath: string | null = null

function initSessionMapPath() {
  const pluginDir = pluginDataDir ?? ensurePluginDataDir()
  if (!pluginDir) return
  pluginDataDir = pluginDir
  sessionMapPath = path.join(pluginDir, "openviking-session-map.json")
}

function serializeSessionMapping(mapping: SessionMapping): SessionMappingPersisted {
  return {
    ovSessionId: mapping.ovSessionId,
    createdAt: mapping.createdAt,
    capturedMessages: Array.from(mapping.capturedMessages),
    messageRoles: Array.from(mapping.messageRoles.entries()),
    pendingMessages: Array.from(mapping.pendingMessages.entries()),
    lastCommitTime: mapping.lastCommitTime,
    commitInFlight: mapping.commitInFlight,
    commitTaskId: mapping.commitTaskId,
    commitStartedAt: mapping.commitStartedAt,
    pendingCleanup: mapping.pendingCleanup,
  }
}

function deserializeSessionMapping(persisted: SessionMappingPersisted): SessionMapping {
  return {
    ovSessionId: persisted.ovSessionId,
    createdAt: persisted.createdAt,
    capturedMessages: new Set(persisted.capturedMessages),
    messageRoles: new Map(persisted.messageRoles),
    pendingMessages: new Map(persisted.pendingMessages),
    sendingMessages: new Set(),
    lastCommitTime: persisted.lastCommitTime,
    commitInFlight: persisted.commitInFlight,
    commitTaskId: persisted.commitTaskId,
    commitStartedAt: persisted.commitStartedAt,
    pendingCleanup: persisted.pendingCleanup,
  }
}

async function loadSessionMap(): Promise<void> {
  if (!sessionMapPath) return

  try {
    if (!fs.existsSync(sessionMapPath)) {
      log("INFO", "persistence", "No session map file found, starting fresh")
      return
    }

    const content = await fs.promises.readFile(sessionMapPath, "utf-8")
    const data: SessionMapFile = JSON.parse(content)

    if (data.version !== 1) {
      log("ERROR", "persistence", "Unsupported session map version", { version: data.version })
      return
    }

    for (const [opencodeSessionId, persisted] of Object.entries(data.sessions)) {
      sessionMap.set(opencodeSessionId, deserializeSessionMapping(persisted))
    }

    log("INFO", "persistence", "Session map loaded", {
      count: sessionMap.size,
      last_saved: new Date(data.lastSaved).toISOString()
    })
  } catch (error: any) {
    log("ERROR", "persistence", "Failed to load session map", { error: error.message })

    // Backup corrupted file
    if (fs.existsSync(sessionMapPath)) {
      const backupPath = `${sessionMapPath}.corrupted.${Date.now()}`
      await fs.promises.rename(sessionMapPath, backupPath)
      log("INFO", "persistence", "Corrupted file backed up", { backup: backupPath })
    }
  }
}

async function saveSessionMap(): Promise<void> {
  if (!sessionMapPath) return

  try {
    const sessions: Record<string, SessionMappingPersisted> = {}
    for (const [opencodeSessionId, mapping] of sessionMap.entries()) {
      sessions[opencodeSessionId] = serializeSessionMapping(mapping)
    }

    const data: SessionMapFile = {
      version: 1,
      sessions,
      lastSaved: Date.now()
    }

    // Atomic write: temp file + rename
    const tempPath = sessionMapPath + '.tmp'
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8")
    await fs.promises.rename(tempPath, sessionMapPath)

    log("DEBUG", "persistence", "Session map saved", { count: sessionMap.size })
  } catch (error: any) {
    log("ERROR", "persistence", "Failed to save session map", { error: error.message })
  }
}

// Debounced save to reduce disk I/O
let saveTimer: NodeJS.Timeout | null = null

function debouncedSaveSessionMap(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveSessionMap().catch(error => {
      log("ERROR", "persistence", "Debounced save failed", { error: error.message })
    })
  }, 300)
}

// ============================================================================
// Configuration
// ============================================================================

interface OpenVikingConfig {
  endpoint: string
  apiKey: string
  account: string
  user: string
  agent: string
  enabled: boolean
  timeoutMs: number
  sessionIdTemplate: string
  autoCommitOnCompact: boolean
  compactKeepRecentCount: number
  autoCommit?: {
    enabled: boolean
    intervalMinutes: number
  }
  // Auto memory recall configuration
  autoRecall?: {
    enabled: boolean
    limit: number
    scoreThreshold: number
    maxContentChars: number
    preferAbstract: boolean
    tokenBudget: number
  }
}

// ============================================================================
// API Response Types
// ============================================================================

interface OpenVikingResponse<T = unknown> {
  status: string
  result?: T
  error?: string | { code?: string; message?: string; details?: Record<string, unknown> }
  time?: number
  usage?: Record<string, number>
}

interface SearchResult {
  memories: any[]
  resources: any[]
  skills: any[]
  total: number
  query_plan?: string
}

type MemoryCounts = number | Record<string, number>

interface CommitResult {
  session_id: string
  status: string
  memories_extracted?: MemoryCounts
  active_count_updated?: number
  archived?: boolean
  task_id?: string
  message?: string
  stats?: {
    total_turns?: number
    contexts_used?: number
    skills_used?: number
    memories_extracted?: number
  }
}

interface SessionResult {
  session_id: string
}

interface TaskResult {
  task_id: string
  task_type: string
  status: "pending" | "running" | "completed" | "failed"
  created_at: number
  updated_at: number
  resource_id?: string
  result?: {
    session_id?: string
    memories_extracted?: MemoryCounts
    archived?: boolean
  }
  error?: string | null
}

type CommitStartResult =
  | { mode: "background"; taskId: string }
  | { mode: "completed"; result: CommitResult }

const DEFAULT_CONFIG: OpenVikingConfig = {
  endpoint: "http://localhost:1933",
  apiKey: "",
  account: "",
  user: "opencode",
  agent: "opencode",
  enabled: true,
  timeoutMs: 30000,
  sessionIdTemplate: "{user}-{tool}-{session}",
  autoCommitOnCompact: true,
  compactKeepRecentCount: 0,
  autoCommit: {
    enabled: true,
    intervalMinutes: 10
  },
  autoRecall: {
    enabled: true,
    limit: 6,
    scoreThreshold: 0.15,
    maxContentChars: 500,
    preferAbstract: true,
    tokenBudget: 2000,
  },
}

function totalMemoriesExtracted(memories?: MemoryCounts): number {
  if (typeof memories === "number") {
    return memories
  }
  if (!memories || typeof memories !== "object") {
    return 0
  }
  return Object.entries(memories).reduce((sum, [key, value]) => {
    if (key === "total") {
      return sum
    }
    return sum + (typeof value === "number" ? value : 0)
  }, 0)
}

function totalMemoriesFromResult(result?: {
  memories_extracted?: MemoryCounts
} | null): number {
  return totalMemoriesExtracted(result?.memories_extracted)
}

function clampRecallConfig(recall: NonNullable<OpenVikingConfig["autoRecall"]>): void {
  recall.limit = Math.max(1, Math.min(50, Math.round(recall.limit)))
  recall.scoreThreshold = Math.max(0, Math.min(1, recall.scoreThreshold))
  recall.tokenBudget = Math.max(100, Math.min(10000, Math.round(recall.tokenBudget)))
}

function loadOvcliConfig(): Partial<OpenVikingConfig> {
  const candidates = [
    process.env.OPENVIKING_CLI_CONFIG_FILE,
    path.join(homedir(), ".openviking", "ovcli.conf"),
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const raw = JSON.parse(fs.readFileSync(candidate, "utf-8"))
      return {
        endpoint: raw.url || raw.endpoint || raw.base_url,
        apiKey: raw.api_key || raw.apiKey || raw.key,
        account: raw.account,
        user: raw.user,
        agent: raw.agent || raw.agent_id,
      }
    } catch {
      // Try the next candidate.
    }
  }

  return {}
}

function applyEnvironmentOverrides(config: OpenVikingConfig): OpenVikingConfig {
  if (process.env.OPENVIKING_URL || process.env.OPENVIKING_BASE_URL) {
    config.endpoint = process.env.OPENVIKING_URL || process.env.OPENVIKING_BASE_URL || config.endpoint
  }
  if (process.env.OPENVIKING_API_KEY || process.env.OPENVIKING_BEARER_TOKEN) {
    config.apiKey = process.env.OPENVIKING_API_KEY || process.env.OPENVIKING_BEARER_TOKEN || config.apiKey
  }
  if (process.env.OPENVIKING_ACCOUNT) {
    config.account = process.env.OPENVIKING_ACCOUNT
  }
  if (process.env.OPENVIKING_USER) {
    config.user = process.env.OPENVIKING_USER
  }
  if (process.env.OPENVIKING_AGENT_ID || process.env.OPENVIKING_AGENT) {
    config.agent = process.env.OPENVIKING_AGENT_ID || process.env.OPENVIKING_AGENT || config.agent
  }
  if (process.env.OPENVIKING_SESSION_ID_TEMPLATE) {
    config.sessionIdTemplate = process.env.OPENVIKING_SESSION_ID_TEMPLATE
  }
  if (process.env.OPENVIKING_AUTO_COMMIT_ON_COMPACT) {
    config.autoCommitOnCompact = !["0", "false", "no"].includes(process.env.OPENVIKING_AUTO_COMMIT_ON_COMPACT.toLowerCase())
  }
  return config
}

function loadConfig(): OpenVikingConfig {
  const configPath = path.join(pluginFileDir, "openviking-config.json")
  const ovcliConfig = loadOvcliConfig()

  try {
    if (fs.existsSync(configPath)) {
      const fileContent = fs.readFileSync(configPath, "utf-8")
      const fileConfig = JSON.parse(fileContent)
      const config = {
        ...DEFAULT_CONFIG,
        ...ovcliConfig,
        ...fileConfig,
        autoCommit: fileConfig.autoCommit
          ? {
              ...DEFAULT_CONFIG.autoCommit,
              ...fileConfig.autoCommit,
            }
          : DEFAULT_CONFIG.autoCommit
            ? { ...DEFAULT_CONFIG.autoCommit }
            : undefined,
        autoRecall: fileConfig.autoRecall
          ? {
              ...DEFAULT_CONFIG.autoRecall,
              ...fileConfig.autoRecall,
            }
          : DEFAULT_CONFIG.autoRecall
            ? { ...DEFAULT_CONFIG.autoRecall }
            : undefined,
      }
      if (config.autoCommit) {
        config.autoCommit.intervalMinutes = getAutoCommitIntervalMinutes(config)
      }

      // Validate recall config ranges
      if (config.autoRecall) {
        clampRecallConfig(config.autoRecall)
      }

      return applyEnvironmentOverrides(config)
    }
  } catch (error) {
    console.warn(`Failed to load OpenViking config from ${configPath}:`, error)
  }

  // Check environment variable even if config file doesn't exist.
  const config = {
    ...DEFAULT_CONFIG,
    ...ovcliConfig,
    autoCommit: DEFAULT_CONFIG.autoCommit
      ? { ...DEFAULT_CONFIG.autoCommit }
      : undefined,
    autoRecall: DEFAULT_CONFIG.autoRecall
      ? { ...DEFAULT_CONFIG.autoRecall }
      : undefined,
  }
  if (config.autoCommit) {
    config.autoCommit.intervalMinutes = getAutoCommitIntervalMinutes(config)
  }

  return applyEnvironmentOverrides(config)
}

// ============================================================================
// HTTP Client
// ============================================================================

interface HttpRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE"
  endpoint: string
  body?: any
  timeoutMs?: number
  abortSignal?: AbortSignal
}

function buildOpenVikingHeaders(config: OpenVikingConfig, includeContentType = true): Record<string, string> {
  const headers: Record<string, string> = {}

  if (includeContentType) {
    headers["Content-Type"] = "application/json"
  }

  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`
    headers["X-API-Key"] = config.apiKey
  }
  if (config.account) {
    headers["X-OpenViking-Account"] = config.account
  }
  if (config.user) {
    headers["X-OpenViking-User"] = config.user
  }
  if (config.agent) {
    headers["X-OpenViking-Agent"] = config.agent
  }

  return headers
}

async function makeRequest<T = any>(config: OpenVikingConfig, options: HttpRequestOptions): Promise<T> {
  const url = `${config.endpoint}${options.endpoint}`
  const headers = buildOpenVikingHeaders(config)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? config.timeoutMs)

  // Chain with tool's abort signal if provided
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, controller.signal])
    : controller.signal

  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const errorText = await response.text()
      let errorMessage: string
      try {
        const errorJson = JSON.parse(errorText)
        // Handle case where error/message might be objects
        const rawError = errorJson.error || errorJson.message
        if (typeof rawError === "string") {
          errorMessage = rawError
        } else if (rawError && typeof rawError === "object") {
          errorMessage = JSON.stringify(rawError)
        } else {
          errorMessage = errorText
        }
      } catch {
        errorMessage = errorText
      }

      switch (response.status) {
        case 401:
        case 403:
          throw new Error("Authentication failed. Please check API key configuration.")
        case 404:
          throw new Error(`Resource not found: ${options.endpoint}`)
        case 500:
          throw new Error(`OpenViking server error: ${errorMessage}`)
        default:
          throw new Error(`Request failed (${response.status}): ${errorMessage}`)
      }
    }

    return (await response.json()) as T
  } catch (error: any) {
    clearTimeout(timeout)

    if (error.name === "AbortError") {
      throw new Error(`Request timeout after ${options.timeoutMs ?? config.timeoutMs}ms`)
    }

    if (error.message?.includes("fetch failed") || error.code === "ECONNREFUSED") {
      throw new Error(
        `OpenViking service unavailable at ${config.endpoint}. Please check if the service is running (try: openviking-server).`,
      )
    }

    throw error
  }
}

function getResponseErrorMessage(error: OpenVikingResponse["error"]): string {
  if (!error) return "Unknown OpenViking error"
  if (typeof error === "string") return error
  return error.message || error.code || "Unknown OpenViking error"
}

function unwrapResponse<T>(response: OpenVikingResponse<T>): T {
  if (!response || typeof response !== "object") {
    throw new Error("OpenViking returned an invalid response")
  }
  if (response.status && response.status !== "ok") {
    throw new Error(getResponseErrorMessage(response.error))
  }
  return response.result as T
}

async function checkServiceHealth(config: OpenVikingConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.endpoint}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch (error: any) {
    log("ERROR", "health", "OpenViking health check failed", {
      endpoint: config.endpoint,
      error: error.message,
    })
    return false
  }
}

// ============================================================================
// Session Lifecycle Helpers
// ============================================================================

function mergeMessageContent(existing: string | undefined, incoming: string): string {
  const next = incoming.trim()
  if (!next) return existing ?? ""
  if (!existing) return next
  if (next === existing) return existing
  if (next.startsWith(existing)) return next
  if (existing.startsWith(next)) return existing
  if (next.includes(existing)) return next
  if (existing.includes(next)) return existing
  return `${existing}\n${next}`.trim()
}

function upsertBufferedMessage(
  sessionId: string,
  messageId: string,
  updates: Partial<Pick<BufferedMessage, "role" | "content">>,
): void {
  const now = Date.now()

  if (now - lastBufferCleanupAt >= BUFFER_CLEANUP_INTERVAL_MS) {
    for (const [bufferedSessionId, bufferedMessages] of sessionMessageBuffer.entries()) {
      const freshMessages = bufferedMessages.filter((message) => now - message.timestamp <= BUFFERED_MESSAGE_TTL_MS)
      if (freshMessages.length === 0) {
        sessionMessageBuffer.delete(bufferedSessionId)
        continue
      }
      if (freshMessages.length !== bufferedMessages.length) {
        sessionMessageBuffer.set(bufferedSessionId, freshMessages)
      }
    }
    lastBufferCleanupAt = now
  }

  const existingBuffer = sessionMessageBuffer.get(sessionId) ?? []
  const freshBuffer = existingBuffer.filter((message) => now - message.timestamp <= BUFFERED_MESSAGE_TTL_MS)

  let buffered = freshBuffer.find((message) => message.messageId === messageId)
  if (!buffered) {
    while (freshBuffer.length >= MAX_BUFFERED_MESSAGES_PER_SESSION) {
      freshBuffer.shift()
    }
    buffered = { messageId, timestamp: now }
    freshBuffer.push(buffered)
  } else {
    buffered.timestamp = now
  }

  if (updates.role) {
    buffered.role = updates.role
  }
  if (updates.content) {
    buffered.content = mergeMessageContent(buffered.content, updates.content)
  }

  sessionMessageBuffer.set(sessionId, freshBuffer)
}

function cleanupOrphanedMessageBuffers(now: number): void {
  for (const [sessionId, buffer] of sessionMessageBuffer.entries()) {
    if (sessionMap.has(sessionId)) {
      continue
    }

    const oldestMessage = buffer[0]
    if (!oldestMessage) {
      sessionMessageBuffer.delete(sessionId)
      continue
    }

    if (now - oldestMessage.timestamp <= BUFFERED_MESSAGE_TTL_MS * 2) {
      continue
    }

    log("INFO", "buffer", "Cleaning up orphaned message buffer", {
      session_id: sessionId,
      buffer_age_ms: now - oldestMessage.timestamp,
      message_count: buffer.length,
    })
    sessionMessageBuffer.delete(sessionId)
  }
}

function hasUnsavedSessionWork(mapping: SessionMapping): boolean {
  return mapping.capturedMessages.size > 0 ||
    mapping.pendingMessages.size > 0 ||
    mapping.commitInFlight === true
}

function getAutoCommitIntervalMinutes(config: OpenVikingConfig): number {
  const configured = Number(config.autoCommit?.intervalMinutes ?? DEFAULT_CONFIG.autoCommit?.intervalMinutes ?? 10)
  if (!Number.isFinite(configured)) {
    return DEFAULT_CONFIG.autoCommit?.intervalMinutes ?? 10
  }
  return Math.max(1, configured)
}

function resolveEventSessionId(event: any): string | undefined {
  return event?.properties?.info?.id
    ?? event?.properties?.sessionID
    ?? event?.properties?.sessionId
}

function safeSessionComponent(value: string | undefined, fallback: string): string {
  const normalized = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return normalized || fallback
}

function deriveOpenVikingSessionId(opencodeSessionId: string, config: OpenVikingConfig): string {
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

/**
 * Create or connect to OpenViking session for an OpenCode session
 */
async function ensureOpenVikingSession(
  opencodeSessionId: string,
  config: OpenVikingConfig,
): Promise<string | null> {
  const existingMapping = sessionMap.get(opencodeSessionId)
  const knownSessionId = existingMapping?.ovSessionId || deriveOpenVikingSessionId(opencodeSessionId, config)

  if (knownSessionId) {
    try {
      const response = await makeRequest<OpenVikingResponse<SessionResult>>(config, {
        method: "GET",
        endpoint: `/api/v1/sessions/${encodeURIComponent(knownSessionId)}?auto_create=true`,
        timeoutMs: 5000,
      })
      const result = unwrapResponse(response)
      if (result) {
        log("INFO", "session", "Connected to deterministic OpenViking session", {
          opencode_session: opencodeSessionId,
          openviking_session: knownSessionId,
        })
        return knownSessionId
      }
    } catch (error: any) {
      log("INFO", "session", "Persisted OpenViking session unavailable, creating a new one", {
        opencode_session: opencodeSessionId,
        openviking_session: knownSessionId,
        error: error.message,
      })
    }
  }

  log("ERROR", "session", "Failed to create deterministic OpenViking session", {
    opencode_session: opencodeSessionId,
    openviking_session: knownSessionId,
  })
  return null
}

async function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    function onAbort() {
      clearTimeout(timer)
      reject(new Error("Operation aborted"))
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function findRunningCommitTaskId(
  ovSessionId: string,
  config: OpenVikingConfig,
): Promise<string | undefined> {
  try {
    const response = await makeRequest<OpenVikingResponse<TaskResult[]>>(config, {
      method: "GET",
      endpoint: `/api/v1/tasks?task_type=session_commit&resource_id=${encodeURIComponent(ovSessionId)}&limit=10`,
      timeoutMs: 5000,
    })
    const tasks = unwrapResponse(response) ?? []
    const runningTask = tasks.find((task) => task.status === "pending" || task.status === "running")
    return runningTask?.task_id
  } catch (error: any) {
    log("ERROR", "session", "Failed to query running commit tasks", {
      openviking_session: ovSessionId,
      error: error.message,
    })
    return undefined
  }
}

function clearCommitState(mapping: SessionMapping): void {
  mapping.commitInFlight = false
  mapping.commitTaskId = undefined
  mapping.commitStartedAt = undefined
}

function isMissingCommitTaskError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return message.includes("resource not found") || message.includes("not found")
}

let backgroundCommitSupported: boolean | null = null
const COMMIT_TIMEOUT_MS = 180000

async function detectBackgroundCommitSupport(config: OpenVikingConfig): Promise<boolean> {
  if (backgroundCommitSupported !== null) {
    return backgroundCommitSupported
  }

  const headers = buildOpenVikingHeaders(config, false)

  try {
    const response = await fetch(`${config.endpoint}/api/v1/tasks?limit=1`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    backgroundCommitSupported = response.ok
  } catch {
    backgroundCommitSupported = false
  }

  log(
    "INFO",
    "session",
    backgroundCommitSupported
      ? "Detected background commit API support"
      : "Detected legacy synchronous commit API",
    { endpoint: config.endpoint },
  )
  return backgroundCommitSupported
}

async function finalizeCommitSuccess(
  mapping: SessionMapping,
  opencodeSessionId: string,
  config: OpenVikingConfig,
): Promise<void> {
  mapping.lastCommitTime = Date.now()
  mapping.capturedMessages.clear()
  clearCommitState(mapping)
  debouncedSaveSessionMap()

  await flushPendingMessages(opencodeSessionId, mapping, config)

  if (mapping.pendingCleanup) {
    if (hasUnsavedSessionWork(mapping)) {
      debouncedSaveSessionMap()
      return
    }

    sessionMap.delete(opencodeSessionId)
    sessionMessageBuffer.delete(opencodeSessionId)
    await saveSessionMap()
    log("INFO", "session", "Cleaned up session mapping after commit completion", {
      openviking_session: mapping.ovSessionId,
      opencode_session: opencodeSessionId,
    })
  }
}

async function runSynchronousCommit(
  mapping: SessionMapping,
  opencodeSessionId: string,
  config: OpenVikingConfig,
  abortSignal?: AbortSignal,
): Promise<CommitResult> {
  mapping.commitInFlight = true
  mapping.commitTaskId = undefined
  mapping.commitStartedAt = Date.now()
  debouncedSaveSessionMap()

  try {
    const response = await makeRequest<OpenVikingResponse<CommitResult>>(config, {
      method: "POST",
      endpoint: `/api/v1/sessions/${mapping.ovSessionId}/commit`,
      timeoutMs: Math.max(config.timeoutMs, COMMIT_TIMEOUT_MS),
      abortSignal,
    })
    const result = unwrapResponse(response)

    log("INFO", "session", "OpenViking synchronous commit completed", {
      openviking_session: mapping.ovSessionId,
      opencode_session: opencodeSessionId,
      memories_extracted: totalMemoriesFromResult(result),
      archived: result?.archived ?? false,
    })

    await finalizeCommitSuccess(mapping, opencodeSessionId, config)
    return result
  } catch (error: any) {
    clearCommitState(mapping)
    debouncedSaveSessionMap()
    throw error
  }
}

async function flushPendingMessages(
  opencodeSessionId: string,
  mapping: SessionMapping,
  config: OpenVikingConfig,
): Promise<void> {
  if (mapping.commitInFlight) {
    return
  }

  for (const messageId of Array.from(mapping.pendingMessages.keys())) {
    if (mapping.capturedMessages.has(messageId) || mapping.sendingMessages.has(messageId)) {
      continue
    }
    const role = mapping.messageRoles.get(messageId)
    const content = mapping.pendingMessages.get(messageId)
    if (!role || !content || !content.trim()) {
      continue
    }

    mapping.sendingMessages.add(messageId)
    try {
      log("DEBUG", "message", "Committing pending message content", {
        session_id: opencodeSessionId,
        message_id: messageId,
        role,
        content_length: content.length,
      })

      const success = await addMessageToSession(
        mapping.ovSessionId,
        role,
        content,
        config
      )

      if (success) {
        const latestContent = mapping.pendingMessages.get(messageId)
        if (latestContent && latestContent !== content) {
          log("DEBUG", "message", "Message changed during send; keeping latest content pending", {
            session_id: opencodeSessionId,
            message_id: messageId,
            role,
            previous_length: content.length,
            latest_length: latestContent.length,
          })
        } else {
          mapping.capturedMessages.add(messageId)
          mapping.pendingMessages.delete(messageId)
          debouncedSaveSessionMap()
          log("INFO", "message", `${role} message captured successfully`, {
            session_id: opencodeSessionId,
            message_id: messageId,
            role,
          })
        }
      }
    } finally {
      mapping.sendingMessages.delete(messageId)
    }
  }
}

async function startBackgroundCommit(
  mapping: SessionMapping,
  opencodeSessionId: string,
  config: OpenVikingConfig,
  abortSignal?: AbortSignal,
): Promise<CommitStartResult | null> {
  if (mapping.commitInFlight && mapping.commitTaskId) {
    return { mode: "background", taskId: mapping.commitTaskId }
  }

  const supportsBackgroundCommit = await detectBackgroundCommitSupport(config)
  if (!supportsBackgroundCommit) {
    try {
      const result = await runSynchronousCommit(mapping, opencodeSessionId, config, abortSignal)
      return { mode: "completed", result }
    } catch (error: any) {
      log("ERROR", "session", "Failed to run synchronous commit", {
        openviking_session: mapping.ovSessionId,
        opencode_session: opencodeSessionId,
        error: error.message,
      })
      return null
    }
  }

  try {
    const response = await makeRequest<OpenVikingResponse<CommitResult>>(config, {
      method: "POST",
      endpoint: `/api/v1/sessions/${mapping.ovSessionId}/commit?wait=false`,
      timeoutMs: 5000,
      abortSignal,
    })
    const data = unwrapResponse(response)
    const taskId = data?.task_id
    if (!taskId) {
      throw new Error("OpenViking did not return a background task id")
    }

    mapping.commitInFlight = true
    mapping.commitTaskId = taskId
    mapping.commitStartedAt = Date.now()
    debouncedSaveSessionMap()

    log("INFO", "session", "OpenViking background commit accepted", {
      openviking_session: mapping.ovSessionId,
      opencode_session: opencodeSessionId,
      task_id: taskId,
    })
    return { mode: "background", taskId }
  } catch (error: any) {
    if (error.message?.includes("already has a commit in progress")) {
      const taskId = await findRunningCommitTaskId(mapping.ovSessionId, config)
      if (taskId) {
        mapping.commitInFlight = true
        mapping.commitTaskId = taskId
        mapping.commitStartedAt = mapping.commitStartedAt ?? Date.now()
        debouncedSaveSessionMap()
        log("INFO", "session", "Recovered existing background commit task", {
          openviking_session: mapping.ovSessionId,
          opencode_session: opencodeSessionId,
          task_id: taskId,
        })
        return { mode: "background", taskId }
      }
    }

    if (
      error.message?.includes("Request timeout") ||
      error.message?.includes("background task id")
    ) {
      backgroundCommitSupported = false
      try {
        const result = await runSynchronousCommit(mapping, opencodeSessionId, config, abortSignal)
        return { mode: "completed", result }
      } catch (fallbackError: any) {
        log("ERROR", "session", "Failed to fall back to synchronous commit", {
          openviking_session: mapping.ovSessionId,
          opencode_session: opencodeSessionId,
          error: fallbackError.message,
        })
      }
    }

    log("ERROR", "session", "Failed to start OpenViking background commit", {
      openviking_session: mapping.ovSessionId,
      opencode_session: opencodeSessionId,
      error: error.message,
    })
    return null
  }
}

async function pollCommitTaskOnce(
  mapping: SessionMapping,
  opencodeSessionId: string,
  config: OpenVikingConfig,
): Promise<TaskResult["status"] | "unknown"> {
  if (!mapping.commitInFlight) {
    return "unknown"
  }

  if (!mapping.commitTaskId) {
    const recoveredTaskId = await findRunningCommitTaskId(mapping.ovSessionId, config)
    if (!recoveredTaskId) {
      log("INFO", "session", "Clearing stale in-flight commit without task id", {
        openviking_session: mapping.ovSessionId,
        opencode_session: opencodeSessionId,
      })
      clearCommitState(mapping)
      debouncedSaveSessionMap()
      return "unknown"
    }

    mapping.commitTaskId = recoveredTaskId
    debouncedSaveSessionMap()
  }

  try {
    const response = await makeRequest<OpenVikingResponse<TaskResult>>(config, {
      method: "GET",
      endpoint: `/api/v1/tasks/${mapping.commitTaskId}`,
      timeoutMs: 5000,
    })
    const task = unwrapResponse(response)

    if (task.status === "pending" || task.status === "running") {
      return task.status
    }

    if (task.status === "completed") {
      const memoriesExtracted = totalMemoriesFromResult(task.result)
      const archived = task.result?.archived ?? false

      log("INFO", "session", "OpenViking background commit completed", {
        openviking_session: mapping.ovSessionId,
        opencode_session: opencodeSessionId,
        task_id: task.task_id,
        memories_extracted: memoriesExtracted,
        archived,
      })

      await finalizeCommitSuccess(mapping, opencodeSessionId, config)

      return task.status
    }

    log("ERROR", "session", "OpenViking background commit failed", {
      openviking_session: mapping.ovSessionId,
      opencode_session: opencodeSessionId,
      task_id: task.task_id,
      error: task.error,
    })

    clearCommitState(mapping)
    debouncedSaveSessionMap()

    if (mapping.pendingCleanup && !hasUnsavedSessionWork(mapping)) {
      sessionMap.delete(opencodeSessionId)
      sessionMessageBuffer.delete(opencodeSessionId)
      await saveSessionMap()
      log("INFO", "session", "Cleaned up session mapping after failed commit", {
        openviking_session: mapping.ovSessionId,
        opencode_session: opencodeSessionId,
      })
    }

    return task.status
  } catch (error: unknown) {
    if (isMissingCommitTaskError(error)) {
      log("INFO", "session", "Commit task disappeared; clearing stale state", {
        openviking_session: mapping.ovSessionId,
        opencode_session: opencodeSessionId,
        task_id: mapping.commitTaskId,
      })
      clearCommitState(mapping)
      debouncedSaveSessionMap()
      return "unknown"
    }

    log("ERROR", "session", "Failed to poll OpenViking background commit", {
      openviking_session: mapping.ovSessionId,
      opencode_session: opencodeSessionId,
      task_id: mapping.commitTaskId,
      error: error instanceof Error ? error.message : String(error),
    })
    return "unknown"
  }
}

async function waitForCommitCompletion(
  mapping: SessionMapping,
  opencodeSessionId: string,
  config: OpenVikingConfig,
  abortSignal?: AbortSignal,
  timeoutMs = 180000,
): Promise<TaskResult | null> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (abortSignal?.aborted) {
      throw new Error("Operation aborted")
    }

    if (!mapping.commitInFlight) {
      return null
    }
    if (!mapping.commitTaskId) {
      const recoveredTaskId = await findRunningCommitTaskId(mapping.ovSessionId, config)
      if (!recoveredTaskId) {
        clearCommitState(mapping)
        debouncedSaveSessionMap()
        return null
      }

      mapping.commitTaskId = recoveredTaskId
      debouncedSaveSessionMap()
    }

    try {
      const response = await makeRequest<OpenVikingResponse<TaskResult>>(config, {
        method: "GET",
        endpoint: `/api/v1/tasks/${mapping.commitTaskId}`,
        timeoutMs: 5000,
        abortSignal,
      })
      const task = unwrapResponse(response)

      if (task.status === "completed") {
        const memoriesExtracted = totalMemoriesFromResult(task.result)
        const archived = task.result?.archived ?? false

        await finalizeCommitSuccess(mapping, opencodeSessionId, config)

        log("INFO", "memcommit", "Background commit completed while waiting", {
          openviking_session: mapping.ovSessionId,
          opencode_session: opencodeSessionId,
          task_id: task.task_id,
          memories_extracted: memoriesExtracted,
          archived,
        })
        return task
      }

      if (task.status === "failed") {
        clearCommitState(mapping)
        debouncedSaveSessionMap()
        throw new Error(task.error || "Background commit failed")
      }

      await sleep(2000, abortSignal)
    } catch (error: unknown) {
      if (isMissingCommitTaskError(error)) {
        log("INFO", "session", "Commit task disappeared while waiting; clearing stale state", {
          openviking_session: mapping.ovSessionId,
          opencode_session: opencodeSessionId,
          task_id: mapping.commitTaskId,
        })
        clearCommitState(mapping)
        debouncedSaveSessionMap()
        return null
      }

      throw error
    }
  }

  return null
}

// ============================================================================
// Auto-Commit Scheduler
// ============================================================================

let autoCommitTimer: NodeJS.Timeout | null = null

function startAutoCommit(config: OpenVikingConfig) {
  if (autoCommitTimer) {
    log("INFO", "auto-commit", "Auto-commit scheduler already running")
    return
  }

  if (!config.autoCommit?.enabled) {
    log("INFO", "auto-commit", "Auto-commit disabled in config")
    return
  }

  const checkIntervalMs = 60 * 1000  // Check every minute

  autoCommitTimer = setInterval(async () => {
    await checkAndCommitSessions(config)
  }, checkIntervalMs)

  log("INFO", "auto-commit", "Auto-commit scheduler started", {
    check_interval_seconds: 60,
    commit_interval_minutes: getAutoCommitIntervalMinutes(config)
  })
}

function stopAutoCommit() {
  if (autoCommitTimer) {
    clearInterval(autoCommitTimer)
    autoCommitTimer = null
    log("INFO", "auto-commit", "Auto-commit scheduler stopped")
  }
}

async function checkAndCommitSessions(config: OpenVikingConfig): Promise<void> {
  const intervalMs = getAutoCommitIntervalMinutes(config) * 60 * 1000
  const now = Date.now()

  cleanupOrphanedMessageBuffers(now)

  for (const [opencodeSessionId, mapping] of sessionMap.entries()) {
    if (mapping.commitInFlight) {
      await pollCommitTaskOnce(mapping, opencodeSessionId, config)
      continue
    }

    if (mapping.pendingMessages.size > 0) {
      await flushPendingMessages(opencodeSessionId, mapping, config)
    }

    const timeSinceLastCommit = now - (mapping.lastCommitTime ?? mapping.createdAt)
    const hasNewMessages = mapping.capturedMessages.size > 0

    if (timeSinceLastCommit >= intervalMs && hasNewMessages) {
      log("INFO", "auto-commit", "Triggering auto-commit", {
        opencode_session: opencodeSessionId,
        openviking_session: mapping.ovSessionId,
        time_since_last_commit_minutes: Math.floor(timeSinceLastCommit / 60000),
        captured_messages_count: mapping.capturedMessages.size
      })

      await startBackgroundCommit(mapping, opencodeSessionId, config)
    }
  }
}

/**
 * Add message to OpenViking session
 */
async function addMessageToSession(
  ovSessionId: string,
  role: "user" | "assistant",
  content: string,
  config: OpenVikingConfig,
): Promise<boolean> {
  try {
    const response = await makeRequest<OpenVikingResponse<void>>(config, {
      method: "POST",
      endpoint: `/api/v1/sessions/${ovSessionId}/messages`,
      body: { role, content },
      timeoutMs: 5000,
    })
    unwrapResponse(response)

    log("INFO", "message", "Message added to OpenViking session", {
      openviking_session: ovSessionId,
      role,
      content_length: content.length,
    })
    return true
  } catch (error: any) {
    log("ERROR", "message", "Failed to add message to OpenViking session", {
      openviking_session: ovSessionId,
      role,
      error: error.message,
    })
    return false
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatSearchResults(
  result: SearchResult,
  toolName: string,
  query: string,
  extra?: Record<string, unknown>
): string {
  const { memories = [], resources = [], skills = [] } = result
  const allResults = [...memories, ...resources, ...skills]
  if (allResults.length === 0) {
    log("INFO", toolName, "No results found", { query })
    return "No results found matching the query."
  }
  log("INFO", toolName, "Search completed", { count: allResults.length })
  return JSON.stringify(
    { total: result.total ?? allResults.length, memories, resources, skills, ...extra },
    null, 2
  )
}

function resolveSearchMode(
  requestedMode: "auto" | "fast" | "deep" | undefined,
  query: string,
  sessionId?: string
): "fast" | "deep" {
  if (requestedMode === "fast" || requestedMode === "deep") {
    return requestedMode
  }

  if (sessionId) {
    return "deep"
  }

  const normalized = query.trim()
  const wordCount = normalized ? normalized.split(/\s+/).length : 0
  if (normalized.includes("?") || normalized.length >= 80 || wordCount >= 8) {
    return "deep"
  }

  return "fast"
}

function validateVikingUri(uri: string, toolName: string): string | null {
  if (!uri.startsWith("viking://")) {
    const error = `Invalid URI format. Must start with "viking://". Example: viking://user/memories/`
    log("ERROR", toolName, "Invalid URI format", { uri })
    return `Error: ${error}`
  }
  return null
}

// ============================================================================
// Memory Recall: Types, Ranking & Dedup
// ============================================================================

/** Shape returned by OpenViking search API, adapted for recall use. */
interface RecallSearchItem {
  uri: string
  score: number
  title?: string
  abstract?: string
  content?: string
  type?: string
  category?: string
  level?: number
  overview?: string
}

const AUTO_RECALL_TIMEOUT_MS = 5_000

// ─── Scoring helpers ───

function recallClampScore(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0
  return Math.max(0, Math.min(1, value))
}

const RECALL_STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "whom", "whose", "why", "how",
  "did", "does", "is", "are", "was", "were", "the", "and", "for", "with",
  "from", "that", "this", "your", "you",
])

const RECALL_TOKEN_RE = /[a-z0-9]{2,}/gi

const PREFERENCE_QUERY_RE = /prefer|preference|favorite|favourite|like|偏好|喜欢|爱好|更倾向/i
const TEMPORAL_QUERY_RE = /when|what time|date|day|month|year|yesterday|today|tomorrow|last|next|什么时候|何时|哪天|几月|几年|昨天|今天|明天|上周|下周|上个月|下个月|去年|明年/i

interface RecallQueryProfile {
  tokens: string[]
  wantsPreference: boolean
  wantsTemporal: boolean
}

function buildRecallQueryProfile(query: string): RecallQueryProfile {
  const text = query.trim()
  const allTokens = text.toLowerCase().match(RECALL_TOKEN_RE) ?? []
  const tokens = allTokens.filter((t) => !RECALL_STOPWORDS.has(t))
  return {
    tokens,
    wantsPreference: PREFERENCE_QUERY_RE.test(text),
    wantsTemporal: TEMPORAL_QUERY_RE.test(text),
  }
}

function lexicalOverlapBoost(tokens: string[], text: string): number {
  if (tokens.length === 0 || !text) return 0
  const haystack = ` ${text.toLowerCase()} `
  let matched = 0
  for (const token of tokens.slice(0, 8)) {
    if (haystack.includes(` ${token} `) || haystack.includes(token)) {
      matched += 1
    }
  }
  return Math.min(0.2, (matched / Math.min(tokens.length, 4)) * 0.2)
}

function isEventMemory(item: RecallSearchItem): boolean {
  const cat = (item.category ?? "").toLowerCase()
  return cat === "events" || item.uri.includes("/events/")
}

function isPreferencesMemory(item: RecallSearchItem): boolean {
  return item.category === "preferences" || item.uri.includes("/preferences/") || item.uri.endsWith("/preferences")
}

function isLeafLikeMemory(item: RecallSearchItem): boolean {
  return item.level === 2
}

function rankForInjection(item: RecallSearchItem, query: RecallQueryProfile): number {
  const baseScore = recallClampScore(item.score)
  const abstract = (item.abstract ?? item.overview ?? "").trim()
  const leafBoost = isLeafLikeMemory(item) ? 0.12 : 0
  const eventBoost = query.wantsTemporal && isEventMemory(item) ? 0.1 : 0
  const preferenceBoost = query.wantsPreference && isPreferencesMemory(item) ? 0.08 : 0
  const overlapBoost = lexicalOverlapBoost(query.tokens, `${item.uri} ${abstract}`)
  return baseScore + leafBoost + eventBoost + preferenceBoost + overlapBoost
}

// ─── Dedup + selection ───

function normalizeDedupeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

function isEventOrCaseMemory(item: RecallSearchItem): boolean {
  const cat = (item.category ?? "").toLowerCase()
  const uri = item.uri.toLowerCase()
  return cat === "events" || cat === "cases" || uri.includes("/events/") || uri.includes("/cases/")
}

function getMemoryDedupeKey(item: RecallSearchItem): string {
  const abstract = normalizeDedupeText(item.abstract ?? item.overview ?? "")
  const cat = (item.category ?? "").toLowerCase() || "unknown"
  if (abstract && !isEventOrCaseMemory(item)) {
    return `abstract:${cat}:${abstract}`
  }
  return `uri:${item.uri}`
}

function pickMemoriesForInjection(
  items: RecallSearchItem[],
  limit: number,
  queryText: string,
  scoreThreshold: number = 0,
): RecallSearchItem[] {
  if (items.length === 0 || limit <= 0) return []

  const query = buildRecallQueryProfile(queryText)
  const sorted = [...items].sort((a, b) => rankForInjection(b, query) - rankForInjection(a, query))

  const deduped: RecallSearchItem[] = []
  const seen = new Set<string>()
  for (const item of sorted) {
    const key = getMemoryDedupeKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }

  // Prefer leaf memories first, then supplement with non-leaf
  const leaves = deduped.filter((item) => isLeafLikeMemory(item))
  if (leaves.length >= limit) return leaves.slice(0, limit)

  const picked = [...leaves]
  const used = new Set(leaves.map((item) => item.uri))
  for (const item of deduped) {
    if (picked.length >= limit) break
    if (used.has(item.uri)) continue
    if (recallClampScore(item.score) < scoreThreshold) continue
    picked.push(item)
  }
  return picked
}

// ─── Post-processing ───

function postProcessMemories(
  items: RecallSearchItem[],
  maxContentChars: number,
  preferAbstract: boolean,
): RecallSearchItem[] {
  return items.map((item) => {
    const abstract = (item.abstract ?? "").trim()
    const content = (item.content ?? "").trim()
    let displayContent: string
    if (preferAbstract && abstract) {
      displayContent = abstract.length > maxContentChars ? abstract.slice(0, maxContentChars) + "..." : abstract
    } else if (content) {
      displayContent = content.length > maxContentChars ? content.slice(0, maxContentChars) + "..." : content
    } else if (abstract) {
      displayContent = abstract.length > maxContentChars ? abstract.slice(0, maxContentChars) + "..." : abstract
    } else {
      displayContent = ""
    }
    return { ...item, content: displayContent, abstract: abstract || undefined }
  })
}

function formatMemoryBlock(
  items: RecallSearchItem[],
  maxChars: number,
  tokenBudget: number,
): string {
  if (items.length === 0) return ""

  const maxBlockChars = tokenBudget * 4 // 4 chars ≈ 1 token
  let usedChars = 0
  const lines: string[] = ["<relevant-memories>"]

  for (const item of items) {
    const title = item.title ? `${item.title}\n` : ""
    const content = item.content ?? ""
    const entry = `<memory uri="${item.uri}">\n${title}${content}\n</memory>`
    const entryChars = entry.length + 1 // +1 for newline

    if (usedChars + entryChars > maxBlockChars) break
    lines.push(entry)
    usedChars += entryChars
  }

  if (usedChars === 0) return ""
  lines.push("</relevant-memories>")
  lines.push("Use the `memread` tool with a memory's URI and level=\"overview\" or level=\"read\" to retrieve more details.")
  return lines.join("\n")
}

// ─── Hook helpers ───

/** Extract text from message parts. Returns null if empty or already injected. */
function extractMessageText(parts: { type: string; text?: string }[]): string | null {
  const texts: string[] = []
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text)
    }
  }
  const joined = texts.join(" ").trim()
  if (!joined) return null
  if (joined.includes("<relevant-memories>")) return null
  return joined
}

/** Perform search against OpenViking with a timeout guard. Returns empty on any failure. */
async function performRecallSearch(config: OpenVikingConfig, query: string): Promise<RecallSearchItem[]> {
  try {
    const response = await makeRequest<OpenVikingResponse<{ memories?: RecallSearchItem[]; results?: RecallSearchItem[] }>>(
      config,
      {
        method: "POST",
        endpoint: "/api/v1/search/find",
        body: { query: query.slice(0, 4000), limit: 20, mode: "auto" },
        timeoutMs: AUTO_RECALL_TIMEOUT_MS,
      },
    )
    const result = unwrapResponse(response)
    return result?.memories ?? result?.results ?? []
  } catch {
    return []
  }
}

/** Run auto recall using chat.message hook — injects persistent synthetic part. */
async function runAutoRecall(
  config: OpenVikingConfig,
  input: { sessionID: string; messageID?: string },
  output: { parts: any[] },
): Promise<void> {
  const query = extractMessageText(output.parts ?? [])
  if (!query) return
  const recall = config.autoRecall
  if (!recall) return

  const rawResults = await performRecallSearch(config, query)
  if (rawResults.length === 0) return

  const ranked = pickMemoriesForInjection(
    rawResults,
    recall.limit ?? 6,
    query,
    recall.scoreThreshold ?? 0.15,
  )
  if (ranked.length === 0) return

  const processed = postProcessMemories(
    ranked,
    recall.maxContentChars ?? 500,
    recall.preferAbstract ?? true,
  )

  const block = formatMemoryBlock(
    processed,
    recall.maxContentChars ?? 500,
    recall.tokenBudget ?? 2000,
  )
  if (!block) return

  output.parts.unshift({
    id: `prt-ov-recall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "text",
    text: block,
    synthetic: true,
    sessionID: input.sessionID,
    messageID: input.messageID ?? output.parts.find((part) => part?.messageID)?.messageID,
  })
  log("INFO", "recall", `Injected ${processed.length} memories`)
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
    () => client.session.messages({ sessionID: sessionId }, { throwOnError: true }),
    () => client.session.messages({ sessionId }, { throwOnError: true }),
    () => client.session.messages({ sessionID: sessionId }),
    () => client.session.messages({ sessionId }),
  ]

  for (const attempt of attempts) {
    try {
      const response = await attempt()
      const messages = normalizeClientMessages(response)
      if (messages.length > 0) return messages
    } catch {
      // Try the next SDK shape.
    }
  }

  return []
}

function extractOpenCodeMessageId(message: any): string | undefined {
  return message?.info?.id ?? message?.id ?? message?.messageID ?? message?.messageId
}

function extractOpenCodeMessageRole(message: any): "user" | "assistant" | undefined {
  const role = message?.info?.role ?? message?.role
  return role === "user" || role === "assistant" ? role : undefined
}

function extractOpenCodeMessageText(message: any): string {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const texts: string[] = []
  for (const part of parts) {
    if (!part || part.synthetic) continue
    if (part.type !== "text" || typeof part.text !== "string") continue
    if (part.text.includes("<relevant-memories>")) continue
    const text = part.text.trim()
    if (text) texts.push(text)
  }
  return texts.join("\n\n").trim()
}

async function captureSessionMessagesFromClient(
  client: any,
  opencodeSessionId: string,
  mapping: SessionMapping,
  config: OpenVikingConfig,
): Promise<void> {
  const messages = await fetchOpenCodeSessionMessages(client, opencodeSessionId)
  if (messages.length === 0) return

  let captured = 0
  for (const message of messages) {
    const messageId = extractOpenCodeMessageId(message)
    const role = extractOpenCodeMessageRole(message)
    if (!messageId || !role) continue
    if (mapping.capturedMessages.has(messageId)) continue

    const text = extractOpenCodeMessageText(message)
    if (!text) continue

    mapping.messageRoles.set(messageId, role)
    mapping.pendingMessages.set(
      messageId,
      mergeMessageContent(mapping.pendingMessages.get(messageId), text),
    )
    captured += 1
  }

  if (captured > 0) {
    log("INFO", "capture", "Caught up OpenCode messages from SDK", {
      opencode_session: opencodeSessionId,
      count: captured,
    })
    await flushPendingMessages(opencodeSessionId, mapping, config)
  }
}

// ============================================================================
// Plugin Export
// ============================================================================

export const OpenVikingMemoryPlugin = async (input: PluginInput): Promise<Hooks> => {
  const config = loadConfig()
  initLogger()
  initSessionMapPath()

  if (!config.enabled) {
    console.log("OpenViking Memory Plugin is disabled in configuration")
    return {}
  }

  log("INFO", "plugin", "OpenViking Memory Plugin initialized", { endpoint: config.endpoint })

  // Load session map from disk
  await loadSessionMap()

  const healthy = await checkServiceHealth(config)
  log("INFO", "health", healthy ? "OpenViking health check passed" : "OpenViking health check failed", {
    endpoint: config.endpoint,
  })

  // Start auto-commit scheduler
  startAutoCommit(config)

  return {
    event: async ({ event }) => {
      if (event && event.type && event.type === "session.diff") {
        return;
      }

      // Handle session lifecycle events
      if (event.type === "session.created") {
        const sessionId = resolveEventSessionId(event)
        if (!sessionId) {
          log("ERROR", "event", "session.created event missing sessionId", {
            event: safeStringify(event)
          })
          return
        }

        log("INFO", "event", "OpenCode session created", {
          session_id: sessionId,
          session_info: safeStringify(event.properties?.info)
        })

        // Create or connect to OpenViking session (non-blocking)
        const ovSessionId = await ensureOpenVikingSession(sessionId, config)
        if (ovSessionId) {
          sessionMap.set(sessionId, {
            ovSessionId,
            createdAt: Date.now(),
            capturedMessages: new Set(),
            messageRoles: new Map(),
            pendingMessages: new Map(),
            sendingMessages: new Set(),
            lastCommitTime: undefined,
            commitInFlight: false,
          })

          // Process buffered messages that arrived before session mapping
          const bufferedMessages = sessionMessageBuffer.get(sessionId)
          if (bufferedMessages && bufferedMessages.length > 0) {
            log("INFO", "event", "Processing buffered messages", {
              session_id: sessionId,
              count: bufferedMessages.length
            })

            const mapping = sessionMap.get(sessionId)!
            for (const buffered of bufferedMessages) {
              // Store role if available
              if (buffered.role) {
                mapping.messageRoles.set(buffered.messageId, buffered.role)
              }
              // Store content as pending if available
              if (buffered.content) {
                mapping.pendingMessages.set(
                  buffered.messageId,
                  mergeMessageContent(mapping.pendingMessages.get(buffered.messageId), buffered.content)
                )
              }

            }

            await flushPendingMessages(sessionId, mapping, config)

            // Clear buffer
            sessionMessageBuffer.delete(sessionId)
          }

          debouncedSaveSessionMap()
          log("INFO", "event", "Session mapping established", {
            opencode_session: sessionId,
            openviking_session: ovSessionId,
            session_info: safeStringify(event.properties?.info)
          })
        } else {
          log("ERROR", "event", "Failed to establish session mapping", {
            session_id: sessionId,
            session_info: safeStringify(event.properties?.info)
          })
        }
      } else if (event.type === "session.deleted") {
        const sessionId = resolveEventSessionId(event)
        if (!sessionId) {
          log("ERROR", "event", "session.deleted event missing sessionId", {
            event: safeStringify(event)
          })
          return
        }

        log("INFO", "event", "OpenCode session deleted", {
          session_id: sessionId,
          session_info: safeStringify(event.properties?.info)
        })

        // Commit OpenViking session if mapped
        const mapping = sessionMap.get(sessionId)
        if (mapping) {
          await flushPendingMessages(sessionId, mapping, config)

          if (mapping.capturedMessages.size > 0 || mapping.commitInFlight) {
            mapping.pendingCleanup = true
            if (!mapping.commitInFlight) {
              await startBackgroundCommit(mapping, sessionId, config)
            }
          } else {
            sessionMap.delete(sessionId)
            sessionMessageBuffer.delete(sessionId)  // Clean up buffer
            await saveSessionMap()
            log("INFO", "event", "Session mapping removed", {
              opencode_session: sessionId,
              openviking_session: mapping.ovSessionId,
              session_info: safeStringify(event.properties?.info)
            })
          }
        } else {
          log("INFO", "event", "No session mapping found for deleted session", {
            session_id: sessionId,
            session_info: safeStringify(event.properties?.info)
          })
        }
      } else if (event.type === "session.error") {
        const sessionId = resolveEventSessionId(event)
        const eventAny = event as any
        if (!sessionId) {
          log("ERROR", "event", "session.error event missing sessionId", {
            event: safeStringify(event)
          })
          return
        }

        log("ERROR", "event", "OpenCode session error", {
          session_id: sessionId,
          error: safeStringify(eventAny.properties?.error ?? eventAny.error),
          session_info: safeStringify(eventAny.properties?.info)
        })

        // Optionally commit session to preserve work
        const mapping = sessionMap.get(sessionId)
        if (mapping) {
          log("INFO", "event", "Attempting to commit session after error", {
            opencode_session: sessionId,
            openviking_session: mapping.ovSessionId,
            session_info: safeStringify(eventAny.properties?.info)
          })
          // Assistant text parts can arrive before finish=stop records the role.
          let inferredRole = false
          for (const [messageId, content] of mapping.pendingMessages.entries()) {
            if (!mapping.messageRoles.has(messageId) && content.trim()) {
              mapping.messageRoles.set(messageId, "assistant")
              inferredRole = true
            }
          }
          if (inferredRole) debouncedSaveSessionMap()

          await flushPendingMessages(sessionId, mapping, config)

          if (hasUnsavedSessionWork(mapping)) {
            mapping.pendingCleanup = true
            if (!mapping.commitInFlight) {
              await startBackgroundCommit(mapping, sessionId, config)
            }
          } else {
            sessionMap.delete(sessionId)
            sessionMessageBuffer.delete(sessionId)  // Clean up buffer
            await saveSessionMap()
          }
        }
      } else if (event.type === "session.idle") {
        const sessionId = resolveEventSessionId(event)
        if (!sessionId) {
          log("DEBUG", "event", "session.idle event missing sessionId", {
            event: safeStringify(event)
          })
          return
        }

        let mapping = sessionMap.get(sessionId)
        if (!mapping) {
          const ovSessionId = await ensureOpenVikingSession(sessionId, config)
          if (!ovSessionId) return
          mapping = {
            ovSessionId,
            createdAt: Date.now(),
            capturedMessages: new Set(),
            messageRoles: new Map(),
            pendingMessages: new Map(),
            sendingMessages: new Set(),
            lastCommitTime: undefined,
            commitInFlight: false,
          }
          sessionMap.set(sessionId, mapping)
        }

        await captureSessionMessagesFromClient(input.client, sessionId, mapping, config)
        await flushPendingMessages(sessionId, mapping, config)
        debouncedSaveSessionMap()
      } else if (event.type === "message.updated") {
        // Handle message capture for automatic session recording
        const message = event.properties?.info
        if (!message) {
          log("DEBUG", "event", "message.updated event missing info", {
            event: safeStringify(event)
          })
          return
        }

        const sessionId = message.sessionID
        const messageId = message.id
        const role = message.role
        const finish = (message as any).finish

        // Check if we have a session mapping
        const mapping = sessionMap.get(sessionId)
        if (!mapping) {
          // Buffer this message for later processing
          upsertBufferedMessage(sessionId, messageId, role ? { role } : {})
          log("DEBUG", "message", "Message buffered (no session mapping yet)", {
            session_id: sessionId,
            message_id: messageId,
            role: role
          })
          return
        }

        if (role === "user") {
          if (!mapping.messageRoles.has(messageId)) {
            mapping.messageRoles.set(messageId, role)
            log("DEBUG", "message", `${role} message role stored`, {
              session_id: sessionId,
              message_id: messageId,
              role: role,
            })
          }
        } else if (role === "assistant" && finish === "stop") {
          mapping.messageRoles.set(messageId, role)

          log("DEBUG", "message", `${role} message completed and role stored`, {
            session_id: sessionId,
            message_id: messageId,
            role: role,
            finish: finish,
          })
        }

        await flushPendingMessages(sessionId, mapping, config)

        // For assistant messages: log when fully completed (with tokens/cost)
        if (role === "assistant" && message.time?.completed) {
          log("DEBUG", "message", "Assistant message fully completed", {
            session_id: sessionId,
            message_id: messageId,
            tokens: message.tokens,
            cost: message.cost,
          })
        }
      } else if (event.type === "message.part.updated") {
        // Handle message part updates to capture content
        const part = event.properties?.part
        if (!part) {
          return
        }

        const sessionId = part.sessionID
        const messageId = part.messageID
        const partType = part.type

        // Check if we have a session mapping
        const mapping = sessionMap.get(sessionId)
        if (!mapping) {
          // Buffer this message content for later processing
          if (partType === "text" && part.text && part.text.trim().length > 0) {
            upsertBufferedMessage(sessionId, messageId, { content: part.text })
            log("DEBUG", "message", "Message content buffered (no session mapping yet)", {
              session_id: sessionId,
              message_id: messageId,
              content_length: part.text.length
            })
          }
          return
        }

        // Only capture text parts
        if (partType === "text" && part.text) {
          // Check if message already captured
          if (mapping.capturedMessages.has(messageId)) {
            return
          }

          const content = part.text
          if (content && content.trim().length > 0) {
            mapping.pendingMessages.set(
              messageId,
              mergeMessageContent(mapping.pendingMessages.get(messageId), content)
            )
            log("DEBUG", "message", "Message content stored as pending", {
              session_id: sessionId,
              message_id: messageId,
              content_length: content.length,
              waiting_for_role: !mapping.messageRoles.has(messageId),
              commit_in_flight: mapping.commitInFlight === true,
            })
          }
        }
      }
    },

    tool: {
      openviking_health: tool({
        description: "Check whether the configured OpenViking server is reachable and healthy.",
        args: {},
        async execute() {
          try {
            const response = await fetch(`${config.endpoint}/health`, {
              method: "GET",
              headers: buildOpenVikingHeaders(config, false),
              signal: AbortSignal.timeout(3000),
            })
            const text = await response.text()
            return response.ok ? `OpenViking is healthy: ${text}` : `OpenViking health check failed (${response.status}): ${text}`
          } catch (error: any) {
            return `OpenViking is unhealthy: ${error.message}`
          }
        },
      }),

      openviking_remember: tool({
        description:
          "Store concise user-provided facts, preferences, decisions, or reusable knowledge into OpenViking long-term memory. Do not store secrets, passwords, private keys, or customer/private data unless already safely redacted.",
        args: {
          messages: z.array(z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
          })).describe("Messages to store and extract into memory."),
        },
        async execute(args, context) {
          const storeSessionId = deriveOpenVikingSessionId(
            `remember-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            config,
          )
          try {
            for (const message of args.messages) {
              if (!message.content.trim()) continue
              await makeRequest<OpenVikingResponse<void>>(config, {
                method: "POST",
                endpoint: `/api/v1/sessions/${encodeURIComponent(storeSessionId)}/messages`,
                body: { role: message.role, content: message.content },
                abortSignal: context.abort,
              })
            }
            const response = await makeRequest<OpenVikingResponse<CommitResult>>(config, {
              method: "POST",
              endpoint: `/api/v1/sessions/${encodeURIComponent(storeSessionId)}/commit`,
              body: { keep_recent_count: 0 },
              abortSignal: context.abort,
            })
            const result = unwrapResponse(response)
            return JSON.stringify({
              message: `Stored ${args.messages.length} message(s) and started memory extraction.`,
              session_id: storeSessionId,
              task_id: result?.task_id,
              status: result?.status,
            }, null, 2)
          } catch (error: any) {
            return `Error: ${error.message}`
          }
        },
      }),

      openviking_search: tool({
        description:
          "Deep semantic retrieval with optional current-session context. Returns ranked memories, resources, and skills. Use for ambiguous questions or when the current conversation matters.",
        args: {
          query: z.string().describe("Natural language search query."),
          target_uri: z.string().optional().describe("Optional URI prefix, e.g. viking://resources/ or viking://user/memories/."),
          session_id: z.string().optional().describe("Optional explicit OpenViking session id. Defaults to current mapped session when available."),
          limit: z.number().optional().describe("Maximum results."),
          min_score: z.number().optional().describe("Minimum relevance score."),
          level: z.array(z.number()).optional().describe("Optional OpenViking memory/resource levels to include."),
        },
        async execute(args, context) {
          const mapping = context.sessionID ? sessionMap.get(context.sessionID) : undefined
          const sessionId = args.session_id ?? mapping?.ovSessionId
          try {
            const response = await makeRequest<OpenVikingResponse<SearchResult>>(config, {
              method: "POST",
              endpoint: "/api/v1/search/search",
              body: {
                query: args.query,
                target_uri: args.target_uri ?? "",
                session_id: sessionId,
                limit: args.limit ?? 10,
                score_threshold: args.min_score,
                level: args.level,
              },
              abortSignal: context.abort,
            })
            return formatSearchResults(unwrapResponse(response), "openviking_search", args.query, { session_id: sessionId })
          } catch (error: any) {
            return `Error: ${error.message}`
          }
        },
      }),

      openviking_find: tool({
        description:
          "Fast semantic retrieval without session context. Use for direct concept/resource lookup when conversation context is not needed.",
        args: {
          query: z.string().describe("Search query."),
          target_uri: z.string().optional().describe("Optional URI prefix."),
          limit: z.number().optional().describe("Maximum results."),
          min_score: z.number().optional().describe("Minimum relevance score."),
          level: z.array(z.number()).optional().describe("Optional OpenViking levels to include."),
        },
        async execute(args, context) {
          try {
            const response = await makeRequest<OpenVikingResponse<SearchResult>>(config, {
              method: "POST",
              endpoint: "/api/v1/search/find",
              body: {
                query: args.query,
                target_uri: args.target_uri ?? "",
                limit: args.limit ?? 10,
                score_threshold: args.min_score,
                level: args.level,
              },
              abortSignal: context.abort,
            })
            return formatSearchResults(unwrapResponse(response), "openviking_find", args.query)
          } catch (error: any) {
            return `Error: ${error.message}`
          }
        },
      }),

      openviking_read: tool({
        description:
          "Read full content from one or more viking:// file URIs. For directories, use openviking_list or openviking_browse.",
        args: {
          uris: z.union([z.string(), z.array(z.string())]).describe("Single URI or list of viking:// URIs."),
          offset: z.number().optional().describe("Starting line offset for file reads."),
          limit: z.number().optional().describe("Line limit for file reads."),
        },
        async execute(args, context) {
          const uris = Array.isArray(args.uris) ? args.uris : [args.uris]
          const results: string[] = []
          for (const uri of uris) {
            const validationError = validateVikingUri(uri, "openviking_read")
            if (validationError) return validationError
            const query = new URLSearchParams({
              uri,
              offset: String(args.offset ?? 0),
              limit: String(args.limit ?? -1),
            })
            const response = await makeRequest<OpenVikingResponse<string | Record<string, unknown>>>(config, {
              method: "GET",
              endpoint: `/api/v1/content/read?${query.toString()}`,
              abortSignal: context.abort,
            })
            const content = unwrapResponse(response)
            results.push(`=== ${uri} ===\n${typeof content === "string" ? content : JSON.stringify(content, null, 2)}`)
          }
          return results.join("\n\n")
        },
      }),

      openviking_list: tool({
        description: "List files and subdirectories under a viking:// directory URI.",
        args: {
          uri: z.string().describe("Directory URI to list."),
          recursive: z.boolean().optional().describe("Recursively list descendants."),
          simple: z.boolean().optional().describe("Return URI-oriented simple output."),
          node_limit: z.number().optional().describe("Maximum number of nodes."),
        },
        async execute(args, context) {
          const validationError = validateVikingUri(args.uri, "openviking_list")
          if (validationError) return validationError
          const query = new URLSearchParams({
            uri: args.uri,
            recursive: String(args.recursive ?? false),
            simple: String(args.simple ?? false),
            node_limit: String(args.node_limit ?? 1000),
          })
          const response = await makeRequest<OpenVikingResponse<any[]>>(config, {
            method: "GET",
            endpoint: `/api/v1/fs/ls?${query.toString()}`,
            abortSignal: context.abort,
          })
          return JSON.stringify(unwrapResponse(response), null, 2)
        },
      }),

      openviking_grep: tool({
        description: "Search content in viking:// files using a regex pattern. Use this for exact symbol/string lookup.",
        args: {
          uri: z.string().describe("URI scope to search."),
          pattern: z.string().describe("Regex pattern."),
          case_insensitive: z.boolean().optional(),
          node_limit: z.number().optional(),
        },
        async execute(args, context) {
          const response = await makeRequest<OpenVikingResponse<Record<string, unknown>>>(config, {
            method: "POST",
            endpoint: "/api/v1/search/grep",
            body: {
              uri: args.uri,
              pattern: args.pattern,
              case_insensitive: args.case_insensitive ?? false,
              node_limit: args.node_limit ?? 50,
            },
            abortSignal: context.abort,
          })
          return JSON.stringify(unwrapResponse(response), null, 2)
        },
      }),

      openviking_glob: tool({
        description: "Find viking:// files matching a glob pattern, e.g. **/*.md or **/README*.",
        args: {
          pattern: z.string().describe("Glob pattern."),
          uri: z.string().optional().describe("URI scope. Defaults to viking://."),
          node_limit: z.number().optional(),
        },
        async execute(args, context) {
          const response = await makeRequest<OpenVikingResponse<Record<string, unknown>>>(config, {
            method: "POST",
            endpoint: "/api/v1/search/glob",
            body: {
              pattern: args.pattern,
              uri: args.uri ?? "viking://",
              node_limit: args.node_limit ?? 100,
            },
            abortSignal: context.abort,
          })
          return JSON.stringify(unwrapResponse(response), null, 2)
        },
      }),

      openviking_forget: tool({
        description:
          "Permanently delete a viking:// URI from OpenViking. Only use after the user explicitly asks to delete/forget the exact URI.",
        args: {
          uri: z.string().describe("Exact URI to delete."),
          recursive: z.boolean().optional().describe("Delete directory tree recursively."),
        },
        async execute(args, context) {
          const validationError = validateVikingUri(args.uri, "openviking_forget")
          if (validationError) return validationError
          const query = new URLSearchParams({
            uri: args.uri,
            recursive: String(args.recursive ?? false),
          })
          const response = await makeRequest<OpenVikingResponse<Record<string, unknown>>>(config, {
            method: "DELETE",
            endpoint: `/api/v1/fs?${query.toString()}`,
            abortSignal: context.abort,
          })
          return JSON.stringify(unwrapResponse(response), null, 2)
        },
      }),

      openviking_add_resource: tool({
        description:
          "Add a remote resource such as an HTTP(S), git, ssh, or git@ URL to OpenViking. Local paths should be added with the ov CLI.",
        args: {
          path: z.string().describe("Remote URL or git repository URL."),
          to: z.string().optional().describe("Target viking:// URI."),
          parent: z.string().optional().describe("Parent viking:// URI. Do not combine with to."),
          reason: z.string().optional(),
          instruction: z.string().optional(),
          wait: z.boolean().optional(),
          timeout: z.number().optional(),
          watch_interval: z.number().optional(),
        },
        async execute(args, context) {
          const response = await makeRequest<OpenVikingResponse<Record<string, unknown>>>(config, {
            method: "POST",
            endpoint: "/api/v1/resources",
            body: {
              path: args.path,
              to: args.to,
              parent: args.parent,
              reason: args.reason ?? "",
              instruction: args.instruction ?? "",
              wait: args.wait ?? false,
              timeout: args.timeout,
              watch_interval: args.watch_interval ?? 0,
            },
            abortSignal: context.abort,
          })
          return JSON.stringify(unwrapResponse(response), null, 2)
        },
      }),

      openviking_commit: tool({
        description:
          "Commit the current OpenCode conversation's mapped OpenViking session immediately and extract persistent memories.",
        args: {
          session_id: z.string().optional().describe("Optional explicit OpenViking session id. Omit to use current mapped session."),
        },
        async execute(args, context) {
          let sessionId = args.session_id
          const mapping = context.sessionID ? sessionMap.get(context.sessionID) : undefined
          if (!sessionId && mapping) sessionId = mapping.ovSessionId
          if (!sessionId) {
            return "Error: no mapped OpenViking session for the current OpenCode session."
          }

          try {
            if (mapping && mapping.ovSessionId === sessionId && context.sessionID) {
              await flushPendingMessages(context.sessionID, mapping, config)
            }
            const response = await makeRequest<OpenVikingResponse<CommitResult>>(config, {
              method: "POST",
              endpoint: `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
              body: { keep_recent_count: 0 },
              abortSignal: context.abort,
            })
            return JSON.stringify(unwrapResponse(response), null, 2)
          } catch (error: any) {
            return `Error: ${error.message}`
          }
        },
      }),

      memread: tool({
        description:
          "Retrieve the content of a specific memory, resource, or skill at a given viking:// URI.\n\nProgressive loading levels:\n- abstract: brief summary\n- overview: structured directory overview\n- read: full content\n- auto: choose overview for directories and read for files\n\nUse when:\n- You have a URI from memsearch or membrowse\n- You need to inspect a memory, resource, or skill in more detail\n\nRequires: Complete viking:// URI (e.g., viking://user/memories/profile.md)",
        args: {
          uri: z
            .string()
            .describe(
              "Complete viking:// URI from search results or list output (e.g., viking://user/memories/profile.md, viking://agent/memories/context.md)",
            ),
          level: z
            .enum(["auto", "abstract", "overview", "read"])
            .optional()
            .describe("'auto' (directory->overview, file->read), 'abstract' (brief summary), 'overview' (directory summary), 'read' (full content)"),
        },
        async execute(args, context) {
          log("INFO", "memread", "Reading memory", { uri: args.uri, level: args.level })

          // Validate URI format
          const validationError = validateVikingUri(args.uri, "memread")
          if (validationError) return validationError

          try {
            let level = args.level ?? "auto"
            if (level === "auto") {
              try {
                const statResponse = await makeRequest<OpenVikingResponse<{ isDir?: boolean }>>(config, {
                  method: "GET",
                  endpoint: `/api/v1/fs/stat?uri=${encodeURIComponent(args.uri)}`,
                  abortSignal: context.abort,
                })
                const statResult = unwrapResponse(statResponse)
                level = statResult?.isDir ? "overview" : "read"
              } catch {
                level = "read"
              }
            }

            const response = await makeRequest<OpenVikingResponse<string | Record<string, unknown>>>(config, {
              method: "GET",
              endpoint: `/api/v1/content/${level}?uri=${encodeURIComponent(args.uri)}`,
              abortSignal: context.abort,
            })

            const content = unwrapResponse(response)
            if (!content) {
              log("INFO", "memread", "No content found", { uri: args.uri })
              return `No content found at ${args.uri}`
            }

            log("INFO", "memread", "Read completed", { uri: args.uri, level })
            return typeof content === "string" ? content : JSON.stringify(content, null, 2)
          } catch (error: any) {
            log("ERROR", "memread", "Read failed", { error: error.message, uri: args.uri })
            return `Error: ${error.message}`
          }
        },
      }),

      membrowse: tool({
        description:
          "Browse the OpenViking filesystem structure for a specific URI.\n\nViews:\n- list: list immediate children, or recurse when `recursive=true`\n- tree: return a directory tree view\n- stat: return metadata for a single file or directory\n\nUse when:\n- You need to discover available URIs before reading\n- You want to inspect directory structure under memories/resources/skills\n- You need file metadata before deciding how to read it\n\nRequires: Complete viking:// URI",
        args: {
          uri: z
            .string()
            .describe(
              "Complete viking:// URI to inspect (e.g., viking://user/memories/, viking://agent/memories/, viking://resources/zh/)",
            ),
          view: z
            .enum(["list", "tree", "stat"])
            .optional()
            .describe("'list' for directory listing, 'tree' for recursive tree view, 'stat' for metadata on a single URI"),
          recursive: z.boolean().optional().describe("Only used with view='list'. Recursively list descendants."),
          simple: z.boolean().optional().describe("Only used with view='list'. Return simpler URI-oriented output."),
        },
        async execute(args, context) {
          log("INFO", "membrowse", "Browsing URI", { args })

          // Validate URI format
          const validationError = validateVikingUri(args.uri, "membrowse")
          if (validationError) return validationError

          try {
            const view = args.view ?? "list"
            const encodedUri = encodeURIComponent(args.uri)

            if (view === "stat") {
              const response = await makeRequest<OpenVikingResponse<Record<string, unknown>>>(config, {
                method: "GET",
                endpoint: `/api/v1/fs/stat?uri=${encodedUri}`,
                abortSignal: context.abort,
              })
              const result = unwrapResponse(response)
              return JSON.stringify({ view, item: result }, null, 2)
            }

            const endpoint = view === "tree"
              ? `/api/v1/fs/tree?uri=${encodedUri}`
              : `/api/v1/fs/ls?uri=${encodedUri}&recursive=${args.recursive ? "true" : "false"}&simple=${args.simple ? "true" : "false"}`
            const response = await makeRequest<OpenVikingResponse<any[]>>(config, {
              method: "GET",
              endpoint,
              abortSignal: context.abort,
            })

            const result = unwrapResponse(response)
            const items = Array.isArray(result) ? result : []
            if (items.length === 0) {
              return `No items found at ${args.uri}`
            }

            return JSON.stringify({ view, count: items.length, items }, null, 2)
          } catch (error: any) {
            log("ERROR", "membrowse", "Browse failed", { error: error.message, uri: args.uri })
            return `Error: ${error.message}`
          }
        },
      }),

      memcommit: tool({
        description:
          "Commit the current OpenCode session to OpenViking and extract persistent memories from the accumulated conversation.\n\nBy default this tool commits the OpenViking session mapped to the current OpenCode session. Use `session_id` only when you need to target a specific OpenViking session manually.\n\nUse when:\n- You want a mid-session memory extraction without ending the chat\n- You want recently discussed preferences, entities, or cases persisted immediately\n\nAutomatically extracts and stores:\n- User profile, preferences, entities, events → viking://user/memories/\n- Agent cases and patterns → viking://agent/memories/\n\nReturns background commit progress or completion details, including task_id, memories_extracted, and archived.",
        args: {
          session_id: z
            .string()
            .optional()
            .describe("Optional explicit OpenViking session ID. Omit to commit the current OpenCode session's mapped OpenViking session."),
        },
        async execute(args, context) {
          let sessionId = args.session_id
          if (!sessionId && context.sessionID) {
            const mapping = sessionMap.get(context.sessionID)
            if (mapping) {
              sessionId = mapping.ovSessionId
            }
          }

          log("INFO", "memcommit", "Committing session", {
            requested_session_id: args.session_id,
            resolved_session_id: sessionId,
            opencode_session_id: context.sessionID,
          })

          if (!sessionId) {
            return "Error: No OpenViking session is associated with the current OpenCode session. Start or resume a normal OpenCode session first, or pass an explicit session_id."
          }

          try {
            const mapping = context.sessionID ? sessionMap.get(context.sessionID) : undefined
            const resolvedMapping = mapping?.ovSessionId === sessionId ? mapping : undefined

            if (resolvedMapping) {
              await flushPendingMessages(
                context.sessionID ?? sessionId,
                resolvedMapping,
                config,
              )
            }

            if (resolvedMapping?.commitInFlight) {
              const task = await waitForCommitCompletion(
                resolvedMapping,
                context.sessionID ?? sessionId,
                config,
                context.abort,
              )
              if (task?.status === "completed") {
                const memoriesExtracted = totalMemoriesFromResult(task.result)
                return JSON.stringify(
                  {
                    message: `Memory extraction complete: ${memoriesExtracted} memories extracted`,
                    session_id: task.result?.session_id ?? sessionId,
                    status: task.status,
                    memories_extracted: memoriesExtracted,
                    archived: task.result?.archived ?? false,
                    task_id: task.task_id,
                  },
                  null,
                  2,
                )
              }
            }

            const tempMapping: SessionMapping = resolvedMapping ?? {
              ovSessionId: sessionId,
              createdAt: Date.now(),
              capturedMessages: new Set(),
              messageRoles: new Map(),
              pendingMessages: new Map(),
              sendingMessages: new Set(),
            }

            const commitStart = await startBackgroundCommit(
              tempMapping,
              context.sessionID ?? sessionId,
              config,
              context.abort,
            )
            if (!commitStart) {
              throw new Error("Failed to start background commit")
            }

            if (commitStart.mode === "completed") {
              const memoriesExtracted = totalMemoriesFromResult(commitStart.result)
              return JSON.stringify(
                {
                  message: `Memory extraction complete: ${memoriesExtracted} memories extracted`,
                  session_id: commitStart.result.session_id ?? sessionId,
                  status: commitStart.result.status ?? "completed",
                  memories_extracted: memoriesExtracted,
                  archived: commitStart.result.archived ?? false,
                },
                null,
                2,
              )
            }

            const task = await waitForCommitCompletion(
              tempMapping,
              context.sessionID ?? sessionId,
              config,
              context.abort,
            )

            if (!task) {
              return JSON.stringify(
                {
                  message: "Commit is still processing in the background",
                  session_id: sessionId,
                  status: "accepted",
                  task_id: commitStart.taskId,
                },
                null,
                2,
              )
            }

            const memoriesExtracted = totalMemoriesFromResult(task.result)
            return JSON.stringify(
              {
                message: `Memory extraction complete: ${memoriesExtracted} memories extracted`,
                session_id: task.result?.session_id ?? sessionId,
                status: task.status,
                memories_extracted: memoriesExtracted,
                archived: task.result?.archived ?? false,
                task_id: task.task_id,
              },
              null,
              2,
            )
          } catch (error: any) {
            log("ERROR", "memcommit", "Commit failed", {
              error: error.message,
              session_id: sessionId,
            })
            return `Error: ${error.message}`
          }
        },
      }),

      memsearch: tool(
        {
          description:
            "Search OpenViking memories, resources, and skills through a unified interface.\n\nModes:\n- auto: choose between fast similarity search and deep context-aware search\n- fast: use simple semantic similarity search\n- deep: use intent analysis and optional session context\n\nReturns memories, resources, and skills with relevance scores and match reasons.\n\nUse when:\n- You want to find relevant memories or resources by meaning\n- You need a single search tool instead of choosing between low-level APIs\n- You want deeper retrieval for complex or ambiguous questions",
          args: {
            query: z.string().describe("Search query - can be natural language, a complex question, or a task description"),
            target_uri: z
              .string()
              .optional()
              .describe(
                "Limit search to a specific URI prefix (e.g., viking://resources/, viking://user/memories/). Omit to search all contexts.",
              ),
            mode: z
              .enum(["auto", "fast", "deep"])
              .optional()
              .describe("Search mode. 'auto' chooses based on query complexity and session context, 'fast' forces /find, 'deep' forces /search"),
            session_id: z
              .string()
              .optional()
              .describe(
                "Optional OpenViking session ID for context-aware search. If omitted in auto/deep mode, the current OpenCode session mapping will be used when available.",
              ),
            limit: z.number().optional().describe("Max results (default: 10)"),
            score_threshold: z.number().optional().describe("Optional minimum score threshold"),
          },
          async execute(args, context) {
            log("INFO", "memsearch", "Executing unified search", { args })

            // Auto-inject session_id if not provided
            let sessionId = args.session_id
            if (!sessionId && context.sessionID) {
              const mapping = sessionMap.get(context.sessionID)
              if (mapping) {
                sessionId = mapping.ovSessionId
                log("INFO", "memsearch", "Auto-injected session context", {
                  opencode_session: context.sessionID,
                  openviking_session: sessionId,
                })
              }
            }

            const mode = resolveSearchMode(args.mode, args.query, sessionId)
            const requestBody: {
              query: string
              limit: number
              target_uri?: string
              session_id?: string
              score_threshold?: number
            } = {
              query: args.query,
              limit: args.limit ?? 10,
            }
            if (args.target_uri) requestBody.target_uri = args.target_uri
            if (args.score_threshold !== undefined) requestBody.score_threshold = args.score_threshold
            if (mode === "deep" && sessionId) requestBody.session_id = sessionId

            try {
              const response = await makeRequest<OpenVikingResponse<SearchResult>>(config, {
                method: "POST",
                endpoint: mode === "deep" ? "/api/v1/search/search" : "/api/v1/search/find",
                body: requestBody,
                abortSignal: context.abort,
              })

              const result = unwrapResponse(response) ?? { memories: [], resources: [], skills: [], total: 0 }
              return formatSearchResults(result, "memsearch", args.query, {
                mode,
                query_plan: result.query_plan,
              })
            } catch (error: any) {
              log("ERROR", "memsearch", "Search failed", { error: error.message, args })
              return `Error: ${error.message}`
            }
          },
        },
      ),
    },

    "chat.message": async (input, output) => {
      try {
        if (!config.autoRecall?.enabled) return
        await runAutoRecall(config, input, output)
      } catch (error: any) {
        log("WARN", "recall", "Auto recall failed, skipping silently", {
          error: error?.message ?? String(error),
        })
      }
    },

    "experimental.session.compacting": async (hookInput, output) => {
      if (!config.autoCommitOnCompact) return

      const sessionId = hookInput.sessionID
      let mapping = sessionMap.get(sessionId)
      if (!mapping) {
        const ovSessionId = await ensureOpenVikingSession(sessionId, config)
        if (!ovSessionId) return
        mapping = {
          ovSessionId,
          createdAt: Date.now(),
          capturedMessages: new Set(),
          messageRoles: new Map(),
          pendingMessages: new Map(),
          sendingMessages: new Set(),
          lastCommitTime: undefined,
          commitInFlight: false,
        }
        sessionMap.set(sessionId, mapping)
      }

      try {
        await captureSessionMessagesFromClient(input.client, sessionId, mapping, config)
        await flushPendingMessages(sessionId, mapping, config)

        if (mapping.commitInFlight) {
          await waitForCommitCompletion(mapping, sessionId, config, undefined, Math.max(config.timeoutMs, 180000))
        }

        if (mapping.capturedMessages.size > 0 || mapping.pendingMessages.size > 0) {
          await runSynchronousCommit(mapping, sessionId, config)
        }

        output.context.push(
          [
            "## OpenViking Memory",
            `The current OpenCode session has been committed to OpenViking session ${mapping.ovSessionId} before compaction.`,
            "Future turns can use OpenViking tools to retrieve memories, resources, and archived session context.",
          ].join("\n"),
        )
        log("INFO", "compact", "Committed OpenViking session before OpenCode compaction", {
          opencode_session: sessionId,
          openviking_session: mapping.ovSessionId,
        })
      } catch (error: any) {
        log("ERROR", "compact", "Pre-compact OpenViking commit failed; preserving state", {
          opencode_session: sessionId,
          openviking_session: mapping.ovSessionId,
          error: error?.message ?? String(error),
        })
      } finally {
        debouncedSaveSessionMap()
      }
    },

    "shell.env": async (_hookInput, output) => {
      output.env.OPENVIKING_URL = config.endpoint
      output.env.OPENVIKING_BASE_URL = config.endpoint
      if (config.apiKey) output.env.OPENVIKING_API_KEY = config.apiKey
      if (config.account) output.env.OPENVIKING_ACCOUNT = config.account
      if (config.user) output.env.OPENVIKING_USER = config.user
      if (config.agent) output.env.OPENVIKING_AGENT_ID = config.agent
    },

    "experimental.chat.system.transform": async (_hookInput, output) => {
      output.system.push(
        [
          "## OpenViking Memory",
          "OpenViking long-term memory is active in this OpenCode session.",
          "Relevant memories may be automatically injected into user turns.",
          "For manual memory and resource operations, use the openviking_* tools.",
          "Do not store secrets, passwords, private keys, customer data, or personal privacy data unless it is safely redacted.",
        ].join("\n"),
      )
    },

    dispose: async () => {
      // Flush any pending debounced save
      if (saveTimer) {
        clearTimeout(saveTimer)
        await saveSessionMap()
      }
      // Stop auto-commit scheduler
      stopAutoCommit()
      log("INFO", "plugin", "OpenViking Memory Plugin stopped")
    }
  }
}

export default OpenVikingMemoryPlugin
