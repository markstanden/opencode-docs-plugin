import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_WEIGHTS,
    trialUtility,
    type ScoredTrial,
    type UtilityWeights,
} from "./fixtures/placement-harness/ac-scoring.mts";
import {
    differenceInterval,
    intervalFromCounts,
} from "./fixtures/placement-harness/analysis/bounds.ts";
import {
    accountByArm,
    accountByScenarioArm,
    accountTrials,
    scoreTrial,
    type TrialScored,
} from "./fixtures/placement-harness/analysis/accounting.ts";
import {
    pairObservations,
    pairedComparison,
} from "./fixtures/placement-harness/analysis/pairing.ts";
import type {
    AssessmentStatus,
    AttemptState,
    TrialRecord,
} from "./fixtures/placement-harness/analysis/records.ts";
import type { SlotSpec } from "./fixtures/placement-harness/analysis/model.ts";
import type { DocumentationOutcome } from "./fixtures/placement-harness/ac-scoring.mts";

type TrialOverrides = Omit<Partial<ScoredTrial>, "outcome"> & {
    outcome?: DocumentationOutcome | undefined;
};

const trial = (overrides: TrialOverrides = {}): ScoredTrial => ({
    arm: "A",
    scenario: "R01",
    planned: true,
    usable: true,
    outcome: "useful-create",
    primary: "pass",
    guardrailBreach: false,
    ...overrides,
});

const boundsOf = (overrides: TrialOverrides, weights?: UtilityWeights) => {
    const utility = trialUtility(trial(overrides), weights);
    return { low: utility.low, high: utility.high, assessed: utility.assessed };
};

describe("unknown-component bounds", () => {
    it("derives the documentation interval from every allowed outcome under the declared weights", () => {
        // Arrange — a duplicate penalty below the misleading penalty widens the
        // lowest possible document score; the interval must follow the policy.
        const weights: UtilityWeights = {
            ...DEFAULT_WEIGHTS,
            useful: 3,
            duplicate: -8,
            taskFailure: -4,
        };

        // Act
        const unknownDocPass = boundsOf(
            { outcome: undefined, primary: "pass" },
            weights,
        );
        const unknownDocFail = boundsOf(
            { outcome: undefined, primary: "fail" },
            weights,
        );
        const bothUnknown = boundsOf(
            { outcome: undefined, primary: "unknown" },
            weights,
        );

        // Assert
        assert.deepEqual(unknownDocPass, {
            low: -8,
            high: 3,
            assessed: false,
        });
        assert.deepEqual(unknownDocFail, {
            low: -12,
            high: -1,
            assessed: false,
        });
        assert.deepEqual(bothUnknown, {
            low: -12,
            high: 3,
            assessed: false,
        });
    });

    it("keeps the frozen default bounds: known pass [-5,+5], known fail [-10,0], both unknown [-10,+5]", () => {
        // Act / Assert
        assert.deepEqual(boundsOf({ outcome: undefined, primary: "pass" }), {
            low: -5,
            high: 5,
            assessed: false,
        });
        assert.deepEqual(boundsOf({ outcome: undefined, primary: "fail" }), {
            low: -10,
            high: 0,
            assessed: false,
        });
        assert.deepEqual(boundsOf({ outcome: undefined, primary: "unknown" }), {
            low: -10,
            high: 5,
            assessed: false,
        });
    });

    it("retains a known documentation outcome when the primary result is unknown", () => {
        // Act
        const usefulWithUnknownTask = boundsOf({
            outcome: "useful-update",
            primary: "unknown",
        });
        const misleadingWithUnknownTask = boundsOf({
            outcome: "misleading",
            primary: "unknown",
        });

        // Assert
        assert.deepEqual(usefulWithUnknownTask, {
            low: 0,
            high: 5,
            assessed: false,
        });
        assert.deepEqual(misleadingWithUnknownTask, {
            low: -10,
            high: -5,
            assessed: false,
        });
    });

    it("scores a fully known trial exactly under custom weights", () => {
        // Arrange
        const weights: UtilityWeights = { ...DEFAULT_WEIGHTS, taskFailure: -4 };

        // Act
        const utility = trialUtility(
            trial({ outcome: "misleading", primary: "fail" }),
            weights,
        );

        // Assert
        assert.deepEqual(utility, {
            score: -9,
            low: -9,
            high: -9,
            assessed: true,
        });
    });
});

describe("interval arithmetic", () => {
    it("computes a full-population difference as B.low − A.high .. B.high − A.low", () => {
        // Arrange — the PR #50 confirmation numbers: A 29 ±5, B 26 ±5.
        const control = { low: 24, high: 34 };
        const candidate = { low: 21, high: 31 };

        // Act
        const delta = differenceInterval(candidate, control);

        // Assert
        assert.deepEqual(delta, { low: -13, high: 7 });
    });

    it("derives an interval from accounting totals plus missing bounds", () => {
        // Act
        const interval = intervalFromCounts({
            utilityTotal: 29,
            utilityLow: 24,
            utilityHigh: 34,
        });

        // Assert
        assert.deepEqual(interval, { low: 24, high: 34 });
    });
});

/** A minimal loaded trial record for scoring tests. */
const record = (
    overrides: {
        attempt?: AttemptState;
        usable?: boolean | "unknown";
        primary?: "pass" | "fail" | "unknown";
        status?: AssessmentStatus;
        outcome?: DocumentationOutcome | undefined;
        gateStatus?: string;
    } = {},
): TrialRecord => ({
    identity: { resultRoot: "results", stamp: "cc-A-r0-R01", scenario: "R01" },
    attempt: {
        state: overrides.attempt ?? "recorded",
        usable: overrides.usable ?? true,
        problems: [],
    },
    run: { state: "available", value: {}, source: "meta.json" },
    gate:
        overrides.gateStatus === undefined
            ? { state: "missing", source: "gate.json" }
            : {
                  state: "available",
                  value: { status: overrides.gateStatus, reason: null },
                  source: "gate.json",
              },
    primary: { status: overrides.primary ?? "pass", problems: [] },
    assessment: {
        status: overrides.status ?? "judged",
        layer: "judge",
        outcome: "outcome" in overrides ? overrides.outcome : "useful-create",
        reason: "reason",
        evidence: [],
        preservation: { state: "missing", source: "ac" },
        problems: [],
    },
    judgeModel: { state: "missing", source: "meta.json" },
    tokens: { state: "missing", source: "stdout.jsonl" },
    artefacts: {
        finalAnswer: { state: "missing", source: "final.md" },
        writesText: { state: "missing", source: "writes.txt" },
        docsOperations: { state: "missing", source: "docs-operations.jsonl" },
        promptText: { state: "missing", source: "prompt.md" },
    },
});

const slot = (overrides: Partial<SlotSpec> = {}): SlotSpec => ({
    slot: 1,
    stamp: "cc-A-r0-R01",
    scenario: "R01",
    arm: "A",
    repetition: 0,
    pairId: "P01",
    ...overrides,
});

describe("scoreTrial", () => {
    it("maps a loaded record onto the shared scored-trial and utility shapes", () => {
        // Act
        const scored = scoreTrial(record(), slot());

        // Assert
        assert.equal(scored.identity.stamp, "cc-A-r0-R01");
        assert.equal(scored.disposition, "first-attempt");
        assert.equal(scored.trial.outcome, "useful-create");
        assert.equal(scored.trial.primary, "pass");
        assert.equal(scored.utility.assessed, true);
        assert.equal(scored.utility.score, 5);
        assert.equal(scored.assessmentStatus, "judged");
        assert.equal(scored.gateStatus, "missing");
    });

    it("keeps an unassessed trial as an interval, never a zero", () => {
        // Act
        const scored = scoreTrial(
            record({ status: "unassessed", outcome: undefined }),
            slot(),
        );

        // Assert
        assert.equal(scored.utility.assessed, false);
        assert.equal(scored.utility.score, 0);
        assert.equal(scored.utility.low, -5);
        assert.equal(scored.utility.high, 5);
    });

    it("never treats an unusable run as scored evidence", () => {
        // Act
        const scored = scoreTrial(record({ usable: false }), slot());

        // Assert
        assert.equal(scored.utility.assessed, false);
        assert.equal(scored.trial.usable, false);
    });
});

describe("accounting", () => {
    const scored = (
        overrides: Omit<Partial<TrialScored>, "trial"> & {
            trial?: Partial<ScoredTrial>;
        } = {},
    ): TrialScored => {
        const base = scoreTrial(record(), slot());
        return {
            ...base,
            ...overrides,
            trial: { ...base.trial, ...overrides.trial },
        };
    };

    it("counts planned, launched, usable, assessed and assessment states separately", () => {
        // Arrange
        const rows = [
            scored(),
            scored({
                assessmentStatus: "unassessed",
                utility: { score: 0, low: -5, high: 5, assessed: false },
            }),
            scored({
                attemptState: "reservation-only",
                assessmentStatus: "unknown",
                utility: { score: 0, low: -5, high: 5, assessed: false },
            }),
            scored({
                attemptState: "absent",
                assessmentStatus: "not-run",
                utility: { score: 0, low: -5, high: 5, assessed: false },
            }),
        ];

        // Act
        const counts = accountTrials(rows, 4);

        // Assert
        assert.equal(counts.planned, 4);
        assert.equal(counts.recordedLaunches, 2);
        assert.equal(counts.unprovenDirectories, 1);
        assert.equal(counts.absent, 1);
        assert.equal(counts.assessed, 1);
        assert.equal(counts.assessmentStatuses.judged, 1);
        assert.equal(counts.assessmentStatuses.unassessed, 1);
        assert.equal(counts.assessmentStatuses.unknown, 1);
        assert.equal(counts.assessmentStatuses["not-run"], 1);
    });

    it("keeps gate outcomes and semantic outcomes as different measures", () => {
        // Arrange
        const rows = [
            scored({ gateStatus: "pass" }),
            scored({ gateStatus: "blocked", trial: { outcome: "misleading" } }),
            scored({ gateStatus: "deferred" }),
        ];

        // Act
        const counts = accountTrials(rows, 3);

        // Assert
        assert.deepEqual(counts.gate, {
            pass: 1,
            blocked: 1,
            other: 1,
            missing: 0,
        });
        assert.equal(counts.outcomes.misleading, 1);
        assert.equal(counts.outcomes["useful-create"], 2);
    });

    it("sums assessed utility and keeps missing components as bounds", () => {
        // Arrange
        const rows = [
            scored({ utility: { score: 5, low: 5, high: 5, assessed: true } }),
            scored({
                utility: { score: -1, low: -1, high: -1, assessed: true },
            }),
            scored({
                utility: { score: 0, low: -5, high: 5, assessed: false },
            }),
        ];

        // Act
        const counts = accountTrials(rows, 3);

        // Assert
        assert.equal(counts.utilityTotal, 4);
        assert.equal(counts.utilityLow, -1);
        assert.equal(counts.utilityHigh, 9);
        assert.equal(counts.meanPerAssessed, 2);
    });

    it("reports zero-denominator means as null, not zero", () => {
        // Act
        const counts = accountTrials([], 0);

        // Assert
        assert.equal(counts.meanPerPlanned, null);
        assert.equal(counts.meanPerAssessed, null);
        assert.equal(counts.planned, 0);
        assert.equal(counts.assessed, 0);
    });

    it("excludes excluded observations from utility but keeps them visible", () => {
        // Act
        const counts = accountTrials(
            [
                scored({
                    disposition: "excluded",
                    utility: { score: 5, low: 5, high: 5, assessed: true },
                }),
                scored({
                    utility: { score: 5, low: 5, high: 5, assessed: true },
                }),
            ],
            2,
        );

        // Assert
        assert.equal(counts.excluded, 1);
        assert.equal(counts.utilityTotal, 5);
    });

    it("groups by arm and by scenario, using declared slots for denominators", () => {
        // Arrange
        const rows = [
            scored(),
            scored({
                identity: {
                    slot: 2,
                    pairId: "P02",
                    scenario: "R02",
                    arm: "B",
                    repetition: 0,
                    stamp: "cc-B-r0-R02",
                },
                trial: { arm: "B", scenario: "R02" },
            }),
        ];
        const slots = [
            slot(),
            slot({
                slot: 2,
                stamp: "cc-B-r0-R02",
                scenario: "R02",
                arm: "B",
                pairId: "P02",
            }),
        ];

        // Act
        const byArm = accountByArm(rows, slots);
        const byScenario = accountByScenarioArm(rows, slots);

        // Assert
        assert.equal(byArm.A?.planned, 1);
        assert.equal(byArm.B?.planned, 1);
        assert.equal(byScenario.A?.R01?.assessed, 1);
        assert.equal(byScenario.B?.R02?.assessed, 1);
        assert.equal(byScenario.A?.R02, undefined);
    });

    it("is order-independent: shuffling observations changes no total", () => {
        // Arrange
        const rows = [
            scored({ utility: { score: 5, low: 5, high: 5, assessed: true } }),
            scored({
                utility: { score: -2, low: -2, high: -2, assessed: true },
            }),
            scored({
                utility: { score: 0, low: -5, high: 5, assessed: false },
            }),
        ];

        // Act
        const forward = accountTrials(rows, 3);
        const shuffled = accountTrials([...rows].reverse(), 3);

        // Assert
        assert.deepEqual(shuffled, forward);
        assert.deepEqual(
            accountByArm(rows, [slot(), slot({ slot: 2 })]),
            accountByArm([...rows].reverse(), [slot({ slot: 2 }), slot()]),
        );
    });
});

describe("pairing", () => {
    const observation = (
        slotNumber: number,
        arm: string,
        scenario: string,
        pairId: string,
        score: number | null,
    ): TrialScored => {
        const base = scoreTrial(record(), slot());
        return {
            ...base,
            identity: {
                slot: slotNumber,
                pairId,
                scenario,
                arm,
                repetition: 0,
                stamp: `cc-${arm}-r0-${scenario}`,
            },
            trial: { ...base.trial, arm, scenario },
            utility:
                score === null
                    ? { score: 0, low: -5, high: 5, assessed: false }
                    : { score, low: score, high: score, assessed: true },
            assessmentStatus: score === null ? "unassessed" : "judged",
        };
    };

    const slotsFor = (
        pairs: Array<{
            pairId: string;
            scenario: string;
            a: boolean;
            b: boolean;
        }>,
    ): SlotSpec[] => {
        const slots: SlotSpec[] = [];
        pairs.forEach((pair, index) => {
            slots.push(
                slot({
                    slot: index * 2 + 1,
                    stamp: `cc-A-r0-${pair.scenario}`,
                    scenario: pair.scenario,
                    arm: "A",
                    pairId: pair.pairId,
                }),
                slot({
                    slot: index * 2 + 2,
                    stamp: `cc-B-r0-${pair.scenario}`,
                    scenario: pair.scenario,
                    arm: "B",
                    pairId: pair.pairId,
                }),
            );
        });
        return slots;
    };

    it("pairs by declared identity and separates complete pairs from unmatched observations", () => {
        // Arrange — PR #49 shape: 13 complete pairs plus one unmatched each side.
        const pairs = Array.from({ length: 15 }, (_, index) => ({
            pairId: `P${String(index + 1).padStart(2, "0")}`,
            scenario: index % 3 === 0 ? "R01" : index % 3 === 1 ? "R02" : "R03",
            a: index !== 0,
            b: index !== 1,
        }));
        const rows = [
            ...pairs.map((pair, index) =>
                observation(
                    index * 2 + 1,
                    "A",
                    pair.scenario,
                    pair.pairId,
                    pair.a ? 0 : null,
                ),
            ),
            ...pairs.map((pair, index) =>
                observation(
                    index * 2 + 2,
                    "B",
                    pair.scenario,
                    pair.pairId,
                    pair.b ? 0 : null,
                ),
            ),
        ];

        // Act
        const result = pairObservations(rows, slotsFor(pairs));

        // Assert
        assert.equal(result.pairs.length, 15);
        assert.equal(result.pairs.filter((pair) => pair.complete).length, 13);
        assert.equal(result.unmatched.length, 2);
        assert.deepEqual(
            result.unmatched.map((row) => row.identity.arm).sort(),
            ["A", "B"],
        );
    });

    it("computes the paired delta, win counts and interval from complete pairs only", () => {
        // Arrange — 3 complete pairs: B +5, tie, A +5.
        const pairs = [
            { pairId: "P03", scenario: "R02", a: 0, b: 5 },
            { pairId: "P05", scenario: "R03", a: 0, b: 0 },
            { pairId: "P23", scenario: "R02", a: 5, b: 0 },
        ];
        const rows = pairs.flatMap((pair, index) => [
            observation(index * 2 + 1, "A", pair.scenario, pair.pairId, pair.a),
            observation(index * 2 + 2, "B", pair.scenario, pair.pairId, pair.b),
        ]);
        const pairing = pairObservations(
            rows,
            slotsFor(pairs.map((pair) => ({ ...pair, a: true, b: true }))),
        );

        // Act
        const comparison = pairedComparison(pairing.pairs, "A", "B");

        // Assert
        assert.equal(comparison.completePairs, 3);
        assert.equal(comparison.candidateBetter, 1);
        assert.equal(comparison.controlBetter, 1);
        assert.equal(comparison.ties, 1);
        assert.equal(comparison.delta, 0);
        assert.deepEqual(comparison.interval, { low: 0, high: 0 });
    });

    it("never pairs by array adjacency: reordering observations changes nothing", () => {
        // Arrange
        const pairs = [
            { pairId: "P01", scenario: "R01", a: 5, b: 0 },
            { pairId: "P02", scenario: "R02", a: 0, b: 5 },
        ];
        const rows = pairs.flatMap((pair, index) => [
            observation(index * 2 + 1, "A", pair.scenario, pair.pairId, pair.a),
            observation(index * 2 + 2, "B", pair.scenario, pair.pairId, pair.b),
        ]);
        const slots = slotsFor(
            pairs.map((pair) => ({ ...pair, a: true, b: true })),
        );

        // Act
        const forward = pairObservations(rows, slots);
        const reversed = pairObservations(
            [...rows].reverse(),
            [...slots].reverse(),
        );

        // Assert
        assert.deepEqual(
            pairedComparison(reversed.pairs, "A", "B"),
            pairedComparison(forward.pairs, "A", "B"),
        );
    });

    it("keeps observations without a declared pair out of the pair analysis", () => {
        // Arrange
        const rows = [observation(1, "A", "R01", "", 5)];
        const slots = [slot({ pairId: undefined })];

        // Act
        const result = pairObservations(rows, slots);

        // Assert
        assert.equal(result.pairs.length, 0);
        assert.equal(result.unpaired.length, 1);
    });
});
