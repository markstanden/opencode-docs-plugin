import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BudgetClaim } from "./fixtures/placement-harness/analysis/budget.ts";
import {
    closeCampaign,
    deriveClosure,
    type ClosureInput,
    type JudgeAttempt,
    type SlotObservation,
} from "./fixtures/placement-harness/analysis/closure.ts";

const zeroTokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
};

/** One judge attempt that failed auth before inference. */
const failedAuth = (attemptId: string): JudgeAttempt => ({
    attemptId,
    spawned: true,
    reachedInference: false,
    steps: 0,
    tokens: zeroTokens,
    status: "judge-error",
    durationMs: 120,
});

/** One judge attempt that reached inference and judged. */
const judged = (attemptId: string): JudgeAttempt => ({
    attemptId,
    spawned: true,
    reachedInference: true,
    steps: 1,
    tokens: { input: 10, output: 4, reasoning: 2, cacheRead: 0 },
    status: "judged",
    durationMs: 900,
});

/** One recorded, launched slot with two trial steps. */
const slot = (
    number: number,
    judge: JudgeAttempt[],
    overrides: Partial<SlotObservation> = {},
): SlotObservation => ({
    slot: number,
    pairId: `P0${Math.ceil(number / 2)}`,
    stamp: `pd-${number % 2 === 1 ? "A" : "B"}-r0-X${number}`,
    arm: number % 2 === 1 ? "A" : "B",
    scenario: `X${number}`,
    launched: true,
    recorded: true,
    trialSteps: 2,
    trialTokens: { input: 100, output: 20, reasoning: 5, cacheRead: 50 },
    trialDurationMs: 1000,
    judgeAttempts: judge,
    ...overrides,
});

/** A synthetic eight-slot campaign. */
function eightSlots(): SlotObservation[] {
    return Array.from({ length: 8 }, (_, index) =>
        slot(index + 1, [
            failedAuth("attempt-001"),
            judged("attempt-002"),
        ]),
    );
}

const input = (overrides: Partial<ClosureInput> = {}): ClosureInput => ({
    scheduledSlots: 8,
    observations: eightSlots(),
    ceilings: { trial: 16, judge: 16 },
    closed: false,
    ...overrides,
});

describe("campaign accounting", () => {
    it("separates launches, attempts reaching inference and usable judgements", () => {
        // Act
        const report = deriveClosure(input());

        // Assert
        assert.equal(report.trialLaunches, 8);
        assert.equal(report.trial.inferred, 8);
        assert.equal(report.judge.attempts, 16);
        assert.equal(report.judge.inferred, 8);
        assert.equal(report.judge.usableJudgements, 8);
        assert.equal(report.judge.unusableJudgements, 8);
        assert.equal(report.judge.steps, 8);
    });

    it("reports a known zero separately from an unavailable token field", () => {
        // Arrange
        const observations = [
            slot(1, [failedAuth("attempt-001")], {
                trialTokens: { ...zeroTokens },
            }),
            slot(2, [judged("attempt-001")], {
                trialTokens: {
                    input: 10,
                    output: null,
                    reasoning: 0,
                    cacheRead: null,
                },
            }),
        ];

        // Act
        const report = deriveClosure(input({ observations }));

        // Assert
        assert.equal(report.trial.tokens.input, 10);
        assert.equal(report.trial.tokens.output, null);
        assert.equal(report.trial.tokens.reasoning, 0);
        assert.equal(report.trial.tokenCoverage.input, 2);
        assert.equal(report.trial.tokenCoverage.output, 1);
    });

    it("exposes an unresolved reservation without counting it as a launch", () => {
        // Arrange
        const claim: BudgetClaim = {
            kind: "judge",
            index: 1,
            path: "judge/judge-0001.claim",
            state: "reserved",
            at: "2026-11-11T00:00:00Z",
            stamp: null,
            attemptId: null,
            note: null,
        };

        // Act
        const report = deriveClosure(
            input({ judgeClaims: [claim], observations: [] }),
        );

        // Assert
        assert.equal(report.judge.attempts, 0);
        assert.match(report.problems.join("; "), /never spawned/);
    });

    it("exposes a ceiling breach rather than absorbing it", () => {
        // Act
        const report = deriveClosure(
            input({ ceilings: { trial: 7, judge: 7 } }),
        );

        // Assert
        assert.match(report.problems.join("; "), /exceed the ceiling/);
    });
});

describe("campaign closure", () => {
    it("closes a clean P04 scope without inventing unrun slots", () => {
        // Arrange
        const observations = eightSlots().slice(0, 4);

        // Act
        const report = deriveClosure(
            input({ observations, scheduledSlots: 8 }),
        );
        const outcome = closeCampaign(report);

        // Assert
        assert.equal(outcome.ok, true);
        assert.equal(
            (outcome as { event: { scope: number } }).event.scope,
            4,
        );
        assert.deepEqual(report.unrunSlots, [5, 6, 7, 8]);
        assert.equal(report.stoppedAt, observations[3]?.stamp);
    });

    it("closes a clean P08 scope independently", () => {
        // Act
        const report = deriveClosure(input());
        const outcome = closeCampaign(report);

        // Assert
        assert.equal(outcome.ok, true);
        assert.deepEqual(report.unrunSlots, []);
        assert.equal(report.observedSlots, 8);
    });

    it("refuses to reopen a closed campaign", () => {
        // Arrange
        const report = deriveClosure(input());
        const first = closeCampaign(report);
        assert.equal(first.ok, true);

        // Act
        const second = closeCampaign({ ...report, state: "closed" });

        // Assert
        assert.equal(second.ok, false);
        assert.match(
            (second as { problems: string[] }).problems.join("; "),
            /already closed/,
        );
    });

    it("refuses a close with an unexplained observation", () => {
        // Arrange
        const observations = [
            slot(1, [judged("attempt-001")], { recorded: false }),
        ];

        // Act
        const report = deriveClosure(input({ observations }));
        const outcome = closeCampaign(report);

        // Assert
        assert.equal(outcome.ok, false);
        assert.match(
            (outcome as { problems: string[] }).problems.join("; "),
            /launched without a recorded result/,
        );
    });

    it("refuses to close a campaign with no evidence", () => {
        // Act
        const outcome = closeCampaign(
            deriveClosure(input({ observations: [] })),
        );

        // Assert
        assert.equal(outcome.ok, false);
        assert.match(
            (outcome as { problems: string[] }).problems.join("; "),
            /no campaign evidence/,
        );
    });
});
