#!/usr/bin/env node

import { copyFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const targetDir = join(homedir(), ".config", "opencode", "plugins")

await mkdir(targetDir, { recursive: true })

const pluginTarget = join(targetDir, "openviking-memory.ts")
const configTarget = join(targetDir, "openviking-config.json")
const hadConfig = existsSync(configTarget)

await copyFile(join(root, "openviking-memory.ts"), pluginTarget)

if (!hadConfig) {
  await copyFile(join(root, "openviking-config.example.json"), configTarget)
}

console.log(`Installed OpenViking OpenCode plugin to ${pluginTarget}`)
console.log(`Config: ${configTarget}${hadConfig ? " (kept existing file)" : " (created from template)"}`)
