import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AccountingCounts } from "./fixtures/placement-harness/analysis/accounting.ts";
import {
    pairedMisleadingCriterion,
    personalTrialDecision,
    type ArmMeasureSummary,
    type PairedOutcome,
} from "./fixtures/placement-harness/analysis/measures.ts";

/** One arm's opportunity summary with the counts the screen reads. */
function arm(
    overrides: {
        recording?: number;
        retrieval?: number;
        recordingUnknown?: number;
        retrievalUnknown?: number;
    } = {},
): ArmMeasureSummary {
    const recording = overrides.recording ?? 2;
    const retrieval = overrides.retrieval ?? 2;
    return {
        recording: {
            planned: 4,
            success: recording,
            miss: 4 - recording,
            unknown: overrides.recordingUnknown ?? 0,
            notRun: 0,
            dispositions: {},
        },
        retrieval: {
            planned: 5,
            applied: retrieval,
            miss: 5 - retrieval,
            unknown: overrides.retrievalUnknown ?? 0,
            notRun: 0,
            states: {},
        },
    };
}

/** One arm's accounting with equal primary passes by default. */
function counts(overrides: Partial<AccountingCounts> = {}): AccountingCounts {
    return {
        planned: 8,
        recordedLaunches: 8,
        unprovenDirectories: 0,
        absent: 0,
        completed: 8,
        usableUnknown: 0,
        unusable: 0,
        documented: 8,
        assessed: 8,
        excluded: 0,
        assessmentStatuses: {
            judged: 8,
            "invalid-verdict": 0,
            "judge-error": 0,
            unassessed: 0,
            "not-run": 0,
            unknown: 0,
        },
        primary: { pass: 8, fail: 0, unknown: 0 },
        gate: { pass: 8, blocked: 0, other: 0, missing: 0 },
        outcomes: {
            "useful-create": 2,
            "useful-update": 2,
            transient: 0,
            duplicate: 0,
            misleading: 0,
            none: 4,
        },
        utilityTotal: 20,
        ...overrides,
    } as AccountingCounts;
}

const clean = { status: "clean", detail: "no candidate guardrail concern" };
const complete = { status: "pass", detail: "coverage complete" };
const threshold = { status: "pass", lead: 0, interval: { low: 0, high: 0 } };

/** One pair's outcomes, arm A as control and B as candidate. */
function pair(
    pairId: string,
    control: string[],
    candidate: string[],
): PairedOutcome {
    return {
        pairId,
        control: control as PairedOutcome["control"],
        candidate: candidate as PairedOutcome["candidate"],
    };
}

describe("paired misleading veto", () => {
    it("fails when only the candidate is misleading in one pair", () => {
        // Act
        const criterion = pairedMisleadingCriterion([
            pair("P01", ["misleading"], ["none"]),
            pair("P02", ["none"], ["misleading"]),
        ]);

        // Assert
        assert.equal(criterion.status, "fail");
        assert.match(criterion.reasons[0] ?? "", /P02/);
    });

    it("passes when both sides of the pair are misleading", () => {
        // Act
        const criterion = pairedMisleadingCriterion([
            pair("P01", ["misleading"], ["misleading"]),
        ]);

        // Assert
        assert.equal(criterion.status, "pass");
    });
});

describe("authoritative personal-trial screen", () => {
    it("gives no promotion even when a paired swap hides equal aggregates", () => {
        // Arrange: A misleading in P01, B in P02; B has one extra retrieval, so
        // the opportunity counts and aggregate utility both look like a win.
        const decision = personalTrialDecision(
            "A",
            "B",
            {
                A: arm({ retrieval: 2 }),
                B: arm({ retrieval: 3 }),
            },
            { A: counts(), B: counts() },
            clean,
            complete,
            threshold,
            [
                pair("P01", ["misleading"], ["none"]),
                pair("P02", ["none"], ["misleading"]),
            ],
        );

        // Assert
        assert.equal(decision.recommendation, "no-promotion");
        assert.match(decision.reasons.join("; "), /candidate-only misleading/);
    });

    it("promotes when the same extra retrieval has no paired loss", () => {
        // Act
        const decision = personalTrialDecision(
            "A",
            "B",
            {
                A: arm({ retrieval: 2 }),
                B: arm({ retrieval: 3 }),
            },
            { A: counts(), B: counts() },
            clean,
            complete,
            threshold,
            [pair("P01", ["misleading"], ["misleading"])],
        );

        // Assert
        assert.equal(decision.recommendation, "personal-trial");
    });

    it("gives no promotion on a dead heat", () => {
        // Act
        const decision = personalTrialDecision(
            "A",
            "B",
            { A: arm(), B: arm() },
            { A: counts(), B: counts() },
            clean,
            complete,
            threshold,
            [pair("P01", ["none"], ["none"])],
        );

        // Assert
        assert.equal(decision.recommendation, "no-promotion");
    });

    it("gives no promotion on a certain loss", () => {
        // Act
        const decision = personalTrialDecision(
            "A",
            "B",
            { A: arm({ retrieval: 3 }), B: arm({ retrieval: 1 }) },
            { A: counts(), B: counts() },
            clean,
            complete,
            threshold,
            [pair("P01", ["none"], ["none"])],
        );

        // Assert
        assert.equal(decision.recommendation, "no-promotion");
    });

    it("stays inconclusive on an unresolved candidate guardrail", () => {
        // Act
        const decision = personalTrialDecision(
            "A",
            "B",
            { A: arm({ retrieval: 2 }), B: arm({ retrieval: 3 }) },
            { A: counts(), B: counts() },
            { status: "unresolved", detail: "destructive-loss: unresolved" },
            complete,
            threshold,
            [pair("P01", ["none"], ["none"])],
        );

        // Assert
        assert.equal(decision.recommendation, "inconclusive");
        assert.match(decision.reasons.join("; "), /guardrail is unresolved/);
    });

    it("stays inconclusive on incomplete evidence", () => {
        // Act
        const decision = personalTrialDecision(
            "A",
            "B",
            { A: arm({ retrieval: 2 }), B: arm({ retrieval: 3 }) },
            { A: counts(), B: counts() },
            clean,
            { status: "fail", detail: "assessment coverage: 4/8, 4/8" },
            threshold,
            [pair("P01", ["none"], ["none"])],
        );

        // Assert
        assert.equal(decision.recommendation, "inconclusive");
    });
});
