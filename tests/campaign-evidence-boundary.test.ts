import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
    answerIdentityProblem,
    journalMacValid,
    verifyOperationsJournal,
} from "./fixtures/placement-harness/analysis/journal.ts";
import {
    loadTrialRecord,
    type EvidenceReader,
} from "./fixtures/placement-harness/analysis/records.ts";
import { measureTrial } from "./fixtures/placement-harness/analysis/measures.ts";

const KEY = "run-key-0123456789";
const OTHER_KEY = "another-run-key";

/** One served Code Mode twin record as the plugin writes it. */
function record(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        schemaVersion: 1,
        tool: "docs",
        surface: "codemode-twin",
        sessionID: "ses_abc",
        messageID: "msg_abc",
        callID: "call_abc",
        input: { read: "db/pool.md" },
        status: "completed",
        result: { content: "note", metadata: { lake: "docs", path: "db/pool.md" } },
        ...overrides,
    });
}

/** Sign one record body the way the plugin does. */
function signed(overrides: Record<string, unknown> = {}, key = KEY): string {
    const body = JSON.parse(record(overrides)) as Record<string, unknown>;
    const mac = createHmac("sha256", key)
        .update(JSON.stringify(body), "utf8")
        .digest("hex");
    return JSON.stringify({ ...body, mac });
}

const identity = {
    sessions: new Set(["ses_abc"]),
    messages: new Set(["msg_abc"]),
};
const callIds = new Set(["call_abc"]);
const dispatches = [
    {
        tool: "docs",
        status: "completed",
        input: { read: "db/pool.md" },
    },
];

/** One signed add record for the same run. */
const signedAdd = (
    key = KEY,
    overrides: Record<string, unknown> = {},
): string =>
    signed(
        {
            callID: "call_add",
            input: { add: { mode: "create", path: "db/pool.md" } },
            result: {
                content: "added",
                metadata: { lake: "docs", path: "db/pool.md" },
            },
            ...overrides,
        },
        key,
    );

const verify = (
    lines: readonly string[] | undefined,
    overrides: Partial<Parameters<typeof verifyOperationsJournal>[0]> = {},
) =>
    verifyOperationsJournal({
        lines,
        key: KEY,
        identity,
        callIds,
        dispatches,
        ...overrides,
    });

describe("operations-journal verification", () => {
    it("credits a signed, attributed record with a matching host dispatch", () => {
        // Act
        const result = verify([signed()]);

        // Assert
        assert.equal(result.state, "verified");
        assert.equal(result.credited.length, 1);
        assert.deepEqual(result.rejected, []);
    });

    it("signs only when the MAC covers exactly the record body", () => {
        // Arrange
        const body = JSON.parse(signed()) as Record<string, unknown>;

        // Act
        const valid = journalMacValid(body, KEY);
        const wrongKey = journalMacValid(body, OTHER_KEY);

        // Assert
        assert.equal(valid, true);
        assert.equal(wrongKey, false);
    });

    it("rejects an unsigned record", () => {
        // Act
        const result = verify([record()]);

        // Assert
        assert.equal(result.credited.length, 0);
        assert.deepEqual(result.rejected, [{ index: 0, reason: "bad-mac" }]);
    });

    it("rejects a record signed with another run's key", () => {
        // Act
        const result = verify([signed({}, OTHER_KEY)]);

        // Assert
        assert.deepEqual(result.rejected, [{ index: 0, reason: "bad-mac" }]);
    });

    it("rejects a record replayed from another run's identity", () => {
        // Act
        const replay = verify([signed({ sessionID: "ses_other" })]);
        const foreignCall = verify([signed({ callID: "call_other" })]);

        // Assert
        assert.deepEqual(replay.rejected, [
            { index: 0, reason: "unattributed" },
        ]);
        assert.deepEqual(foreignCall.rejected, [
            { index: 0, reason: "unattributed" },
        ]);
    });

    it("never credits two records for one host dispatch", () => {
        // Act
        const result = verify([signed(), signed()]);

        // Assert
        assert.equal(result.credited.length, 1);
        assert.deepEqual(result.rejected, [
            { index: 1, reason: "no-host-dispatch" },
        ]);
    });

    it("keeps a truncated journal line explicit and credits the intact one", () => {
        // Act
        const result = verify([signed(), '{"schemaVersion":1,"tool":"docs"']);

        // Assert
        assert.equal(result.credited.length, 1);
        assert.deepEqual(result.rejected, [{ index: 1, reason: "not-json" }]);
    });

    it("credits nothing when the signing key is missing", () => {
        // Act
        const result = verify([signed()], { key: null });

        // Assert
        assert.equal(result.state, "unverifiable-key");
        assert.equal(result.credited.length, 0);
        assert.match(result.problems[0] ?? "", /without a usable signing key/);
    });

    it("distinguishes an absent journal from an unverifiable one", () => {
        // Act
        const absent = verify(undefined);

        // Assert
        assert.equal(absent.state, "absent");
        assert.deepEqual(absent.credited, []);
    });

    it("rejects a record ignored by the host trail", () => {
        // Act
        const result = verify([signed()], { dispatches: [] });

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    it("rejects a record whose shape is not a served twin call", () => {
        // Act
        const result = verify([signed({ surface: "native" })]);

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "not-served-twin" },
        ]);
    });
});

describe("captured answer identity", () => {
    const answer = "The pool cap stays at 10.\n";
    const hash = createHash("sha256").update(answer, "utf8").digest("hex");

    it("accepts an answer matching the producer's byte hash", () => {
        // Act / Assert
        assert.equal(answerIdentityProblem(answer, hash), null);
    });

    it("refuses an answer altered after capture", () => {
        // Act
        const problem = answerIdentityProblem(
            "The pool cap stays at 10, and TLS is optional.\n",
            hash,
        );

        // Assert
        assert.match(problem ?? "", /does not match meta\.answerHash/);
    });

    it("leaves an unhashed legacy answer unbound without refusing it", () => {
        // Act / Assert
        assert.equal(answerIdentityProblem(answer, undefined), null);
    });
});

/** An in-memory evidence tree: files keyed by relative path. */
const evidence = (files: Record<string, string>): EvidenceReader => ({
    readTextFile: (path) =>
        files[path] === undefined
            ? { state: "missing", source: path }
            : { state: "available", value: files[path]!, source: path },
    readDirectoryEntries: (dir) => {
        if (files[dir] !== undefined) {
            return { state: "not-a-directory", source: dir };
        }
        const prefix = dir.endsWith("/") ? dir : `${dir}/`;
        const children = new Set<string>();
        let exists = false;
        for (const path of Object.keys(files)) {
            if (!path.startsWith(prefix)) continue;
            exists = true;
            children.add(path.slice(prefix.length).split("/")[0]!);
        }
        if (!exists) return { state: "missing", source: dir };
        return {
            state: "available",
            value: [...children].sort(),
            source: dir,
        };
    },
});

const STAMP = "pd-A-r0-R01";
const TRIAL = `gen/a/results/${STAMP}/R01`;
const ANSWER = "Recorded the pool cap.\n";

/** The complete file set of one signed, judged, passing trial. */
const trialFiles = (
    journalLines: string[],
    overrides: { key?: string | null; answer?: string } = {},
): Record<string, string> => {
    const answer = overrides.answer ?? ANSWER;
    const files: Record<string, string> = {
        [`${TRIAL}/meta.json`]: JSON.stringify({
            exit: 0,
            signal: null,
            answerValid: true,
            answerHash: createHash("sha256")
                .update(ANSWER, "utf8")
                .digest("hex"),
            policyViolations: [],
        }),
        [`${TRIAL}/gate.json`]: JSON.stringify({ status: "pass", reason: null }),
        [`${TRIAL}/primary-check.json`]: JSON.stringify({
            status: "pass",
            exit: 0,
        }),
        [`${TRIAL}/final.md`]: answer,
        [`${TRIAL}/writes.txt`]: "added lakes/docs/db/pool.md\n",
        [`${TRIAL}/stdout.jsonl`]: JSON.stringify({
            type: "step_finish",
            sessionID: "ses_abc",
            messageID: "msg_abc",
            part: { tokens: { input: 1, output: 1 } },
        }),
        [`${TRIAL}/tools.jsonl`]: [
            JSON.stringify({
                id: "call_add",
                tool: "execute",
                status: "completed",
                metadata: {},
            }),
            JSON.stringify({
            id: "call_abc",
            tool: "execute",
            status: "completed",
            metadata: {
                metadata: {
                    toolCalls: [
                        {
                            tool: "docs",
                            status: "completed",
                            input: { read: "db/pool.md" },
                        },
                        {
                            tool: "docs",
                            status: "completed",
                            input: {
                                add: { mode: "create", path: "db/pool.md" },
                            },
                        },
                    ],
                },
            },
            }),
        ].join("\n"),
        [`${TRIAL}/ac/attempt-001/judgement.json`]: JSON.stringify({
            status: "judged",
            documentationOutcome: "useful-create",
            documentationReason: "durable finding",
            evidence: ["pool cap"],
            retrievalApplication: {
                state: "applied",
                quote: "the pool cap is 10",
            },
        }),
        [`${TRIAL}/ac/attempt-001/meta.json`]: JSON.stringify({
            judgeModel: "judge",
            status: "finished",
        }),
    };
    if (journalLines.length > 0) {
        files[`${TRIAL}/docs-operations.jsonl`] = `${journalLines.join("\n")}\n`;
    }
    if (overrides.key !== null) {
        files[`${TRIAL}/docs-operations.key`] = `${overrides.key ?? KEY}\n`;
    }
    return files;
};

const declarations = {
    recording: ["R01"],
    retrieval: {
        R01: { note: "db/pool.md", lake: "docs", facts: [] },
    },
};

const measure = (files: Record<string, string>) =>
    measureTrial(
        loadTrialRecord(evidence(files), {
            resultRoot: "gen/a/results",
            stamp: STAMP,
            scenario: "R01",
            inventoryFactIds: [],
            selectionPolicy: "judgement-only",
        }),
        declarations,
        "A",
    );

describe("analyser evidence boundary", () => {
    it("credits a signed read and write that the host recorded", () => {
        // Act
        const result = measure(trialFiles([signed(), signedAdd()]));

        // Assert
        assert.equal(result.recording.disposition, "verified-write");
        assert.equal(result.retrieval.state, "applied");
    });

    it("credits nothing from an unsigned journal", () => {
        // Act
        const result = measure(
            trialFiles([signed(), signedAdd()], { key: null }),
        );

        // Assert
        assert.equal(result.recording.disposition, "unknown");
        assert.equal(result.retrieval.state, "unknown");
    });

    it("rejects a record replayed from another run", () => {
        // Arrange
        const replay = signed({ sessionID: "ses_other" });
        const replayAdd = signedAdd(KEY, { sessionID: "ses_other" });

        // Act
        const result = measure(trialFiles([replay, replayAdd]));

        // Assert
        assert.equal(result.recording.disposition, "unknown");
        assert.equal(result.retrieval.state, "unknown");
    });

    it("keeps a tampered answer from becoming usable evidence", () => {
        // Arrange
        const files = trialFiles([signed()], {
            answer: "A different answer.\n",
        });

        // Act
        const record = loadTrialRecord(evidence(files), {
            resultRoot: "gen/a/results",
            stamp: STAMP,
            scenario: "R01",
            inventoryFactIds: [],
            selectionPolicy: "judgement-only",
        });

        // Assert
        assert.equal(record.attempt.usable, false);
        assert.match(record.answerProblem ?? "", /answerHash/);
    });
});
