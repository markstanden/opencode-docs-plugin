import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    measureTrial,
    parseMeasureDeclarations,
    parseOperations,
    personalTrialDecision,
    targetsNote,
    type ArmMeasureSummary,
    type MeasureDeclarations,
} from "./fixtures/placement-harness/analysis/measures.ts";
import type { AccountingCounts } from "./fixtures/placement-harness/analysis/accounting.ts";
import type { TrialRecord } from "./fixtures/placement-harness/analysis/records.ts";

const declarations: MeasureDeclarations = {
    recording: ["R01"],
    retrieval: {
        S02: { note: "ops/staging-deploy.md", facts: [] },
    },
};

const journal = {
    read: JSON.stringify({
        status: "completed",
        surface: "native",
        input: { read: "ops/staging-deploy.md" },
    }),
    add: JSON.stringify({
        status: "completed",
        surface: "native",
        input: { add: { mode: "create", path: "ops/note.md" } },
    }),
    failedAdd: JSON.stringify({
        status: "error",
        surface: "native",
        input: { add: { mode: "create", path: "ops/note.md" } },
    }),
    search: JSON.stringify({
        status: "completed",
        surface: "native",
        input: { search: "staging" },
    }),
};

type Overrides = {
    gate?: string;
    primary?: "pass" | "fail" | "unknown";
    outcome?: string;
    journal?: string[];
    journalState?: "available" | "missing";
    retrieval?: { state: string; quote: string } | null;
    scenario?: string;
};

const record = (overrides: Overrides = {}): TrialRecord => ({
    identity: {
        resultRoot: "gen/a/results",
        stamp: "pd-A-r0-S02",
        scenario: overrides.scenario ?? "S02",
    },
    attempt: { state: "recorded", usable: true, problems: [] },
    run: { state: "available", value: {}, source: "meta.json" },
    gate: {
        state: "available",
        value: { status: overrides.gate ?? "pass", reason: null },
        source: "gate.json",
    },
    primary: { status: overrides.primary ?? "pass", problems: [] },
    assessment: {
        status: "judged",
        layer: "judge",
        outcome: (overrides.outcome ?? "none") as never,
        reason: "r",
        evidence: ["e"],
        preservation: { state: "missing", source: "ac" },
        retrieval:
            overrides.retrieval === null
                ? { state: "missing", source: "ac" }
                : {
                      state: "available",
                      value: overrides.retrieval ?? {
                          state: "applied",
                          quote: "used the ordering",
                      },
                      source: "ac",
                  },
        problems: [],
    },
    judgeModel: { state: "available", value: "judge", source: "meta" },
    tokens: { state: "missing", source: "stdout.jsonl" },
    artefacts: {
        finalAnswer: { state: "available", value: "answer", source: "final" },
        writesText: { state: "available", value: "", source: "writes" },
        docsOperations:
            overrides.journalState === "missing"
                ? { state: "missing", source: "docs" }
                : {
                      state: "available",
                      value: overrides.journal ?? [],
                      source: "docs",
                  },
        promptText: { state: "missing", source: "prompt" },
    },
});

const counts = (overrides: Partial<AccountingCounts> = {}): AccountingCounts =>
    ({
        planned: 2,
        recordedLaunches: 2,
        unprovenDirectories: 0,
        absent: 0,
        completed: 2,
        usableUnknown: 0,
        unusable: 0,
        documented: 2,
        assessed: 2,
        excluded: 0,
        assessmentStatuses: {
            judged: 2,
            "invalid-verdict": 0,
            "judge-error": 0,
            unassessed: 0,
            "not-run": 0,
            unknown: 0,
        },
        primary: { pass: 2, fail: 0, unknown: 0 },
        gate: { pass: 2, blocked: 0, other: 0, missing: 0 },
        outcomes: {
            "useful-create": 0,
            "useful-update": 0,
            transient: 0,
            duplicate: 0,
            misleading: 0,
            none: 2,
        },
        utilityTotal: 0,
        ...overrides,
    }) as AccountingCounts;

describe("measure declarations", () => {
    it("accepts eligible scenarios, target notes and preservation facts", () => {
        // Act
        const parsed = parseMeasureDeclarations({
            recordingOpportunities: ["R01"],
            retrievalOpportunities: ["S02"],
            scenarios: {
                S02: {
                    retrieval: { note: "ops/staging-deploy.md" },
                    preservation: { facts: [{ id: "snapshot" }] },
                },
            },
        });

        // Assert
        assert.deepEqual(parsed.problems, []);
        assert.deepEqual(parsed.declarations?.recording, ["R01"]);
        assert.deepEqual(parsed.declarations?.retrieval.S02, {
            note: "ops/staging-deploy.md",
            facts: ["snapshot"],
        });
    });

    it("refuses a retrieval opportunity with no target note", () => {
        // Act
        const parsed = parseMeasureDeclarations({
            recordingOpportunities: [],
            retrievalOpportunities: ["S02"],
            scenarios: { S02: { retrieval: {} } },
        });

        // Assert
        assert.match(
            parsed.problems.join("; "),
            /scenarios\.S02\.retrieval\.note must be nonblank/,
        );
    });
});

describe("docs-operation parsing", () => {
    it("classifies reads and adds with their typed targets", () => {
        // Act
        const parsed = parseOperations([journal.read, journal.add]);

        // Assert
        assert.deepEqual(parsed.problems, []);
        assert.deepEqual(
            parsed.operations.map((one) => [one.verb, one.target]),
            [
                ["read", "ops/staging-deploy.md"],
                ["add", "ops/note.md"],
            ],
        );
    });

    it("keeps an unparsable line explicit", () => {
        // Act
        const parsed = parseOperations(["not json"]);

        // Assert
        assert.match(parsed.problems.join("; "), /not JSON/);
    });

    it("matches lake-qualified and lake-relative targets, not fragments", () => {
        // Assert
        assert.equal(
            targetsNote("shared/ado/status.md", "ado/status.md"),
            true,
        );
        assert.equal(targetsNote("ado/status.md", "ado/status.md"), true);
        assert.equal(targetsNote("ado/status.md", "other/status.md"), false);
    });
});

describe("retrieval measure", () => {
    it("counts an attributable read whose detail the judge saw applied", () => {
        // Act
        const measured = measureTrial(
            record({ journal: [journal.read] }),
            declarations,
            "A",
        );

        // Assert
        assert.equal(measured.retrieval.state, "applied");
        assert.equal(measured.retrieval.read, true);
        assert.match(measured.retrieval.trace[0] ?? "", /staging-deploy/);
    });

    it("treats an observed absence of a read as a miss", () => {
        // Act
        const measured = measureTrial(
            record({ journal: [journal.search] }),
            declarations,
            "A",
        );

        // Assert
        assert.equal(measured.retrieval.state, "miss");
        assert.equal(measured.retrieval.read, false);
    });

    it("stays unknown when a read exists but no judgement was recorded", () => {
        // Act
        const measured = measureTrial(
            record({ journal: [journal.read], retrieval: null }),
            declarations,
            "A",
        );

        // Assert
        assert.equal(measured.retrieval.state, "unknown");
    });

    it("does not credit a read when the primary task failed", () => {
        // Act
        const measured = measureTrial(
            record({ journal: [journal.read], primary: "fail" }),
            declarations,
            "A",
        );

        // Assert
        assert.equal(measured.retrieval.state, "unknown");
    });

    it("stays unknown when the journal itself is missing", () => {
        // Act
        const measured = measureTrial(
            record({ journalState: "missing" }),
            declarations,
            "A",
        );

        // Assert
        assert.equal(measured.retrieval.state, "unknown");
    });
});

describe("recording measure", () => {
    const recordingDeclarations: MeasureDeclarations = {
        recording: ["R01"],
        retrieval: {},
    };
    const create = (overrides: Overrides = {}) =>
        record({
            scenario: "R01",
            outcome: "useful-create",
            journal: [journal.add],
            ...overrides,
        });

    it("counts a verified plugin-mediated write to a shared lake", () => {
        // Act
        const measured = measureTrial(create(), recordingDeclarations, "A");

        // Assert
        assert.equal(measured.recording.success, true);
        assert.equal(measured.recording.disposition, "verified-write");
    });

    it("separates a filesystem-only write from a verified write", () => {
        // Act
        const measured = measureTrial(
            create({ journal: [journal.search] }),
            recordingDeclarations,
            "A",
        );

        // Assert
        assert.equal(measured.recording.success, false);
        assert.equal(measured.recording.disposition, "filesystem-only");
    });

    it("separates a tool error from a verified write", () => {
        // Act
        const measured = measureTrial(
            create({ journal: [journal.failedAdd] }),
            recordingDeclarations,
            "A",
        );

        // Assert
        assert.equal(measured.recording.disposition, "tool-error");
    });

    it("stays unknown when a write exists but no judgement was recorded", () => {
        // Arrange
        const value = create();
        value.assessment.outcome = undefined;
        value.assessment.status = "judge-error";

        // Act
        const measured = measureTrial(value, recordingDeclarations, "A");

        // Assert
        assert.equal(measured.recording.disposition, "unknown");
    });
});

describe("personal-trial screen", () => {
    type ArmOverrides = {
        recording?: Partial<ArmMeasureSummary["recording"]>;
        retrieval?: Partial<ArmMeasureSummary["retrieval"]>;
    };
    const arm = (overrides: ArmOverrides = {}) => ({
        recording: {
            planned: 4,
            success: 2,
            miss: 2,
            unknown: 0,
            dispositions: {},
            ...(overrides.recording ?? {}),
        },
        retrieval: {
            planned: 5,
            applied: 2,
            miss: 3,
            unknown: 0,
            states: {},
            ...(overrides.retrieval ?? {}),
        },
    });
    type ScreenOverrides = {
        measures?: Record<string, ArmMeasureSummary>;
        counts?: Record<string, AccountingCounts>;
        guardrails?: { status: string; detail: string };
        coverage?: { status: string; detail: string };
        utilityThreshold?: {
            status: string;
            lead: number | null;
            interval: { low: number; high: number } | null;
        };
    };
    const screen = (overrides: ScreenOverrides = {}) =>
        personalTrialDecision(
            "A",
            "B",
            overrides.measures ?? { A: arm(), B: arm() },
            overrides.counts ?? { A: counts(), B: counts() },
            overrides.guardrails ?? { status: "clean", detail: "clean" },
            overrides.coverage ?? { status: "pass", detail: "complete" },
            overrides.utilityThreshold ?? {
                status: "pass",
                lead: 0,
                interval: { low: 0, high: 0 },
            },
        );

    it("gives no promotion on a dead heat", () => {
        // Act
        const decision = screen();

        // Assert
        assert.equal(decision.recommendation, "no-promotion");
        assert.match(decision.reasons.join("; "), /tie gives no promotion/);
        assert.equal(decision.utilityThreshold.component, "utility-threshold");
    });

    it("earns a personal trial on one extra applied retrieval", () => {
        // Arrange
        const extra = screen({
            measures: {
                A: arm(),
                B: arm({ retrieval: { applied: 3, miss: 2 } }),
            },
        });

        // Assert
        assert.equal(extra.recommendation, "personal-trial");
    });

    it("is inconclusive when missing attribution could change the decision", () => {
        // Arrange
        const unknown = screen({
            measures: {
                A: arm(),
                B: arm({
                    recording: { success: 2, miss: 1, unknown: 1 },
                }),
            },
        });

        // Assert
        assert.equal(unknown.recommendation, "inconclusive");
        assert.match(unknown.reasons.join("; "), /unknown/);
    });
});
