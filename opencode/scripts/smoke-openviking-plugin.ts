import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"

type MockState = {
  messages: Array<{ sessionId: string; role: string; content: string }>
  commits: Array<{ sessionId: string }>
}

const state: MockState = {
  messages: [],
  commits: [],
}

async function readBody(request: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : {}
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

function createMockOpenVikingServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:1933")
    const pathname = url.pathname

    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, { status: "ok", result: "mock healthy" })
      return
    }

    if (request.method === "POST" && pathname === "/api/v1/search/find") {
      sendJson(response, 200, {
        status: "ok",
        result: {
          memories: [
            {
              uri: "viking://user/memories/preferences/docker-smoke.md",
              score: 0.91,
              title: "Docker smoke preference",
              abstract: "The user wants OpenCode plugins tested inside Docker before rollout.",
              content: "The user wants OpenCode plugins tested inside Docker before rollout.",
              category: "preferences",
              level: 2,
            },
          ],
          skills: [],
          total: 1,
        },
      })
      return
    }

    if (request.method === "GET" && pathname === "/api/v1/content/read") {
      sendJson(response, 200, { status: "ok", result: "mock memory content" })
      return
    }

    if (request.method === "POST" && pathname.match(/^\/api\/v1\/sessions\/[^/]+\/messages$/)) {
      const sessionId = decodeURIComponent(pathname.split("/")[4])
      const body = await readBody(request)
      state.messages.push({
        sessionId,
        role: body.role,
        content: body.content ?? "",
      })
      sendJson(response, 200, { status: "ok", result: { session_id: sessionId } })
      return
    }

    if (request.method === "POST" && pathname.match(/^\/api\/v1\/sessions\/[^/]+\/commit$/)) {
      const sessionId = decodeURIComponent(pathname.split("/")[4])
      state.commits.push({ sessionId })
      sendJson(response, 200, {
        status: "ok",
        result: {
          session_id: sessionId,
          status: "completed",
          archived: false,
          memories_extracted: 1,
        },
      })
      return
    }

    sendJson(response, 404, { status: "error", error: { message: `unhandled ${request.method} ${pathname}` } })
  })
}

const server = createMockOpenVikingServer()
const stateDir = await mkdtemp(path.join(tmpdir(), "ov-opencode-smoke-"))
server.listen(1933, "127.0.0.1")
await once(server, "listening")

try {
  process.env.OPENVIKING_URL = "http://127.0.0.1:1933"
  process.env.OPENVIKING_ACCOUNT = "smoke"
  process.env.OPENVIKING_USER = "docker_user"
  process.env.OPENVIKING_OPENCODE_STATE_DIR = stateDir

  const { default: OpenVikingMemoryPlugin } = await import("../openviking-memory.ts")

  const sessionID = "oc-smoke-session"
  const fakeClient = {
    session: {
      async messages() {
        return {
          data: [
            {
              info: { id: "msg-user-1", role: "user" },
              parts: [{ type: "text", text: "Please remember that Docker smoke tests matter." }],
            },
            {
              info: { id: "msg-assistant-1", role: "assistant" },
              parts: [{ type: "text", text: "I will verify the plugin inside Docker." }],
            },
          ],
        }
      },
    },
  }

  const hooks = await OpenVikingMemoryPlugin({
    client: fakeClient,
    project: { id: "project-smoke", name: "smoke" },
    directory: "/workspace",
    worktree: "/workspace",
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: undefined,
  } as any)

  assert.equal(typeof hooks.event, "function", "event hook should be registered")
  assert.equal(typeof hooks["chat.message"], "function", "chat.message hook should be registered")
  assert.equal(typeof hooks["experimental.session.compacting"], "function", "compacting hook should be registered")
  assert.equal(hooks.tool, undefined, "Codex-aligned plugin should not expose custom tools")

  await hooks.event!({
    event: {
      id: "evt-message-updated",
      type: "message.updated",
      properties: { info: { id: "msg-stream", sessionID, role: "user" } },
    } as any,
  })
  await hooks.event!({
    event: {
      id: "evt-message-part-updated",
      type: "message.part.updated",
      properties: { part: { sessionID, messageID: "msg-stream", type: "text", text: "streaming text" } },
    } as any,
  })
  assert.equal(state.messages.length, 0, "message.* events should not write to OpenViking")

  const output = {
    message: { id: "msg-user-2", role: "user" },
    parts: [{ id: "part-user-2", type: "text", text: "What should we remember about Docker tests?", messageID: "msg-user-2" }],
  }
  await hooks["chat.message"]!({ sessionID } as any, output as any)
  assert.match(output.parts[0].text, /<openviking-context/, "chat.message should inject OpenViking context")
  assert.match(output.parts[0].text, /docker-smoke\.md/, "injected memory should include mock URI")

  await hooks.event!({
    event: {
      id: "evt-session-idle",
      type: "session.idle",
      properties: { sessionID },
    } as any,
  })

  assert.equal(state.messages.length, 2, "session.idle should capture user and assistant messages")
  assert.equal(state.messages[0].sessionId, `docker_user-opencode-${sessionID}`)

  const compactOutput = { context: [] as string[], prompt: undefined as string | undefined }
  await hooks["experimental.session.compacting"]!({ sessionID }, compactOutput)
  assert.equal(state.commits.length, 1, "compacting hook should commit the OpenViking session")
  assert.match(compactOutput.context.join("\n"), /OpenViking session docker_user-opencode-oc-smoke-session is committed/)

  await hooks.dispose?.()
  console.log("OpenViking OpenCode plugin smoke test passed")
} finally {
  server.close()
  await rm(stateDir, { recursive: true, force: true })
}
