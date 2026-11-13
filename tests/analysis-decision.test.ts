import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    evaluateGuardrail,
    summariseGuardrails,
    type GuardrailArmSummary,
} from "./fixtures/placement-harness/analysis/guardrails.ts";
import { evaluateDecision } from "./fixtures/placement-harness/analysis/decision.ts";
import type {
    Loaded,
    PreservationByFact,
    TrialRecord,
} from "./fixtures/placement-harness/analysis/records.ts";
import type { AccountingCounts } from "./fixtures/placement-harness/analysis/accounting.ts";
import type {
    GuardrailSpec,
    ScenarioIdentity,
    SelectionSpec,
} from "./fixtures/placement-harness/analysis/model.ts";
import {
    finalistQualifies,
    type ArmSummary,
} from "./fixtures/placement-harness/ac-scoring.mts";

const mutationGuardrail: GuardrailSpec = {
    id: "mutation-policy",
    kind: "mutation-policy",
    requirement: "no out-of-policy mutation",
};

const lossGuardrail: GuardrailSpec = {
    id: "destructive-loss",
    kind: "destructive-loss",
    requirement: "no loss of still-valid facts",
};

const inventoryScenario: ScenarioIdentity = {
    id: "R02",
    preservationInventory: {
        facts: [
            {
                id: "poolSize",
                label: "pool cap",
                mentionPatterns: ["\\b10\\b"],
            },
            {
                id: "obsoleteTlsClaim",
                label: "obsolete TLS claim",
                obsoleteCurrentPatterns: ["sslmode"],
            },
        ],
        negationCues: ["\\bnot\\b"],
    },
};

const bareScenario: ScenarioIdentity = { id: "R04" };

const record = (
    overrides: {
        stamp?: string;
        scenario?: string;
        run?: Loaded<Record<string, unknown>>;
        gate?: Loaded<{ status: string; reason: string | null }>;
        preservation?: Loaded<PreservationByFact>;
    } = {},
): TrialRecord => ({
    identity: {
        resultRoot: "results",
        stamp: overrides.stamp ?? "cc-A-r0-R02",
        scenario: overrides.scenario ?? "R02",
    },
    attempt: { state: "recorded", usable: true, problems: [] },
    run:
        overrides.run ??
        ({
            state: "available",
            value: { policyViolations: [] },
            source: "meta",
        } as Loaded<Record<string, unknown>>),
    gate:
        overrides.gate ??
        ({ state: "missing", source: "gate.json" } as Loaded<{
            status: string;
            reason: string | null;
        }>),
    primary: { status: "pass", problems: [] },
    assessment: {
        status: "judged",
        layer: "judge",
        outcome: "useful-update",
        reason: "reason",
        evidence: [],
        preservation:
            overrides.preservation ??
            ({ state: "missing", source: "ac" } as Loaded<PreservationByFact>),
        retrieval: { state: "missing", source: "ac" },
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

const preservation = (
    facts: Record<string, { state: string; quote: string } | "missing">,
): Loaded<PreservationByFact> => {
    const value: PreservationByFact = {};
    for (const [factId, entry] of Object.entries(facts)) {
        value[factId] =
            entry === "missing"
                ? { state: "missing", source: `ac#${factId}` }
                : {
                      state: "available",
                      value: entry,
                      source: `ac#${factId}`,
                  };
    }
    return { state: "available", value, source: "ac" };
};

describe("evaluateGuardrail", () => {
    it("passes a mutation policy with no recorded violations", () => {
        // Act
        const finding = evaluateGuardrail(
            mutationGuardrail,
            record(),
            inventoryScenario,
        );

        // Assert
        assert.equal(finding.status, "pass");
        assert.deepEqual(finding.evidence, []);
    });

    it("fails a mutation policy with recorded violations and keeps the record", () => {
        // Arrange
        const run: Loaded<Record<string, unknown>> = {
            state: "available",
            value: {
                policyViolations: ["work/package.json outside allowed paths"],
            },
            source: "meta",
        };

        // Act
        const finding = evaluateGuardrail(
            mutationGuardrail,
            record({ run }),
            inventoryScenario,
        );

        // Assert
        assert.equal(finding.status, "fail");
        assert.ok(
            finding.evidence.some((line) => line.includes("package.json")),
        );
    });

    it("stays unknown when no mutation policy was recorded, never a false pass", () => {
        // Act
        const absent = evaluateGuardrail(
            mutationGuardrail,
            record({ run: { state: "missing", source: "meta" } }),
            inventoryScenario,
        );
        const fieldless = evaluateGuardrail(
            mutationGuardrail,
            record({
                run: { state: "available", value: {}, source: "meta" },
            }),
            inventoryScenario,
        );

        // Assert
        assert.equal(absent.status, "unknown");
        assert.equal(fieldless.status, "unknown");
    });

    it("passes destructive-loss when every inventory fact is retained or the obsolete claim removed", () => {
        // Act
        const finding = evaluateGuardrail(
            lossGuardrail,
            record({
                preservation: preservation({
                    poolSize: { state: "retained", quote: "pool holds 10" },
                    obsoleteTlsClaim: { state: "removed", quote: "gone" },
                }),
            }),
            inventoryScenario,
        );

        // Assert
        assert.equal(finding.status, "pass");
    });

    it("fails destructive-loss on a lost fact or a surviving obsolete claim, quoting the evidence", () => {
        // Act
        const lost = evaluateGuardrail(
            lossGuardrail,
            record({
                preservation: preservation({
                    poolSize: { state: "lost", quote: "(absent)" },
                    obsoleteTlsClaim: { state: "removed", quote: "gone" },
                }),
            }),
            inventoryScenario,
        );
        const obsoleteSurvived = evaluateGuardrail(
            lossGuardrail,
            record({
                preservation: preservation({
                    poolSize: { state: "retained", quote: "pool holds 10" },
                    obsoleteTlsClaim: {
                        state: "retained",
                        quote: "sslmode=disable",
                    },
                }),
            }),
            inventoryScenario,
        );

        // Assert
        assert.equal(lost.status, "fail");
        assert.ok(lost.evidence.some((line) => line.includes("(absent)")));
        assert.equal(obsoleteSurvived.status, "fail");
        assert.ok(
            obsoleteSurvived.evidence.some((line) => line.includes("sslmode")),
        );
    });

    it("stays unknown when a preservation observation is missing or unrecognised", () => {
        // Act
        const missing = evaluateGuardrail(
            lossGuardrail,
            record({
                preservation: preservation({
                    poolSize: { state: "retained", quote: "pool holds 10" },
                    obsoleteTlsClaim: "missing",
                }),
            }),
            inventoryScenario,
        );
        const unrecognised = evaluateGuardrail(
            lossGuardrail,
            record({
                preservation: preservation({
                    poolSize: { state: "vibes", quote: "?" },
                    obsoleteTlsClaim: { state: "removed", quote: "gone" },
                }),
            }),
            inventoryScenario,
        );
        const noAssessment = evaluateGuardrail(
            lossGuardrail,
            record(),
            inventoryScenario,
        );

        // Assert
        assert.equal(missing.status, "unknown");
        assert.equal(unrecognised.status, "unknown");
        assert.equal(noAssessment.status, "unknown");
    });

    it("cannot establish loss without a semantic assessment: a preserve gate block is unresolved, not a failure", () => {
        // Arrange — the R04 shape: no inventory, gate blocked on a preserved path.
        const gate: Loaded<{ status: string; reason: string | null }> = {
            state: "available",
            value: {
                status: "blocked",
                reason: "preserved lakes/docs/db/migrations.md was modified by the run; the expectation requires it untouched",
            },
            source: "gate.json",
        };

        // Act
        const unresolved = evaluateGuardrail(
            lossGuardrail,
            record({ scenario: "R04", gate }),
            bareScenario,
        );
        const untouched = evaluateGuardrail(
            lossGuardrail,
            record({ scenario: "R04" }),
            bareScenario,
        );

        // Assert
        assert.equal(unresolved.status, "unknown");
        assert.ok(
            unresolved.evidence.some((line) => line.includes("migrations.md")),
        );
        assert.equal(untouched.status, "not-applicable");
    });
});

describe("summariseGuardrails", () => {
    it("summarises per declared guardrail with coverage counts and stamp-prefixed evidence", () => {
        // Arrange
        const trials = [
            record({ stamp: "cc-B-r0-R02" }),
            record({
                stamp: "cc-B-r1-R02",
                preservation: preservation({
                    poolSize: { state: "lost", quote: "(absent)" },
                    obsoleteTlsClaim: { state: "removed", quote: "gone" },
                }),
            }),
            record({ stamp: "cc-B-r2-R04", scenario: "R04" }),
        ];

        // Act
        const summaries = summariseGuardrails(
            [mutationGuardrail, lossGuardrail],
            [inventoryScenario, bareScenario],
            trials,
        );

        // Assert
        const mutation = summaries.find(
            (summary) => summary.guardrailId === "mutation-policy",
        )!;
        const loss = summaries.find(
            (summary) => summary.guardrailId === "destructive-loss",
        )!;
        assert.equal(mutation.status, "clean");
        assert.equal(mutation.coverage.pass, 3);
        assert.equal(loss.status, "breached");
        assert.equal(loss.coverage.fail, 1);
        assert.equal(loss.coverage["not-applicable"], 1);
        assert.ok(
            loss.evidence.some((line) => line.startsWith("cc-B-r1-R02:")),
        );
    });

    it("prefers an unresolved guardrail over a clean one", () => {
        // Arrange
        const trials = [
            record({
                stamp: "cc-B-r0-R02",
                preservation: preservation({
                    poolSize: { state: "retained", quote: "10" },
                    obsoleteTlsClaim: { state: "removed", quote: "gone" },
                }),
            }),
            record({
                stamp: "cc-B-r1-R02",
                preservation: preservation({
                    poolSize: { state: "retained", quote: "10" },
                    obsoleteTlsClaim: "missing",
                }),
            }),
        ];

        // Act
        const [loss] = summariseGuardrails(
            [lossGuardrail],
            [inventoryScenario],
            trials,
        );

        // Assert
        assert.equal(loss?.status, "unresolved");
        assert.equal(loss?.coverage.pass, 1);
        assert.equal(loss?.coverage.unknown, 1);
    });
});

const counts = (
    overrides: Partial<AccountingCounts> = {},
): AccountingCounts => ({
    planned: 20,
    recordedLaunches: 20,
    unprovenDirectories: 0,
    absent: 0,
    completed: 20,
    usableUnknown: 0,
    unusable: 0,
    documented: 20,
    assessed: 20,
    excluded: 0,
    assessmentStatuses: {
        judged: 20,
        "invalid-verdict": 0,
        "judge-error": 0,
        unassessed: 0,
        "not-run": 0,
        unknown: 0,
    },
    primary: { pass: 20, fail: 0, unknown: 0 },
    gate: { pass: 20, blocked: 0, other: 0, missing: 0 },
    outcomes: {
        "useful-create": 20,
        "useful-update": 0,
        transient: 0,
        duplicate: 0,
        misleading: 0,
        none: 0,
    },
    utilityTotal: 100,
    utilityLow: 100,
    utilityHigh: 100,
    meanPerPlanned: 5,
    meanPerAssessed: 5,
    ...overrides,
});

const selection = (overrides: Partial<SelectionSpec> = {}): SelectionSpec => ({
    controlArm: "A",
    candidateArm: "B",
    threshold: 5,
    requireCompleteCoverage: true,
    ...overrides,
});

const guardrailSummary = (
    status: GuardrailArmSummary["status"],
): GuardrailArmSummary => ({
    guardrailId: "mutation-policy",
    kind: "mutation-policy",
    requirement: "no out-of-policy mutation",
    status,
    coverage: { pass: 20, fail: 0, unknown: 0, "not-applicable": 0 },
    evidence: [],
});

describe("evaluateDecision", () => {
    it("qualifies when coverage is complete, the threshold is met and guardrails are clean", () => {
        // Act
        const decision = evaluateDecision(
            selection(),
            {
                A: counts(),
                B: counts({
                    utilityTotal: 106,
                    utilityLow: 106,
                    utilityHigh: 106,
                }),
            },
            [guardrailSummary("clean")],
        );

        // Assert
        assert.equal(decision.overall, "qualified");
        assert.equal(decision.coverage.status, "pass");
        assert.equal(decision.threshold.status, "pass");
        assert.equal(decision.threshold.lead, 6);
        assert.equal(decision.guardrails.status, "clean");
    });

    it("is inconclusive when assessment coverage is incomplete, even if the assessed population trails", () => {
        // Act
        const decision = evaluateDecision(
            selection(),
            {
                A: counts({
                    utilityTotal: 29,
                    utilityLow: 29,
                    utilityHigh: 29,
                }),
                B: counts({
                    utilityTotal: 26,
                    utilityLow: 26,
                    utilityHigh: 26,
                    documented: 19,
                    assessed: 19,
                }),
            },
            [guardrailSummary("clean")],
        );

        // Assert
        assert.equal(decision.overall, "inconclusive");
        assert.equal(decision.coverage.status, "fail");
        assert.equal(decision.threshold.status, "fail");
        assert.equal(decision.threshold.lead, -3);
        assert.ok(decision.reasons.some((line) => line.includes("coverage")));
    });

    it("does not qualify on a threshold failure with complete coverage", () => {
        // Act
        const decision = evaluateDecision(
            selection(),
            {
                A: counts(),
                B: counts({
                    utilityTotal: 103,
                    utilityLow: 103,
                    utilityHigh: 103,
                }),
            },
            [guardrailSummary("clean")],
        );

        // Assert
        assert.equal(decision.overall, "not-qualified");
        assert.equal(decision.threshold.status, "fail");
    });

    it("does not qualify when a guardrail is breached, however large the lead", () => {
        // Act
        const decision = evaluateDecision(
            selection(),
            {
                A: counts(),
                B: counts({
                    utilityTotal: 200,
                    utilityLow: 200,
                    utilityHigh: 200,
                }),
            },
            [guardrailSummary("breached")],
        );

        // Assert
        assert.equal(decision.overall, "not-qualified");
        assert.equal(decision.guardrails.status, "breached");
    });

    it("is inconclusive when a guardrail is unresolved: an unknown cannot prove failure", () => {
        // Act
        const decision = evaluateDecision(
            selection(),
            {
                A: counts(),
                B: counts({
                    utilityTotal: 106,
                    utilityLow: 106,
                    utilityHigh: 106,
                }),
            },
            [guardrailSummary("unresolved")],
        );

        // Assert
        assert.equal(decision.overall, "inconclusive");
        assert.equal(decision.guardrails.status, "unresolved");
        assert.equal(decision.threshold.status, "pass");
    });

    it("reports not-defined when the campaign froze no selection rule", () => {
        // Act
        const decision = evaluateDecision(
            undefined,
            {
                A: counts(),
                B: counts(),
            },
            [],
        );

        // Assert
        assert.equal(decision.overall, "not-defined");
        assert.equal(decision.coverage.status, "not-defined");
        assert.equal(decision.threshold.status, "not-defined");
        assert.equal(decision.threshold.lead, null);
        assert.equal(decision.guardrails.status, "not-defined");
    });

    it("qualifies only when the full-population interval clears the threshold", () => {
        // Arrange — every missing-data completion of B leads A by at least 6.
        const decision = evaluateDecision(
            selection({ threshold: 5 }),
            {
                A: counts({ utilityLow: 96, utilityHigh: 104 }),
                B: counts({
                    utilityTotal: 112,
                    utilityLow: 110,
                    utilityHigh: 118,
                }),
            },
            [guardrailSummary("clean")],
        );

        // Assert
        assert.equal(decision.coverage.status, "pass");
        assert.equal(decision.threshold.status, "pass");
        assert.equal(decision.overall, "qualified");
        assert.deepEqual(decision.threshold.interval, { low: 6, high: 22 });
        assert.equal(decision.threshold.lead, 12);
    });

    it("fails when no full-population completion reaches the threshold", () => {
        // Act
        const decision = evaluateDecision(
            selection({ threshold: 5 }),
            {
                A: counts(),
                B: counts({
                    utilityTotal: 95,
                    utilityLow: 95,
                    utilityHigh: 97,
                }),
            },
            [guardrailSummary("clean")],
        );

        // Assert
        assert.deepEqual(decision.threshold.interval, { low: -5, high: -3 });
        assert.equal(decision.threshold.status, "fail");
        assert.equal(decision.overall, "not-qualified");
    });

    it("is inconclusive when the full-population interval crosses the threshold", () => {
        // Arrange — the confirmation's observed −3 and bounds −13..+7 vs +5.
        const decision = evaluateDecision(
            selection({ threshold: 5 }),
            {
                A: counts({
                    utilityTotal: 29,
                    utilityLow: 24,
                    utilityHigh: 34,
                }),
                B: counts({
                    utilityTotal: 26,
                    utilityLow: 21,
                    utilityHigh: 31,
                    documented: 19,
                    assessed: 19,
                }),
            },
            [guardrailSummary("clean")],
        );

        // Assert
        assert.equal(decision.threshold.lead, -3);
        assert.deepEqual(decision.threshold.interval, { low: -13, high: 7 });
        assert.equal(decision.threshold.status, "inconclusive");
        assert.equal(decision.overall, "inconclusive");
    });

    it("lets a non-compensable breach decide even when the threshold interval crosses", () => {
        // Act
        const decision = evaluateDecision(
            selection({ threshold: 5 }),
            {
                A: counts({
                    utilityTotal: 29,
                    utilityLow: 24,
                    utilityHigh: 34,
                }),
                B: counts({
                    utilityTotal: 26,
                    utilityLow: 21,
                    utilityHigh: 31,
                }),
            },
            [guardrailSummary("breached")],
        );

        // Assert
        assert.equal(decision.threshold.status, "inconclusive");
        assert.equal(decision.guardrails.status, "breached");
        assert.equal(decision.overall, "not-qualified");
    });

    it("reports an incomparable threshold as inconclusive, not a failure", () => {
        // Act
        const decision = evaluateDecision(
            selection(),
            {
                A: counts({ utilityTotal: 0, assessed: 0, documented: 0 }),
                B: counts({ utilityTotal: 0, assessed: 0, documented: 0 }),
            },
            [guardrailSummary("clean")],
        );

        // Assert
        assert.equal(decision.threshold.status, "inconclusive");
        assert.equal(decision.overall, "inconclusive");
    });

    it("qualifies when the interval's lower bound sits exactly on the threshold", () => {
        // Act
        const decision = evaluateDecision(
            selection({ threshold: 5 }),
            {
                A: counts(),
                B: counts({
                    utilityTotal: 105,
                    utilityLow: 105,
                    utilityHigh: 105,
                }),
            },
            [guardrailSummary("clean")],
        );

        // Assert – the rule is "every completion clears it", so equality passes.
        assert.deepEqual(decision.threshold.interval, { low: 5, high: 5 });
        assert.equal(decision.threshold.status, "pass");
        assert.equal(decision.overall, "qualified");
    });

    it("is inconclusive when the interval's upper bound sits exactly on the threshold", () => {
        // Act
        const decision = evaluateDecision(
            selection({ threshold: 5 }),
            {
                A: counts(),
                B: counts({
                    utilityTotal: 100,
                    utilityLow: 100,
                    utilityHigh: 105,
                }),
            },
            [guardrailSummary("clean")],
        );

        // Assert – equality is not a failure: only an interval wholly below the
        // threshold fails.
        assert.deepEqual(decision.threshold.interval, { low: 0, high: 5 });
        assert.equal(decision.threshold.status, "inconclusive");
        assert.equal(decision.overall, "inconclusive");
    });

    it("marks coverage not-applicable when the rule does not require it", () => {
        // Act
        const decision = evaluateDecision(
            selection({ requireCompleteCoverage: false }),
            {
                A: counts(),
                B: counts({
                    utilityTotal: 105,
                    utilityLow: 105,
                    utilityHigh: 105,
                    documented: 19,
                    assessed: 19,
                }),
            },
            [guardrailSummary("clean")],
        );

        // Assert
        assert.equal(decision.coverage.status, "not-applicable");
        assert.equal(decision.overall, "qualified");
    });

    it("reports not-defined when the campaign declared no guardrails", () => {
        // Act – model validation forbids an empty list in a real manifest, so
        // this limb is reachable only from a direct caller.
        const decision = evaluateDecision(
            selection(),
            { A: counts(), B: counts() },
            [],
        );

        // Assert
        assert.equal(decision.guardrails.status, "not-defined");
        assert.equal(
            decision.guardrails.detail,
            "the campaign declared no guardrails",
        );
    });

    it("reports not-defined when the selection names an arm with no accounting", () => {
        // Act
        const decision = evaluateDecision(selection(), { A: counts() }, [
            guardrailSummary("clean"),
        ]);

        // Assert
        assert.equal(decision.overall, "not-defined");
        assert.match(decision.reasons.join("; "), /A\/B/);
    });
});

describe("decision compatibility with finalistQualifies", () => {
    const summary = (overrides: Partial<ArmSummary> = {}): ArmSummary => ({
        arm: "A",
        planned: 20,
        attempted: 20,
        completed: 20,
        usable: 20,
        assessed: 20,
        outcomes: {
            "useful-create": 0,
            "useful-update": 0,
            transient: 0,
            duplicate: 0,
            misleading: 0,
            none: 0,
        },
        primaryPass: 20,
        primaryFail: 0,
        primaryUnknown: 0,
        guardrailBreaches: 0,
        total: 100,
        meanPerPlanned: 5,
        meanPerAssessed: 5,
        missingLow: 0,
        missingHigh: 0,
        ...overrides,
    });

    it("agrees with the boolean API whenever every limb is decisive", () => {
        // Arrange
        const cases: Array<{
            control: ArmSummary;
            candidate: ArmSummary;
            threshold: number;
        }> = [
            {
                control: summary({ arm: "A" }),
                candidate: summary({ arm: "B", total: 106 }),
                threshold: 5,
            },
            {
                control: summary({ arm: "A" }),
                candidate: summary({ arm: "B", total: 103 }),
                threshold: 5,
            },
            {
                control: summary({ arm: "A" }),
                candidate: summary({
                    arm: "B",
                    total: 120,
                    guardrailBreaches: 1,
                }),
                threshold: 5,
            },
        ];

        // Act / Assert
        for (const one of cases) {
            const boolean = finalistQualifies(
                one.control,
                one.candidate,
                one.threshold,
            ).qualifies;
            const decision = evaluateDecision(
                selection({ threshold: one.threshold }),
                {
                    A: counts({
                        utilityTotal: one.control.total,
                        utilityLow: one.control.total,
                        utilityHigh: one.control.total,
                    }),
                    B: counts({
                        utilityTotal: one.candidate.total,
                        utilityLow: one.candidate.total,
                        utilityHigh: one.candidate.total,
                        assessed: one.candidate.assessed,
                        documented: one.candidate.assessed,
                        planned: one.candidate.planned,
                    }),
                },
                [
                    guardrailSummary(
                        one.candidate.guardrailBreaches > 0
                            ? "breached"
                            : "clean",
                    ),
                ],
            );
            assert.equal(
                decision.overall === "qualified",
                boolean,
                JSON.stringify(one.candidate),
            );
        }
    });

    it("splits the boolean false into not-qualified and inconclusive, and records the difference", () => {
        // Arrange — incomplete coverage with a trailing assessed population.
        const control = summary({ arm: "A", total: 29 });
        const candidate = summary({
            arm: "B",
            total: 26,
            assessed: 19,
            planned: 20,
        });

        // Act
        const boolean = finalistQualifies(control, candidate, 5);
        const decision = evaluateDecision(
            selection(),
            {
                A: counts({
                    utilityTotal: 29,
                    utilityLow: 29,
                    utilityHigh: 29,
                }),
                B: counts({
                    utilityTotal: 26,
                    utilityLow: 26,
                    utilityHigh: 26,
                    assessed: 19,
                    documented: 19,
                }),
            },
            [guardrailSummary("clean")],
        );

        // Assert
        assert.equal(boolean.qualifies, false);
        assert.equal(decision.overall, "inconclusive");
        assert.equal(decision.coverage.status, "fail");
        assert.equal(decision.threshold.status, "fail");
    });
});
