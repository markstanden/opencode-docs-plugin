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
        result: {
            content: "note",
            metadata: {
                read: "docs:db/pool.md",
                lake: "docs",
                path: "lakes/docs/db/pool.md",
            },
        },
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
const dispatches = [
    {
        tool: "docs",
        status: "completed",
        input: { read: "db/pool.md" },
        callId: "call_abc",
    },
    {
        tool: "docs",
        status: "completed",
        input: { add: { mode: "create", path: "db/pool.md" } },
        callId: "call_add",
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
                metadata: {
                    written: true,
                    lake: "docs",
                    path: "lakes/docs/db/pool.md",
                },
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
        callIds: new Set(["call_abc", "call_add"]),
        nativeCalls: [],
        dispatches,
        ...overrides,
    });

/** The observed native add shape, with campaign paths and values sanitised. */
const ADD_STRUCT = {
    mode: "replace",
    path: "db/pool.md",
    expectedRevision: "rev-1",
    metadata: { Area: "DB", Keywords: ["pool"], Summary: "cap" },
    body: "# Pool cap\n\n### Facts\n\n- the cap is 10\n",
};

/** One signed native add record for the same run. */
const nativeAddRecord = (input: unknown = { add: ADD_STRUCT }): string =>
    signed({
        surface: "native",
        callID: "native_add",
        input,
        result: {
            content: "replaced",
            metadata: {
                written: true,
                lake: "docs",
                path: "lakes/docs/db/pool.md",
            },
        },
    });

/** The host half of one native add dispatch. */
const nativeAddOptions = (input: unknown) => ({
    callIds: new Set(["native_add"]),
    nativeCalls: [
        {
            tool: "docs",
            status: "completed",
            input,
            callId: "native_add",
        },
    ],
    dispatches: [],
});

const nativeAddVerify = (
    hostInput: unknown,
    signedInput: unknown = { add: ADD_STRUCT },
) => verify([nativeAddRecord(signedInput)], nativeAddOptions(hostInput));

/** Verify one native add record with an explicit signed result. */
const nativeAddResultVerify = (
    hostInput: unknown,
    signedInput: unknown,
    metadata: Record<string, unknown>,
    content = "result",
) =>
    verify(
        [
            signed({
                surface: "native",
                callID: "native_add",
                input: signedInput,
                result: { content, metadata },
            }),
        ],
        nativeAddOptions(hostInput),
    );

/** The result metadata of the one credited record. */
function creditedMetadata(
    result: ReturnType<typeof verifyOperationsJournal>,
): Record<string, unknown> {
    const envelope = result.credited[0]?.record.result;
    assert.ok(
        typeof envelope === "object" &&
            envelope !== null &&
            !Array.isArray(envelope),
    );
    const metadata = (envelope as Record<string, unknown>).metadata;
    assert.ok(
        typeof metadata === "object" &&
            metadata !== null &&
            !Array.isArray(metadata),
    );
    return metadata as Record<string, unknown>;
}

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

    it("rejects a record whose surface is not a served registration", () => {
        // Act
        const result = verify([signed({ surface: "unknown" })]);

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "not-served-twin" },
        ]);
    });

    it("credits a native record against its own host call", () => {
        // Act
        const result = verify(
            [
                signed({
                    surface: "native",
                    callID: "native_1",
                }),
            ],
            {
                callIds: new Set(["native_1"]),
                nativeCalls: [
                    {
                        tool: "docs",
                        status: "completed",
                        input: { read: "db/pool.md" },
                        callId: "native_1",
                    },
                ],
                dispatches: [],
            },
        );

        // Assert
        assert.equal(result.credited.length, 1);
        assert.deepEqual(result.rejected, []);
    });

    it("credits a native write whose host add is a JSON string", () => {
        // Arrange: the observed 2026-11-12 shape — the host trail keeps the
        // pre-decode string, the signed journal holds the decoded struct.
        const result = nativeAddVerify({ add: JSON.stringify(ADD_STRUCT) });

        // Assert
        assert.equal(result.credited.length, 1);
        assert.deepEqual(result.rejected, []);
    });

    it("keeps exact object-form native add matching as the first path", () => {
        // Act
        const result = nativeAddVerify({ add: ADD_STRUCT });

        // Assert
        assert.equal(result.credited.length, 1);
        assert.deepEqual(result.rejected, []);
    });

    it("rejects a malformed native add string", () => {
        // Act
        const result = nativeAddVerify({ add: '{"mode":"replace",' });

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    it("rejects a double-encoded native add string", () => {
        // Act: one decode yields another string, not the signed object.
        const result = nativeAddVerify({
            add: JSON.stringify(JSON.stringify(ADD_STRUCT)),
        });

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    for (const [label, patch] of [
        ["body", { body: "# A different note\n" }],
        ["path", { path: "db/other.md" }],
    ] as const) {
        it(`rejects a string-form add with a changed ${label}`, () => {
            // Act
            const result = nativeAddVerify({
                add: JSON.stringify({ ...ADD_STRUCT, ...patch }),
            });

            // Assert
            assert.deepEqual(result.rejected, [
                { index: 0, reason: "no-host-dispatch" },
            ]);
        });
    }

    it("credits a string-form add beside a matching sibling lake", () => {
        // Arrange: the whole input must match, including the lake selector.
        const result = verify(
            [
                signed({
                    surface: "native",
                    callID: "native_add",
                    input: { lake: "docs", add: ADD_STRUCT },
                }),
            ],
            {
                callIds: new Set(["native_add"]),
                nativeCalls: [
                    {
                        tool: "docs",
                        status: "completed",
                        input: {
                            lake: "docs",
                            add: JSON.stringify(ADD_STRUCT),
                        },
                        callId: "native_add",
                    },
                ],
                dispatches: [],
            },
        );

        // Assert
        assert.equal(result.credited.length, 1);
        assert.deepEqual(result.rejected, []);
    });

    it("rejects a string-form add beside a different sibling lake", () => {
        // Arrange: the decoded add matches, but the lake selector does not.
        const result = verify(
            [
                signed({
                    surface: "native",
                    callID: "native_add",
                    input: { lake: "docs", add: ADD_STRUCT },
                }),
            ],
            {
                callIds: new Set(["native_add"]),
                nativeCalls: [
                    {
                        tool: "docs",
                        status: "completed",
                        input: {
                            lake: "shared",
                            add: JSON.stringify(ADD_STRUCT),
                        },
                        callId: "native_add",
                    },
                ],
                dispatches: [],
            },
        );

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    it("never credits two string-form records for one host dispatch", () => {
        // Act
        const result = verify(
            [nativeAddRecord(), nativeAddRecord()],
            nativeAddOptions({ add: JSON.stringify(ADD_STRUCT) }),
        );

        // Assert
        assert.equal(result.credited.length, 1);
        assert.deepEqual(result.rejected, [
            { index: 1, reason: "no-host-dispatch" },
        ]);
    });

    it("does not admit a string add on the Code Mode twin surface", () => {
        // Arrange: the exception is native-only; nested matching is unchanged.
        const twin = signed({
            callID: "call_add",
            input: { add: ADD_STRUCT },
        });
        const result = verify([twin], {
            dispatches: [
                {
                    tool: "docs",
                    status: "completed",
                    input: { add: JSON.stringify(ADD_STRUCT) },
                    callId: "call_add",
                },
            ],
        });

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    it("does not match a host object against a signed string add", () => {
        // Act: the exception is one-way; the signed bytes stay authoritative.
        const result = nativeAddVerify(
            { add: ADD_STRUCT },
            { add: JSON.stringify(ADD_STRUCT) },
        );

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    it("credits the observed nested-only lake refusal as attribution without a write", () => {
        // Arrange: the runtime discarded the nested lake before execute, so
        // the plugin saw two writable lakes and refused; the call is still
        // attributable, but no write can be credited.
        const hostInput = { add: { ...ADD_STRUCT, lake: "shared" } };
        const signedInput = { add: ADD_STRUCT };

        // Act
        const result = nativeAddResultVerify(hostInput, signedInput, {
            written: false,
        });

        // Assert
        assert.equal(result.credited.length, 1);
        assert.deepEqual(result.rejected, []);
        assert.equal(creditedMetadata(result).written, false);
    });

    it("refuses a successful add whose only lake is nested", () => {
        // Arrange: a write needs the top-level selector to corroborate the
        // signed result; the undelivered nested value cannot do that.
        const hostInput = { add: { ...ADD_STRUCT, lake: "docs" } };
        const signedInput = { add: ADD_STRUCT };
        const metadata = {
            written: true,
            lake: "docs",
            path: "lakes/docs/db/pool.md",
        };

        // Act
        const result = nativeAddResultVerify(hostInput, signedInput, metadata);

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    for (const [label, nestedLake] of [
        ["matching", "docs"],
        ["conflicting", "shared"],
    ] as const) {
        it(`credits a ${label} nested lake against the effective top-level lake`, () => {
            // Arrange: the nested value is undelivered and must never become
            // the credited destination; the top-level selector is what the
            // plugin saw.
            const hostInput = {
                lake: "docs",
                add: { ...ADD_STRUCT, lake: nestedLake },
            };
            const signedInput = { lake: "docs", add: ADD_STRUCT };
            const metadata = {
                written: true,
                lake: "docs",
                path: "lakes/docs/db/pool.md",
            };

            // Act
            const result = nativeAddResultVerify(
                hostInput,
                signedInput,
                metadata,
            );

            // Assert
            assert.equal(result.credited.length, 1);
            assert.deepEqual(result.rejected, []);
            assert.equal(creditedMetadata(result).lake, "docs");
        });
    }

    it("refuses a successful add whose signed result contradicts the effective lake", () => {
        // Arrange: the host top-level selector says docs, but the signed
        // result claims the ignored nested lake wrote shared.
        const hostInput = {
            lake: "docs",
            add: { ...ADD_STRUCT, lake: "shared" },
        };
        const signedInput = { lake: "docs", add: ADD_STRUCT };
        const metadata = {
            written: true,
            lake: "shared",
            path: "lakes/shared/db/pool.md",
        };

        // Act
        const result = nativeAddResultVerify(hostInput, signedInput, metadata);

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    it("credits a string-form add containing a nested lake", () => {
        // Arrange: the existing string decode and the new nested-field rule
        // apply in the same one-way native path.
        const hostInput = {
            lake: "docs",
            add: JSON.stringify({ ...ADD_STRUCT, lake: "shared" }),
        };
        const signedInput = { lake: "docs", add: ADD_STRUCT };
        const metadata = {
            written: true,
            lake: "docs",
            path: "lakes/docs/db/pool.md",
        };

        // Act
        const result = nativeAddResultVerify(hostInput, signedInput, metadata);

        // Assert
        assert.equal(result.credited.length, 1);
        assert.deepEqual(result.rejected, []);
        assert.equal(creditedMetadata(result).lake, "docs");
    });

    it("refuses a string-form add whose nested lake is the only selector", () => {
        // Arrange
        const hostInput = {
            add: JSON.stringify({ ...ADD_STRUCT, lake: "shared" }),
        };
        const signedInput = { add: ADD_STRUCT };
        const metadata = {
            written: true,
            lake: "shared",
            path: "lakes/shared/db/pool.md",
        };

        // Act
        const result = nativeAddResultVerify(hostInput, signedInput, metadata);

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    it("rejects an extra nested field beside the ignored lake", () => {
        // Arrange: the comparator must not become a general unknown-field
        // dropper; only the one undelivered field is ignored.
        const hostInput = {
            lake: "docs",
            add: { ...ADD_STRUCT, lake: "shared", extra: "kept" },
        };
        const signedInput = { lake: "docs", add: ADD_STRUCT };
        const metadata = {
            written: true,
            lake: "docs",
            path: "lakes/docs/db/pool.md",
        };

        // Act
        const result = nativeAddResultVerify(hostInput, signedInput, metadata);

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    it("does not normalise a nested lake already present in the signed record", () => {
        // Arrange: the signed bytes are authoritative; a record carrying the
        // undelivered field is not rewritten to fit the host trail.
        const hostInput = {
            lake: "docs",
            add: { ...ADD_STRUCT, lake: "shared" },
        };
        const signedInput = {
            lake: "docs",
            add: { ...ADD_STRUCT, lake: "docs" },
        };
        const metadata = {
            written: true,
            lake: "docs",
            path: "lakes/docs/db/pool.md",
        };

        // Act
        const result = nativeAddResultVerify(hostInput, signedInput, metadata);

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    it("refuses a non-object host add", () => {
        // Arrange
        const hostInput = { lake: "docs", add: null };
        const signedInput = { lake: "docs", add: ADD_STRUCT };
        const metadata = {
            written: true,
            lake: "docs",
            path: "lakes/docs/db/pool.md",
        };

        // Act
        const result = nativeAddResultVerify(hostInput, signedInput, metadata);

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    it("refuses a non-object host input", () => {
        // Arrange: a malformed host trail is not a comparable dispatch.
        const signedInput = { lake: "docs", add: ADD_STRUCT };
        const metadata = {
            written: true,
            lake: "docs",
            path: "lakes/docs/db/pool.md",
        };

        // Act
        const result = nativeAddResultVerify(null, signedInput, metadata);

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    for (const [label, resultValue] of [
        ["no signed result", undefined],
        ["no result metadata", { content: "result" }],
        ["no write fact", { content: "result", metadata: { lake: "docs" } }],
        ["no result lake", { content: "result", metadata: { written: true } }],
    ] as const) {
        it(`refuses a nested-lake add with ${label}`, () => {
            // Arrange
            const hostInput = {
                lake: "docs",
                add: { ...ADD_STRUCT, lake: "shared" },
            };
            const signedInput = { lake: "docs", add: ADD_STRUCT };
            const line = signed({
                surface: "native",
                callID: "native_add",
                input: signedInput,
                // `undefined` is dropped by JSON.stringify, leaving no result.
                result: resultValue,
            });

            // Act
            const result = verify([line], nativeAddOptions(hostInput));

            // Assert
            assert.deepEqual(result.rejected, [
                { index: 0, reason: "no-host-dispatch" },
            ]);
        });
    }

    it("never credits two nested-lake records for one host dispatch", () => {
        // Arrange
        const line = signed({
            surface: "native",
            callID: "native_add",
            input: { lake: "docs", add: ADD_STRUCT },
            result: {
                content: "replaced",
                metadata: {
                    written: true,
                    lake: "docs",
                    path: "lakes/docs/db/pool.md",
                },
            },
        });

        // Act
        const result = verify(
            [line, line],
            nativeAddOptions({
                lake: "docs",
                add: { ...ADD_STRUCT, lake: "shared" },
            }),
        );

        // Assert
        assert.equal(result.credited.length, 1);
        assert.deepEqual(result.rejected, [
            { index: 1, reason: "no-host-dispatch" },
        ]);
    });

    it("does not admit a nested lake on the Code Mode twin surface", () => {
        // Arrange: the exception remains native-only.
        const twin = signed({
            callID: "call_add",
            input: { add: ADD_STRUCT },
            result: {
                content: "replaced",
                metadata: {
                    written: true,
                    lake: "docs",
                    path: "lakes/docs/db/pool.md",
                },
            },
        });

        // Act
        const result = verify([twin], {
            dispatches: [
                {
                    tool: "docs",
                    status: "completed",
                    input: { add: { ...ADD_STRUCT, lake: "shared" } },
                    callId: "call_add",
                },
            ],
        });

        // Assert
        assert.deepEqual(result.rejected, [
            { index: 0, reason: "no-host-dispatch" },
        ]);
    });

    it("keeps the credited signed record byte-identical", () => {
        // Arrange
        const line = signed({
            surface: "native",
            callID: "native_add",
            input: { lake: "docs", add: ADD_STRUCT },
            result: {
                content: "replaced",
                metadata: {
                    written: true,
                    lake: "docs",
                    path: "lakes/docs/db/pool.md",
                },
            },
        });
        const originalMac = (JSON.parse(line) as Record<string, unknown>).mac;

        // Act
        const result = verify(
            [line],
            nativeAddOptions({
                lake: "docs",
                add: { ...ADD_STRUCT, lake: "shared" },
            }),
        );

        // Assert
        assert.equal(result.credited.length, 1);
        assert.ok(result.credited[0] !== undefined);
        assert.equal(journalMacValid(result.credited[0].record, KEY), true);
        assert.equal(result.credited[0].record.mac, originalMac);
        assert.deepEqual(result.credited[0].record.input, {
            lake: "docs",
            add: ADD_STRUCT,
        });
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

    it("refuses an unhashed answer unless legacy coverage is explicit", () => {
        // Act
        const strict = answerIdentityProblem(answer, undefined);
        const legacy = answerIdentityProblem(answer, undefined, {
            allowUnbound: true,
        });

        // Assert
        assert.match(String(strict), /no recorded answer hash/);
        assert.equal(legacy, null);
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
        [`${TRIAL}/gate.json`]: JSON.stringify({
            status: "pass",
            reason: null,
        }),
        [`${TRIAL}/primary-check.json`]: JSON.stringify({
            status: "pass",
            exit: 0,
        }),
        [`${TRIAL}/final.md`]: answer,
        [`${TRIAL}/writes.txt`]: "added: lakes/docs/db/pool.md (content)\n",
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
                metadata: {
                    metadata: {
                        toolCalls: [
                            {
                                tool: "docs",
                                status: "completed",
                                input: {
                                    add: {
                                        mode: "create",
                                        path: "db/pool.md",
                                    },
                                },
                            },
                        ],
                    },
                },
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
        files[`${TRIAL}/docs-operations.jsonl`] =
            `${journalLines.join("\n")}\n`;
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
