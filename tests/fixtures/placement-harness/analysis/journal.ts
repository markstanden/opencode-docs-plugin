/**
 * The one checked evidence boundary for the plugin's operation journal.
 *
 * The plugin can write an opt-in, HMAC-signed journal of served docs
 * operations. That journal is the only record of a nested Code Mode call, so
 * it is also the easiest evidence to forge. This module decides what the
 * journal proves, and nothing else in the harness or analyser may credit a
 * journal line it did not verify.
 *
 * Trust boundary: the signing key and the journal are both harness output,
 * copied after the trial process exits. A trial tool cannot acquire the key
 * during the run, so a correctly signed line with this run's session, message
 * and execute identities, matching a host-recorded dispatch one-to-one, is
 * evidence the plugin served that call. The key is held locally beside the
 * evidence; possession of that key is possession of the ability to forge, so
 * the verification is tamper-evident, not tamper-proof.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

/** The session and message identities observed in one run's CLI trail. */
export interface JournalIdentity {
    /** Session ids the run emitted. */
    sessions: ReadonlySet<string>;
    /** Message ids the run emitted. */
    messages: ReadonlySet<string>;
}

/** One docs dispatch the host recorded inside an execute result. */
export interface JournalDispatch {
    /** The journal's registered tool name (`docs` or `docs_search`). */
    tool: string;
    /** The dispatch status the host recorded. */
    status: string;
    /** The dispatch input the host recorded. */
    input: unknown;
}

/** One credited journal line. */
export interface CreditedJournalRecord {
    /** The zero-based line index. */
    index: number;
    /** The verified record, including its MAC. */
    record: Record<string, unknown>;
}

/** One rejected journal line and why. */
export interface RejectedJournalRecord {
    /** The zero-based line index. */
    index: number;
    /** A stable reason slug, suitable for diagnostics. */
    reason:
        | "not-json"
        | "not-served-twin"
        | "bad-mac"
        | "unattributed"
        | "no-host-dispatch";
}

/** The explicit result of verifying a journal. */
export type JournalVerification =
    | {
          /** No journal was captured: the pre-instrumentation status quo. */
          state: "absent";
          credited: [];
          rejected: [];
          problems: string[];
      }
    | {
          /** A journal exists but its signing key does not. Nothing is credited. */
          state: "unverifiable-key";
          credited: [];
          rejected: RejectedJournalRecord[];
          problems: string[];
      }
    | {
          /** The journal was verified; `credited` is the only usable evidence. */
          state: "verified";
          credited: CreditedJournalRecord[];
          rejected: RejectedJournalRecord[];
          problems: string[];
      };

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse one journal line, or undefined when it is not a JSON object. */
function parseLine(line: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

/** Whether a record names a served Code Mode twin call. */
export function isServedTwinRecord(
    record: Record<string, unknown>,
): boolean {
    if (record.schemaVersion !== 1) return false;
    if (record.tool !== "docs" && record.tool !== "docs_search") return false;
    if (record.surface !== "codemode-twin") return false;
    return isRecord(record.input);
}

/**
 * Whether a record's MAC matches the given key. The MAC covers every field
 * except `mac`, in the record's own member order, exactly as the plugin writes
 * it.
 * @param record The journal record.
 * @param key The run's signing key.
 * @returns True when the MAC is well formed and matches.
 */
export function journalMacValid(
    record: Record<string, unknown>,
    key: string,
): boolean {
    const mac = record.mac;
    if (typeof mac !== "string") return false;
    const body = Object.fromEntries(
        Object.entries(record).filter(([field]) => field !== "mac"),
    );
    const expected = createHmac("sha256", key)
        .update(JSON.stringify(body), "utf8")
        .digest("hex");
    const left = Buffer.from(expected, "hex");
    const right = Buffer.from(mac, "hex");
    return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether a record carries this run's observed identity and names an execute
 * call present in its trail.
 * @param record The journal record.
 * @param identity The run's observed session/message ids.
 * @param callIds The execute call ids in the run's trail.
 * @returns True when every identity matches exactly.
 */
export function journalRecordAttributed(
    record: Record<string, unknown>,
    identity: JournalIdentity,
    callIds: ReadonlySet<string>,
): boolean {
    if (
        typeof record.sessionID !== "string" ||
        !identity.sessions.has(record.sessionID)
    ) {
        return false;
    }
    if (
        typeof record.messageID !== "string" ||
        !identity.messages.has(record.messageID)
    ) {
        return false;
    }
    return typeof record.callID === "string" && callIds.has(record.callID);
}

/**
 * Consume one matching host dispatch, so two journal lines can never both
 * claim one dispatch.
 * @param dispatches The remaining dispatches.
 * @param record The journal record.
 * @returns True when one dispatch was consumed.
 */
function consumeDispatch(
    dispatches: JournalDispatch[],
    record: Record<string, unknown>,
): boolean {
    const match = dispatches.findIndex(
        (dispatch) =>
            dispatch.tool === record.tool &&
            dispatch.status === record.status &&
            isDeepStrictEqual(dispatch.input, record.input),
    );
    if (match < 0) return false;
    dispatches.splice(match, 1);
    return true;
}

/**
 * Verify one captured journal against this run's identity and host dispatches.
 *
 * Order matters: shape, then MAC, then identity, then one-to-one dispatch
 * matching. A line failing any step is rejected with its reason and is never
 * credited. If a journal exists but no usable key does, nothing is credited
 * and the state says why.
 * @param input The captured lines, key and run observations.
 * @param input.lines The captured journal lines, or undefined when absent.
 * @param input.key The run's signing key, or null when unavailable.
 * @param input.identity The run's observed session and message ids.
 * @param input.callIds The execute call ids in the run's trail.
 * @param input.dispatches The docs dispatches the host recorded.
 * @returns The explicit verification result.
 */
export function verifyOperationsJournal(input: {
    lines: readonly string[] | undefined;
    key: string | null | undefined;
    identity: JournalIdentity;
    callIds: ReadonlySet<string>;
    dispatches: readonly JournalDispatch[];
}): JournalVerification {
    if (input.lines === undefined) {
        return {
            state: "absent",
            credited: [],
            rejected: [],
            problems: [],
        };
    }
    const key =
        typeof input.key === "string" && input.key.trim() !== ""
            ? input.key.trim()
            : null;
    if (key === null) {
        return {
            state: "unverifiable-key",
            credited: [],
            rejected: input.lines.flatMap((line, index) =>
                line.trim() === "" ? [] : [{ index, reason: "not-json" as const }],
            ),
            problems: [
                "a docs-operation journal exists without a usable signing key; no journal line is credited",
            ],
        };
    }
    const dispatches = [...input.dispatches];
    const credited: CreditedJournalRecord[] = [];
    const rejected: RejectedJournalRecord[] = [];
    for (const [index, line] of input.lines.entries()) {
        const outcome = verifyLine(line, index, key, input, dispatches);
        if (outcome.rejected !== undefined) rejected.push(outcome.rejected);
        if (outcome.credited !== undefined) credited.push(outcome.credited);
    }
    return { state: "verified", credited, rejected, problems: [] };
}

/**
 * Verify one journal line and consume its host dispatch when it is credited.
 * @param line The raw line.
 * @param index The zero-based line index.
 * @param key The run's signing key.
 * @param input The run's observed identity and call ids.
 * @param input.identity The run's observed session/message ids.
 * @param input.callIds The execute call ids in the trail.
 * @param dispatches The mutable remaining dispatches.
 * @returns The credited record or the rejection.
 */
function verifyLine(
    line: string,
    index: number,
    key: string,
    input: {
        identity: JournalIdentity;
        callIds: ReadonlySet<string>;
    },
    dispatches: JournalDispatch[],
): { credited?: CreditedJournalRecord; rejected?: RejectedJournalRecord } {
    if (line.trim() === "") return {};
    const record = parseLine(line);
    if (record === undefined) return { rejected: { index, reason: "not-json" } };
    if (!isServedTwinRecord(record)) {
        return { rejected: { index, reason: "not-served-twin" } };
    }
    if (!journalMacValid(record, key)) {
        return { rejected: { index, reason: "bad-mac" } };
    }
    if (!journalRecordAttributed(record, input.identity, input.callIds)) {
        return { rejected: { index, reason: "unattributed" } };
    }
    if (!consumeDispatch(dispatches, record)) {
        return { rejected: { index, reason: "no-host-dispatch" } };
    }
    return { credited: { index, record } };
}

/**
 * Collect the session and message identities a saved CLI trail observed.
 * @param stdoutText The saved `stdout.jsonl` bytes.
 * @returns The identity sets; empty when the trail is unreadable.
 */
export function journalIdentityFromTrail(stdoutText: string): JournalIdentity {
    const identity: { sessions: Set<string>; messages: Set<string> } = {
        sessions: new Set(),
        messages: new Set(),
    };
    for (const line of stdoutText.split("\n")) {
        if (line.trim() === "") continue;
        let event: unknown;
        try {
            event = JSON.parse(line) as unknown;
        } catch {
            continue;
        }
        if (isRecord(event)) addEventIdentity(event, identity);
    }
    return identity;
}

/**
 * Add one event's session and message ids, including a nested part's.
 * @param event The parsed event.
 * @param identity The accumulating identity sets.
 * @param identity.sessions The observed session ids.
 * @param identity.messages The observed message ids.
 */
function addEventIdentity(
    event: Record<string, unknown>,
    identity: { sessions: Set<string>; messages: Set<string> },
): void {
    if (typeof event.sessionID === "string") {
        identity.sessions.add(event.sessionID);
    }
    if (typeof event.messageID === "string") {
        identity.messages.add(event.messageID);
    }
    const part = isRecord(event.part) ? event.part : undefined;
    if (part === undefined) return;
    if (typeof part.sessionID === "string") {
        identity.sessions.add(part.sessionID);
    }
    if (typeof part.messageID === "string") {
        identity.messages.add(part.messageID);
    }
}

/** The host half of journal attribution, read from a saved tools trail. */
export interface HostDispatches {
    /** Execute call ids present in the trail. */
    callIds: Set<string>;
    /** Docs dispatches the host recorded inside execute results. */
    dispatches: JournalDispatch[];
}

/** The journal tool name for one host dispatch name. */
function dispatchTool(name: unknown): string | null {
    if (name === "docs.docs_search") return "docs_search";
    if (name === "docs") return "docs";
    return null;
}

/**
 * Extract the host dispatches and execute call ids from a saved `tools.jsonl`.
 * @param toolsText The saved tools trail bytes.
 * @returns The host half of attribution; empty when the trail is unreadable.
 */
export function hostDispatchesFromTrail(toolsText: string): HostDispatches {
    const result: HostDispatches = {
        callIds: new Set(),
        dispatches: [],
    };
    for (const line of toolsText.split("\n")) {
        if (line.trim() === "") continue;
        let entry: unknown;
        try {
            entry = JSON.parse(line) as unknown;
        } catch {
            continue;
        }
        if (isRecord(entry)) addHostDispatches(entry, result);
    }
    return result;
}

/**
 * Add one tool-trail entry's execute id and docs dispatches.
 * @param entry The parsed trail entry.
 * @param result The accumulating host result.
 */
function addHostDispatches(
    entry: Record<string, unknown>,
    result: HostDispatches,
): void {
    if (typeof entry.id === "string" && entry.tool === "execute") {
        result.callIds.add(entry.id);
    }
    if (entry.tool !== "execute" || !isRecord(entry.metadata)) return;
    const envelope = isRecord(entry.metadata.metadata)
        ? entry.metadata.metadata
        : entry.metadata;
    const calls = Array.isArray(envelope.toolCalls) ? envelope.toolCalls : [];
    appendDispatches(calls, result.dispatches);
}

/**
 * Append the docs dispatches one execute result recorded.
 * @param calls The result's recorded tool calls.
 * @param dispatches The accumulating dispatches.
 */
function appendDispatches(
    calls: readonly unknown[],
    dispatches: JournalDispatch[],
): void {
    for (const call of calls) {
        if (!isRecord(call)) continue;
        const tool = dispatchTool(call.tool);
        if (tool === null) continue;
        dispatches.push({
            tool,
            status: typeof call.status === "string" ? call.status : "unknown",
            input: call.input,
        });
    }
}

/**
 * Check a captured answer against the producer's `meta.answerHash`.
 *
 * The harness hashes the exact final-answer text as bytes (`sha256(text)`),
 * so the analyser must hash the recorded `final.md` bytes, never a normalised
 * rendering. A missing hash leaves the answer unbound rather than trusted.
 * @param answer The recorded answer bytes.
 * @param answerHash The producer's recorded hash, when present.
 * @returns A problem, or null when the answer matches or no hash was recorded.
 */
export function answerIdentityProblem(
    answer: string,
    answerHash: unknown,
): string | null {
    if (typeof answerHash !== "string" || answerHash === "") return null;
    const actual = createHash("sha256").update(answer, "utf8").digest("hex");
    if (actual !== answerHash) {
        return "recorded answer does not match meta.answerHash; the answer was altered after capture";
    }
    return null;
}
