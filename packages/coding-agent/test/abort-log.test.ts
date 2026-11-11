import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AbortRecord, readAbortLog, recordAbort } from "../src/core/abort-log.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-abort-log-"));
	tempDirs.push(dir);
	return dir;
}

function sampleRecord(overrides: Partial<AbortRecord> = {}): AbortRecord {
	return {
		timestamp: "2026-01-02T03:04:05.000Z",
		runId: "7f6c2f7a-2f7e-4a0e-9a3a-0f3aa8f5c6b1",
		scope: "agent_request",
		caller: ["AgentSession.abort (file:///repo/src/core/agent-session.ts:1234:5)"],
		version: "1.5.2",
		sessionId: "session-1",
		cwd: "/repo",
		pid: 4242,
		...overrides,
	};
}

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

// #12027
describe("abort log", () => {
	it("round-trips records including optional fields", async () => {
		const path = join(await createTempDir(), "aborts.json");
		const liveRequest = sampleRecord({ requestRunId: "request-run-1", reason: "sdk" });
		const settled = sampleRecord({
			runId: "9a1d5c3e-4b2f-4c8d-8e7f-1a2b3c4d5e6f",
			scope: "between_requests",
			caller: [
				"AgentSession.abort (file:///repo/src/core/agent-session.ts:1250:5)",
				"runner (file:///repo/x.ts:1:1)",
			],
			sessionFile: "/repo/session.jsonl",
			sessionLeafId: "leaf-1",
			pid: 1,
		});

		recordAbort(liveRequest, path);
		recordAbort(settled, path);

		expect(readAbortLog(path)).toEqual([liveRequest, settled]);
		const written: unknown = JSON.parse(await readFile(path, "utf8"));
		expect(written).toHaveLength(2);
		expect(await readFile(path, "utf8")).toMatch(/\n$/);
	});

	it("keeps only the latest 20 records", async () => {
		const path = join(await createTempDir(), "aborts.json");
		for (let index = 0; index < 25; index++) {
			recordAbort(sampleRecord({ runId: `run-${index}` }), path);
		}

		const records = readAbortLog(path);
		expect(records.map((record) => record.runId)).toEqual(
			Array.from({ length: 20 }, (_, index) => `run-${index + 5}`),
		);
		const written: unknown = JSON.parse(await readFile(path, "utf8"));
		expect(written).toHaveLength(20);
	});

	it("returns an empty list when the file is absent or corrupt", async () => {
		const dir = await createTempDir();
		expect(readAbortLog(join(dir, "missing.json"))).toEqual([]);

		const corrupt = join(dir, "corrupt.json");
		await writeFile(corrupt, "{not json", "utf8");
		expect(readAbortLog(corrupt)).toEqual([]);

		const notAnArray = join(dir, "object.json");
		await writeFile(notAnArray, JSON.stringify({ timestamp: "2026-01-02T03:04:05.000Z" }), "utf8");
		expect(readAbortLog(notAnArray)).toEqual([]);
	});

	it("drops records with invalid required or optional fields", async () => {
		const path = join(await createTempDir(), "aborts.json");
		const valid = sampleRecord();
		const fullyPopulated = sampleRecord({
			runId: "9a1d5c3e-4b2f-4c8d-8e7f-1a2b3c4d5e6f",
			requestRunId: "request-run-1",
			reason: "user",
			sessionFile: "/repo/session.jsonl",
			sessionLeafId: "leaf-1",
		});
		const entries: unknown[] = [
			valid,
			fullyPopulated,
			{ ...valid, runId: 7 },
			{ ...valid, version: null },
			{ ...valid, sessionId: ["session-1"] },
			{ ...valid, cwd: undefined },
			{ ...valid, scope: "unknown_scope" },
			{ ...valid, caller: "frame" },
			{ ...valid, caller: ["frame", 3] },
			{ ...valid, requestRunId: 42 },
			{ ...valid, reason: { text: "sdk" } },
			{ ...valid, sessionFile: 7 },
			{ ...valid, sessionLeafId: false },
			{ ...valid, pid: "4242" },
			null,
			"not a record",
			7,
		];
		await writeFile(path, JSON.stringify(entries), "utf8");

		expect(readAbortLog(path)).toEqual([valid, fullyPopulated]);
	});

	it("does not throw when the log cannot be written", async () => {
		const dir = await createTempDir();
		const blocker = join(dir, "blocker");
		await writeFile(blocker, "not a directory", "utf8");

		expect(() => recordAbort(sampleRecord(), join(blocker, "aborts.json"))).not.toThrow();
		expect(readAbortLog(join(blocker, "aborts.json"))).toEqual([]);

		expect(() => recordAbort(sampleRecord(), dir)).not.toThrow();
		expect(readAbortLog(dir)).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("creates the log with 0600 permissions", async () => {
		const path = join(await createTempDir(), "aborts.json");

		recordAbort(sampleRecord(), path);

		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("writes to the configured agent directory by default", async () => {
		const dir = await createTempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", dir);

		recordAbort(sampleRecord());

		expect(readAbortLog(join(dir, "aborts.json"))).toEqual([sampleRecord()]);
	});
});
