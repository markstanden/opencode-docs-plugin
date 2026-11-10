import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_WEIGHTS,
    buildAcPrompt,
    documentationScore,
    finalistQualifies,
    parseAcJudgement,
    rankCandidates,
    sensitivity,
    summariseArm,
    trialUtility,
    validateAcJudgement,
    type DocumentationOutcome,
    type ScoredTrial,
} from "./fixtures/placement-harness/ac-scoring.mts";

type TrialOverrides = Omit<Partial<ScoredTrial>, "outcome"> & {
    outcome?: DocumentationOutcome | undefined;
};

const trial = (overrides: TrialOverrides = {}): ScoredTrial => ({
    arm: "A",
    scenario: "NOTE-01",
    planned: true,
    usable: true,
    outcome: "useful-create",
    primary: "pass",
    guardrailBreach: false,
    ...overrides,
});

describe("buildAcPrompt", () => {
    it("carries the task, truth and both document states", () => {
        // Arrange
        const input = {
            taskPrompt: "TASK-MARKER",
            standingPermission: "PERMISSION-MARKER",
            scenarioTruth: "TRUTH-MARKER",
            beforeDocs: [{ path: "docs/before.md", contents: "BEFORE-BODY" }],
            afterDocs: [{ path: "docs/after.md", contents: "AFTER-BODY" }],
            changedPaths: ["docs/after.md"],
            primary: { status: "pass", exit: 0, stdout: "OK", stderr: "" },
            docsOperations: ["read docs/before.md"],
            answer: "ANSWER-MARKER",
        };

        // Act
        const prompt = buildAcPrompt(input);

        // Assert
        for (const marker of [
            "TASK-MARKER",
            "PERMISSION-MARKER",
            "TRUTH-MARKER",
            "docs/before.md",
            "BEFORE-BODY",
            "AFTER-BODY",
            "ANSWER-MARKER",
        ]) {
            assert.ok(prompt.includes(marker), `prompt is missing ${marker}`);
        }
    });

    it("renders an empty document state explicitly instead of leaving a gap", () => {
        // Arrange
        const input = {
            taskPrompt: "t",
            standingPermission: "p",
            scenarioTruth: "s",
            beforeDocs: [],
            afterDocs: [],
            changedPaths: [],
            primary: { status: "pass", exit: 0, stdout: "", stderr: "" },
            docsOperations: [],
            answer: "a",
        };

        // Act
        const prompt = buildAcPrompt(input);

        // Assert
        assert.match(prompt, /BEFORE THE TRIAL:\n\(none\)/);
        assert.match(prompt, /PATHS CHANGED[\s\S]*?\(none\)/);
    });
});

describe("parseAcJudgement", () => {
    it("parses a bare JSON object", () => {
        // Arrange
        const text =
            '{"documentationOutcome":"transient","documentationReason":"r","evidence":["e"]}';

        // Act
        const parsed = parseAcJudgement(text);

        // Assert
        assert.deepEqual(parsed.problems, []);
        assert.equal(parsed.value?.documentationOutcome, "transient");
    });

    it("parses an object wrapped in judge prose", () => {
        // Arrange
        const text =
            'Here is my verdict:\n{"documentationOutcome":"none","documentationReason":"r","evidence":["e"]}\nDone.';

        // Act
        const parsed = parseAcJudgement(text);

        // Assert
        assert.deepEqual(parsed.problems, []);
        assert.equal(parsed.value?.documentationOutcome, "none");
    });

    it("fails without a JSON object", () => {
        // Arrange
        const text = "I could not decide.";

        // Act
        const parsed = parseAcJudgement(text);

        // Assert
        assert.ok(parsed.value === undefined);
        assert.match(parsed.problems[0] ?? "", /no JSON object/);
    });

    it("reports a bare JSON array as no object at all", () => {
        // Arrange
        const text = "[1,2,3]";

        // Act
        const parsed = parseAcJudgement(text);

        // Assert
        assert.ok(parsed.value === undefined);
        assert.match(parsed.problems[0] ?? "", /no JSON object/);
    });
});

describe("validateAcJudgement", () => {
    const changed = {
        documentsChanged: true,
        createdPaths: ["docs/new.md"],
        modifiedPaths: [],
    };
    const unchanged = {
        documentsChanged: false,
        createdPaths: [],
        modifiedPaths: [],
    };

    it("accepts a useful create backed by a created document", () => {
        // Arrange
        const value = {
            documentationOutcome: "useful-create",
            documentationReason: "captures the page cap",
            evidence: ["the transport caps pages at 500"],
        };

        // Act
        const problems = validateAcJudgement(value, changed);

        // Assert
        assert.deepEqual(problems, []);
    });

    it("rejects a create when nothing was created", () => {
        // Arrange
        const value = {
            documentationOutcome: "useful-create",
            documentationReason: "r",
            evidence: ["e"],
        };

        // Act
        const problems = validateAcJudgement(value, {
            documentsChanged: true,
            createdPaths: [],
            modifiedPaths: ["docs/old.md"],
        });

        // Assert
        assert.match(problems.join("; "), /no document was created/);
    });

    it("rejects an update when no existing document was modified", () => {
        // Arrange
        const value = {
            documentationOutcome: "useful-update",
            documentationReason: "r",
            evidence: ["e"],
        };

        // Act
        const problems = validateAcJudgement(value, changed);

        // Assert
        assert.match(problems.join("; "), /no existing document was modified/);
    });

    it('rejects "none" when a document changed', () => {
        // Arrange
        const value = {
            documentationOutcome: "none",
            documentationReason: "r",
            evidence: ["e"],
        };

        // Act
        const problems = validateAcJudgement(value, changed);

        // Assert
        assert.match(
            problems.join("; "),
            /but a documentation document changed/,
        );
    });

    it("rejects a written outcome when nothing changed", () => {
        // Arrange
        const value = {
            documentationOutcome: "transient",
            documentationReason: "r",
            evidence: ["e"],
        };

        // Act
        const problems = validateAcJudgement(value, unchanged);

        // Assert
        assert.match(problems.join("; "), /no documentation document changed/);
    });

    it("accepts restraint with an explicit reason", () => {
        // Arrange
        const value = {
            documentationOutcome: "none",
            documentationReason: "no durable finding; correct restraint",
            evidence: ["no knowledge-lake document changed"],
        };

        // Act
        const problems = validateAcJudgement(value, unchanged);

        // Assert
        assert.deepEqual(problems, []);
    });

    it("rejects an off-enum outcome", () => {
        // Arrange
        const value = {
            documentationOutcome: "good",
            documentationReason: "r",
            evidence: ["e"],
        };

        // Act
        const problems = validateAcJudgement(value, changed);

        // Assert
        assert.match(
            problems.join("; "),
            /documentationOutcome must be one of/,
        );
    });

    it("rejects a blank reason and empty evidence together", () => {
        // Arrange
        const value = {
            documentationOutcome: "useful-create",
            documentationReason: "   ",
            evidence: [],
        };

        // Act
        const problems = validateAcJudgement(value, changed);

        // Assert
        assert.match(problems.join("; "), /nonblank string/);
        assert.match(problems.join("; "), /at least one nonblank string/);
    });
});

describe("R02 preservation assessment", () => {
    const changed = {
        documentsChanged: true,
        createdPaths: [],
        modifiedPaths: ["docs/db/pool.md"],
    };
    const baseInput = {
        taskPrompt: "Make the pool require TLS.",
        standingPermission: "You may update documentation.",
        scenarioTruth: "The pool facts must survive.",
        beforeDocs: [{ path: "docs/db/pool.md", contents: "before" }],
        afterDocs: [{ path: "docs/db/pool.md", contents: "after" }],
        changedPaths: ["lakes/docs/db/pool.md"],
        primary: { status: "pass", exit: 0, stdout: "ok", stderr: "" },
        docsOperations: ["completed native replace docs/db/pool.md"],
        answer: "Updated the note.",
    };
    const finding = (state: string, quote: string) => ({ state, quote });
    const assessment = (overrides = {}) => ({
        documentationOutcome: "useful-update",
        documentationReason: "corrected the TLS claim",
        evidence: ["Connections require TLS."],
        preservation: {
            poolSize: finding("retained", "at most 10 connections"),
            acquireTimeout: finding("retained", "up to 5 seconds"),
            startupMigrations: finding("retained", "at application startup"),
            obsoleteTlsClaim: finding("removed", "(absent)"),
        },
        ...overrides,
    });

    it("asks for the preservation entries only when the scenario requires them", () => {
        // Act
        const required = buildAcPrompt({
            ...baseInput,
            requirePreservation: true,
        });
        const optional = buildAcPrompt(baseInput);

        // Assert
        assert.match(required, /PRESERVATION ASSESSMENT/);
        assert.match(required, /"obsoleteTlsClaim"/);
        assert.doesNotMatch(optional, /PRESERVATION ASSESSMENT/);
    });

    it("accepts a complete evidence-backed assessment", () => {
        // Act
        const problems = validateAcJudgement(assessment(), changed, {
            requirePreservation: true,
        });

        // Assert
        assert.deepEqual(problems, []);
    });

    it("rejects a required assessment that is missing", () => {
        // Arrange
        const value = assessment();
        delete (value as { preservation?: unknown }).preservation;

        // Act
        const problems = validateAcJudgement(value, changed, {
            requirePreservation: true,
        });

        // Assert
        assert.match(problems.join("; "), /preservation must be an object/);
    });

    it("rejects an unquoted fact", () => {
        // Arrange
        const value = assessment({
            preservation: {
                ...assessment().preservation,
                acquireTimeout: finding("retained", "   "),
            },
        });

        // Act
        const problems = validateAcJudgement(value, changed, {
            requirePreservation: true,
        });

        // Assert
        assert.match(
            problems.join("; "),
            /preservation\.acquireTimeout\.quote must be a nonblank string/,
        );
    });

    it("rejects lost valid knowledge scored as a useful update", () => {
        // Arrange
        const value = assessment({
            preservation: {
                ...assessment().preservation,
                poolSize: finding("lost", "(absent)"),
            },
        });

        // Act
        const problems = validateAcJudgement(value, changed, {
            requirePreservation: true,
        });

        // Assert
        assert.match(problems.join("; "), /lost valid fact \(poolSize\)/);
    });

    it("accepts lost valid knowledge scored as misleading", () => {
        // Arrange
        const value = assessment({
            documentationOutcome: "misleading",
            preservation: {
                ...assessment().preservation,
                poolSize: finding("lost", "(absent)"),
            },
        });

        // Act
        const problems = validateAcJudgement(value, changed, {
            requirePreservation: true,
        });

        // Assert
        assert.deepEqual(problems, []);
    });

    it("rejects a lost fact when no document changed", () => {
        // Arrange
        const unchanged = {
            documentsChanged: false,
            createdPaths: [],
            modifiedPaths: [],
        };
        const value = assessment({
            documentationOutcome: "misleading",
            preservation: {
                ...assessment().preservation,
                startupMigrations: finding("lost", "(absent)"),
            },
        });

        // Act
        const problems = validateAcJudgement(value, unchanged, {
            requirePreservation: true,
        });

        // Assert
        assert.match(problems.join("; "), /no documentation document changed/);
    });

    it("leaves a judgement without preservation valid when not required", () => {
        // Arrange
        const value = {
            documentationOutcome: "useful-update",
            documentationReason: "r",
            evidence: ["e"],
        };

        // Act
        const problems = validateAcJudgement(value, {
            documentsChanged: true,
            createdPaths: [],
            modifiedPaths: ["docs/db/pool.md"],
        });

        // Assert
        assert.deepEqual(problems, []);
    });
});

describe("documentationScore", () => {
    it("scores every outcome under the default weights", () => {
        // Arrange
        const expected: Record<string, number> = {
            "useful-create": 5,
            "useful-update": 5,
            transient: -1,
            duplicate: -2,
            misleading: -5,
            none: 0,
        };

        // Act + Assert
        for (const [outcome, score] of Object.entries(expected)) {
            assert.equal(
                documentationScore(
                    outcome as Parameters<typeof documentationScore>[0],
                ),
                score,
                outcome,
            );
        }
    });

    it("honours overridden weights", () => {
        // Arrange
        const weights = { ...DEFAULT_WEIGHTS, useful: 8, transient: -2 };

        // Act + Assert
        assert.equal(documentationScore("useful-update", weights), 8);
        assert.equal(documentationScore("transient", weights), -2);
        assert.equal(documentationScore("duplicate", weights), -2);
    });
});

describe("trialUtility", () => {
    it("adds the documentation and failed-primary components", () => {
        // Arrange
        const slot = trial({ outcome: "transient", primary: "fail" });

        // Act
        const utility = trialUtility(slot);

        // Assert
        assert.equal(utility.score, -6);
        assert.equal(utility.assessed, true);
    });

    it("treats an unknown primary result as a bounded interval, not zero", () => {
        // Arrange
        const slot = trial({ outcome: "useful-create", primary: "unknown" });

        // Act
        const utility = trialUtility(slot);

        // Assert
        assert.equal(utility.low, 0);
        assert.equal(utility.high, 5);
        assert.equal(utility.assessed, false);
    });

    it("reports an unusable trial as missing, never as a zero outcome", () => {
        // Arrange
        const slot = trial({ usable: false, outcome: undefined });

        // Act
        const utility = trialUtility(slot);

        // Assert
        assert.equal(utility.score, 0);
        assert.equal(utility.low, -10);
        assert.equal(utility.high, 5);
        assert.equal(utility.assessed, false);
    });
});

describe("summariseArm", () => {
    it("counts outcomes, tasks and guardrails over the planned slots", () => {
        // Arrange
        const slots = [
            trial({ outcome: "useful-create" }),
            trial({ outcome: "transient", primary: "fail" }),
            trial({ outcome: "none", primary: "unknown" }),
            trial({ outcome: "misleading", guardrailBreach: true }),
        ];

        // Act
        const summary = summariseArm(slots);

        // Assert
        assert.equal(summary.planned, 4);
        assert.equal(summary.assessed, 3);
        assert.equal(summary.total, 5 - 6 - 5);
        assert.equal(summary.outcomes["useful-create"], 1);
        assert.equal(summary.outcomes.transient, 1);
        assert.equal(summary.outcomes.misleading, 1);
        assert.equal(summary.primaryFail, 1);
        assert.equal(summary.primaryUnknown, 1);
        assert.equal(summary.guardrailBreaches, 1);
    });

    it("reports means per planned and per assessed trial separately", () => {
        // Arrange
        const slots = [
            trial({ outcome: "useful-create" }),
            trial({ outcome: "useful-update" }),
            trial({ outcome: undefined, usable: false }),
            trial({ scenario: "NOTE-03", outcome: undefined, usable: false }),
        ];

        // Act
        const summary = summariseArm(slots);

        // Assert
        assert.equal(summary.total, 10);
        assert.equal(summary.meanPerPlanned, 2.5);
        assert.equal(summary.meanPerAssessed, 5);
        assert.ok(summary.missingLow < 0);
        assert.ok(summary.missingHigh > 0);
    });
});

describe("finalistQualifies", () => {
    const summary = (overrides: Parameters<typeof summariseArm>[0]) =>
        summariseArm(overrides);
    const complete = (outcome: ScoredTrial["outcome"]) =>
        summary([
            trial({ outcome }),
            trial({ outcome }),
            trial({ outcome }),
            trial({ outcome }),
        ]);

    it("qualifies a complete candidate at the threshold", () => {
        // Arrange
        const control = complete("none");
        const candidate = complete("useful-create");

        // Act
        const verdict = finalistQualifies(control, candidate, 2);

        // Assert
        assert.equal(verdict.qualifies, true);
    });

    it("refuses incomplete assessment coverage", () => {
        // Arrange
        const control = summary([
            trial({ outcome: "none" }),
            trial({ outcome: undefined, usable: false }),
        ]);
        const candidate = summary([trial({ outcome: "useful-create" })]);

        // Act
        const verdict = finalistQualifies(control, candidate, 2);

        // Assert
        assert.equal(verdict.qualifies, false);
        assert.match(verdict.reason, /incomplete assessment coverage/);
    });

    it("refuses a candidate with a guardrail breach even when it leads", () => {
        // Arrange
        const control = complete("none");
        const candidate = summary([
            trial({ outcome: "useful-create" }),
            trial({ outcome: "useful-create" }),
            trial({ outcome: "useful-create" }),
            trial({ outcome: "useful-create", guardrailBreach: true }),
        ]);

        // Act
        const verdict = finalistQualifies(control, candidate, 2);

        // Assert
        assert.equal(verdict.qualifies, false);
        assert.match(verdict.reason, /guardrail breach/);
    });

    it("refuses a lead below the threshold", () => {
        // Arrange
        const control = complete("none");
        const candidate = summary([
            trial({ outcome: "useful-create" }),
            trial({ outcome: "transient" }),
            trial({ outcome: "none" }),
            trial({ outcome: "none" }),
        ]);

        // Act
        const verdict = finalistQualifies(control, candidate, 5);

        // Assert
        assert.equal(verdict.qualifies, false);
        assert.match(verdict.reason, /lead 4 < 5/);
    });
});

describe("rankCandidates", () => {
    const entry = (
        arm: string,
        outcomes: ScoredTrial["outcome"][],
        characters: number,
    ) => ({
        arm,
        characters,
        summary: summariseArm(
            outcomes.map((outcome) => trial({ arm, outcome })),
        ),
    });

    it("ranks by utility first", () => {
        // Arrange
        const weaker = entry("C", ["useful-create", "none"], 600);
        const stronger = entry("D", ["useful-create", "useful-create"], 900);

        // Act
        const ranked = rankCandidates([weaker, stronger]);

        // Assert
        assert.deepEqual(
            ranked.map((candidate) => candidate.arm),
            ["D", "C"],
        );
    });

    it("breaks a utility tie on fewer primary-task failures", () => {
        // Arrange
        const failing = summariseArm([
            trial({ arm: "C", outcome: "useful-create" }),
            trial({ arm: "C", outcome: "useful-create", primary: "fail" }),
            trial({ arm: "C", outcome: "useful-create" }),
        ]);
        const clean = summariseArm([
            trial({ arm: "D", outcome: "useful-create" }),
            trial({ arm: "D", outcome: "useful-create" }),
        ]);

        // Act
        const ranked = rankCandidates([
            { arm: "C", characters: 100, summary: failing },
            { arm: "D", characters: 900, summary: clean },
        ]);

        // Assert
        assert.equal(failing.total, clean.total);
        assert.deepEqual(
            ranked.map((candidate) => candidate.arm),
            ["D", "C"],
        );
    });

    it("breaks a utility tie on fewer misleading outcomes before length", () => {
        // Arrange
        const misleading = summariseArm([
            trial({ arm: "E", outcome: "useful-create" }),
            trial({ arm: "E", outcome: "misleading" }),
            trial({ arm: "E", outcome: "useful-create" }),
            trial({ arm: "E", outcome: "useful-create" }),
        ]);
        const clean = summariseArm([
            trial({ arm: "F", outcome: "useful-create" }),
            trial({ arm: "F", outcome: "useful-create" }),
            trial({ arm: "F", outcome: "none" }),
            trial({ arm: "F", outcome: "none" }),
        ]);

        // Act
        const ranked = rankCandidates([
            { arm: "E", characters: 100, summary: misleading },
            { arm: "F", characters: 900, summary: clean },
        ]);

        // Assert
        assert.equal(misleading.total, clean.total);
        assert.equal(misleading.outcomes.misleading, 1);
        assert.deepEqual(
            ranked.map((candidate) => candidate.arm),
            ["F", "E"],
        );
    });

    it("breaks a full tie on shorter text, then arm id", () => {
        // Arrange
        const long = entry("B", ["useful-create"], 1200);
        const shortZ = entry("Z", ["useful-create"], 400);
        const shortA = entry("A", ["useful-create"], 400);

        // Act
        const ranked = rankCandidates([long, shortZ, shortA]);

        // Assert
        assert.deepEqual(
            ranked.map((candidate) => candidate.arm),
            ["A", "Z", "B"],
        );
    });
});

describe("sensitivity", () => {
    it("re-scores every arm for each weight combination", () => {
        // Arrange
        const arms = {
            A: [
                trial({ arm: "A", outcome: "useful-create" }),
                trial({ arm: "A", outcome: "transient" }),
            ],
            B: [
                trial({ arm: "B", outcome: "useful-create" }),
                trial({ arm: "B", outcome: "none" }),
            ],
        };

        // Act
        const cells = sensitivity(arms, [3, 5], [0.5, 2]);

        // Assert
        assert.equal(cells.length, 4);
        const atUseful3Transient05 = cells.find(
            (cell) => cell.useful === 3 && cell.transient === 0.5,
        );
        assert.deepEqual(atUseful3Transient05?.totals, { A: 2.5, B: 3 });
    });

    it("shows a ranking that flips when the transient penalty is zero", () => {
        // Arrange
        const arms = {
            A: [
                trial({ arm: "A", outcome: "useful-create" }),
                trial({ arm: "A", outcome: "transient" }),
            ],
            B: [
                trial({ arm: "B", outcome: "useful-create" }),
                trial({ arm: "B", outcome: "none" }),
            ],
        };

        // Act
        const cells = sensitivity(arms, [5], [0, 2]);

        // Assert
        const free = cells.find((cell) => cell.transient === 0);
        const costly = cells.find((cell) => cell.transient === 2);
        assert.deepEqual(free?.ranking, ["A", "B"]);
        assert.deepEqual(costly?.ranking, ["B", "A"]);
    });
});
