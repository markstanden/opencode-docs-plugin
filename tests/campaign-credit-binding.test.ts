import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAnalysis } from "./fixtures/placement-harness/analysis/analyse.mts";

const KEY = "credit-binding-key";

/** Write one file, creating its parents. */
function write(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
}

/** Sign one served twin record the way the plugin does. */
function signed(overrides: Record<string, unknown>): string {
    const body = {
        schemaVersion: 1,
        tool: "docs",
        surface: "codemode-twin",
        sessionID: "ses_1",
        messageID: "msg_1",
        callID: "call_1",
        status: "completed",
        ...overrides,
    };
    const mac = createHmac("sha256", KEY)
        .update(JSON.stringify(body), "utf8")
        .digest("hex");
    return JSON.stringify({ ...body, mac });
}

const answer = "Updated the note.\n";
const answerHash = createHash("sha256").update(answer, "utf8").digest("hex");

/**
 * One judged, passing trial with a plugin write and a writes report.
 * @param root The evidence root.
 * @param arm The arm id.
 * @param inputPath The add target the host delivered.
 * @param writes The writes report.
 * @param options Producer-shape overrides for the journal record.
 */
function trial(
    root: string,
    arm: string,
    inputPath: string,
    writes: string,
    options: {
        surface?: "native" | "codemode-twin";
        written?: boolean;
        reportedPath?: string;
        callId?: string;
        hostCallId?: string;
        operation?: "add" | "read";
        retrieval?: "applied" | "not-retrieved";
        outcome?: string;
    } = {},
): void {
    const surface = options.surface ?? "codemode-twin";
    const written = options.written ?? true;
    const operation = options.operation ?? "add";
    const reportedPath = options.reportedPath ?? `lakes/docs/${inputPath}`;
    const callId = options.callId ?? "call_1";
    const hostCallId = options.hostCallId ?? callId;
    const dir = join(
        root,
        "gen",
        arm.toLowerCase(),
        "results",
        `pd-${arm}-r0-X`,
        "X",
    );
    write(
        join(dir, "meta.json"),
        JSON.stringify({
            exit: 0,
            signal: null,
            answerValid: true,
            answerHash,
            policyViolations: [],
        }),
    );
    write(
        join(dir, "gate.json"),
        JSON.stringify({ status: "pass", reason: null }),
    );
    write(
        join(dir, "primary-check.json"),
        JSON.stringify({ status: "pass", exit: 0 }),
    );
    write(join(dir, "final.md"), answer);
    write(join(dir, "writes.txt"), writes);
    write(
        join(dir, "stdout.jsonl"),
        `${JSON.stringify({ sessionID: "ses_1", messageID: "msg_1" })}\n`,
    );
    const input =
        operation === "read"
            ? { read: inputPath }
            : { add: { mode: "update", path: inputPath } };
    const metadata =
        operation === "read"
            ? written
                ? { read: "docs:ops/note.md", lake: "docs", path: reportedPath }
                : { read: null }
            : written
              ? { written: true, lake: "docs", path: reportedPath }
              : { written: false };
    write(
        join(dir, "tools.jsonl"),
        surface === "native"
            ? `${JSON.stringify({
                  id: hostCallId,
                  tool: "docs",
                  status: "completed",
                  input,
              })}\n`
            : `${JSON.stringify({
                  id: hostCallId,
                  tool: "execute",
                  status: "completed",
                  metadata: {
                      metadata: {
                          toolCalls: [
                              {
                                  tool: "docs",
                                  status: "completed",
                                  input,
                              },
                          ],
                      },
                  },
              })}\n`,
    );
    write(
        join(dir, "docs-operations.jsonl"),
        `${signed({
            surface,
            callID: callId,
            input,
            result: {
                content: written ? "done" : "REFUSE",
                metadata,
            },
        })}\n`,
    );
    write(join(dir, "docs-operations.key"), `${KEY}\n`);
    write(
        join(dir, "ac/attempt-001/judgement.json"),
        JSON.stringify({
            status: "judged",
            documentationOutcome: options.outcome ?? "useful-update",
            documentationReason: "durable correction",
            evidence: ["the cap stays"],
            ...(options.retrieval === undefined
                ? {}
                : {
                      retrievalApplication: {
                          state: options.retrieval,
                          quote: options.retrieval === "applied" ? "used it" : "(none)",
                      },
                  }),
        }),
    );
    write(
        join(dir, "ac/attempt-001/meta.json"),
        JSON.stringify({ judgeModel: "judge", status: "finished" }),
    );
}

/**
 * A campaign whose arms differ only in whether the plugin add targets the
 * document the trial changed.
 * @returns The evidence root and output directory.
 */
function campaign(): { root: string; out: string } {
    const root = mkdtempSync(join(tmpdir(), "pd-credit-"));
    write(
        join(root, "evidence/measures.json"),
        JSON.stringify({
            recordingOpportunities: ["X"],
            retrievalOpportunities: [],
            scenarios: {},
        }),
    );
    write(
        join(root, "manifest.json"),
        JSON.stringify({
            schemaVersion: 1,
            campaign: { id: "credit-binding" },
            arms: [{ id: "A" }, { id: "B" }],
            scenarios: [{ id: "X", kind: "update" }],
            schedule: {
                slots: [
                    {
                        slot: 1,
                        stamp: "pd-A-r0-X",
                        scenario: "X",
                        arm: "A",
                        repetition: 0,
                        pairId: "P01",
                    },
                    {
                        slot: 2,
                        stamp: "pd-B-r0-X",
                        scenario: "X",
                        arm: "B",
                        repetition: 0,
                        pairId: "P01",
                    },
                ],
            },
            evidence: {
                layout: "ac-v1",
                resultRoots: { A: "gen/a/results", B: "gen/b/results" },
                inputs: { measures: "evidence/measures.json" },
            },
            assessment: {
                selectionPolicy: "judgement-only",
                attemptId: "attempt-001",
            },
            policy: {
                policyId: "credit-binding",
                weights: {
                    useful: 5,
                    transient: -1,
                    duplicate: -2,
                    misleading: -5,
                    taskFailure: -5,
                },
                guardrails: [
                    {
                        id: "mutation-policy",
                        kind: "mutation-policy",
                        requirement: "no out-of-policy mutation",
                    },
                ],
                selection: {
                    controlArm: "A",
                    candidateArm: "B",
                    threshold: 0,
                    requireCompleteCoverage: true,
                },
            },
        }),
    );
    // A's add targets the changed document; B's add targets another note.
    const writes = "modified: lakes/docs/ops/note.md (content)\n";
    trial(root, "A", "ops/note.md", writes);
    trial(root, "B", "ops/other.md", writes);
    return { root, out: mkdtempSync(join(tmpdir(), "pd-credit-out-")) };
}

describe("credit binding through the analyser CLI", () => {
    it("credits only the arm whose plugin write matches the changed document", () => {
        // Arrange
        const { root, out } = campaign();

        try {
            // Act
            const run = runAnalysis([
                "--campaign",
                join(root, "manifest.json"),
                "--evidence-root",
                root,
                "--out",
                out,
            ]);
            const analysis = JSON.parse(
                readFileSync(join(out, "analysis.json"), "utf8"),
            ) as {
                measures: {
                    arms: Record<string, { recording: { success: number } }>;
                    personalTrial: { recommendation: string };
                };
                screening: {
                    personalTrial: { recommendation: string };
                };
            };
            const report = readFileSync(join(out, "REPORT.md"), "utf8");

            // Assert
            assert.equal(run.status, 0);
            assert.equal(analysis.measures.arms.A?.recording.success, 1);
            assert.equal(analysis.measures.arms.B?.recording.success, 0);
            assert.equal(
                analysis.screening.personalTrial.recommendation,
                analysis.measures.personalTrial.recommendation,
            );
            assert.ok(
                report.includes(
                    `**Personal-trial screen:** ${analysis.measures.personalTrial.recommendation}`,
                ),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("shared evidence verifier through the analyser CLI", () => {
    it("credits nothing when the journal signing key is absent", () => {
        // Arrange
        const { root, out } = campaign();
        unlinkSync(join(root, "gen/a/results/pd-A-r0-X/X/docs-operations.key"));

        try {
            // Act
            const run = runAnalysis([
                "--campaign",
                join(root, "manifest.json"),
                "--evidence-root",
                root,
                "--out",
                out,
            ]);
            const analysis = JSON.parse(
                readFileSync(join(out, "analysis.json"), "utf8"),
            ) as {
                measures: {
                    arms: Record<string, { recording: { success: number } }>;
                    trials: Array<{
                        arm: string;
                        recording: { disposition: string };
                    }>;
                };
            };

            // Assert
            assert.equal(run.status, 0);
            assert.equal(analysis.measures.arms.A?.recording.success, 0);
            assert.equal(
                analysis.measures.trials.find((trial) => trial.arm === "A")
                    ?.recording.disposition,
                "unknown",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

/** Run the analyser and return the parsed analysis and report. */
function analyse(root: string): {
    status: number | null;
    analysis: {
        measures: {
            arms: Record<
                string,
                {
                    recording: { success: number };
                    retrieval: { applied: number; unknown: number };
                }
            >;
            trials: Array<{
                arm: string;
                recording: { disposition: string; success: boolean };
                retrieval: { state: string };
            }>;
        };
    };
} {
    const out = mkdtempSync(join(tmpdir(), "pd-credit-out-"));
    const run = runAnalysis([
        "--campaign",
        join(root, "manifest.json"),
        "--evidence-root",
        root,
        "--out",
        out,
    ]);
    return {
        status: run.status,
        analysis: JSON.parse(readFileSync(join(out, "analysis.json"), "utf8")),
    };
}

describe("real producer shapes and operation outcomes", () => {
    it("credits a native add attributed to its host call", () => {
        // Arrange
        const { root } = campaign();
        try {
            trial(root, "A", "ops/note.md", "modified: lakes/docs/ops/note.md (content)\n", {
                surface: "native",
            });
            trial(root, "B", "ops/other.md", "modified: lakes/docs/ops/note.md (content)\n", {
                surface: "native",
            });

            // Act
            const { status, analysis } = analyse(root);

            // Assert
            assert.equal(status, 0);
            assert.equal(analysis.measures.arms.A?.recording.success, 1);
            assert.equal(analysis.measures.arms.B?.recording.success, 0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not credit a refused add beside a useful filesystem edit", () => {
        // Arrange
        const { root } = campaign();
        try {
            trial(root, "A", "ops/note.md", "modified: lakes/docs/ops/note.md (content)\n", {
                written: false,
            });

            // Act
            const { status, analysis } = analyse(root);

            // Assert
            assert.equal(status, 0);
            const a = analysis.measures.trials.find((entry) => entry.arm === "A");
            assert.equal(a?.recording.success, false);
            assert.equal(a?.recording.disposition, "tool-error");
            assert.equal(analysis.measures.arms.A?.recording.success, 0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not credit a dispatch belonging to another execute", () => {
        // Arrange
        const { root } = campaign();
        try {
            const dir = join(
                root,
                "gen/a/results/pd-A-r0-X/X",
            );
            write(
                join(dir, "tools.jsonl"),
                [
                    {
                        id: "call_1",
                        tool: "execute",
                        status: "completed",
                        metadata: {
                            metadata: {
                                toolCalls: [
                                    {
                                        tool: "docs",
                                        status: "completed",
                                        input: {
                                            add: {
                                                mode: "update",
                                                path: "ops/note.md",
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                    {
                        id: "call_2",
                        tool: "execute",
                        status: "completed",
                        metadata: {
                            metadata: {
                                toolCalls: [
                                    {
                                        tool: "docs",
                                        status: "completed",
                                        input: {
                                            add: {
                                                mode: "update",
                                                path: "ops/other.md",
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    },
                ]
                    .map((entry) => JSON.stringify(entry))
                    .join("\n") + "\n",
            );
            write(
                join(dir, "docs-operations.jsonl"),
                `${signed({
                    callID: "call_2",
                    input: { add: { mode: "update", path: "ops/note.md" } },
                    result: {
                        content: "updated",
                        metadata: {
                            written: true,
                            lake: "docs",
                            path: "lakes/docs/ops/note.md",
                        },
                    },
                })}\n`,
            );

            // Act
            const { status, analysis } = analyse(root);

            // Assert
            assert.equal(status, 0);
            assert.equal(analysis.measures.arms.A?.recording.success, 0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("credits a new file under a new directory, ignoring the directory", () => {
        // Arrange
        const { root } = campaign();
        try {
            trial(
                root,
                "A",
                "ops/new/note.md",
                "added: lakes/docs/ops/new (dir)\nadded: lakes/docs/ops/new/note.md (content)\n",
                { outcome: "useful-create" },
            );
            trial(
                root,
                "B",
                "ops/new/other.md",
                "added: lakes/docs/ops/new (dir)\nadded: lakes/docs/ops/new/note.md (content)\n",
                { outcome: "useful-create" },
            );

            // Act
            const { status, analysis } = analyse(root);

            // Assert
            assert.equal(status, 0);
            assert.equal(analysis.measures.arms.A?.recording.success, 1);
            assert.equal(analysis.measures.arms.B?.recording.success, 0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not credit a write reported in another lake", () => {
        // Arrange
        const { root } = campaign();
        try {
            trial(root, "A", "ops/note.md", "modified: lakes/docs/ops/note.md (content)\n", {
                reportedPath: "lakes/other/ops/note.md",
            });

            // Act
            const { status, analysis } = analyse(root);

            // Assert
            assert.equal(status, 0);
            assert.equal(analysis.measures.arms.A?.recording.success, 0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("credits a native read that applied the declared lake note", () => {
        // Arrange
        const { root } = campaign();
        try {
            write(
                join(root, "evidence/measures.json"),
                JSON.stringify({
                    recordingOpportunities: [],
                    retrievalOpportunities: ["X"],
                    scenarios: {
                        X: {
                            retrieval: {
                                note: "ops/note.md",
                                lake: "docs",
                                detail: "the staging order",
                            },
                        },
                    },
                }),
            );
            trial(root, "A", "ops/note.md", "none\n", {
                operation: "read",
                surface: "native",
                retrieval: "applied",
            });
            trial(root, "B", "ops/note.md", "none\n", {
                operation: "read",
                surface: "native",
                written: false,
                retrieval: "not-retrieved",
            });

            // Act
            const { status, analysis } = analyse(root);

            // Assert
            assert.equal(status, 0);
            assert.equal(analysis.measures.arms.A?.retrieval.applied, 1);
            assert.equal(analysis.measures.arms.B?.retrieval.applied, 0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
