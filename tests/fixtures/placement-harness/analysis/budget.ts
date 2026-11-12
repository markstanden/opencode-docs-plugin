/**
 * Durable, exclusive spend claims for a campaign.
 *
 * A claim is a small file created with `wx` in a per-kind directory. Because
 * the filesystem decides the winner, two invocations racing for the last
 * allowance cannot both succeed, and no lock or clock is consulted.
 *
 * A claim counts against its ceiling from the moment it is created. That is
 * deliberate: a crash between reserving and spawning leaves a durable
 * reservation that still consumes budget, so recovery can never silently
 * exceed the authorised number of calls.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The spend kinds with independent ceilings. */
export type BudgetKind = "trial" | "judge";

/** The lifecycle of one durable claim. */
export type ClaimState = "reserved" | "spawned" | "closed";

/** One durable claim record. */
export interface BudgetClaim {
    /** The spend kind. */
    kind: BudgetKind;
    /** The one-based claim index within the kind. */
    index: number;
    /** The claim file path. */
    path: string;
    /** The current lifecycle state. */
    state: ClaimState;
    /** When the claim was created. */
    at: string | null;
    /** The trial stamp or analysis selection the claim names. */
    stamp: string | null;
    /** The attempt id the claim names. */
    attemptId: string | null;
    /** A free-form note written by the caller. */
    note: string | null;
}

/** The outcome of claiming one budget slot. */
export type ClaimResult =
    | { ok: true; claim: BudgetClaim }
    | { ok: false; reason: string; used: number; ceiling: number };

/** A claim's caller-supplied identity. */
export interface ClaimIdentity {
    /** The trial stamp or analysis selection the claim names. */
    stamp?: string;
    /** The attempt id the claim names. */
    attemptId?: string;
    /** A free-form note. */
    note?: string;
    /** The creation timestamp, injected for determinism in tests. */
    at?: string;
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The claim filename for one index. */
export function claimFileName(kind: BudgetKind, index: number): string {
    return `${kind}-${String(index).padStart(4, "0")}.claim`;
}

/** The directory holding one kind's claims. */
export function claimDir(root: string, kind: BudgetKind): string {
    return join(root, kind);
}

/** Parse one claim file, or null when its bytes are unusable. */
function claimOf(
    kind: BudgetKind,
    index: number,
    path: string,
    text: string,
): BudgetClaim | null {
    let value: unknown;
    try {
        value = JSON.parse(text) as unknown;
    } catch {
        return null;
    }
    if (!isRecord(value)) return null;
    const state = value.state;
    if (state !== "reserved" && state !== "spawned" && state !== "closed") {
        return null;
    }
    return {
        kind,
        index,
        path,
        state,
        at: typeof value.at === "string" ? value.at : null,
        stamp: typeof value.stamp === "string" ? value.stamp : null,
        attemptId: typeof value.attemptId === "string" ? value.attemptId : null,
        note: typeof value.note === "string" ? value.note : null,
    };
}

/**
 * Read every claim of one kind, in index order. A file that matches the claim
 * name but cannot be parsed is returned as a `reserved` claim so it still
 * consumes budget: corrupt state fails closed.
 * @param root The campaign evidence root.
 * @param kind The spend kind.
 * @returns The claims, including unreadable ones as reserved.
 */
export function readClaims(root: string, kind: BudgetKind): BudgetClaim[] {
    const dir = claimDir(root, kind);
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const pattern = new RegExp(`^${kind}-(\\d{4})\\.claim$`);
    const claims: BudgetClaim[] = [];
    for (const name of names.sort()) {
        const match = pattern.exec(name);
        if (match === null) continue;
        const index = Number(match[1]);
        const path = join(dir, name);
        const text = readFileSync(path, "utf8");
        claims.push(
            claimOf(kind, index, path, text) ?? {
                kind,
                index,
                path,
                state: "reserved",
                at: null,
                stamp: null,
                attemptId: null,
                note: "unreadable claim treated as reserved",
            },
        );
    }
    return claims;
}

/**
 * Claim the next free slot of one kind, or refuse at the ceiling.
 *
 * The claim is written with `wx`, so the create is the arbitration point.
 * A refused claim writes nothing and returns the observed usage.
 * @param root The campaign evidence root.
 * @param kind The spend kind.
 * @param ceiling The authorised calls of this kind.
 * @param identity The caller's identity fields.
 * @returns The created claim, or the refusal.
 */
export function claimBudget(
    root: string,
    kind: BudgetKind,
    ceiling: number,
    identity: ClaimIdentity = {},
): ClaimResult {
    if (!Number.isInteger(ceiling) || ceiling < 1) {
        return {
            ok: false,
            reason: `invalid ${kind} ceiling ${String(ceiling)}`,
            used: 0,
            ceiling,
        };
    }
    const dir = claimDir(root, kind);
    mkdirSync(dir, { recursive: true });
    for (let index = 1; index <= ceiling; index += 1) {
        const claim = createClaim(dir, kind, index, identity);
        if (claim !== undefined) return { ok: true, claim };
    }
    return {
        ok: false,
        reason: `${kind} ceiling reached: ${String(ceiling)} authorised call(s)`,
        used: ceiling,
        ceiling,
    };
}

/**
 * Try to create one claim file exclusively.
 * @param dir The kind's claim directory.
 * @param kind The spend kind.
 * @param index The claim index.
 * @param identity The caller's identity fields.
 * @returns The claim, or undefined when that slot is already taken.
 */
function createClaim(
    dir: string,
    kind: BudgetKind,
    index: number,
    identity: ClaimIdentity,
): BudgetClaim | undefined {
    const path = join(dir, claimFileName(kind, index));
    const claim: BudgetClaim = {
        kind,
        index,
        path,
        state: "reserved",
        at: identity.at ?? null,
        stamp: identity.stamp ?? null,
        attemptId: identity.attemptId ?? null,
        note: identity.note ?? null,
    };
    try {
        writeFileSync(path, claimBytes(claim, new Date().toISOString()), {
            encoding: "utf8",
            flag: "wx",
        });
        return { ...claim, at: identity.at ?? new Date().toISOString() };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return undefined;
    }
}

/**
 * Serialise one claim record.
 * @param claim The claim.
 * @param at The creation timestamp.
 * @returns The JSON bytes with a trailing newline.
 */
function claimBytes(claim: BudgetClaim, at: string): string {
    return `${JSON.stringify(
        {
            kind: claim.kind,
            index: claim.index,
            state: claim.state,
            at: claim.at ?? at,
            stamp: claim.stamp,
            attemptId: claim.attemptId,
            note: claim.note,
        },
        null,
        2,
    )}\n`;
}

/**
 * Advance one claim's durable state.
 * @param claim The claim to update.
 * @param state The new lifecycle state.
 * @param patch Extra identity fields to record.
 * @param patch.note The new note.
 * @param patch.stamp The stamp to record.
 * @param patch.attemptId The attempt id to record.
 * @returns The updated claim.
 */
export function advanceClaim(
    claim: BudgetClaim,
    state: ClaimState,
    patch: { note?: string; stamp?: string; attemptId?: string } = {},
): BudgetClaim {
    const updated: BudgetClaim = {
        ...claim,
        state,
        stamp: patch.stamp ?? claim.stamp,
        attemptId: patch.attemptId ?? claim.attemptId,
        note: patch.note ?? claim.note,
    };
    writeFileSync(
        updated.path,
        claimBytes(updated, new Date().toISOString()),
        "utf8",
    );
    return updated;
}

/** Per-state claim counts. */
export interface ClaimUsage {
    /** Total claims, which is the spend committed against the ceiling. */
    claimed: number;
    /** Claims whose call has not yet been observed to start. */
    reserved: number;
    /** Claims whose call started and has not closed. */
    spawned: number;
    /** Claims whose call reached a terminal record. */
    closed: number;
}

/**
 * Count one kind's claims by lifecycle state.
 * @param root The campaign evidence root.
 * @param kind The spend kind.
 * @returns The counts.
 */
export function claimUsage(root: string, kind: BudgetKind): ClaimUsage {
    const claims = readClaims(root, kind);
    return {
        claimed: claims.length,
        reserved: claims.filter((claim) => claim.state === "reserved").length,
        spawned: claims.filter((claim) => claim.state === "spawned").length,
        closed: claims.filter((claim) => claim.state === "closed").length,
    };
}

/**
 * Classify a claim that has not closed, for a restart decision. A reservation
 * that never spawned is `unresolved`; a spawned call with no terminal record
 * is `unknown-outcome`. Both refuse re-entry and preserve the original claim.
 * @param claim The claim.
 * @returns The restart classification, or null when the claim is closed.
 */
export function restartDisposition(
    claim: BudgetClaim,
): "unresolved" | "unknown-outcome" | null {
    if (claim.state === "closed") return null;
    return claim.state === "reserved" ? "unresolved" : "unknown-outcome";
}
