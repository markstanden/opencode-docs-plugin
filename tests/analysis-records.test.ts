import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    loadLaunchLedger,
    loadTrialRecord,
    readMarkdownTree,
    type EvidenceReader,
} from "./fixtures/placement-harness/analysis/records.ts";

/** An in-memory evidence tree: files keyed by relative path. */
const evidence = (files: Record<string, string>): EvidenceReader => ({
    readTextFile: (path) =>
        files[path] === undefined
            ? { state: "missing", source: path }
            : { state: "available", value: files[path]!, source: path },
    readDirectoryEntries: (dir) => {
        const prefix = dir.endsWith("/") ? dir : `${dir}/`;
        const children = new Set<string>();
        let exists = false;
        for (const path of Object.keys(files)) {
            if (!path.startsWith(prefix)) continue;
            exists = true;
            const rest = path.slice(prefix.length);
            children.add(rest.split("/")[0]!);
        }
        if (!exists) return { state: "missing", source: dir };
        return {
            state: "available",
            value: [...children].sort(),
            source: dir,
        };
    },
});

const judgedJson = (outcome = "useful-create") =>
    JSON.stringify({
        status: "judged",
        documentationOutcome: outcome,
        documentationReason: "needed and supported",
        evidence: ["decisive quote"],
    });

/** The complete file set of one usable, judged, passing trial. */
const completeTrial = (stamp: string): Record<string, string> => ({
    [`results/${stamp}/meta.json`]: JSON.stringify({
        exit: 0,
        signal: null,
        timedOut: false,
        outputOverflow: false,
        answerValid: true,
        policyViolations: [],
    }),
    [`results/${stamp}/gate.json`]: JSON.stringify({
        status: "pass",
        reason: "criteria met",
    }),
    [`results/${stamp}/primary-check.json`]: JSON.stringify({
        status: "pass",
        exit: 0,
    }),
    [`results/${stamp}/ac/attempt-001/judgement.json`]: judgedJson(),
    [`results/${stamp}/ac/attempt-001/meta.json`]: JSON.stringify({
        judgeModel: "opencode-go/glm-5.3-flash",
        status: "finished",
    }),
    [`results/${stamp}/final.md`]: "I created docs/note.md.",
    [`results/${stamp}/writes.txt`]: "added: docs/note.md (file)",
    [`results/${stamp}/docs-operations.jsonl`]:
        '{"surface":"native","status":"success","input":{"add":{"mode":"create","path":"docs/note.md"}}}\n',
    [`results/${stamp}/stdout.jsonl`]:
        '{"type":"step_finish","part":{"tokens":{"input":10,"output":5,"reasoning":0,"cache":{"read":2}}}}\n',
});

const load = (
    files: Record<string, string>,
    overrides: Partial<Parameters<typeof loadTrialRecord>[1]> = {},
) =>
    loadTrialRecord(evidence(files), {
        resultRoot: "results",
        stamp: "cc-A-r0-R01",
        scenario: "R01",
        inventoryFactIds: [],
        selectionPolicy: "resolution-then-judgement",
        ...overrides,
    });

describe("loadTrialRecord", () => {
    it("loads a complete judged trial with usable, gate, primary and assessment facts", () => {
        // Act
        const record = load(completeTrial("cc-A-r0-R01"));

        // Assert
        assert.equal(record.attempt.state, "recorded");
        assert.equal(record.attempt.usable, true);
        assert.equal(record.gate.state, "available");
        assert.equal(
            record.gate.state === "available" ? record.gate.value.status : "",
            "pass",
        );
        assert.equal(record.primary.status, "pass");
        assert.equal(record.assessment.status, "judged");
        assert.equal(record.assessment.layer, "judge");
        assert.equal(record.assessment.outcome, "useful-create");
        assert.equal(record.judgeModel.state, "available");
        assert.equal(record.tokens.state, "available");
        assert.deepEqual(
            record.tokens.state === "available" ? record.tokens.value : null,
            { input: 10, output: 5, reasoning: 0, cacheRead: 2, steps: 1 },
        );
        assert.equal(record.artefacts.finalAnswer.state, "available");
    });

    it("treats an absent trial directory as not run, never as empty", () => {
        // Act
        const record = load({});

        // Assert
        assert.equal(record.attempt.state, "absent");
        assert.equal(record.assessment.status, "not-run");
        assert.equal(record.gate.state, "missing");
        assert.equal(record.primary.status, "unknown");
        assert.equal(record.artefacts.finalAnswer.state, "missing");
    });

    it("never promotes a bare reservation to a recorded launch", () => {
        // Act
        const record = load({ "results/cc-A-r0-R01/.reservation": "" });

        // Assert
        assert.equal(record.attempt.state, "reservation-only");
        assert.equal(record.attempt.usable, "unknown");
        // A reservation proves no judge attempt either way: unknown, not not-run.
        assert.equal(record.assessment.status, "unknown");
    });

    it("stays unknown when a directory exists without a run record", () => {
        // Act
        const record = load({
            "results/cc-A-r0-R01/prompt.md": "the prompt",
        });

        // Assert
        assert.equal(record.attempt.state, "unknown");
        assert.equal(record.attempt.usable, "unknown");
        assert.ok(
            record.attempt.problems.some((p) => p.includes("no run record")),
        );
    });

    it("marks a run unusable when validity fields disagree, and limited when absent", () => {
        // Act
        const timedOut = load({
            "results/cc-A-r0-R01/meta.json": JSON.stringify({
                exit: 0,
                signal: null,
                timedOut: true,
                outputOverflow: false,
                answerValid: true,
            }),
        });
        const limited = load({
            "results/cc-A-r0-R01/meta.json": JSON.stringify({ exit: 0 }),
        });

        // Assert
        assert.equal(timedOut.attempt.usable, false);
        assert.ok(
            timedOut.attempt.problems.some((p) => p.includes("timedOut")),
        );
        assert.equal(limited.attempt.usable, false);
        assert.ok(
            limited.attempt.problems.some((p) => p.includes("answerValid")),
        );
    });

    it("keeps primary unknown when the check is missing or malformed", () => {
        // Act
        const missing = load({});
        const malformed = load({
            ...completeTrial("cc-A-r0-R01"),
            "results/cc-A-r0-R01/primary-check.json": "not json",
        });

        // Assert
        assert.equal(missing.primary.status, "unknown");
        assert.equal(malformed.primary.status, "unknown");
        assert.ok(
            malformed.primary.problems.some((p) => p.includes("not json")),
        );
    });

    it("keeps the gate as explicit evidence with its recorded reason", () => {
        // Act
        const blocked = load({
            "results/cc-A-r0-R01/gate.json": JSON.stringify({
                status: "blocked",
                reason: "preserved content was modified",
            }),
        });

        // Assert
        assert.equal(blocked.gate.state, "available");
        assert.equal(
            blocked.gate.state === "available" ? blocked.gate.value.status : "",
            "blocked",
        );
    });

    it("never turns a judge error or invalid verdict into an outcome", () => {
        // Act
        const judgeError = load({
            ...completeTrial("cc-A-r0-R01"),
            "results/cc-A-r0-R01/ac/attempt-001/judgement.json": JSON.stringify(
                {
                    status: "judge-error",
                    problems: ["process not ok (exit null)"],
                },
            ),
        });
        const invalid = load({
            ...completeTrial("cc-A-r0-R01"),
            "results/cc-A-r0-R01/ac/attempt-001/judgement.json": JSON.stringify(
                {
                    status: "invalid-verdict",
                    problems: ["documentationOutcome must be one of ..."],
                },
            ),
        });

        // Assert
        assert.equal(judgeError.assessment.status, "judge-error");
        assert.equal(judgeError.assessment.outcome, undefined);
        assert.equal(invalid.assessment.status, "invalid-verdict");
        assert.equal(invalid.assessment.outcome, undefined);
    });

    it("reports an unsupported outcome value instead of silently dropping it", () => {
        // Act
        const record = load({
            ...completeTrial("cc-A-r0-R01"),
            "results/cc-A-r0-R01/ac/attempt-001/judgement.json": JSON.stringify(
                {
                    status: "judged",
                    documentationOutcome: "excellent",
                    documentationReason: "great",
                    evidence: ["quote"],
                },
            ),
        });

        // Assert
        assert.equal(record.assessment.status, "judged");
        assert.equal(record.assessment.outcome, undefined);
        assert.ok(
            record.assessment.problems.some((p) =>
                p.includes("unsupported documentationOutcome"),
            ),
        );
    });

    it("prefers a judged deterministic resolution over the raw judgement", () => {
        // Act
        const record = load({
            ...completeTrial("cc-A-r0-R01"),
            "results/cc-A-r0-R01/ac/attempt-001/judgement.json": JSON.stringify(
                {
                    status: "invalid-verdict",
                    problems: ["verdict is not valid JSON"],
                },
            ),
            "results/cc-A-r0-R01/ac/attempt-001/resolution.json":
                JSON.stringify({
                    status: "judged",
                    parsed: {
                        documentationOutcome: "useful-update",
                        documentationReason: "repaired",
                        evidence: ["quote"],
                    },
                }),
        });

        // Assert
        assert.equal(record.assessment.layer, "deterministic-resolution");
        assert.equal(record.assessment.outcome, "useful-update");
    });

    it("falls back to the raw judgement when a resolution stayed unresolved", () => {
        // Act
        const record = load({
            ...completeTrial("cc-A-r0-R01"),
            "results/cc-A-r0-R01/ac/attempt-001/judgement.json": JSON.stringify(
                {
                    status: "invalid-verdict",
                    problems: ["verdict is not valid JSON"],
                },
            ),
            "results/cc-A-r0-R01/ac/attempt-001/resolution.json":
                JSON.stringify({
                    status: "unresolved",
                    method: "first-balanced-object",
                }),
        });

        // Assert
        assert.equal(record.assessment.layer, "judge");
        assert.equal(record.assessment.status, "invalid-verdict");
        assert.ok(
            record.assessment.problems.some((p) => p.includes("unresolved")),
        );
    });

    it("honours a recorded judgement-only policy even when a resolution exists", () => {
        // Act — the resolution says useful-update, the judgement says none;
        // the recorded policy governs, never the favourable verdict.
        const record = load(
            {
                ...completeTrial("cc-A-r0-R01"),
                "results/cc-A-r0-R01/ac/attempt-001/judgement.json":
                    judgedJson("none"),
                "results/cc-A-r0-R01/ac/attempt-001/resolution.json":
                    JSON.stringify({
                        status: "judged",
                        parsed: {
                            documentationOutcome: "useful-update",
                            documentationReason: "repaired",
                            evidence: ["quote"],
                        },
                    }),
            },
            { selectionPolicy: "judgement-only" },
        );

        // Assert
        assert.equal(record.assessment.layer, "judge");
        assert.equal(record.assessment.outcome, "none");
    });

    it("reports unassessed when an attempt exists without a judgement", () => {
        // Act
        const files = completeTrial("cc-A-r0-R01");
        const record = load(
            Object.fromEntries(
                Object.entries(files).filter(
                    ([path]) => !path.includes("judgement.json"),
                ),
            ),
        );

        // Assert
        assert.equal(record.assessment.status, "unassessed");
        assert.equal(record.assessment.outcome, undefined);
    });

    it("loads preservation per inventory fact, malformed and absent facts explicit", () => {
        // Arrange
        const files = completeTrial("cc-A-r0-R01");
        const judged = {
            ...files,
            "results/cc-A-r0-R01/ac/attempt-001/judgement.json": JSON.stringify(
                {
                    status: "judged",
                    documentationOutcome: "useful-update",
                    documentationReason: "corrected",
                    evidence: ["quote"],
                    preservation: {
                        poolSize: { state: "retained", quote: "pool 10" },
                        obsoleteTlsClaim: { state: "removed", quote: "gone" },
                        acquireTimeout: { state: "vibes", quote: "" },
                    },
                },
            ),
        };
        const factIds = [
            "poolSize",
            "acquireTimeout",
            "startupMigrations",
            "obsoleteTlsClaim",
        ];

        // Act
        const parsed = load(judged, { inventoryFactIds: factIds });
        const absent = load(files, { inventoryFactIds: factIds });

        // Assert
        assert.equal(parsed.assessment.preservation.state, "available");
        const facts =
            parsed.assessment.preservation.state === "available"
                ? parsed.assessment.preservation.value
                : {};
        assert.equal(facts["poolSize"]?.state, "available");
        assert.equal(
            facts["poolSize"]?.state === "available"
                ? facts["poolSize"]?.value.state
                : "",
            "retained",
        );
        assert.equal(facts["obsoleteTlsClaim"]?.state, "available");
        assert.equal(facts["startupMigrations"]?.state, "missing");
        assert.equal(facts["acquireTimeout"]?.state, "malformed");
        assert.ok(
            facts["acquireTimeout"]?.state === "malformed" &&
                facts["acquireTimeout"].problems.some((p) =>
                    p.includes("quote"),
                ),
        );
        // No judgement at all: the whole preservation record is missing.
        assert.equal(absent.assessment.preservation.state, "missing");
    });

    it("reads a missing document snapshot as missing and an empty one as empty", () => {
        // Act
        const absent = readMarkdownTree(
            evidence({}),
            "gen/a/fixtures/R01/lakes/docs",
        );
        const empty = readMarkdownTree(
            evidence({ "gen/a/fixtures/R01/lakes/docs/keep.txt": "not md" }),
            "gen/a/fixtures/R01/lakes/docs",
        );

        // Assert
        assert.equal(absent.state, "missing");
        assert.equal(empty.state, "available");
        assert.deepEqual(empty.state === "available" ? empty.value : null, []);
    });

    it("reads a document snapshot recursively and sorted", () => {
        // Act
        const tree = readMarkdownTree(
            evidence({
                "lake/z.md": "Z",
                "lake/sub/a.md": "A",
                "lake/m.txt": "ignored",
            }),
            "lake",
        );

        // Assert
        assert.equal(tree.state, "available");
        assert.deepEqual(
            tree.state === "available" ? tree.value.map((doc) => doc.path) : [],
            ["sub/a.md", "z.md"],
        );
    });

    it("marks token accounting malformed when the trail is unparsable", () => {
        // Act
        const record = load({
            ...completeTrial("cc-A-r0-R01"),
            "results/cc-A-r0-R01/stdout.jsonl":
                '{"type":"step_finish","part":{"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0}}}}\noops\n',
        });

        // Assert
        assert.equal(record.tokens.state, "malformed");
        assert.ok(
            record.tokens.state === "malformed" &&
                record.tokens.problems.some((p) => p.includes("oops")),
        );
    });

    it("reports unselected judge attempts instead of silently ignoring them", () => {
        // Act
        const files = completeTrial("cc-A-r0-R01");
        const record = load({
            ...files,
            "results/cc-A-r0-R01/ac/attempt-002/judgement.json":
                judgedJson("misleading"),
        });

        // Assert
        assert.ok(
            record.assessment.problems.some((p) => p.includes("attempt-002")),
        );
    });
});

describe("loadLaunchLedger", () => {
    it("parses recorded launch events", () => {
        // Act
        const ledger = loadLaunchLedger(
            evidence({
                "evidence/ATTEMPTS.jsonl":
                    '{"at":"2026-11-10T18:20:27Z","event":"launch","stamp":"cc-A-r0-R01"}\n' +
                    '{"at":"2026-11-10T18:21:00Z","event":"slot-complete","stamp":"cc-A-r0-R01"}\n',
            }),
            "evidence/ATTEMPTS.jsonl",
        );

        // Assert
        assert.equal(ledger.state, "available");
        assert.equal(
            ledger.state === "available" ? ledger.value.length : -1,
            2,
        );
    });

    it("reports a missing ledger as missing and a corrupt line as malformed", () => {
        // Act
        const missing = loadLaunchLedger(
            evidence({}),
            "evidence/ATTEMPTS.jsonl",
        );
        const malformed = loadLaunchLedger(
            evidence({
                "evidence/ATTEMPTS.jsonl": '{"event":"launch"}\nbroken\n',
            }),
            "evidence/ATTEMPTS.jsonl",
        );

        // Assert
        assert.equal(missing.state, "missing");
        assert.equal(malformed.state, "malformed");
    });
});
