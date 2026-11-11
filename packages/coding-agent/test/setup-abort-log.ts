/**
 * Keeps every coding-agent test away from the user's real agent directory.
 *
 * Aborting a session writes `aborts.json` under the agent directory, so an
 * unfixed test would touch the user's real log. Each test file gets its own
 * temp directory, removed after its tests; abort records are written
 * synchronously, so no pending write outlives the teardown.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const previousAgentDir = process.env[ENV_AGENT_DIR];
const agentDir = mkdtempSync(join(tmpdir(), "pi-coding-agent-test-"));

process.env[ENV_AGENT_DIR] = agentDir;

afterAll(() => {
	if (previousAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = previousAgentDir;
	}
	rmSync(agentDir, { recursive: true, force: true });
});
