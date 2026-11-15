import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";

/**
 * The environment variables enabling the opt-in operation journal: a path
 * and a per-run signing key. Both unset — the production default — the
 * plugin writes no journal at all. The key makes capture tamper-evident; a
 * trial tool can write a shaped line but cannot sign it.
 */
export const OPERATION_JOURNAL_ENV = "DOCS_OPERATION_JOURNAL";
export const OPERATION_JOURNAL_KEY_ENV = "DOCS_OPERATION_JOURNAL_KEY";

/** One record of a docs operation the plugin actually served. */
export interface OperationJournalRecord {
    /** Schema version; the harness refuses records it does not understand. */
    readonly schemaVersion: 1;
    /** The registered tool name (`docs` or the Code Mode twin `docs_search`). */
    readonly tool: string;
    /** The registration surface, never the caller's claimed route. */
    readonly surface: "native" | "codemode-twin";
    /** Whether the plugin returned a result or threw. */
    readonly status: "completed" | "error";
    /** The exact input the host delivered. */
    readonly input: unknown;
    /** The served result; present only on completion. */
    readonly result?: { content: unknown; metadata: unknown };
    /** The failure, textually; present only on error. */
    readonly error?: string;
    /** The session id value. */
    readonly sessionID?: string;
    /** The message id value. */
    readonly messageID?: string;
    /** The call id value. */
    readonly callID?: string;
    /** HMAC-SHA256 over the record without this field. */
    readonly mac?: string;
}

/**
 * Append one served docs operation to the journal named by
 * {@link OPERATION_JOURNAL_ENV}, signed with the per-run key named by
 * {@link OPERATION_JOURNAL_KEY_ENV}. This is opt-in production
 * instrumentation, silent when unset: a Code Mode nested call emits no CLI
 * trail event, so the plugin records what it actually served. The signature
 * makes a forged file or appended line detectable even though the journal
 * path is on a mount the trial can write. Fail-quiet by construction —
 * measurement must never break the tool.
 * @param record The operation facts, taken from the real execution.
 */
export function journalOperation(record: OperationJournalRecord): void {
    const path = process.env[OPERATION_JOURNAL_ENV];
    const key = process.env[OPERATION_JOURNAL_KEY_ENV];
    if (path === undefined || path === "") return;
    if (key === undefined || key === "") return;
    try {
        const body = { ...record };
        const mac = createHmac("sha256", key)
            .update(JSON.stringify(body), "utf8")
            .digest("hex");
        appendFileSync(path, `${JSON.stringify({ ...body, mac })}\n`, "utf8");
    } catch {
        // Measured is best-effort: a journal write must never fail a tool.
    }
}
