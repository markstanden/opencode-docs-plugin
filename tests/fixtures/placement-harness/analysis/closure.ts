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
    /** Input-token subtotal, or null when unrecorded on any observation. */
    input: number | null;
    /** Output-token subtotal, or null when unrecorded on any observation. */
    output: number | null;
    /** Reasoning-token subtotal, or null when unrecorded on any observation. */
    reasoning: number | null;
    /** Cache-read-token subtotal, or null when unrecorded on any observation. */
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
    const trial = emptyAccount();
    const judge = { ...emptyAccount(), usableJudgements: 0, unusableJudgements: 0 };
    const observed = input.observations.filter(isObserved);
    for (const slot of observed) {
        addTrial(trial, slot);
        for (const attempt of slot.judgeAttempts) addJudge(judge, attempt);
    }
    const problems = [
        ...budgetProblems(input, trial.attempts, judge.attempts),
        ...observationProblems(observed),
    ];
    const recordedTrials = observed.filter((slot) => slot.recorded).length;
    problems.push(...closureProblems(input.closed, observed.length, recordedTrials));
    return {
        state: input.closed ? "closed" : "open",
        scheduledSlots: input.scheduledSlots,
        observedSlots: observed.length,
        unrunSlots: unrunOf(input.scheduledSlots, observed),
        trialLaunches: trial.attempts,
        recordedTrials,
        trial,
        judge,
        stoppedAt: [...observed].at(-1)?.stamp ?? null,
        problems,
    };
}

/** One model's accumulator while summing. */
interface AccountAccumulator extends ModelAccount {
    /** Attempts that spawned. */
    attempts: number;
    /** Attempts that reached inference. */
    inferred: number;
}

/** An empty model accumulator. */
function emptyAccount(): AccountAccumulator {
    return {
        attempts: 0,
        inferred: 0,
        steps: null,
        tokens: emptyTokens(),
        tokenCoverage: emptyCoverage(),
        durationMs: null,
    };
}

/** Whether one slot has any evidence at all. */
function isObserved(slot: SlotObservation): boolean {
    return slot.launched || slot.recorded || slot.judgeAttempts.length > 0;
}

/** Add one slot's trial evidence. */
function addTrial(account: AccountAccumulator, slot: SlotObservation): void {
    if (!slot.launched) return;
    account.attempts += 1;
    if (slot.trialSteps !== null && slot.trialSteps > 0) account.inferred += 1;
    account.steps = addField(account.steps, slot.trialSteps);
    addTokens(account.tokens, slot.trialTokens);
    account.durationMs = addField(account.durationMs, slot.trialDurationMs);
    addCoverage(account, slot.trialTokens);
}

/** Add one judge attempt's evidence. */
function addJudge(
    account: AccountAccumulator & {
        usableJudgements: number;
        unusableJudgements: number;
    },
    attempt: JudgeAttempt,
): void {
    if (attempt.spawned) account.attempts += 1;
    if (attempt.reachedInference) account.inferred += 1;
    account.steps = addField(account.steps, attempt.steps);
    addTokens(account.tokens, attempt.tokens);
    account.durationMs = addField(account.durationMs, attempt.durationMs);
    addCoverage(account, attempt.tokens);
    if (attempt.status === "judged") account.usableJudgements += 1;
    else account.unusableJudgements += 1;
}

/** Count which token fields an observation reported. */
function addCoverage(
    account: AccountAccumulator,
    tokens: TokenFields | null,
): void {
    if (tokens === null) return;
    for (const field of ["input", "output", "reasoning", "cacheRead"] as const) {
        if (tokens[field] !== null) account.tokenCoverage[field] += 1;
    }
}

/** The slot numbers with no evidence. */
function unrunOf(
    scheduledSlots: number,
    observed: readonly SlotObservation[],
): number[] {
    const observedNumbers = new Set(observed.map((slot) => slot.slot));
    return Array.from({ length: scheduledSlots }, (_, index) => index + 1).filter(
        (number) => !observedNumbers.has(number),
    );
}

/** Ceiling and reservation disagreements. */
function budgetProblems(
    input: ClosureInput,
    trialLaunches: number,
    judgeAttempts: number,
): string[] {
    const problems: string[] = [];
    if (trialLaunches > input.ceilings.trial) {
        problems.push(
            `trial launches ${String(trialLaunches)} exceed the ceiling ${String(input.ceilings.trial)}`,
        );
    }
    if (judgeAttempts > input.ceilings.judge) {
        problems.push(
            `judge attempts ${String(judgeAttempts)} exceed the ceiling ${String(input.ceilings.judge)}`,
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
    return problems;
}

/** Per-slot disagreements the accounts expose. */
function observationProblems(observed: readonly SlotObservation[]): string[] {
    const problems: string[] = [];
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
    return problems;
}

/** A closed campaign with an observed but unrecorded slot. */
function closureProblems(
    closed: boolean,
    observed: number,
    recorded: number,
): string[] {
    return closed && recorded < observed
        ? [
              `campaign is closed with ${String(observed - recorded)} observed slot(s) lacking a recorded result`,
          ]
        : [];
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
