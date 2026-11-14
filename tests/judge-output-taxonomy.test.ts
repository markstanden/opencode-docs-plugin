// Judge-output taxonomy: an observed malformed capture stays invalid, its raw
// bytes are retained, and a complete-but-malformed response is distinguished
// from incomplete capture, schema failure and semantic inconsistency.
//
// The positive counterpart of the observed defect is the same response with a
// structurally valid closing sequence; it is derived in-test from the
// byte-identical fixture and never replaces it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
    judgeFailureClass,
    parseAcJudgement,
    validateAcJudgement,
} from "./fixtures/placement-harness/ac-scoring.mts";

const HERE = import.meta.dirname;
const HARNESS = join(HERE, "fixtures", "placement-harness");
const RUN = join(HARNESS, "ac", "run.mts");
const FIXTURE_DIR = join(HERE, "fixtures", "judge-recovery");
const OBSERVED = join(FIXTURE_DIR, "observed-output.jsonl");
const WITNESS = join(FIXTURE_DIR, "witness.json");
const OBSERVED_SHA =
    "90e06045cc7d5e6cace645dab1a8818dafb98df8a7b6e1e726757bd9f35bf0d4";
const STAMP = "pd-A-r0-S05";
const CASE = "S05";

const sha256 = (body: string | Buffer): string =>
    createHash("sha256").update(body).digest("hex");

/** The judge text part of the observed capture. */
function observedText(): string {
    const line = readFileSync(OBSERVED, "utf8").trim().split("\n")[1]!;
    return (JSON.parse(line) as { part: { text: string } }).part.text;
}

/**
 * The observed response with the structurally valid closing sequence: the
 * transcript's final `"}]` becomes `"]}`. Every other byte is unchanged.
 */
function validCloseText(): string {
    const text = observedText();
    assert.ok(text.endsWith('"}]'), "fixture tail shape changed");
    return `${text.slice(0, -3)}"]}`;
}

/** One JSONL judge trail with an optional terminal step finish. */
function trail(
    text: string,
    options: { reason?: string | null } = {},
): string {
    const events: Array<Record<string, unknown>> = [
        { type: "step_start", part: { type: "step-start" } },
        { type: "text", part: { type: "text", text } },
    ];
    if (options.reason !== null) {
        events.push({
            type: "step_finish",
            part: { type: "step-finish", reason: options.reason ?? "stop" },
        });
    }
    return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

/** A launcher that replays one canned capture and exit code. */
function stubLauncher(root: string): string {
    const path = join(root, "judge-stub.sh");
    writeFileSync(
        path,
        '#!/usr/bin/env bash\ncat "$STUB_OUTPUT_FILE"\nexit "${STUB_EXIT:-0}"\n',
        "utf8",
    );
    chmodSync(path, 0o755);
    return path;
}

/** Seed one recorded trial the judge path can read. */
function seedTrial(root: string, options: { changed?: boolean } = {}): string {
    const dir = join(root, "gen/a/results", STAMP, CASE);
    mkdirSync(dir, { recursive: true });
    const answer = "The assertion was fixed; no note was written.\n";
    writeFileSync(join(dir, "final.md"), answer, "utf8");
    writeFileSync(
        join(dir, "meta.json"),
        JSON.stringify({
            exit: 0,
            signal: null,
            answerValid: true,
            answerHash: sha256(answer),
        }),
        "utf8",
    );
    writeFileSync(join(dir, "prompt.md"), "Fix the failing assertion.\n", "utf8");
    writeFileSync(
        join(dir, "writes.txt"),
        options.changed === true
            ? "modified: work/test/assertion.test.ts (file)\n"
            : "none\n",
        "utf8",
    );
    writeFileSync(
        join(dir, "primary-check.json"),
        JSON.stringify({ status: "pass", exit: 0, stdout: "", stderr: "" }),
        "utf8",
    );
    if (options.changed === true) {
        const lake = join(dir, "live", "lakes", "docs");
        mkdirSync(lake, { recursive: true });
        writeFileSync(
            join(lake, "note.md"),
            "---\nArea: Test\nKeywords:\n  - x\nSummary: y\n---\n\n# Note\n\nA claim.\n",
            "utf8",
        );
    }
    return dir;
}

/** Run the real judge entry point against one canned capture. */
function runJudge(
    root: string,
    body: string,
    exit = 0,
): { result: ReturnType<typeof spawnSync>; attemptDir: string } {
    const capture = join(root, "capture.jsonl");
    writeFileSync(capture, body, "utf8");
    writeFileSync(join(root, "truth.json"), "{}\n", "utf8");
    const attemptDir = join(
        root,
        "gen/a/results",
        STAMP,
        CASE,
        "ac/attempt-001",
    );
    const result = spawnSync(
        process.execPath,
        [
            RUN,
            "judge",
            "--base",
            join(root, "gen/a"),
            "--stamp",
            STAMP,
            "--case",
            CASE,
            "--truth",
            join(root, "truth.json"),
            "--launcher",
            stubLauncher(root),
            "--model",
            "opencode-go/deepseek-v4.1-flash",
            "--workdir",
            join(root, "evidence/ac-runs"),
            "--timeout",
            "30000",
        ],
        {
            encoding: "utf8",
            env: {
                ...process.env,
                STUB_OUTPUT_FILE: capture,
                STUB_EXIT: String(exit),
                OPENCODE_CONFIG_CONTENT: "{}",
            },
        },
    );
    return { result, attemptDir };
}

/** One fresh synthetic campaign root. */
function campaign(options: { changed?: boolean } = {}): string {
    const root = mkdtempSync(join(tmpdir(), "pd-judge-taxonomy-"));
    seedTrial(root, options);
    return root;
}

/** The recorded judgement of one attempt. */
function judgementOf(attemptDir: string): Record<string, unknown> {
    return JSON.parse(
        readFileSync(join(attemptDir, "judgement.json"), "utf8"),
    ) as Record<string, unknown>;
}

describe("observed malformed capture", () => {
    it("is preserved byte-identically and still parses as invalid", () => {
        // Arrange
        const witness = JSON.parse(readFileSync(WITNESS, "utf8")) as {
            originalOutputSha256: string;
        };

        // Act
        const text = observedText();

        // Assert: the fixture is the original byte stream.
        assert.equal(sha256(readFileSync(OBSERVED)), OBSERVED_SHA);
        assert.equal(witness.originalOutputSha256, OBSERVED_SHA);

        // Assert: the defect is the tail, not a mid-string quote.
        assert.ok(text.endsWith('"}]'));
        assert.equal(text.length, 1559);
        assert.throws(() => JSON.parse(text), /after array element/);

        // Assert: the strict parser refuses it and the class is a syntax
        // failure of a complete capture, never an inferred verdict.
        assert.deepEqual(parseAcJudgement(text), {
            problems: ["verdict is not valid JSON"],
        });
        assert.equal(
            judgeFailureClass({ complete: true, problems: ["x"] }),
            "json-syntax",
        );
    });

    it("parses and validates once the closing sequence is structurally valid", () => {
        // Arrange
        const text = validCloseText();
        const state = {
            documentsChanged: false,
            createdPaths: [],
            modifiedPaths: [],
        };

        // Act
        const parsed = parseAcJudgement(text);

        // Assert
        assert.deepEqual(parsed.problems, []);
        assert.equal(parsed.value?.documentationOutcome, "none");
        assert.deepEqual(validateAcJudgement(parsed.value!, state), []);
    });
});

describe("judge attempt taxonomy", () => {
    it("records a complete malformed response as json-syntax and retains its bytes", () => {
        // Arrange
        const root = campaign();
        const capture = readFileSync(OBSERVED, "utf8");

        try {
            // Act
            const { result, attemptDir } = runJudge(root, capture);

            // Assert: no usable judgement, classified precisely.
            assert.equal(result.status, 1, String(result.stderr));
            const judgement = judgementOf(attemptDir);
            assert.equal(judgement.status, "invalid-verdict");
            assert.equal(judgement.failureClass, "json-syntax");
            assert.equal(
                (judgement.completion as { complete: boolean }).complete,
                true,
            );

            // Assert: raw bytes and the extracted final content are kept.
            const raw = readFileSync(join(attemptDir, "output.jsonl"));
            assert.equal(sha256(raw), OBSERVED_SHA);
            assert.equal(
                readFileSync(join(attemptDir, "finalAnswer.txt"), "utf8"),
                observedText(),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("judges the same response with a valid closing sequence", () => {
        // Arrange
        const root = campaign();

        try {
            // Act
            const { result, attemptDir } = runJudge(
                root,
                trail(validCloseText()),
            );

            // Assert
            assert.equal(result.status, 0, String(result.stderr));
            const judgement = judgementOf(attemptDir);
            assert.equal(judgement.status, "judged");
            assert.equal(judgement.failureClass, undefined);
            assert.equal(judgement.documentationOutcome, "none");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("classifies a malformed response without terminal completion as incomplete capture", () => {
        // Arrange: the trail ends on the text part, not a step finish.
        const root = campaign();

        try {
            // Act
            const { result, attemptDir } = runJudge(
                root,
                trail(observedText(), { reason: null }),
            );

            // Assert
            assert.equal(result.status, 1, String(result.stderr));
            const judgement = judgementOf(attemptDir);
            assert.equal(judgement.failureClass, "empty-or-truncated");
            assert.equal(
                (judgement.completion as { complete: boolean }).complete,
                false,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not treat an earlier step finish as completion of the final response", () => {
        // Arrange: a finished step, then trailing text with no terminal finish.
        const root = campaign();
        const body = [
            JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
            JSON.stringify({
                type: "step_finish",
                part: { type: "step-finish", reason: "stop" },
            }),
            JSON.stringify({
                type: "text",
                part: { type: "text", text: observedText() },
            }),
        ].join("\n");

        try {
            // Act
            const { result, attemptDir } = runJudge(root, `${body}\n`);

            // Assert
            assert.equal(result.status, 1, String(result.stderr));
            const judgement = judgementOf(attemptDir);
            assert.equal(judgement.failureClass, "empty-or-truncated");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("classifies valid JSON that fails the schema as a schema failure", () => {
        // Arrange
        const root = campaign();
        const body = JSON.stringify({
            documentationOutcome: "great",
            documentationReason: "A reason.",
            evidence: ["An excerpt."],
        });

        try {
            // Act
            const { result, attemptDir } = runJudge(root, trail(body));

            // Assert
            assert.equal(result.status, 1, String(result.stderr));
            assert.equal(judgementOf(attemptDir).failureClass, "schema");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("classifies a schema-valid judgement that contradicts the mutation facts as semantic", () => {
        // Arrange: the lake changed, so "none" is inconsistent.
        const root = campaign({ changed: true });
        const body = JSON.stringify({
            documentationOutcome: "none",
            documentationReason: "No documentation change.",
            evidence: ["No change."],
        });

        try {
            // Act
            const { result, attemptDir } = runJudge(root, trail(body));

            // Assert
            assert.equal(result.status, 1, String(result.stderr));
            assert.equal(judgementOf(attemptDir).failureClass, "semantic");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("classifies a failed judge process as a transport or process failure", () => {
        // Arrange
        const root = campaign();

        try {
            // Act
            const { result, attemptDir } = runJudge(
                root,
                trail(validCloseText()),
                7,
            );

            // Assert
            assert.equal(result.status, 1, String(result.stderr));
            const judgement = judgementOf(attemptDir);
            assert.equal(judgement.status, "judge-error");
            assert.equal(judgement.failureClass, "transport-or-process");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("classifies an empty successful capture as empty-or-truncated", () => {
        // Arrange
        const root = campaign();

        try {
            // Act
            const { result, attemptDir } = runJudge(root, "");

            // Assert
            assert.equal(result.status, 1, String(result.stderr));
            const judgement = judgementOf(attemptDir);
            assert.equal(judgement.status, "judge-error");
            assert.equal(judgement.failureClass, "empty-or-truncated");
            assert.ok(existsSync(join(attemptDir, "finalAnswer.txt")));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
