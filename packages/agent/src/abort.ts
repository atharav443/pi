// Bounded, browser-compatible capture of where and why a live agent run was aborted.

/** Diagnostic detail for the first abort of a live run. */
export interface AbortProvenance {
	/** Full UUID of the run that was aborted. */
	runId: string;
	/** Normalized caller-supplied reason, when one was provided. */
	reason?: string;
	/** Caller stack frames, nearest first. */
	caller: readonly string[];
	/** ISO 8601 time at which the abort was observed. */
	timestamp: string;
}

const MAX_REASON_LENGTH = 200;
const MAX_CALLER_FRAMES = 6;
const MAX_CALLER_FRAME_LENGTH = 160;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Collapse control characters to spaces, trim, and cap a reason at 200 characters.
 *
 * Returns `undefined` for missing or empty reasons so records omit the field.
 */
export function normalizeAbortReason(reason: string | undefined): string | undefined {
	if (reason === undefined) return undefined;
	const normalized = reason.replace(CONTROL_CHARACTERS, " ").trim();
	if (normalized.length === 0) return undefined;
	return normalized.slice(0, MAX_REASON_LENGTH).trimEnd();
}

/**
 * Capture up to six caller stack frames, nearest first, each capped at 160 characters.
 *
 * `skip` is the function whose frame marks the capture boundary, typically the
 * abort implementation. Uses V8's `Error.captureStackTrace` when the host
 * provides it and falls back to parsing `Error.stack` in browsers. Node
 * internal frames are excluded; no Node imports are required.
 *
 * Provenance is diagnostics only: a host whose stack capture or formatter throws
 * yields no frames, so it can never prevent the abort itself.
 */
export function captureAbortCaller(skip: () => unknown): string[] {
	try {
		const error = new Error();
		// Browser hosts lack V8's captureStackTrace even though Node's typings declare it.
		if (typeof Error.captureStackTrace === "function") {
			Error.captureStackTrace(error, skip);
			return boundCallerFrames(parseStackFrames(error.stack, true));
		}
		return boundCallerFrames(dropFallbackFrames(parseStackFrames(error.stack, false), skip.name));
	} catch {
		// Hosts with a throwing stack formatter yield no frames; the abort itself still runs.
		return [];
	}
}

/**
 * Parse the frame lines of a stack.
 *
 * V8 formats frames as `at fn (url:line:col)`, with `callerOpt` already removing
 * the frames above the capture boundary. Firefox and Safari format them as
 * `fn@url:line:col` or `@url:line:col`, so those hosts drop the boundary by
 * function name afterwards.
 */
function parseStackFrames(stack: string | undefined, v8: boolean): string[] {
	if (stack === undefined) return [];
	const frames: string[] = [];
	for (const line of stack.split("\n")) {
		const frame = line.trim();
		if (frame.startsWith("at ")) {
			if (frame.includes("captureAbortCaller") || frame.includes("node:internal/")) continue;
			frames.push(frame);
		} else if (!v8 && frame.includes("@")) {
			if (frame.startsWith("captureAbortCaller@")) continue;
			frames.push(frame);
		}
	}
	return frames;
}

function dropFallbackFrames(frames: string[], skipName: string): string[] {
	if (skipName.length === 0) return frames;
	const skipIndex = frames.findIndex((frame) => frame.includes(`${skipName} (`) || frame.includes(`${skipName}@`));
	return skipIndex === -1 ? frames : frames.slice(skipIndex + 1);
}

function boundCallerFrames(frames: string[]): string[] {
	return frames.slice(0, MAX_CALLER_FRAMES).map((frame) => frame.slice(0, MAX_CALLER_FRAME_LENGTH));
}
