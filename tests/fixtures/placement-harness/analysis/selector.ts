/**
 * One frozen attempt selection shared by every consumer.
 *
 * The campaign manifest is the single declared source of which judge attempt
 * the trial, judge, resolver, continuation and analyser read. A command-line
 * override may agree with it or be absent; it may never contradict it. That
 * refusal happens before a spawn or a ledger write, so a conflicting flag
 * cannot spend money or mutate evidence.
 */

/** Where a selection came from. */
export type SelectionSource = "default" | "manifest" | "override";

/** One resolved attempt selection. */
export interface AttemptSelection {
    /** The selected attempt directory name, e.g. `attempt-002`. */
    attemptId: string;
    /** Which declaration produced it. */
    source: SelectionSource;
}

/** The declarations a caller supplies. */
export interface SelectionInput {
    /** The manifest's `assessment.attemptId`, when declared. */
    manifestAttemptId?: string | null | undefined;
    /** A command-line override, when supplied. */
    overrideAttemptId?: string | null | undefined;
}

/** The selection outcome. */
export type SelectionResolution =
    | { ok: true; selection: AttemptSelection }
    | { ok: false; problems: string[] };

/** The attempt id shape every consumer accepts. */
const ATTEMPT_PATTERN = /^attempt-\d{3}$/;

/**
 * Whether an attempt id has the accepted shape.
 * @param attemptId The candidate id.
 * @returns True for `attempt-NNN`.
 */
export function isAttemptId(attemptId: string): boolean {
    return ATTEMPT_PATTERN.test(attemptId);
}

/** The default attempt id when nothing is declared. */
export const DEFAULT_ATTEMPT_ID = "attempt-001";

/**
 * Resolve the single attempt selection.
 *
 * Precedence is: a valid manifest declaration wins; an absent declaration
 * defaults to `attempt-001`. An override is accepted only when it matches the
 * resolved id. An invalid id or a contradiction returns problems and no
 * selection, so callers refuse rather than guess.
 * @param input The manifest declaration and any override.
 * @returns The selection, or every problem found.
 */
export function resolveAttemptSelection(input: SelectionInput): SelectionResolution {
    const problems: string[] = [];
    const manifest = input.manifestAttemptId ?? null;
    const override = input.overrideAttemptId ?? null;
    if (manifest !== null && !isAttemptId(manifest)) {
        problems.push(
            `manifest attemptId ${JSON.stringify(manifest)} must match attempt-NNN`,
        );
    }
    if (override !== null && !isAttemptId(override)) {
        problems.push(
            `override attemptId ${JSON.stringify(override)} must match attempt-NNN`,
        );
    }
    if (problems.length > 0) return { ok: false, problems };
    if (manifest !== null && override !== null && manifest !== override) {
        return {
            ok: false,
            problems: [
                `conflicting attempt selections: manifest ${manifest} and override ${override}`,
            ],
        };
    }
    if (manifest !== null) {
        return {
            ok: true,
            selection: { attemptId: manifest, source: "manifest" },
        };
    }
    if (override !== null) {
        return {
            ok: true,
            selection: { attemptId: override, source: "override" },
        };
    }
    return {
        ok: true,
        selection: { attemptId: DEFAULT_ATTEMPT_ID, source: "default" },
    };
}

/**
 * The selection a recovery run may use. Recovery is a separate authorised
 * budget and a separately identified analysis selection; it must not rewrite
 * the original freeze.
 * @param input The manifest declaration and any recovery override.
 * @returns The selection, or the refusal.
 */
export function resolveRecoverySelection(input: {
    manifestAttemptId?: string | null;
    recoveryAttemptId?: string | null;
}): SelectionResolution {
    const manifest = input.manifestAttemptId ?? null;
    const recovery = input.recoveryAttemptId ?? null;
    if (recovery === null) {
        return {
            ok: false,
            problems: ["recovery requires an explicit attempt id"],
        };
    }
    if (!isAttemptId(recovery)) {
        return {
            ok: false,
            problems: [
                `recovery attemptId ${JSON.stringify(recovery)} must match attempt-NNN`,
            ],
        };
    }
    if (manifest !== null && manifest !== recovery) {
        return {
            ok: false,
            problems: [
                `recovery selection ${recovery} contradicts the frozen manifest selection ${manifest}`,
            ],
        };
    }
    return {
        ok: true,
        selection: { attemptId: recovery, source: "override" },
    };
}
