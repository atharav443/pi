/**
 * Regression #12027: AgentSession abort provenance records.
 *
 * Every case points `PI_CODING_AGENT_DIR` at a temp directory so the abort log
 * never touches the user's real `~/.pi/agent/aborts.json`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERSION } from "../../../src/config.ts";
import { type AbortRecord, readAbortLog } from "../../../src/core/abort-log.ts";
import type { ExtensionBindings } from "../../../src/core/agent-session.ts";
import type { ExtensionContext } from "../../../src/core/extensions/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** A provider request that stays open until the run signal aborts, then reports the abort. */
function blockedResponse(onRequest: () => void): FauxResponseStep {
	return async (_context, options) => {
		onRequest();
		const signal = options?.signal;
		if (signal && !signal.aborted) {
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
		}
		return fauxAssistantMessage("aborted", { stopReason: "aborted" });
	};
}

describe("abort provenance (#12027)", () => {
	const harnesses: Harness[] = [];
	const agentDirs: string[] = [];
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		previousAgentDir = undefined;
		while (agentDirs.length > 0) {
			const dir = agentDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function useTempAgentDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-abort-provenance-"));
		agentDirs.push(dir);
		process.env.PI_CODING_AGENT_DIR = dir;
		return dir;
	}

	function readRecords(agentDir: string): AbortRecord[] {
		return readAbortLog(join(agentDir, "aborts.json"));
	}

	it("records a live request abort with the outer caller and low-level run id", async () => {
		const agentDir = useTempAgentDir();
		const harness = await createHarness();
		harnesses.push(harness);
		const requestStarted = deferred();
		harness.setResponses([blockedResponse(() => requestStarted.resolve())]);

		const prompt = harness.session.prompt("abort me");
		await requestStarted.promise;
		expect(harness.session.isStreaming).toBe(true);
		await harness.session.abort("user");
		await prompt;

		const records = readRecords(agentDir);
		expect(records).toHaveLength(1);
		const record = records[0];
		expect(record.scope).toBe("agent_request");
		expect(record.reason).toBe("user");
		expect(record.runId).toMatch(UUID_PATTERN);
		expect(record.requestRunId).toMatch(UUID_PATTERN);
		expect(record.requestRunId).not.toBe(record.runId);
		expect(record.caller[0]).toContain("12027-abort-provenance.test.ts");
		expect(record.caller.length).toBeLessThanOrEqual(6);
		expect(record.timestamp).toMatch(ISO_PATTERN);
		expect(record.version).toBe(VERSION);
		expect(record.sessionId).toBe(harness.session.sessionId);
		expect(record.sessionFile).toBeUndefined();
		expect(typeof record.sessionLeafId).toBe("string");
		expect(record.cwd).toBe(harness.tempDir);
		expect(record.pid).toBe(process.pid);
	});

	it("writes nothing when aborting an idle session", async () => {
		const agentDir = useTempAgentDir();
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.abort("user");

		expect(readRecords(agentDir)).toEqual([]);
	});

	it("records an abort requested during before_agent_start once, as between_requests", async () => {
		const agentDir = useTempAgentDir();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (_event, ctx) => {
						void ctx.abort();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		await harness.session.prompt("start then abort");

		const records = readRecords(agentDir);
		expect(records).toHaveLength(1);
		expect(records[0].scope).toBe("between_requests");
		expect(records[0].reason).toBe("extension");
		expect(records[0].runId).toMatch(UUID_PATTERN);
		expect(records[0].requestRunId).toBeUndefined();
	});

	it("records an abort requested during agent_before_settle as before_settle", async () => {
		const agentDir = useTempAgentDir();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", (_event, ctx) => {
						void ctx.abort();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("finish then abort");

		const records = readRecords(agentDir);
		expect(records).toHaveLength(1);
		expect(records[0].scope).toBe("before_settle");
		expect(records[0].reason).toBe("extension");
		expect(records[0].runId).toMatch(UUID_PATTERN);
		expect(records[0].requestRunId).toBeUndefined();
	});

	it("records one abort per logical run and keeps the first reason", async () => {
		const agentDir = useTempAgentDir();
		const harness = await createHarness();
		harnesses.push(harness);
		const requestStarted = deferred();
		harness.setResponses([blockedResponse(() => requestStarted.resolve())]);

		const prompt = harness.session.prompt("abort me");
		await requestStarted.promise;
		const first = harness.session.abort("user");
		const second = harness.session.abort("rpc");
		await Promise.all([first, second, prompt]);

		const records = readRecords(agentDir);
		expect(records).toHaveLength(1);
		expect(records[0].reason).toBe("user");
	});

	it("assigns a new logical run id to each aborted run", async () => {
		const agentDir = useTempAgentDir();
		const harness = await createHarness();
		harnesses.push(harness);

		for (const [index, reason] of ["user", "rpc"].entries()) {
			const requestStarted = deferred();
			harness.appendResponses([blockedResponse(() => requestStarted.resolve())]);
			const prompt = harness.session.prompt(`abort ${index}`);
			await requestStarted.promise;
			await harness.session.abort(reason);
			await prompt;
		}

		const records = readRecords(agentDir);
		expect(records.map((record) => record.reason)).toEqual(["user", "rpc"]);
		expect(records[0].runId).toMatch(UUID_PATTERN);
		expect(records[1].runId).toMatch(UUID_PATTERN);
		expect(records[0].runId).not.toBe(records[1].runId);
	});

	it("records disposal of an active run and stops observing afterwards", async () => {
		const agentDir = useTempAgentDir();
		const harness = await createHarness();
		harnesses.push(harness);
		const requestStarted = deferred();
		harness.setResponses([blockedResponse(() => requestStarted.resolve())]);

		const prompt = harness.session.prompt("abort me");
		await requestStarted.promise;
		harness.session.dispose();
		await prompt;

		const records = readRecords(agentDir);
		expect(records).toHaveLength(1);
		expect(records[0].reason).toBe("session.dispose");
		expect(records[0].scope).toBe("agent_request");
		expect(records[0].requestRunId).toMatch(UUID_PATTERN);

		// A later direct agent abort would be recorded by a leaked observer.
		const directStarted = deferred();
		harness.setResponses([blockedResponse(() => directStarted.resolve())]);
		const directRun = harness.session.agent.prompt("direct after dispose");
		await directStarted.promise;
		harness.session.agent.abort("detached");
		await directRun;

		expect(readRecords(agentDir)).toHaveLength(1);
	});

	it("records a direct agent abort outside a session run", async () => {
		const agentDir = useTempAgentDir();
		const harness = await createHarness();
		harnesses.push(harness);
		const requestStarted = deferred();
		harness.setResponses([blockedResponse(() => requestStarted.resolve())]);

		const directRun = harness.session.agent.prompt("direct");
		await requestStarted.promise;
		harness.session.agent.abort("embedder");
		await directRun;

		const records = readRecords(agentDir);
		expect(records).toHaveLength(1);
		expect(records[0].scope).toBe("agent_request");
		expect(records[0].reason).toBe("embedder");
		expect(records[0].requestRunId).toMatch(UUID_PATTERN);
	});

	it("gives each direct agent abort its own logical identity", async () => {
		const agentDir = useTempAgentDir();
		const harness = await createHarness();
		harnesses.push(harness);

		for (const [index, reason] of ["direct-one", "direct-two"].entries()) {
			const requestStarted = deferred();
			harness.appendResponses([blockedResponse(() => requestStarted.resolve())]);
			const run = harness.session.agent.prompt(`direct ${index}`);
			await requestStarted.promise;
			harness.session.agent.abort(reason);
			await run;
		}

		const records = readRecords(agentDir);
		expect(records.map((record) => record.reason)).toEqual(["direct-one", "direct-two"]);
		expect(records[0].runId).toMatch(UUID_PATTERN);
		expect(records[1].runId).toMatch(UUID_PATTERN);
		expect(records[0].runId).not.toBe(records[1].runId);
		// Outside a session run the direct Agent run is the logical run, so both ids name it.
		for (const record of records) {
			expect(record.runId).toBe(record.requestRunId);
		}
	});

	it("writes no record when disposing before the run reaches the agent", async () => {
		const agentDir = useTempAgentDir();
		const startupReached = deferred();
		const releaseStartup = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						startupReached.resolve();
						await releaseStartup.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("after dispose")]);

		const prompt = harness.session.prompt("start then dispose");
		await startupReached.promise;
		harness.session.dispose();
		expect(readRecords(agentDir)).toEqual([]);

		releaseStartup.resolve();
		await prompt;
		expect(readRecords(agentDir)).toEqual([]);
	});

	it("writes no record when disposing during agent_before_settle", async () => {
		const agentDir = useTempAgentDir();
		let harness: Harness | undefined;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => {
						harness?.session.dispose();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("finish then dispose");

		expect(readRecords(agentDir)).toEqual([]);
	});

	it("keeps cancellation working when the abort log cannot be written", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const blockerDir = mkdtempSync(join(tmpdir(), "pi-abort-provenance-"));
		agentDirs.push(blockerDir);
		const fileAsAgentDir = join(blockerDir, "agent-dir");
		writeFileSync(fileAsAgentDir, "not a directory");
		process.env.PI_CODING_AGENT_DIR = fileAsAgentDir;
		const requestStarted = deferred();
		harness.setResponses([blockedResponse(() => requestStarted.resolve())]);

		const prompt = harness.session.prompt("abort me");
		await requestStarted.promise;
		await harness.session.abort("user");
		await prompt;

		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.messages.at(-1)?.role).toBe("assistant");
		expect(readAbortLog(join(fileAsAgentDir, "aborts.json"))).toEqual([]);
	});

	it("keeps the abort reason out of the transcript and the next request", async () => {
		const agentDir = useTempAgentDir();
		const harness = await createHarness();
		harnesses.push(harness);
		const nextContexts: string[] = [];
		const requestStarted = deferred();
		harness.setResponses([
			blockedResponse(() => requestStarted.resolve()),
			(context) => {
				nextContexts.push(JSON.stringify(context));
				return fauxAssistantMessage("recovered");
			},
		]);

		const prompt = harness.session.prompt("abort me");
		await requestStarted.promise;
		await harness.session.abort("marker-12027");
		await prompt;
		const records = readRecords(agentDir);
		expect(records).toHaveLength(1);
		expect(records[0].reason).toBe("marker-12027");

		const transcript = JSON.stringify(harness.session.messages);
		await harness.session.prompt("next request");

		expect(nextContexts).toHaveLength(1);
		expect(transcript).not.toContain("marker-12027");
		expect(transcript).not.toContain("aborts.json");
		expect(nextContexts[0]).not.toContain("marker-12027");
		expect(nextContexts[0]).not.toContain("aborts.json");
		expect(readRecords(agentDir)).toHaveLength(1);
	});
});

describe("interactive abort reasons (#12027)", () => {
	it("the queue-restore helper labels extension aborts and defaults to user", () => {
		const abortReasons: string[] = [];
		let queue = { steering: [] as string[], followUp: [] as string[] };
		const fakeThis = {
			clearAllQueues: () => queue,
			updatePendingMessagesDisplay: () => {},
			editor: { getText: () => "", getExpandedText: () => "", setText: () => {} },
			session: {
				abort: (reason: string) => {
					abortReasons.push(reason);
					return Promise.resolve();
				},
			},
		};
		const restore = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor");

		Reflect.apply(restore, fakeThis, [{ abort: true, abortReason: "extension" }]);
		queue = { steering: ["queued"], followUp: [] };
		Reflect.apply(restore, fakeThis, [{ abort: true }]);

		expect(abortReasons).toEqual(["extension", "user"]);
	});

	it("the bound extension abort handler labels its abort as extension", async () => {
		const restored: Array<{ abort?: boolean; abortReason?: string }> = [];
		let captured: ExtensionBindings | undefined;
		const fakeThis = {
			createExtensionUIContext: () => ({}),
			session: {
				bindExtensions: async (options: ExtensionBindings) => {
					captured = options;
				},
				resourceLoader: { getThemes: () => ({ themes: [], diagnostics: [] }) },
				extensionRunner: undefined,
			},
			setupAutocompleteProvider: () => {},
			setupExtensionShortcuts: () => {},
			showLoadedResources: () => {},
			showStartupNoticesIfNeeded: () => {},
			restoreQueuedMessagesToEditor: (options?: { abort?: boolean; abortReason?: string }) => {
				restored.push(options ?? {});
				return 0;
			},
		};
		const bind = Reflect.get(InteractiveMode.prototype, "bindCurrentSessionExtensions");

		await Reflect.apply(bind, fakeThis, []);
		captured?.abortHandler?.();

		expect(restored).toEqual([{ abort: true, abortReason: "extension" }]);
	});

	it("the extension shortcut context labels its abort as extension", () => {
		const restored: Array<{ abort?: boolean; abortReason?: string }> = [];
		let capturedContext: ExtensionContext | undefined;
		const defaultEditor: { onExtensionShortcut?: (data: string) => boolean } = {};
		const fakeThis = {
			keybindings: { getEffectiveConfig: () => ({}) },
			createExtensionUIContext: () => ({}),
			sessionManager: { getCwd: () => "/tmp" },
			settingsManager: { isProjectTrusted: () => true },
			session: {
				model: undefined,
				scopedModels: [],
				thinkingLevel: "off",
				agent: { signal: undefined },
				pendingMessageCount: 0,
				getContextUsage: () => undefined,
				systemPrompt: "",
			},
			defaultEditor,
			restoreQueuedMessagesToEditor: (options?: { abort?: boolean; abortReason?: string }) => {
				restored.push(options ?? {});
				return 0;
			},
		};
		const runner = {
			getShortcuts: () =>
				new Map([
					[
						"ctrl+g",
						{
							handler: (ctx: ExtensionContext) => {
								capturedContext = ctx;
							},
						},
					],
				]),
			getModelRegistry: () => undefined,
		};
		const setup = Reflect.get(InteractiveMode.prototype, "setupExtensionShortcuts");

		Reflect.apply(setup, fakeThis, [runner]);
		// Terminal input for ctrl+g is the control character, not the key-id text.
		expect(defaultEditor.onExtensionShortcut?.(String.fromCharCode(7))).toBe(true);
		capturedContext?.abort();

		expect(restored).toEqual([{ abort: true, abortReason: "extension" }]);
	});
});
