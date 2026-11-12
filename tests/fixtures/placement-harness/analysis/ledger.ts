/**
 * Structural parsing of the campaign attempt ledger.
 *
 * The ledger is the durable record of what a campaign authorised and launched.
 * It is read as data at a trust boundary: one JSON object per line, with the
 * fields the runner writes. A malformed, truncated or ambiguous ledger never
 * authorises spend — a caller must treat anything but `open`/`closed` with a
 * clean event list as a refusal, not as an empty ledger.
 */

/** One structurally valid ledger event. */
export interface LedgerEvent {
    /** Event timestamp, or null when the line carried none. */
    at: string | null;
    /** The recorded event name. */
    event: string;
    /** The trial stamp, when the event names one. */
    stamp: string | null;
    /** The scheduled slot number, when the event names one. */
    slot: number | null;
    /** The attempt id, when the event names one. */
    attemptId: string | null;
    /** The pair id, when the event names one. */
    pairId: string | null;
    /** The arm id, when the event names one. */
    arm: string | null;
    /** The campaign id, when the event names one. */
    campaign: string | null;
}

/** The explicit state of one ledger read. */
export type LedgerState = "missing" | "malformed" | "open" | "closed";

/** The result of reading a ledger. */
export interface LedgerParse {
    /** The explicit state; only `open` and `closed` are trustworthy. */
    state: LedgerState;
    /** Every structurally valid event, in file order. */
    events: LedgerEvent[];
    /** Every reason the ledger cannot be trusted, never silently dropped. */
    problems: string[];
    /** The close timestamp, when the ledger records a valid close. */
    closedAt: string | null;
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A nonblank string, or null. */
function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A positive integer, or null. */
function slotOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 1
        ? value
        : null;
}

/**
 * Parse one ledger line.
 * @param line The raw line, without its newline.
 * @param index The zero-based line index, for problem messages.
 * @returns The event, or a problem.
 */
function eventOf(
    line: string,
    index: number,
): { event?: LedgerEvent; problem?: string } {
    let value: unknown;
    try {
        value = JSON.parse(line) as unknown;
    } catch {
        return { problem: `ledger line ${String(index + 1)} is not JSON` };
    }
    if (!isRecord(value)) {
        return {
            problem: `ledger line ${String(index + 1)} is not a JSON object`,
        };
    }
    const event = stringOrNull(value.event);
    if (event === null) {
        return {
            problem: `ledger line ${String(index + 1)} has no event name`,
        };
    }
    return {
        event: {
            at: stringOrNull(value.at),
            event,
            stamp: stringOrNull(value.stamp),
            slot: slotOrNull(value.slot),
            attemptId: stringOrNull(value.attemptId),
            pairId: stringOrNull(value.pairId),
            arm: stringOrNull(value.arm),
            campaign: stringOrNull(value.campaign),
        },
    };
}

/**
 * Parse a whole ledger.
 *
 * A blank line is ignored; any other unreadable line makes the ledger
 * `malformed`, because a partial read cannot prove what spend was authorised.
 * A `campaign-closed` event closes the ledger only when every line parsed.
 * @param text The ledger bytes, or undefined when the file is absent.
 * @returns The state, the valid events and every problem.
 */
export function parseCampaignLedger(text: string | undefined): LedgerParse {
    if (text === undefined) {
        return {
            state: "missing",
            events: [],
            problems: ["attempt ledger is missing"],
            closedAt: null,
        };
    }
    const events: LedgerEvent[] = [];
    const problems: string[] = [];
    for (const [index, raw] of text.split("\n").entries()) {
        const line = raw.trim();
        if (line === "") continue;
        const parsed = eventOf(line, index);
        if (parsed.event !== undefined) events.push(parsed.event);
        if (parsed.problem !== undefined) problems.push(parsed.problem);
    }
    if (problems.length > 0) {
        return { state: "malformed", events, problems, closedAt: null };
    }
    const close = events.find((event) => event.event === "campaign-closed");
    if (close !== undefined) {
        return {
            state: "closed",
            events,
            problems: [],
            closedAt: close.at,
        };
    }
    return { state: "open", events, problems: [], closedAt: null };
}

/**
 * Whether a parsed ledger permits a new launch or judge call. Only a clean
 * `open` ledger does; `missing` is refused by campaign policy, not by this
 * predicate, so the caller can distinguish "no campaign yet" from "closed".
 * @param ledger The parse result.
 * @returns True only for a clean open ledger.
 */
export function isOpenLedger(ledger: LedgerParse): boolean {
    return ledger.state === "open";
}

/** One scheduled stamp's observed events. */
export interface StampEvents {
    /** Events naming this stamp, in file order. */
    events: LedgerEvent[];
    /** Trial launch events. */
    launches: number;
    /** Judge launch events. */
    judgeLaunches: number;
    /** Whether a slot-blocked event exists. */
    blocked: boolean;
    /** Whether a slot-complete event exists. */
    complete: boolean;
}

/**
 * Group ledger events by stamp, keeping unknown stamps visible.
 * @param events The parsed events.
 * @returns Per-stamp events and the stamps the ledger mentions.
 */
export function eventsByStamp(
    events: readonly LedgerEvent[],
): Map<string, StampEvents> {
    const grouped = new Map<string, StampEvents>();
    for (const event of events) {
        if (event.stamp === null) continue;
        const entry = grouped.get(event.stamp) ?? {
            events: [],
            launches: 0,
            judgeLaunches: 0,
            blocked: false,
            complete: false,
        };
        entry.events.push(event);
        if (event.event === "launch") entry.launches += 1;
        if (event.event === "judge-launch") entry.judgeLaunches += 1;
        if (event.event === "slot-blocked") entry.blocked = true;
        if (event.event === "slot-complete") entry.complete = true;
        grouped.set(event.stamp, entry);
    }
    return grouped;
}
