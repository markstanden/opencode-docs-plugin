/**
 * Campaign accounting and closure, derived from durable evidence.
 *
 * The report never trusts a hard-coded checkpoint. Counts come from the
 * frozen schedule, the launch claims, the recorded trial directories and each
 * attempt's own token/duration record. A stopped partial campaign closes with
 * the real scope it ran, and a closed campaign cannot be reopened by either
 * the runner or the recovery path.
 */

import type { BudgetClaim } from "./budget.ts";

/** What one scheduled slot's evidence proves. */
export interface SlotObservation {
    /** The declared slot number. */
    slot: number;
    /** The pair id. */
    pairId: string | null;
    /** The trial stamp. */
    stamp: string;
    /** The declared arm. */
    arm: string;
    /** The declared scenario. */
    scenario: string;
    /** Whether a trial launch attempt exists. */
    launched: boolean;
    /** Whether the launch reached a recorded result. */
    recorded: boolean;
    /** Recorded trial steps, or null when no trail was readable. */
    trialSteps: number | null;
    /** Recorded trial token fields; null means unavailable, never zero. */
    trialTokens: TokenFields | null;
    /** Recorded trial duration in milliseconds, or null. */
    trialDurationMs: number | null;
    /** Judge attempts recorded for this slot. */
    judgeAttempts: readonly JudgeAttempt[];
}

/** One token field, kept explicit so a known zero differs from unknown. */
export type TokenFields = {
    input: number | null;
    output: number | null;
    reasoning: number | null;
    cacheRead: number | null;
};

/** What one judge attempt proves. */
export interface JudgeAttempt {
    /** The attempt id, e.g. `attempt-002`. */
    attemptId: string;
    /** Whether the attempt spawned a model call. */
    spawned: boolean;
    /** Whether the call reached inference (at least one step). */
    reachedInference: boolean;
    /** Recorded steps, or null when no trail was readable. */
    steps: number | null;
    /** Recorded token fields, or null when unavailable. */
    tokens: TokenFields | null;
    /** The recorded terminal status. */
    status: "judged" | "invalid-verdict" | "judge-error" | "started" | "unknown";
    /** Recorded duration, or null. */
    durationMs: number | null;
}

/** The derivation inputs. */
export interface ClosureInput {
    /** The frozen schedule size. */
    scheduledSlots: number;
    /** Every slot's observation, in schedule order. */
    observations: readonly SlotObservation[];
    /** The durable trial claims, when the runner kept them. */
    trialClaims?: readonly BudgetClaim[];
    /** The durable judge claims, when the runner kept them. */
    judgeClaims?: readonly BudgetClaim[];
    /** The authorised ceilings. */
    ceilings: { trial: number; judge: number };
    /** Whether the attempt ledger records a terminal close. */
    closed: boolean;
}

/** One model's accounting. */
export interface ModelAccount {
    /** Distinct scheduled slots with a spawn. */
    attempts: number;
    /** Attempts that reached inference. */
    inferred: number;
    /** Summed steps, or null when no trail was readable. */
    steps: number | null;
    /** Per-field totals; null where no attempt reported the field. */
    tokens: TokenFields;
    /** Steps that reported each field, for coverage. */
    tokenCoverage: {
        input: number;
        output: number;
        reasoning: number;
        cacheRead: number;
    };
    /** Summed duration, or null when no attempt reported one. */
    durationMs: number | null;
}

/** The closure report. */
export interface ClosureReport {
    /** Whether the campaign was already closed. */
    state: "open" | "closed";
    /** The scheduled slot count. */
    scheduledSlots: number;
    /** Distinct slots with any evidence. */
    observedSlots: number;
    /** Slots with no evidence at all. */
    unrunSlots: number[];
    /** Distinct slots with a trial spawn. */
    trialLaunches: number;
    /** Distinct slots with a recorded result. */
    recordedTrials: number;
    /** The trial accounting. */
    trial: ModelAccount;
    /** The judge accounting, across every attempt. */
    judge: ModelAccount & {
        attempts: number;
        usableJudgements: number;
        unusableJudgements: number;
    };
    /** The checkpoint the campaign actually stopped at, or null. */
    stoppedAt: string | null;
    /** Every reconciliation disagreement. */
    problems: string[];
}

/** An empty token accumulator. */
function emptyTokens(): TokenFields {
    return { input: null, output: null, reasoning: null, cacheRead: null };
}

/** Add one recorded field; a single unknown observation keeps the total unknown. */
function addField(
    total: number | null,
    value: number | null,
): number | null {
    if (value === null) return null;
    return (total ?? 0) + value;
}

/** Add one attempt's tokens into an accumulator. */
function addTokens(
    total: TokenFields,
    tokens: TokenFields | null,
): void {
    if (tokens === null) return;
    total.input = addField(total.input, tokens.input);
    total.output = addField(total.output, tokens.output);
    total.reasoning = addField(total.reasoning, tokens.reasoning);
    total.cacheRead = addField(total.cacheRead, tokens.cacheRead);
}

/** Token coverage counters. */
function emptyCoverage(): ModelAccount["tokenCoverage"] {
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
}

/**
 * Charge a claimed-but-unspawned attempt explicitly. A reservation consumes
 * budget and appears as an unresolved attempt, never as a launch.
 * @param claims The durable claims.
 * @returns The count of claims that never spawned.
 */
export function unresolvedReservations(
    claims: readonly BudgetClaim[] | undefined,
): BudgetClaim[] {
    return (claims ?? []).filter((claim) => claim.state === "reserved");
}

/**
 * Derive the campaign accounts from durable observations.
 * @param input The schedule, slot observations, claims and ceilings.
 * @returns The closure report.
 */
export function deriveClosure(input: ClosureInput): ClosureReport {
    const problems: string[] = [];
    const trial = {
        attempts: 0,
        inferred: 0,
        steps: null as number | null,
        tokens: emptyTokens(),
        tokenCoverage: emptyCoverage(),
        durationMs: null as number | null,
    };
    const judge = {
        attempts: 0,
        inferred: 0,
        steps: null as number | null,
        tokens: emptyTokens(),
        tokenCoverage: emptyCoverage(),
        durationMs: null as number | null,
        usableJudgements: 0,
        unusableJudgements: 0,
    };
    const observed = input.observations.filter(
        (slot) => slot.launched || slot.recorded || slot.judgeAttempts.length > 0,
    );
    const observedNumbers = new Set(observed.map((slot) => slot.slot));
    const unrun = Array.from(
        { length: input.scheduledSlots },
        (_, index) => index + 1,
    ).filter((number) => !observedNumbers.has(number));
    for (const slot of observed) {
        if (slot.launched) {
            trial.attempts += 1;
            if (slot.trialSteps !== null && slot.trialSteps > 0) {
                trial.inferred += 1;
            }
            trial.steps = addField(trial.steps, slot.trialSteps);
            addTokens(trial.tokens, slot.trialTokens);
            trial.durationMs = addField(trial.durationMs, slot.trialDurationMs);
            if (slot.trialTokens !== null) {
                for (const field of [
                    "input",
                    "output",
                    "reasoning",
                    "cacheRead",
                ] as const) {
                    if (slot.trialTokens[field] !== null) {
                        trial.tokenCoverage[field] += 1;
                    }
                }
            }
        }
        for (const attempt of slot.judgeAttempts) {
            if (attempt.spawned) judge.attempts += 1;
            if (attempt.reachedInference) judge.inferred += 1;
            judge.steps = addField(judge.steps, attempt.steps);
            addTokens(judge.tokens, attempt.tokens);
            judge.durationMs = addField(judge.durationMs, attempt.durationMs);
            if (attempt.tokens !== null) {
                for (const field of [
                    "input",
                    "output",
                    "reasoning",
                    "cacheRead",
                ] as const) {
                    if (attempt.tokens[field] !== null) {
                        judge.tokenCoverage[field] += 1;
                    }
                }
            }
            if (attempt.status === "judged") judge.usableJudgements += 1;
            else judge.unusableJudgements += 1;
        }
    }
    if (trial.attempts > input.ceilings.trial) {
        problems.push(
            `trial launches ${String(trial.attempts)} exceed the ceiling ${String(input.ceilings.trial)}`,
        );
    }
    if (judge.attempts > input.ceilings.judge) {
        problems.push(
            `judge attempts ${String(judge.attempts)} exceed the ceiling ${String(input.ceilings.judge)}`,
        );
    }
    const unresolvedTrials = unresolvedReservations(input.trialClaims);
    if (unresolvedTrials.length > 0) {
        problems.push(
            `${String(unresolvedTrials.length)} durable trial reservation(s) never spawned and stay unresolved`,
        );
    }
    const unresolvedJudges = unresolvedReservations(input.judgeClaims);
    if (unresolvedJudges.length > 0) {
        problems.push(
            `${String(unresolvedJudges.length)} durable judge reservation(s) never spawned and stay unresolved`,
        );
    }
    for (const slot of observed) {
        if (slot.launched && !slot.recorded) {
            problems.push(`${slot.stamp}: launched without a recorded result`);
        }
        for (const attempt of slot.judgeAttempts) {
            if (attempt.spawned && attempt.steps === null) {
                problems.push(
                    `${slot.stamp}/${attempt.attemptId}: spawned without a readable trail`,
                );
            }
        }
    }
    const recordedTrials = observed.filter((slot) => slot.recorded).length;
    if (input.closed && recordedTrials < observed.length) {
        problems.push(
            `campaign is closed with ${String(observed.length - recordedTrials)} observed slot(s) lacking a recorded result`,
        );
    }
    const lastObserved = [...observed].at(-1) ?? null;
    return {
        state: input.closed ? "closed" : "open",
        scheduledSlots: input.scheduledSlots,
        observedSlots: observed.length,
        unrunSlots: unrun,
        trialLaunches: trial.attempts,
        recordedTrials,
        trial,
        judge,
        stoppedAt: lastObserved?.stamp ?? null,
        problems,
    };
}

/** The closure decision. */
export type ClosureOutcome =
    | { ok: true; event: { event: "campaign-closed"; stoppedAt: string | null; scope: number } }
    | { ok: false; problems: string[] };

/**
 * Decide whether a campaign may close now, and with what scope.
 *
 * A campaign with no evidence is refused rather than closed empty. A stopped
 * partial campaign closes with the slots that actually ran; the schedule's
 * unrun slots are preserved as scope, not invented results.
 * @param report The derived closure report.
 * @returns The close event, or every reason closure is refused.
 */
export function closeCampaign(report: ClosureReport): ClosureOutcome {
    if (report.state === "closed") {
        return {
            ok: false,
            problems: ["campaign is already closed; reopening is refused"],
        };
    }
    if (report.observedSlots === 0) {
        return {
            ok: false,
            problems: ["no campaign evidence exists to close"],
        };
    }
    if (report.problems.length > 0) {
        return { ok: false, problems: report.problems };
    }
    return {
        ok: true,
        event: {
            event: "campaign-closed",
            stoppedAt: report.stoppedAt,
            scope: report.observedSlots,
        },
    };
}
