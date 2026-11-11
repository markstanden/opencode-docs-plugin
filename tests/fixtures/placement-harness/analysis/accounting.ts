/**
 * Trial accounting for the analysis framework.
 *
 * One scheduled slot becomes one {@link TrialScored}: the shared
 * `ac-scoring` scored-trial shape plus the utility its loaded evidence
 * supports. Counting keeps planned slots, recorded launches, unproven
 * directories, completed and usable runs, assessment states, gate outcomes
 * and semantic outcomes as separate measures — a blocked gate is never a
 * semantic failure, and an unassessed trial is never a zero.
 */
import {
    DEFAULT_WEIGHTS,
    trialUtility,
    type DocumentationOutcome,
    type ScoredTrial,
    type UtilityWeights,
} from "../ac-scoring.mts";
import type { AssessmentStatus, AttemptState, TrialRecord } from "./records.ts";
import type { SlotSpec } from "./model.ts";

/** How one observation relates to the frozen schedule. */
export type Disposition = "first-attempt" | "replacement" | "excluded";

/** The declared identity a scored trial carries. */
export interface ScoredIdentity {
    /** The scheduled slot number, or null for an undeclared observation. */
    slot: number | null;
    /** The declared pair id, when the slot belongs to a pair. */
    pairId: string | undefined;
    /** The scenario the slot declared. */
    scenario: string;
    /** The arm the slot declared. */
    arm: string;
    /** The repetition within scenario and arm. */
    repetition: number;
    /** The trial stamp the evidence was loaded under. */
    stamp: string;
}

/** One scored trial: identity, shared scoring shape and derived utility. */
export interface TrialScored {
    /** The declared identity. */
    identity: ScoredIdentity;
    /** How the observation relates to the schedule. */
    disposition: Disposition;
    /** What the trial directory proved about the launch. */
    attemptState: AttemptState;
    /** The shared ac-scoring trial shape. */
    trial: ScoredTrial;
    /** The utility and its bounds. */
    utility: { score: number; low: number; high: number; assessed: boolean };
    /** The selected judgement layer's status. */
    assessmentStatus: AssessmentStatus;
    /** The recorded gate status, or `missing`. */
    gateStatus: string;
}

/** Options for scoring one loaded trial against its declared slot. */
export interface ScoreOptions {
    /** The frozen utility weights. */
    weights?: UtilityWeights;
    /** Whether a non-compensable guardrail breach is established. */
    guardrailBreach?: boolean;
    /** How the observation relates to the schedule. */
    disposition?: Disposition;
}

/** The assessment states every accounting record counts. */
const ASSESSMENT_STATUSES: readonly AssessmentStatus[] = [
    "judged",
    "invalid-verdict",
    "judge-error",
    "unassessed",
    "not-run",
    "unknown",
];

/** The documentation outcomes every accounting record counts. */
const OUTCOME_KEYS: readonly DocumentationOutcome[] = [
    "useful-create",
    "useful-update",
    "transient",
    "duplicate",
    "misleading",
    "none",
];

/** One set of accounting counts. */
export interface AccountingCounts {
    /** Scheduled slots in the declared population. */
    planned: number;
    /** Slots whose directory proves a recorded launch. */
    recordedLaunches: number;
    /** Directories or reservations that prove no launch either way. */
    unprovenDirectories: number;
    /** Planned slots with no directory at all. */
    absent: number;
    /** Recorded runs whose evidence is usable. */
    completed: number;
    /** Slots whose usability cannot be established. */
    usableUnknown: number;
    /** Recorded runs whose evidence is unusable. */
    unusable: number;
    /** Trials with a known documentation outcome (documentation coverage). */
    documented: number;
    /** Trials whose utility is fully known (scored population). */
    assessed: number;
    /** Observations excluded from the measured population. */
    excluded: number;
    /** Count per assessment status. */
    assessmentStatuses: Record<AssessmentStatus, number>;
    /** Primary-task results. */
    primary: { pass: number; fail: number; unknown: number };
    /** Gate outcomes, kept separate from semantic outcomes. */
    gate: { pass: number; blocked: number; other: number; missing: number };
    /** Count per documentation outcome. */
    outcomes: Record<DocumentationOutcome, number>;
    /** Sum of assessed trial utilities. */
    utilityTotal: number;
    /** Full-population lower bound: assessed total plus missing lows. */
    utilityLow: number;
    /** Full-population upper bound: assessed total plus missing highs. */
    utilityHigh: number;
    /** Mean over planned slots, or null without a denominator. */
    meanPerPlanned: number | null;
    /** Mean over assessed trials, or null without a denominator. */
    meanPerAssessed: number | null;
}

/** Start a zeroed accounting record. */
function emptyCounts(planned: number): AccountingCounts {
    const assessmentStatuses = {} as Record<AssessmentStatus, number>;
    for (const status of ASSESSMENT_STATUSES) assessmentStatuses[status] = 0;
    const outcomes = {} as Record<DocumentationOutcome, number>;
    for (const outcome of OUTCOME_KEYS) outcomes[outcome] = 0;
    return {
        planned,
        recordedLaunches: 0,
        unprovenDirectories: 0,
        absent: 0,
        completed: 0,
        usableUnknown: 0,
        unusable: 0,
        documented: 0,
        assessed: 0,
        excluded: 0,
        assessmentStatuses,
        primary: { pass: 0, fail: 0, unknown: 0 },
        gate: { pass: 0, blocked: 0, other: 0, missing: 0 },
        outcomes,
        utilityTotal: 0,
        utilityLow: 0,
        utilityHigh: 0,
        meanPerPlanned: null,
        meanPerAssessed: null,
    };
}

/**
 * Score one loaded trial against its declared slot.
 * @param record The loaded trial record.
 * @param slot The manifest slot the record belongs to.
 * @param options Weights, guardrail state and disposition overrides.
 * @returns The scored trial with identity and utility bounds.
 */
export function scoreTrial(
    record: TrialRecord,
    slot: SlotSpec,
    options: ScoreOptions = {},
): TrialScored {
    const disposition = options.disposition ?? "first-attempt";
    const trial: ScoredTrial = {
        arm: slot.arm,
        scenario: slot.scenario,
        planned: disposition !== "excluded",
        usable: record.attempt.usable === true,
        outcome: record.assessment.outcome,
        primary: record.primary.status,
        guardrailBreach: options.guardrailBreach ?? false,
    };
    return {
        identity: {
            slot: slot.slot,
            pairId: slot.pairId,
            scenario: slot.scenario,
            arm: slot.arm,
            repetition: slot.repetition,
            stamp: slot.stamp,
        },
        disposition,
        attemptState: record.attempt.state,
        trial,
        utility: trialUtility(trial, options.weights ?? DEFAULT_WEIGHTS),
        assessmentStatus: record.assessment.status,
        gateStatus:
            record.gate.state === "available"
                ? record.gate.value.status
                : "missing",
    };
}

/**
 * Count what one trial's attempt record proves.
 * @param counts The counts to update.
 * @param row The scored trial.
 */
function addAttempt(counts: AccountingCounts, row: TrialScored): void {
    if (row.attemptState === "recorded") {
        counts.recordedLaunches += 1;
    } else if (row.attemptState === "absent") {
        counts.absent += 1;
    } else {
        counts.unprovenDirectories += 1;
    }
    if (row.attemptState !== "recorded") {
        counts.usableUnknown += 1;
    } else if (row.trial.usable) {
        counts.completed += 1;
    } else {
        counts.unusable += 1;
    }
}

/**
 * Count one trial's assessment, gate and primary outcomes.
 * @param counts The counts to update.
 * @param row The scored trial.
 */
function addAssessment(counts: AccountingCounts, row: TrialScored): void {
    counts.assessmentStatuses[row.assessmentStatus] += 1;
    if (row.trial.primary === "pass") counts.primary.pass += 1;
    else if (row.trial.primary === "fail") counts.primary.fail += 1;
    else counts.primary.unknown += 1;
    if (row.gateStatus === "pass") counts.gate.pass += 1;
    else if (row.gateStatus === "blocked") counts.gate.blocked += 1;
    else if (row.gateStatus === "missing") counts.gate.missing += 1;
    else counts.gate.other += 1;
    if (row.assessmentStatus === "judged" && row.trial.outcome !== undefined) {
        counts.documented += 1;
        counts.outcomes[row.trial.outcome] += 1;
    }
}

/**
 * Aggregate one measured population.
 * @param scored The scored trials, one per scheduled slot.
 * @param planned The number of scheduled slots in the population.
 * @returns The counts, totals and bounds.
 */
export function accountTrials(
    scored: readonly TrialScored[],
    planned: number,
): AccountingCounts {
    const counts = emptyCounts(planned);
    let missingLow = 0;
    let missingHigh = 0;
    for (const row of scored) {
        if (row.disposition === "excluded") {
            counts.excluded += 1;
            continue;
        }
        addAttempt(counts, row);
        addAssessment(counts, row);
        if (row.utility.assessed) {
            counts.assessed += 1;
            counts.utilityTotal += row.utility.score;
        } else {
            missingLow += row.utility.low;
            missingHigh += row.utility.high;
        }
    }
    counts.utilityLow = counts.utilityTotal + missingLow;
    counts.utilityHigh = counts.utilityTotal + missingHigh;
    counts.meanPerPlanned =
        planned === 0 ? null : counts.utilityTotal / planned;
    counts.meanPerAssessed =
        counts.assessed === 0 ? null : counts.utilityTotal / counts.assessed;
    return counts;
}

/**
 * Aggregate one population per declared arm.
 * @param scored The scored trials.
 * @param slots The declared schedule slots, for planned denominators.
 * @returns Counts keyed by arm id, sorted.
 */
export function accountByArm(
    scored: readonly TrialScored[],
    slots: readonly SlotSpec[],
): Record<string, AccountingCounts> {
    const arms = [
        ...new Set([
            ...slots.map((slot) => slot.arm),
            ...scored.map((row) => row.trial.arm),
        ]),
    ].sort();
    const byArm: Record<string, AccountingCounts> = {};
    for (const arm of arms) {
        byArm[arm] = accountTrials(
            scored.filter((row) => row.trial.arm === arm),
            slots.filter((slot) => slot.arm === arm).length,
        );
    }
    return byArm;
}

/**
 * Aggregate one population per arm and scenario.
 * @param scored The scored trials.
 * @param slots The declared schedule slots, for planned denominators.
 * @returns Counts keyed by arm then scenario, with only present combinations.
 */
export function accountByScenarioArm(
    scored: readonly TrialScored[],
    slots: readonly SlotSpec[],
): Record<string, Record<string, AccountingCounts>> {
    const byScenario: Record<string, Record<string, AccountingCounts>> = {};
    for (const [arm, armSlots] of Object.entries(groupSlotsByArm(slots)).sort(
        ([left], [right]) => left.localeCompare(right),
    )) {
        const scenarios = [
            ...new Set([
                ...armSlots.map((slot) => slot.scenario),
                ...scored
                    .filter((row) => row.trial.arm === arm)
                    .map((row) => row.trial.scenario),
            ]),
        ].sort();
        byScenario[arm] = {};
        for (const scenario of scenarios) {
            byScenario[arm][scenario] = accountTrials(
                scored.filter(
                    (row) =>
                        row.trial.arm === arm &&
                        row.trial.scenario === scenario,
                ),
                armSlots.filter((slot) => slot.scenario === scenario).length,
            );
        }
    }
    return byScenario;
}

/**
 * Group declared slots by arm.
 * @param slots The declared schedule slots.
 * @returns Slots keyed by arm id.
 */
function groupSlotsByArm(
    slots: readonly SlotSpec[],
): Record<string, SlotSpec[]> {
    const grouped: Record<string, SlotSpec[]> = {};
    for (const slot of slots) {
        grouped[slot.arm] = [...(grouped[slot.arm] ?? []), slot];
    }
    return grouped;
}
