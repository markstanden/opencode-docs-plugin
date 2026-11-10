// Evidence-preservation guards for recorded trial and judge attempts.
//
// A reservation is a lock marker, never evidence. Clearing one must remove
// only `.reservation` and must refuse when any other entry exists. An existing
// attempt directory is immutable: a second claim never overwrites its bytes.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The outcome of a guarded evidence operation. */
export interface EvidenceGuardResult {
    /** Whether the operation was allowed. */
    ok: boolean;
    /** Human-readable reason, safe to log. */
    reason: string;
    /** Entries that protect the directory when the operation refused. */
    entries?: string[];
}

/** Everything in a directory except the reservation marker. */
export function recordedEntries(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name !== ".reservation");
}

/**
 * Clear one abandoned reservation without touching recorded evidence.
 * @param directory The result directory holding the reservation.
 * @returns The outcome and, on refusal, the entries that protect the result.
 */
export function clearReservation(directory: string): EvidenceGuardResult {
    if (!existsSync(directory))
        return { ok: false, reason: "directory does not exist" };
    if (!existsSync(join(directory, ".reservation")))
        return { ok: false, reason: "no reservation present" };
    const entries = recordedEntries(directory);
    if (entries.length > 0)
        return {
            ok: false,
            reason: "recorded evidence is present; refusing to clear",
            entries,
        };
    rmSync(join(directory, ".reservation"));
    return { ok: true, reason: "reservation cleared; no evidence removed" };
}

/**
 * Claim a new attempt directory. An existing directory is never reused or
 * overwritten, even when it is empty.
 * @param directory The attempt directory to create.
 * @returns Whether the claim succeeded or why it was refused.
 */
export function claimAttemptDir(directory: string): EvidenceGuardResult {
    if (existsSync(directory))
        return {
            ok: false,
            reason: "attempt directory already exists; refusing to overwrite",
            entries: recordedEntries(directory),
        };
    mkdirSync(directory, { recursive: false });
    return { ok: true, reason: "attempt directory created" };
}
