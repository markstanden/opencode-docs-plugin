import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    eventsByStamp,
    isOpenLedger,
    parseCampaignLedger,
} from "./fixtures/placement-harness/analysis/ledger.ts";
import {
    advanceClaim,
    claimBudget,
    claimUsage,
    readClaims,
    releaseClaim,
    restartDisposition,
} from "./fixtures/placement-harness/analysis/budget.ts";
import {
    DEFAULT_ATTEMPT_ID,
    resolveAttemptSelection,
    resolveRecoverySelection,
} from "./fixtures/placement-harness/analysis/selector.ts";

const budgetModule = pathToFileURL(
    join(
        import.meta.dirname,
        "fixtures",
        "placement-harness",
        "analysis",
        "budget.ts",
    ),
).href;

const temp = (label: string): string =>
    mkdtempSync(join(tmpdir(), `pd-launch-${label}-`));

describe("campaign attempt ledger", () => {
    it("reads a compact single-line close event", () => {
        // Arrange
        const text = `${JSON.stringify({ at: "2026-11-11T00:00:00Z", event: "campaign-start", campaign: "c" })}\n${JSON.stringify({ at: "2026-11-11T01:00:00Z", event: "campaign-closed" })}\n`;

        // Act
        const ledger = parseCampaignLedger(text);

        // Assert
        assert.equal(ledger.state, "closed");
        assert.equal(ledger.closedAt, "2026-11-11T01:00:00Z");
        assert.equal(isOpenLedger(ledger), false);
    });

    it("reads a spaced single-line close event", () => {
        // Arrange
        const text = `{ "event" : "campaign-closed" , "at" : "2026-11-11T01:00:00Z" }\n`;

        // Act
        const ledger = parseCampaignLedger(text);

        // Assert
        assert.equal(ledger.state, "closed");
    });

    it("treats a truncated final line as malformed, never as closed", () => {
        // Arrange
        const text = `{"event":"campaign-closed","at":"2026-11-11T01:00:00Z"}\n{"event":"launch","stamp":"pd-A-r0-R01"`;

        // Act
        const ledger = parseCampaignLedger(text);

        // Assert
        assert.equal(ledger.state, "malformed");
        assert.equal(ledger.closedAt, null);
        assert.deepEqual(ledger.problems, ["ledger line 2 is not JSON"]);
    });

    it("treats a line without an event name as malformed", () => {
        // Act
        const ledger = parseCampaignLedger(`{"stamp":"pd-A-r0-R01"}\n`);

        // Assert
        assert.equal(ledger.state, "malformed");
        assert.match(ledger.problems[0] ?? "", /has no event name/);
    });

    it("keeps every structurally valid event in a malformed ledger", () => {
        // Arrange
        const text = `{"event":"launch","stamp":"pd-A-r0-R01","slot":1}\nnot json\n`;

        // Act
        const ledger = parseCampaignLedger(text);

        // Assert
        assert.equal(ledger.state, "malformed");
        assert.deepEqual(
            ledger.events.map((event) => event.event),
            ["launch"],
        );
        assert.equal(ledger.events[0]?.slot, 1);
    });

    it("distinguishes a missing ledger from an open empty one", () => {
        // Act
        const missing = parseCampaignLedger(undefined);
        const empty = parseCampaignLedger("");

        // Assert
        assert.equal(missing.state, "missing");
        assert.equal(empty.state, "open");
    });

    it("counts launches and judge launches per stamp", () => {
        // Arrange
        const text = [
            { event: "launch", stamp: "pd-A-r0-R01" },
            { event: "judge-launch", stamp: "pd-A-r0-R01" },
            { event: "judge-launch", stamp: "pd-A-r0-R01" },
            { event: "slot-complete", stamp: "pd-A-r0-R01" },
        ]
            .map((event) => JSON.stringify(event))
            .join("\n");

        // Act
        const grouped = eventsByStamp(parseCampaignLedger(text).events);

        // Assert
        const entry = grouped.get("pd-A-r0-R01");
        assert.equal(entry?.launches, 1);
        assert.equal(entry?.judgeLaunches, 2);
        assert.equal(entry?.complete, true);
    });
});

describe("attempt selection", () => {
    it("declares attempt-001 once when nothing overrides it", () => {
        // Act
        const result = resolveAttemptSelection({});

        // Assert
        assert.deepEqual(result, {
            ok: true,
            selection: { attemptId: DEFAULT_ATTEMPT_ID, source: "default" },
        });
    });

    it("honours a historical manifest that selects attempt-002", () => {
        // Act
        const result = resolveAttemptSelection({
            manifestAttemptId: "attempt-002",
        });

        // Assert
        assert.deepEqual(result, {
            ok: true,
            selection: { attemptId: "attempt-002", source: "manifest" },
        });
    });

    it("refuses conflicting manifest and override selections", () => {
        // Act
        const result = resolveAttemptSelection({
            manifestAttemptId: "attempt-002",
            overrideAttemptId: "attempt-001",
        });

        // Assert
        assert.equal(result.ok, false);
        assert.match(
            (result as { problems: string[] }).problems[0] ?? "",
            /conflicting attempt selections/,
        );
    });

    it("accepts an override that agrees with the manifest", () => {
        // Act
        const result = resolveAttemptSelection({
            manifestAttemptId: "attempt-002",
            overrideAttemptId: "attempt-002",
        });

        // Assert
        assert.equal(result.ok, true);
        assert.equal(
            (result as { selection: { attemptId: string } }).selection
                .attemptId,
            "attempt-002",
        );
    });

    it("refuses a malformed attempt id before any consumer runs", () => {
        // Act
        const result = resolveAttemptSelection({
            manifestAttemptId: "attempt-2",
        });

        // Assert
        assert.equal(result.ok, false);
        assert.match(
            (result as { problems: string[] }).problems[0] ?? "",
            /must match attempt-NNN/,
        );
    });

    it("requires recovery to name its own, later selection", () => {
        // Act
        const absent = resolveRecoverySelection({});
        const same = resolveRecoverySelection({
            manifestAttemptId: "attempt-002",
            recoveryAttemptId: "attempt-002",
        });
        const earlier = resolveRecoverySelection({
            manifestAttemptId: "attempt-003",
            recoveryAttemptId: "attempt-002",
        });
        const later = resolveRecoverySelection({
            manifestAttemptId: "attempt-001",
            recoveryAttemptId: "attempt-002",
        });

        // Assert
        assert.equal(absent.ok, false);
        assert.equal(same.ok, false);
        assert.equal(earlier.ok, false);
        assert.equal(later.ok, true);
    });
});

describe("durable budget claims", () => {
    it("lets exactly the ceiling number of callers claim a slot", async () => {
        // Arrange
        const root = temp("race");
        const worker = `import { claimBudget } from ${JSON.stringify(budgetModule)};
const result = claimBudget(process.env.ROOT, "trial", 5, { at: "2026-11-11T00:00:00Z" });
process.stdout.write(JSON.stringify(result));`;

        try {
            // Act
            const outcomes = await Promise.all(
                Array.from(
                    { length: 12 },
                    () =>
                        new Promise<{ ok: boolean; index?: number }>(
                            (resolve) => {
                                const run = spawn(
                                    process.execPath,
                                    ["--input-type=module", "-e", worker],
                                    {
                                        env: { ...process.env, ROOT: root },
                                    },
                                );
                                let out = "";
                                run.stdout?.on("data", (chunk: Buffer) => {
                                    out += chunk.toString();
                                });
                                run.on("close", () =>
                                    resolve(
                                        JSON.parse(out) as {
                                            ok: boolean;
                                            index?: number;
                                        },
                                    ),
                                );
                            },
                        ),
                ),
            );
            const winners = outcomes.filter((outcome) => outcome.ok);

            // Assert
            assert.equal(winners.length, 5);
            assert.equal(readClaims(root, "trial").length, 5);
            assert.equal(
                new Set(readClaims(root, "trial").map((claim) => claim.index))
                    .size,
                5,
            );
            assert.deepEqual(claimUsage(root, "trial"), {
                claimed: 5,
                reserved: 5,
                spawned: 0,
                closed: 0,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps trial and judge ceilings independent", () => {
        // Arrange
        const root = temp("kinds");

        try {
            // Act
            const trial = claimBudget(root, "trial", 1);
            const refusedTrial = claimBudget(root, "trial", 1);
            const judge = claimBudget(root, "judge", 1);

            // Assert
            assert.equal(trial.ok, true);
            assert.equal(refusedTrial.ok, false);
            assert.equal(judge.ok, true);
            assert.deepEqual(claimUsage(root, "judge"), {
                claimed: 1,
                reserved: 1,
                spawned: 0,
                closed: 0,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("writes nothing when a claim is refused", () => {
        // Arrange
        const root = temp("refusal");
        claimBudget(root, "trial", 1);

        try {
            // Act
            const refused = claimBudget(root, "trial", 1);

            // Assert
            assert.equal(refused.ok, false);
            assert.equal(readClaims(root, "trial").length, 1);
            assert.equal((refused as { used: number }).used, 1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("separates a reservation, a spawned call and a closed call", () => {
        // Arrange
        const root = temp("states");

        try {
            // Act
            const reserved = claimBudget(root, "judge", 3);
            assert.equal(reserved.ok, true);
            const first = reserved as {
                claim: import("./fixtures/placement-harness/analysis/budget.ts").BudgetClaim;
            };
            advanceClaim(first.claim, "spawned");
            const second = claimBudget(root, "judge", 3);
            assert.equal(second.ok, true);
            const spawned = (
                second as {
                    claim: import("./fixtures/placement-harness/analysis/budget.ts").BudgetClaim;
                }
            ).claim;
            advanceClaim(spawned, "closed");

            // Assert
            assert.deepEqual(claimUsage(root, "judge"), {
                claimed: 2,
                reserved: 0,
                spawned: 1,
                closed: 1,
            });
            assert.equal(
                restartDisposition(readClaims(root, "judge")[0]!),
                "unknown-outcome",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("counts a corrupt claim file as spent budget", () => {
        // Arrange
        const root = temp("corrupt");
        claimBudget(root, "trial", 2);

        try {
            // Act
            writeFileSync(
                join(root, "trial", "trial-0002.claim"),
                "not json",
                "utf8",
            );
            const claims = readClaims(root, "trial");

            // Assert
            assert.equal(claims.length, 2);
            assert.equal(claims[1]?.state, "reserved");
            assert.match(claims[1]?.note ?? "", /unreadable/);
            assert.equal(
                readFileSync(claims[0]!.path, "utf8").includes('"reserved"'),
                true,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("logical attempt ownership", () => {
    it("refuses a second reservation for the same logical attempt", () => {
        // Arrange
        const root = temp("logical");
        try {
            // Act
            const first = claimBudget(root, "judge", 4, {
                stamp: "pd-A-r0-X",
                attemptId: "attempt-002",
                key: "pd-A-r0-X|attempt-002",
            });
            const second = claimBudget(root, "judge", 4, {
                stamp: "pd-A-r0-X",
                attemptId: "attempt-002",
                key: "pd-A-r0-X|attempt-002",
            });

            // Assert
            assert.equal(first.ok, true);
            assert.equal(second.ok, false);
            assert.match(
                (second as { reason: string }).reason,
                /already owns a reservation/,
            );
            assert.equal(readClaims(root, "judge").length, 1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("lets exactly one of two logical attempts take the last allowance", () => {
        // Arrange
        const root = temp("last");
        try {
            // Act
            const first = claimBudget(root, "trial", 1, {
                stamp: "pd-A-r0-X",
                key: "pd-A-r0-X",
            });
            const second = claimBudget(root, "trial", 1, {
                stamp: "pd-B-r0-X",
                key: "pd-B-r0-X",
            });

            // Assert
            assert.equal(first.ok, true);
            assert.equal(second.ok, false);
            assert.equal(readClaims(root, "trial").length, 1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("releases only a reservation that dispatched nothing", () => {
        // Arrange
        const root = temp("release");
        try {
            const reserved = claimBudget(root, "trial", 2, {
                stamp: "pd-A-r0-X",
                key: "pd-A-r0-X",
            });
            const spawned = claimBudget(root, "trial", 2, {
                stamp: "pd-B-r0-X",
                key: "pd-B-r0-X",
            });
            assert.equal(reserved.ok, true);
            assert.equal(spawned.ok, true);
            assert.equal(spawned.ok, true);
            const spawnedClaim = advanceClaim(
                (spawned as { ok: true; claim: Parameters<typeof advanceClaim>[0] })
                    .claim,
                "spawned",
            );

            // Act
            const releasedReserved = releaseClaim(
                (reserved as { ok: true; claim: Parameters<typeof releaseClaim>[0] })
                    .claim,
            );
            const releasedSpawned = releaseClaim(spawnedClaim);

            // Assert
            assert.equal(releasedReserved, true);
            assert.equal(releasedSpawned, false);
            assert.equal(readClaims(root, "trial").length, 1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("arbitrates one logical attempt across two processes", async () => {
        // Arrange
        const root = temp("barrier");
        const barrier = join(root, "barrier");
        const worker = `import { existsSync, writeFileSync } from "node:fs";
import { claimBudget } from ${JSON.stringify(budgetModule)};
while (!existsSync(process.env.BARRIER)) {
    // Deterministic barrier: both workers are spinning before the claim.
}
const result = claimBudget(process.env.ROOT, "judge", 4, {
    stamp: "pd-A-r0-X",
    attemptId: "attempt-002",
    key: "pd-A-r0-X|attempt-002",
});
writeFileSync(process.env.RESULT, JSON.stringify(result));`;
        const spawnWorker = (name: string) =>
            new Promise<{ ok: boolean }>((resolve, reject) => {
                const child = spawn(process.execPath, ["--input-type=module", "-e", worker], {
                    env: {
                        ...process.env,
                        ROOT: root,
                        BARRIER: barrier,
                        RESULT: join(root, `${name}.json`),
                    },
                    stdio: "ignore",
                });
                child.on("error", reject);
                child.on("exit", () => {
                    resolve(
                        JSON.parse(
                            readFileSync(join(root, `${name}.json`), "utf8"),
                        ),
                    );
                });
            });

        try {
            const pending = [spawnWorker("one"), spawnWorker("two")];
            // Wait until both worker files exist only after claims are done;
            // the barrier is released once both processes are running.
            await new Promise((resolve) => setTimeout(resolve, 250));
            writeFileSync(barrier, "go\n", "utf8");
            const results = await Promise.all(pending);

            // Assert
            assert.equal(results.filter((result) => result.ok).length, 1);
            assert.equal(readClaims(root, "judge").length, 1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
