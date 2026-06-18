import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deriveOvSessionId } from "./ov-session.mjs";

const originalEnv = {
  user: process.env.OPENVIKING_USER,
  account: process.env.OPENVIKING_ACCOUNT,
  configFile: process.env.OPENVIKING_CLI_CONFIG_FILE,
};

function restoreEnv() {
  if (originalEnv.user === undefined) delete process.env.OPENVIKING_USER;
  else process.env.OPENVIKING_USER = originalEnv.user;
  if (originalEnv.account === undefined) delete process.env.OPENVIKING_ACCOUNT;
  else process.env.OPENVIKING_ACCOUNT = originalEnv.account;
  if (originalEnv.configFile === undefined) delete process.env.OPENVIKING_CLI_CONFIG_FILE;
  else process.env.OPENVIKING_CLI_CONFIG_FILE = originalEnv.configFile;
}

test("deriveOvSessionId uses user + claude + session id", () => {
  process.env.OPENVIKING_USER = "zhangsan";
  delete process.env.OPENVIKING_ACCOUNT;

  assert.equal(
    deriveOvSessionId("session-123"),
    "zhangsan-claude-session-123",
  );
  assert.equal(
    deriveOvSessionId("session-123", "subagent:agent-abc"),
    "zhangsan-claude-session-123__agent-abc",
  );

  restoreEnv();
});

test("deriveOvSessionId falls back to ovcli user", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openviking-claude-session-test-"));
  const configFile = join(dir, "ovcli.conf");
  await writeFile(configFile, JSON.stringify({ user: "lisi" }));

  delete process.env.OPENVIKING_USER;
  delete process.env.OPENVIKING_ACCOUNT;
  process.env.OPENVIKING_CLI_CONFIG_FILE = configFile;

  try {
    assert.equal(deriveOvSessionId("session-456"), "lisi-claude-session-456");
  } finally {
    restoreEnv();
    await rm(dir, { recursive: true, force: true });
  }
});
