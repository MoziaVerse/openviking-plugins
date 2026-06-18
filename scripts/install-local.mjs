#!/usr/bin/env node

import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const targetDir = join(homedir(), ".config", "opencode", "plugins")

await mkdir(targetDir, { recursive: true })

const pluginTarget = join(targetDir, "openviking-memory.ts")

await copyFile(join(root, "openviking-memory.ts"), pluginTarget)

console.log(`Installed OpenViking OpenCode plugin to ${pluginTarget}`)
console.log("Config: uses OPENVIKING_* env vars or ~/.openviking/ovcli.conf by default")
