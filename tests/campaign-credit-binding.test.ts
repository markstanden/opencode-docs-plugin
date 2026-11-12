import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
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
 * One judged, passing trial with a plugin add and a writes report.
 * @param root The evidence root.
 * @param arm The arm id.
 * @param addPath The plugin add's reported path.
 * @param writes The writes report.
 */
function trial(
    root: string,
    arm: string,
    addPath: string,
    writes: string,
): void {
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
    write(
        join(dir, "tools.jsonl"),
        `${JSON.stringify({
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
                                add: { mode: "update", path: addPath },
                            },
                        },
                    ],
                },
            },
        })}\n`,
    );
    write(
        join(dir, "docs-operations.jsonl"),
        `${signed({
            input: { add: { mode: "update", path: addPath } },
            result: {
                content: "updated",
                metadata: { lake: "docs", path: addPath },
            },
        })}\n`,
    );
    write(join(dir, "docs-operations.key"), `${KEY}\n`);
    write(
        join(dir, "ac/attempt-001/judgement.json"),
        JSON.stringify({
            status: "judged",
            documentationOutcome: "useful-update",
            documentationReason: "durable correction",
            evidence: ["the cap stays"],
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
    trial(root, "A", "ops/note.md", "modified lakes/docs/ops/note.md\n");
    trial(root, "B", "ops/other.md", "modified lakes/docs/ops/note.md\n");
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
