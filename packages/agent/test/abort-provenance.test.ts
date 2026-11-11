// Focused regression coverage for abort provenance (#12027).

import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type AbortProvenance, Agent, captureAbortCaller, normalizeAbortReason, type StreamFn } from "../src/index.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createAssistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/** A stream that stays open until the run signal aborts, plus a way to await each stream start. */
function createHangingStream(): { streamFn: StreamFn; nextSignal: () => Promise<AbortSignal | undefined> } {
	const signals: Array<AbortSignal | undefined> = [];
	const waiters: Array<(signal: AbortSignal | undefined) => void> = [];

	const streamFn: StreamFn = (_model, _context, options) => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: createAssistantMessage("") });
		options?.signal?.addEventListener(
			"abort",
			() =>
				stream.push({
					type: "error",
					reason: "aborted",
					error: createAssistantMessage("Aborted", "aborted"),
				}),
			{ once: true },
		);
		const waiter = waiters.shift();
		if (waiter) waiter(options?.signal);
		else signals.push(options?.signal);
		return stream;
	};

	const nextSignal = (): Promise<AbortSignal | undefined> => {
		if (signals.length > 0) return Promise.resolve(signals.shift());
		return new Promise((resolve) => waiters.push(resolve));
	};

	return { streamFn, nextSignal };
}

function fallbackBoundary(): void {}

function abortFallbackFixture(): void {}

function installNonV8Stack(stack: string): () => void {
	const originalCapture = Error.captureStackTrace;
	const originalPrepare = Error.prepareStackTrace;
	Object.defineProperty(Error, "captureStackTrace", { configurable: true, value: undefined, writable: true });
	Object.defineProperty(Error, "prepareStackTrace", {
		configurable: true,
		value: () => stack,
		writable: true,
	});
	return () => {
		Object.defineProperty(Error, "captureStackTrace", {
			configurable: true,
			value: originalCapture,
			writable: true,
		});
		Object.defineProperty(Error, "prepareStackTrace", {
			configurable: true,
			value: originalPrepare,
			writable: true,
		});
	};
}

describe("abort provenance (#12027)", () => {
	it("keeps the standard AbortError signal reason", async () => {
		const hanging = createHangingStream();
		const agent = new Agent({ streamFn: hanging.streamFn });

		const prompt = agent.prompt("Hello");
		const signal = await hanging.nextSignal();
		agent.abort("sdk");

		expect(signal?.aborted).toBe(true);
		expect(signal?.reason).toBeInstanceOf(DOMException);
		expect(signal?.reason.name).toBe("AbortError");
		await prompt;
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("attributes the abort to the nearest caller frame", async () => {
		const hanging = createHangingStream();
		const observed: AbortProvenance[] = [];
		const agent = new Agent({ onAbort: (provenance) => observed.push(provenance), streamFn: hanging.streamFn });

		const prompt = agent.prompt("Hello");
		await hanging.nextSignal();
		agent.abort("user");
		await prompt;

		expect(observed).toHaveLength(1);
		expect(observed[0].reason).toBe("user");
		expect(observed[0].caller[0]).toContain("abort-provenance.test.ts");
	});

	it("assigns a unique full UUID to each run", async () => {
		const hanging = createHangingStream();
		const observed: AbortProvenance[] = [];
		const agent = new Agent({ onAbort: (provenance) => observed.push(provenance), streamFn: hanging.streamFn });

		const firstPrompt = agent.prompt("one");
		await hanging.nextSignal();
		agent.abort("one");
		await firstPrompt;

		const secondPrompt = agent.prompt("two");
		await hanging.nextSignal();
		agent.abort("two");
		await secondPrompt;

		expect(observed).toHaveLength(2);
		expect(observed[0].runId).toMatch(UUID_PATTERN);
		expect(observed[1].runId).toMatch(UUID_PATTERN);
		expect(observed[0].runId).not.toBe(observed[1].runId);
	});

	it("ignores duplicate and idle aborts", async () => {
		const hanging = createHangingStream();
		const observed: AbortProvenance[] = [];
		const agent = new Agent({ onAbort: (provenance) => observed.push(provenance), streamFn: hanging.streamFn });

		agent.abort("idle");

		const prompt = agent.prompt("Hello");
		await hanging.nextSignal();
		agent.abort("first");
		agent.abort("second");
		await prompt;
		agent.abort("idle again");

		expect(observed).toHaveLength(1);
		expect(observed[0].reason).toBe("first");
	});

	it("bounds normalized reasons and caller frames", async () => {
		const hanging = createHangingStream();
		const observed: AbortProvenance[] = [];
		const agent = new Agent({ onAbort: (provenance) => observed.push(provenance), streamFn: hanging.streamFn });

		const prompt = agent.prompt("Hello");
		await hanging.nextSignal();
		agent.abort(`${"x".repeat(300)}\n\u0000\tignored`);
		await prompt;

		const provenance = observed[0];
		expect(provenance.reason).toBe("x".repeat(200));
		expect(provenance.caller.length).toBeLessThanOrEqual(6);
		for (const frame of provenance.caller) {
			expect(frame.length).toBeLessThanOrEqual(160);
		}
	});

	it("normalizes empty reasons to undefined", () => {
		expect(normalizeAbortReason(undefined)).toBeUndefined();
		expect(normalizeAbortReason(" \n\t\u0000 ")).toBeUndefined();
		expect(normalizeAbortReason("  user request  ")).toBe("user request");
	});

	it("isolates throwing observers and preserves constructor and observer callbacks", async () => {
		const hanging = createHangingStream();
		const calls: string[] = [];
		const agent = new Agent({
			onAbort: (provenance) => calls.push(`constructor:${provenance.reason}`),
			streamFn: hanging.streamFn,
		});
		agent.addAbortObserver(() => {
			throw new Error("observer failure");
		});
		agent.addAbortObserver((provenance) => calls.push(`observer:${provenance.reason}`));

		const prompt = agent.prompt("Hello");
		await hanging.nextSignal();
		expect(() => agent.abort("sdk")).not.toThrow();
		await prompt;

		expect(calls).toEqual(["constructor:sdk", "observer:sdk"]);
	});

	it("stops notifying after unsubscribe", async () => {
		const hanging = createHangingStream();
		const observed: AbortProvenance[] = [];
		const agent = new Agent({ streamFn: hanging.streamFn });
		const unsubscribe = agent.addAbortObserver((provenance) => observed.push(provenance));

		const firstPrompt = agent.prompt("one");
		await hanging.nextSignal();
		agent.abort("one");
		await firstPrompt;

		unsubscribe();

		const secondPrompt = agent.prompt("two");
		await hanging.nextSignal();
		agent.abort("two");
		await secondPrompt;

		expect(observed).toHaveLength(1);
	});

	it("falls back to Error.stack when captureStackTrace is unavailable", async () => {
		const original = Error.captureStackTrace;
		Object.defineProperty(Error, "captureStackTrace", { configurable: true, value: undefined, writable: true });
		try {
			const hanging = createHangingStream();
			const observed: AbortProvenance[] = [];
			const agent = new Agent({ onAbort: (provenance) => observed.push(provenance), streamFn: hanging.streamFn });

			const prompt = agent.prompt("Hello");
			await hanging.nextSignal();
			agent.abort("fallback");
			await prompt;

			expect(observed).toHaveLength(1);
			expect(observed[0].caller.length).toBeGreaterThan(0);
			expect(observed[0].caller[0]).toContain("abort-provenance.test.ts");
			for (const frame of observed[0].caller) {
				expect(frame).not.toContain("node:internal");
				expect(frame.length).toBeLessThanOrEqual(160);
			}
		} finally {
			Object.defineProperty(Error, "captureStackTrace", { configurable: true, value: original, writable: true });
		}
	});

	it("captures a bounded caller without captureStackTrace", () => {
		const original = Error.captureStackTrace;
		Object.defineProperty(Error, "captureStackTrace", { configurable: true, value: undefined, writable: true });
		try {
			const caller = captureAbortCaller(fallbackBoundary);

			expect(caller.length).toBeGreaterThan(0);
			expect(caller.length).toBeLessThanOrEqual(6);
			expect(caller[0]).toContain("abort-provenance.test.ts");
			expect(caller.join("\n")).not.toContain("node:internal");
		} finally {
			Object.defineProperty(Error, "captureStackTrace", { configurable: true, value: original, writable: true });
		}
	});

	it("parses non-V8 browser stack frames nearest first after the boundary", () => {
		const restore = installNonV8Stack(
			[
				"captureAbortCaller@http://localhost/agent/abort.js:10:9",
				"abortFallbackFixture@http://localhost/agent/agent.js:20:5",
				"fireAbort@http://localhost/app/app.js:30:3",
				"@http://localhost/app/app.js:40:1",
			].join("\n"),
		);
		try {
			const caller = captureAbortCaller(abortFallbackFixture);

			expect(caller).toEqual(["fireAbort@http://localhost/app/app.js:30:3", "@http://localhost/app/app.js:40:1"]);
		} finally {
			restore();
		}
	});

	it("yields no frames when host stack capture throws", () => {
		const original = Error.captureStackTrace;
		Object.defineProperty(Error, "captureStackTrace", {
			configurable: true,
			value: () => {
				throw new Error("capture failed");
			},
			writable: true,
		});
		try {
			expect(captureAbortCaller(fallbackBoundary)).toEqual([]);
		} finally {
			Object.defineProperty(Error, "captureStackTrace", { configurable: true, value: original, writable: true });
		}
	});

	it("keeps cancelling when stack capture throws", async () => {
		const hanging = createHangingStream();
		const observed: AbortProvenance[] = [];
		const agent = new Agent({ onAbort: (provenance) => observed.push(provenance), streamFn: hanging.streamFn });

		const prompt = agent.prompt("Hello");
		const signal = await hanging.nextSignal();
		const original = Error.captureStackTrace;
		Object.defineProperty(Error, "captureStackTrace", {
			configurable: true,
			value: () => {
				throw new Error("capture failed");
			},
			writable: true,
		});
		try {
			agent.abort("capture-failure");
		} finally {
			Object.defineProperty(Error, "captureStackTrace", { configurable: true, value: original, writable: true });
		}
		await prompt;

		expect(signal?.reason).toBeInstanceOf(DOMException);
		expect(signal?.reason.name).toBe("AbortError");
		expect(observed).toHaveLength(1);
		expect(observed[0].caller).toEqual([]);
		expect(observed[0].reason).toBe("capture-failure");
	});
});
