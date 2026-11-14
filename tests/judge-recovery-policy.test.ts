// Recovery policy: registration, eligibility, the dual spend claim and the
// checked selection record. With no registration the campaign keeps its
// historical stop; a registered policy is narrow and cannot be widened.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
    claimBudget,
    readClaims,
} from "./fixtures/placement-harness/analysis/budget.ts";
import {
    claimRecoveryBudget,
    parseRecoveryPolicy,
    recoveryDecision,
    recoveryPolicySha256,
    selectionProblems,
    selectionRecordOf,
    type RecoveryFacts,
    type RecoveryPolicy,
    type SelectionAttempt,
    type SelectionRecord,
} from "./fixtures/placement-harness/analysis/recovery.ts";

const RECOVERY_MODULE = join(
    import.meta.dirname,
    "fixtures/placement-harness/analysis/recovery.ts",
);

/** The prospective 8-pair policy: 16 initial + 2 recoveries of 18 attempts. */
const DECLARED = {
    version: 1,
    eligibleFailureClasses: ["json-syntax"],
    requiresCompletionEvidence: true,
    maxRecoveriesPerSlot: 1,
    recoveryCeiling: 2,
    totalJudgeAttempts: 18,
    providerRequestLimit: null,
};

/** The accepted policy, or a failed test. */
function policy(): RecoveryPolicy {
    const parsed = parseRecoveryPolicy(DECLARED);
    assert.equal(parsed.ok, true);
    return (parsed as { ok: true; policy: RecoveryPolicy }).policy;
}

/** One complete json-syntax failure's facts, with overrides. */
function facts(patch: Partial<RecoveryFacts> = {}): RecoveryFacts {
    return {
        attemptStatus: "invalid-verdict",
        failureClass: "json-syntax",
        completionComplete: true,
        attemptIds: ["attempt-001"],
        judgedAttemptIds: [],
        recoveryClaimsUsed: 0,
        judgeClaimsUsed: 9,
        ledgerState: "open",
        freezeProblems: [],
        unresolvedReservations: [],
        ...patch,
    };
}

/** One attempt fact for a selection record. */
function attempt(
    attemptId: string,
    judgementStatus: string,
    patch: Partial<SelectionAttempt> = {},
): SelectionAttempt {
    return {
        attemptId,
        judgementStatus,
        packetSha256: "packet-1",
        failureClass: null,
        complete: null,
        ...patch,
    };
}

/** A fresh temporary evidence root. */
function temp(): string {
    return mkdtempSync(join(tmpdir(), "pd-recovery-"));
}

describe("recovery policy registration", () => {
    it("accepts the narrow prospective policy", () => {
        // Act
        const parsed = parseRecoveryPolicy(DECLARED);

        // Assert
        assert.equal(parsed.ok, true);
        assert.deepEqual(
            (parsed as { ok: true; policy: RecoveryPolicy }).policy,
            DECLARED,
        );
    });

    it("refuses a policy that widens eligibility or waives completion", () => {
        // Arrange
        const widened = {
            ...DECLARED,
            eligibleFailureClasses: ["json-syntax", "schema"],
        };
        const waived = { ...DECLARED, requiresCompletionEvidence: false };
        const retried = { ...DECLARED, maxRecoveriesPerSlot: 2 };

        // Act
        const parsedWidened = parseRecoveryPolicy(widened);
        const parsedWaived = parseRecoveryPolicy(waived);
        const parsedRetried = parseRecoveryPolicy(retried);

        // Assert
        assert.equal(parsedWidened.ok, false);
        assert.match(
            (parsedWidened as { problems: string[] }).problems.join(" "),
            /may contain only/,
        );
        assert.equal(parsedWaived.ok, false);
        assert.match(
            (parsedWaived as { problems: string[] }).problems.join(" "),
            /cannot waive/,
        );
        assert.equal(parsedRetried.ok, false);
    });

    it("requires an explicit provider-request capability", () => {
        // Arrange
        const missing: Record<string, unknown> = { ...DECLARED };
        delete missing.providerRequestLimit;

        // Act
        const parsed = parseRecoveryPolicy(missing);

        // Assert
        assert.equal(parsed.ok, false);
        assert.match(
            (parsed as { problems: string[] }).problems.join(" "),
            /providerRequestLimit must be declared/,
        );
    });

    it("refuses malformed ceilings and versions", () => {
        // Act
        const cases = [
            { ...DECLARED, version: 2 },
            { ...DECLARED, recoveryCeiling: 0 },
            { ...DECLARED, recoveryCeiling: "many" },
            { ...DECLARED, totalJudgeAttempts: 1 },
            { ...DECLARED, totalJudgeAttempts: 0 },
            { ...DECLARED, providerRequestLimit: 0 },
            { ...DECLARED, providerRequestLimit: "unbounded" },
            { ...DECLARED, eligibleFailureClasses: [] },
            null,
            "policy",
        ].map((value) => parseRecoveryPolicy(value));

        // Assert
        for (const parsed of cases) assert.equal(parsed.ok, false);
        assert.deepEqual(parseRecoveryPolicy(null), {
            ok: false,
            problems: ["recovery policy must be an object"],
        });
    });

    it("hashes the normalised policy canonically", () => {
        // Act
        const first = recoveryPolicySha256(policy());
        const second = recoveryPolicySha256(policy());

        // Assert
        assert.equal(first, second);
        assert.match(first, /^[0-9a-f]{64}$/);
    });
});

describe("recovery eligibility", () => {
    it("permits one recovery for a complete json-syntax failure", () => {
        // Act
        const decision = recoveryDecision(policy(), facts());

        // Assert
        assert.deepEqual(decision, {
            eligible: true,
            attemptId: "attempt-002",
        });
    });

    it("refuses every other failure class", () => {
        // Act
        const decisions = [
            "schema",
            "semantic",
            "empty-or-truncated",
            "transport-or-process",
            null,
        ].map((failureClass) =>
            recoveryDecision(policy(), facts({ failureClass })),
        );

        // Assert
        for (const decision of decisions) {
            assert.equal(decision.eligible, false);
            assert.match(
                (decision as { reason: string }).reason,
                /not eligible/,
            );
        }
    });

    it("refuses when completion of the final response is not established", () => {
        // Act
        const decision = recoveryDecision(
            policy(),
            facts({ completionComplete: false }),
        );

        // Assert
        assert.equal(decision.eligible, false);
        assert.match((decision as { reason: string }).reason, /completion/);
    });

    it("requires affirmative completion evidence, never an unknown value", () => {
        // Arrange: a syntax failure whose completion could not be established
        // (the field is absent, so it reads as null, not as a pass).
        const unknown = recoveryDecision(
            policy(),
            facts({ completionComplete: null }),
        );
        const absent = recoveryDecision(
            policy(),
            facts({ completionComplete: null, failureClass: "json-syntax" }),
        );

        // Act / Assert: null is not affirmative, so no dispatch is permitted.
        for (const decision of [unknown, absent]) {
            assert.equal(decision.eligible, false);
            assert.match(
                (decision as { reason: string }).reason,
                /completion of the final assessed response cannot be established/,
            );
        }
    });

    it("never replaces a usable first assessment", () => {
        // Act
        const judged = recoveryDecision(
            policy(),
            facts({ attemptStatus: "judged" }),
        );
        const otherUsable = recoveryDecision(
            policy(),
            facts({ judgedAttemptIds: ["attempt-001"] }),
        );

        // Assert
        assert.equal(judged.eligible, false);
        assert.equal(otherUsable.eligible, false);
    });

    it("stops after a second unusable assessment", () => {
        // Act
        const decision = recoveryDecision(
            policy(),
            facts({
                attemptIds: ["attempt-001", "attempt-002"],
                judgedAttemptIds: [],
            }),
        );

        // Assert
        assert.equal(decision.eligible, false);
        assert.match(
            (decision as { reason: string }).reason,
            /recovery attempt already exists/,
        );
    });

    it("refuses closed, malformed or missing ledgers", () => {
        // Act
        const decisions = (["closed", "malformed", "missing"] as const).map(
            (ledgerState) => recoveryDecision(policy(), facts({ ledgerState })),
        );

        // Assert
        for (const decision of decisions) {
            assert.equal(decision.eligible, false);
            assert.match((decision as { reason: string }).reason, /ledger/);
        }
    });

    it("refuses a changed freeze and unresolved reservations", () => {
        // Act
        const frozen = recoveryDecision(
            policy(),
            facts({ freezeProblems: ["judge apparatus changed"] }),
        );
        const reserved = recoveryDecision(
            policy(),
            facts({ unresolvedReservations: ["pd-X (unresolved)"] }),
        );

        // Assert
        assert.equal(frozen.eligible, false);
        assert.match((frozen as { reason: string }).reason, /premise/);
        assert.equal(reserved.eligible, false);
        assert.match((reserved as { reason: string }).reason, /reservation/);
    });

    it("refuses when either campaign-wide ceiling is exhausted", () => {
        // Act
        const recovery = recoveryDecision(
            policy(),
            facts({ recoveryClaimsUsed: 2 }),
        );
        const total = recoveryDecision(
            policy(),
            facts({ judgeClaimsUsed: 18 }),
        );

        // Assert
        assert.equal(recovery.eligible, false);
        assert.match(
            (recovery as { reason: string }).reason,
            /recovery ceiling/,
        );
        assert.equal(total.eligible, false);
        assert.match(
            (total as { reason: string }).reason,
            /judge-attempt ceiling/,
        );
    });

    it("refuses a policy that makes no failure class eligible", () => {
        // Arrange: a hand-built policy bypassing registration (defence in depth).
        const handBuilt = {
            ...policy(),
            eligibleFailureClasses: [],
        } as unknown as RecoveryPolicy;

        // Act
        const decision = recoveryDecision(handBuilt, facts());

        // Assert
        assert.equal(decision.eligible, false);
        assert.match(
            (decision as { reason: string }).reason,
            /no failure class eligible/,
        );
    });

    it("refuses a non-contiguous attempt sequence and an empty slot", () => {
        // Act
        const gap = recoveryDecision(
            policy(),
            facts({ attemptIds: ["attempt-001", "attempt-003"] }),
        );
        const empty = recoveryDecision(policy(), facts({ attemptIds: [] }));

        // Assert
        assert.equal(gap.eligible, false);
        assert.match((gap as { reason: string }).reason, /contiguous/);
        assert.equal(empty.eligible, false);
    });
});

describe("selection record as checked evidence", () => {
    const identity = {
        slot: 9,
        pairId: "P05",
        stamp: "pd-A-r0-S05",
        arm: "A",
        scenario: "S05",
    };

    it("accepts a first-assessment record", () => {
        // Arrange
        const record = selectionRecordOf({
            ...identity,
            selectedAttemptId: "attempt-001",
            policySha256: null,
            attempts: [attempt("attempt-001", "judged")],
        });

        // Act
        const problems = selectionProblems(record, {
            ...identity,
            attemptIds: ["attempt-001"],
            manifestAttemptId: "attempt-001",
            policy: null,
        });

        // Assert
        assert.deepEqual(problems, []);
    });

    it("accepts a recovery record whose first attempt was ineligible only by syntax", () => {
        // Arrange
        const record = selectionRecordOf({
            ...identity,
            selectedAttemptId: "attempt-002",
            policySha256: recoveryPolicySha256(policy()),
            attempts: [
                attempt("attempt-001", "invalid-verdict", {
                    failureClass: "json-syntax",
                    complete: true,
                }),
                attempt("attempt-002", "judged"),
            ],
        });

        // Act
        const problems = selectionProblems(record, {
            ...identity,
            attemptIds: ["attempt-001", "attempt-002"],
            manifestAttemptId: "attempt-001",
            policy: policy(),
        });

        // Assert
        assert.deepEqual(problems, []);
    });

    it("refuses tampering, ineligible selection and replacement", () => {
        // Arrange
        const valid = selectionRecordOf({
            ...identity,
            selectedAttemptId: "attempt-002",
            policySha256: recoveryPolicySha256(policy()),
            attempts: [
                attempt("attempt-001", "invalid-verdict", {
                    failureClass: "json-syntax",
                    complete: true,
                }),
                attempt("attempt-002", "judged"),
            ],
        });
        const actual = {
            ...identity,
            attemptIds: ["attempt-001", "attempt-002"],
            manifestAttemptId: "attempt-001",
            policy: policy(),
        };

        // Act: each mutation breaks exactly one checked fact.
        const cases: Array<[string, SelectionRecord, RegExp]> = [
            [
                "identity",
                { ...valid, stamp: "pd-B-r0-S05" },
                /does not match the slot/,
            ],
            [
                "attempt set",
                { ...valid, attempts: [valid.attempts[1]!] },
                /do not match the evidence/,
            ],
            [
                "unusable selection",
                {
                    ...valid,
                    attempts: [
                        valid.attempts[0]!,
                        {
                            ...valid.attempts[1]!,
                            judgementStatus: "invalid-verdict",
                        },
                    ],
                },
                /unusable attempt/,
            ],
            [
                "replacement",
                {
                    ...valid,
                    selectedAttemptId: "attempt-001",
                    attempts: [
                        { ...valid.attempts[0]!, judgementStatus: "judged" },
                        valid.attempts[1]!,
                    ],
                },
                /replaces the usable first assessment|ignores a later usable/,
            ],
            [
                "ineligible class",
                {
                    ...valid,
                    attempts: [
                        {
                            ...valid.attempts[0]!,
                            failureClass: "schema",
                        },
                        valid.attempts[1]!,
                    ],
                },
                /ineligible failure class/,
            ],
            [
                "incomplete capture",
                {
                    ...valid,
                    attempts: [
                        { ...valid.attempts[0]!, complete: false },
                        valid.attempts[1]!,
                    ],
                },
                /incomplete capture/,
            ],
            [
                "packet mismatch",
                {
                    ...valid,
                    attempts: [
                        valid.attempts[0]!,
                        { ...valid.attempts[1]!, packetSha256: "packet-2" },
                    ],
                },
                /different packets/,
            ],
            [
                "policy hash",
                { ...valid, policySha256: "0".repeat(64) },
                /policySha256/,
            ],
        ];
        // Assert
        for (const [label, record, pattern] of cases) {
            const problems = selectionProblems(record, actual);
            assert.ok(
                problems.some((problem) => pattern.test(problem)),
                `${label}: ${JSON.stringify(problems)}`,
            );
        }
    });

    it("refuses malformed selection shapes field by field", () => {
        // Arrange
        const actual = {
            ...identity,
            attemptIds: ["attempt-001"],
            manifestAttemptId: "attempt-001",
            policy: null,
        };
        const valid = selectionRecordOf({
            ...identity,
            selectedAttemptId: "attempt-001",
            policySha256: null,
            attempts: [attempt("attempt-001", "judged")],
        });
        const cases: Array<[string, unknown, RegExp]> = [
            ["not an object", null, /must be an object/],
            ["scheme", { ...valid, schemeVersion: 2 }, /schemeVersion/],
            ["slot", { ...valid, slot: 99 }, /slot does not match/],
            [
                "selected id",
                { ...valid, selectedAttemptId: "nope" },
                /selectedAttemptId/,
            ],
            [
                "attempts array",
                { ...valid, attempts: "nope" },
                /attempts must be an array/,
            ],
            [
                "malformed entry",
                { ...valid, attempts: [null] },
                /entry is malformed/,
            ],
            [
                "bad id",
                { ...valid, attempts: [{ attemptId: "attempt-1" }] },
                /entry is malformed/,
            ],
            [
                "duplicate",
                { ...valid, attempts: [valid.attempts[0], valid.attempts[0]] },
                /repeats attempt/,
            ],
            [
                "no status",
                {
                    ...valid,
                    attempts: [
                        { attemptId: "attempt-001", packetSha256: null },
                    ],
                },
                /no judgement status/,
            ],
            [
                "packet",
                {
                    ...valid,
                    attempts: [
                        {
                            attemptId: "attempt-001",
                            judgementStatus: "judged",
                            packetSha256: 7,
                        },
                    ],
                },
                /packetSha256 is malformed/,
            ],
            [
                "class",
                {
                    ...valid,
                    attempts: [
                        {
                            attemptId: "attempt-001",
                            judgementStatus: "judged",
                            packetSha256: null,
                            failureClass: 7,
                            complete: null,
                        },
                    ],
                },
                /failureClass is malformed/,
            ],
            [
                "complete",
                {
                    ...valid,
                    attempts: [
                        {
                            attemptId: "attempt-001",
                            judgementStatus: "judged",
                            packetSha256: null,
                            failureClass: null,
                            complete: "yes",
                        },
                    ],
                },
                /complete is malformed/,
            ],
            [
                "absent selection",
                { ...valid, selectedAttemptId: "attempt-002" },
                /names an absent attempt/,
            ],
        ];

        // Act / Assert
        for (const [label, value, pattern] of cases) {
            const problems = selectionProblems(value, actual);
            assert.ok(
                problems.some((problem) => pattern.test(problem)),
                `${label}: ${JSON.stringify(problems)}`,
            );
        }
    });

    it("refuses recalculated facts and a replaced usable first assessment", () => {
        // Arrange: the record claims facts the evidence does not carry.
        const valid = selectionRecordOf({
            ...identity,
            selectedAttemptId: "attempt-001",
            policySha256: null,
            attempts: [attempt("attempt-001", "judged")],
        });
        const actual = {
            ...identity,
            attemptIds: ["attempt-001"],
            manifestAttemptId: "attempt-001",
            policy: null,
        };
        const mismatch = selectionProblems(valid, {
            ...actual,
            attemptFacts: {
                "attempt-001": attempt("attempt-001", "judged", {
                    packetSha256: "different",
                }),
            },
        });
        const replacement = selectionProblems(
            selectionRecordOf({
                ...identity,
                selectedAttemptId: "attempt-002",
                policySha256: recoveryPolicySha256(policy()),
                attempts: [
                    attempt("attempt-001", "judged"),
                    attempt("attempt-002", "judged"),
                ],
            }),
            {
                ...identity,
                attemptIds: ["attempt-001", "attempt-002"],
                manifestAttemptId: "attempt-001",
                policy: policy(),
            },
        );

        // Assert
        assert.ok(
            mismatch.some((problem) =>
                /does not match the recorded evidence/.test(problem),
            ),
        );
        assert.ok(
            replacement.some((problem) =>
                /replaces the usable first assessment/.test(problem),
            ),
        );
    });

    it("refuses a recovery selection with no registered policy", () => {
        // Arrange
        const record = selectionRecordOf({
            ...identity,
            selectedAttemptId: "attempt-002",
            policySha256: recoveryPolicySha256(policy()),
            attempts: [
                attempt("attempt-001", "invalid-verdict", {
                    failureClass: "json-syntax",
                    complete: true,
                }),
                attempt("attempt-002", "judged"),
            ],
        });

        // Act
        const problems = selectionProblems(record, {
            ...identity,
            attemptIds: ["attempt-001", "attempt-002"],
            manifestAttemptId: "attempt-001",
            policy: null,
        });

        // Assert
        assert.ok(
            problems.includes(
                "selection differs from the frozen manifest selector with no registered policy",
            ),
        );
    });

    it("refuses a selection that skips or overruns the authorised recovery", () => {
        // Arrange: attempt-003 selected after attempt-001.
        const skip = selectionRecordOf({
            ...identity,
            selectedAttemptId: "attempt-003",
            policySha256: recoveryPolicySha256(policy()),
            attempts: [
                attempt("attempt-001", "invalid-verdict", {
                    failureClass: "json-syntax",
                    complete: true,
                }),
                attempt("attempt-002", "invalid-verdict", {
                    failureClass: "json-syntax",
                    complete: true,
                }),
                attempt("attempt-003", "judged"),
            ],
        });

        // Act
        const problems = selectionProblems(skip, {
            ...identity,
            attemptIds: ["attempt-001", "attempt-002", "attempt-003"],
            manifestAttemptId: "attempt-001",
            policy: policy(),
        });

        // Assert
        assert.ok(
            problems.some((problem) => /at most 1 permitted/.test(problem)),
        );
        assert.ok(
            problems.some((problem) => /not the next attempt/.test(problem)),
        );
    });
});

describe("dual recovery budget", () => {
    it("claims both the recovery and the judge ceiling", () => {
        // Arrange
        const root = temp();

        try {
            // Act
            const claim = claimRecoveryBudget(root, policy(), {
                stamp: "pd-A-r0-S05",
                attemptId: "attempt-002",
                key: "pd-A-r0-S05|attempt-002",
            });

            // Assert
            assert.equal(claim.ok, true);
            assert.equal(readClaims(root, "recovery").length, 1);
            assert.equal(readClaims(root, "judge").length, 1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("releases the recovery reservation when the judge ceiling refuses", () => {
        // Arrange: the total judge ceiling is already spent.
        const root = temp();
        for (let index = 0; index < 18; index += 1) {
            claimBudget(root, "judge", 18);
        }

        try {
            // Act
            const claim = claimRecoveryBudget(root, policy(), {
                stamp: "pd-A-r0-S05",
                attemptId: "attempt-002",
                key: "pd-A-r0-S05|attempt-002",
            });

            // Assert: nothing dispatched, so the recovery slot is returned.
            assert.equal(claim.ok, false);
            assert.match((claim as { reason: string }).reason, /judge budget/);
            assert.equal(readClaims(root, "recovery").length, 0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a repeated claim for the same logical attempt", () => {
        // Arrange
        const root = temp();
        const identity = {
            stamp: "pd-A-r0-S05",
            attemptId: "attempt-002",
            key: "pd-A-r0-S05|attempt-002",
        };

        try {
            // Act
            const first = claimRecoveryBudget(root, policy(), identity);
            const second = claimRecoveryBudget(root, policy(), identity);

            // Assert
            assert.equal(first.ok, true);
            assert.equal(second.ok, false);
            assert.equal(readClaims(root, "recovery").length, 1);
            assert.equal(readClaims(root, "judge").length, 1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("cannot exceed either ceiling under concurrent recoveries", async () => {
        // Arrange: four concurrent distinct slots, ceilings 2 recovery / 18.
        const root = temp();
        const barrier = join(root, "barrier");
        const worker = `import { existsSync, writeFileSync } from "node:fs";
import { claimRecoveryBudget } from ${JSON.stringify(RECOVERY_MODULE)};
const policy = ${JSON.stringify(DECLARED)};
while (!existsSync(process.env.BARRIER)) {
    // Deterministic barrier: every worker spins before its claim.
}
const slot = process.env.SLOT;
const result = claimRecoveryBudget(process.env.ROOT, policy, {
    stamp: slot,
    attemptId: "attempt-002",
    key: slot + "|attempt-002",
});
writeFileSync(process.env.RESULT, JSON.stringify({ ok: result.ok }));`;
        const spawnWorker = (slot: string) =>
            new Promise<{ ok: boolean }>((resolve, reject) => {
                const child = spawn(
                    process.execPath,
                    ["--input-type=module", "-e", worker],
                    {
                        env: {
                            ...process.env,
                            ROOT: root,
                            BARRIER: barrier,
                            SLOT: slot,
                            RESULT: join(root, `${slot}.json`),
                        },
                        stdio: "ignore",
                    },
                );
                child.on("error", reject);
                child.on("exit", () =>
                    resolve(
                        JSON.parse(
                            readFileSync(join(root, `${slot}.json`), "utf8"),
                        ) as { ok: boolean },
                    ),
                );
            });

        try {
            const slots = ["P01", "P02", "P03", "P04"];
            const pending = slots.map(spawnWorker);
            await new Promise((resolve) => setTimeout(resolve, 250));
            writeFileSync(barrier, "go\n", "utf8");
            const results = await Promise.all(pending);

            // Assert: exactly the recovery ceiling, and never past the total.
            assert.equal(results.filter((result) => result.ok).length, 2);
            assert.equal(readClaims(root, "recovery").length, 2);
            assert.equal(readClaims(root, "judge").length, 2);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("lets exactly one concurrent recovery take the last total attempt", async () => {
        // Arrange: 17 of 18 judge attempts spent; two slots race.
        const root = temp();
        for (let index = 0; index < 17; index += 1) {
            claimBudget(root, "judge", 18);
        }
        const barrier = join(root, "barrier");
        const worker = `import { existsSync, writeFileSync } from "node:fs";
import { claimRecoveryBudget } from ${JSON.stringify(RECOVERY_MODULE)};
const policy = ${JSON.stringify(DECLARED)};
while (!existsSync(process.env.BARRIER)) {}
const slot = process.env.SLOT;
const result = claimRecoveryBudget(process.env.ROOT, policy, {
    stamp: slot,
    attemptId: "attempt-002",
    key: slot + "|attempt-002",
});
writeFileSync(process.env.RESULT, JSON.stringify({ ok: result.ok }));`;
        const spawnWorker = (slot: string) =>
            new Promise<{ ok: boolean }>((resolve, reject) => {
                const child = spawn(
                    process.execPath,
                    ["--input-type=module", "-e", worker],
                    {
                        env: {
                            ...process.env,
                            ROOT: root,
                            BARRIER: barrier,
                            SLOT: slot,
                            RESULT: join(root, `${slot}.json`),
                        },
                        stdio: "ignore",
                    },
                );
                child.on("error", reject);
                child.on("exit", () =>
                    resolve(
                        JSON.parse(
                            readFileSync(join(root, `${slot}.json`), "utf8"),
                        ) as { ok: boolean },
                    ),
                );
            });

        try {
            const pending = [spawnWorker("P01"), spawnWorker("P02")];
            await new Promise((resolve) => setTimeout(resolve, 250));
            writeFileSync(barrier, "go\n", "utf8");
            const results = await Promise.all(pending);

            // Assert: one winner, and the loser's reservation was returned.
            assert.equal(results.filter((result) => result.ok).length, 1);
            assert.equal(readClaims(root, "judge").length, 18);
            assert.equal(readClaims(root, "recovery").length, 1);
            assert.ok(existsSync(join(root, "barrier")));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
