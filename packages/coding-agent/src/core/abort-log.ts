import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";

/** A local diagnostic record of why an agent run was aborted. */
export interface AbortRecord {
	timestamp: string;
	runId: string;
	requestRunId?: string;
	scope: "agent_request" | "between_requests" | "before_settle";
	reason?: string;
	caller: readonly string[];
	version: string;
	sessionId: string;
	sessionFile?: string;
	sessionLeafId?: string;
	cwd: string;
	pid: number;
}

const MAX_ABORT_RECORDS = 20;

/** Read the abort log, skipping absent, corrupt and invalid entries. */
export function readAbortLog(path = abortLogPath()): AbortRecord[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const records: AbortRecord[] = [];
	for (const entry of parsed) {
		const record = toAbortRecord(entry);
		if (record) records.push(record);
	}
	return records;
}

/** Append a record, keeping the latest 20. Disk errors are ignored: this is diagnostics only. */
export function recordAbort(record: AbortRecord, path = abortLogPath()): void {
	try {
		writeAbortLog([...readAbortLog(path), record].slice(-MAX_ABORT_RECORDS), path);
	} catch {
		return;
	}
}

function abortLogPath(): string {
	return join(getAgentDir(), "aborts.json");
}

function writeAbortLog(records: readonly AbortRecord[], path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
}

/** Marks an optional field that is present with the wrong type, which rejects its record. */
const INVALID = Symbol("invalid");

// The file is an unknown trust boundary: users, editors and older versions can put any JSON
// there, so every field is checked before it becomes an AbortRecord.
function toAbortRecord(value: unknown): AbortRecord | undefined {
	const timestamp = readRequiredString(value, "timestamp");
	const runId = readRequiredString(value, "runId");
	const version = readRequiredString(value, "version");
	const sessionId = readRequiredString(value, "sessionId");
	const cwd = readRequiredString(value, "cwd");
	const requestRunId = readOptionalString(value, "requestRunId");
	const scope = readField(value, "scope");
	const reason = readOptionalString(value, "reason");
	const caller = readField(value, "caller");
	const sessionFile = readOptionalString(value, "sessionFile");
	const sessionLeafId = readOptionalString(value, "sessionLeafId");
	const pid = readField(value, "pid");
	if (
		timestamp === undefined ||
		runId === undefined ||
		version === undefined ||
		sessionId === undefined ||
		cwd === undefined ||
		requestRunId === INVALID ||
		!isAbortScope(scope) ||
		reason === INVALID ||
		!isStringArray(caller) ||
		sessionFile === INVALID ||
		sessionLeafId === INVALID ||
		typeof pid !== "number"
	) {
		return undefined;
	}
	return {
		timestamp,
		runId,
		requestRunId,
		scope,
		reason,
		caller,
		version,
		sessionId,
		sessionFile,
		sessionLeafId,
		cwd,
		pid,
	};
}

const ABORT_SCOPES = ["agent_request", "between_requests", "before_settle"] as const;

function readField(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return Reflect.get(value, key);
}

function readRequiredString(value: unknown, key: string): string | undefined {
	const field = readField(value, key);
	return typeof field === "string" ? field : undefined;
}

function readOptionalString(value: unknown, key: string): string | undefined | typeof INVALID {
	const field = readField(value, key);
	if (field === undefined) return undefined;
	return typeof field === "string" ? field : INVALID;
}

function isAbortScope(value: unknown): value is AbortRecord["scope"] {
	return ABORT_SCOPES.some((scope) => scope === value);
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}
