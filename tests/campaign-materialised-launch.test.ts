import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { dirname, join } from "node:path";
import { claimBudget } from "./fixtures/placement-harness/analysis/budget.ts";

const here = import.meta.dirname;
const fixture = join(
    here,
    "fixtures",
    "placement-harness",
    "prod014",
    "campaign",
);

/** Write one file, creating parents. */
function write(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
}

/** Materialise a fresh campaign root with the minimum schedule and identity. */
function campaign(): { root: string; counter: string } {
    const root = mkdtempSync(join(tmpdir(), "pd-materialised-"));
    execFileSync(process.execPath, [join(fixture, "materialise.mjs"), root], {
        encoding: "utf8",
    });
    const counter = join(root, "counter.txt");
    write(
        join(root, "evidence/schedule.json"),
        JSON.stringify({
            campaign: "pd-test",
            slots: [
                {
                    slot: 1,
                    pairId: "P01",
                    repetition: 0,
                    scenario: "R01",
                    arm: "A",
                    stamp: "pd-A-r0-R01",
                },
                {
                    slot: 2,
                    pairId: "P01",
                    repetition: 0,
                    scenario: "R01",
                    arm: "B",
                    stamp: "pd-B-r0-R01",
                },
            ],
        }),
    );
    write(join(root, "evidence/ATTEMPTS.jsonl"), "");
    write(
        join(root, "evidence/FROZEN.json"),
        JSON.stringify({
            budget: { plannedTrials: 2, plannedJudgeAttempts: 2 },
        }),
    );
    write(
        join(root, "prepare/manifest.json"),
        JSON.stringify({ assessment: { attemptId: "attempt-002" } }),
    );
    const shim = join(root, "prepare/shim/podman");
    chmodSync(shim, 0o755);
    const stub = join(root, "trial-stub.sh");
    write(stub, `#!/usr/bin/env sh\nprintf 'trial\\n' >>"\${STUB_COUNTER}"\n`);
    chmodSync(stub, 0o755);
    return { root, counter };
}

/** Run one materialised command with a counting trial stub. */
function run(
    root: string,
    counter: string,
    script: string,
    args: readonly string[],
): ReturnType<typeof spawnSync> {
    return spawnSync(
        process.execPath,
        [join(root, "prepare", script), ...args],
        {
            env: {
                ...process.env,
                CAMPAIGN_ROOT: root,
                STUB_COUNTER: counter,
                ZAI_API_KEY: "stub",
            },
            encoding: "utf8",
            timeout: 60000,
        },
    );
}

const counted = (path: string): string =>
    existsSync(path) ? readFileSync(path, "utf8") : "";

describe("materialised launch boundary", () => {
    it("refuses a structurally closed ledger without changing its bytes", () => {
        // Arrange
        const { root, counter } = campaign();
        const ledger = join(root, "evidence/ATTEMPTS.jsonl");
        write(
            ledger,
            `${JSON.stringify({ event: "campaign-closed", at: "2026-11-11T00:00:00Z" })}\n`,
        );
        const before = readFileSync(ledger, "utf8");

        try {
            // Act
            const result = run(root, counter, "run.mjs", [
                "--pair-from",
                "1",
                "--pair-to",
                "1",
                "--trial-command",
                join(root, "trial-stub.sh"),
            ]);

            // Assert
            assert.equal(result.status, 2);
            assert.equal(readFileSync(ledger, "utf8"), before);
            assert.equal(counted(counter), "");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a truncated ledger rather than reading it as open", () => {
        // Arrange
        const { root, counter } = campaign();
        const ledger = join(root, "evidence/ATTEMPTS.jsonl");
        write(ledger, '{"event":"launch","stamp":"pd-A-r0-R01"');
        const before = readFileSync(ledger, "utf8");

        try {
            // Act
            const result = run(root, counter, "run.mjs", [
                "--pair-from",
                "1",
                "--pair-to",
                "1",
                "--trial-command",
                join(root, "trial-stub.sh"),
            ]);

            // Assert
            assert.equal(result.status, 2);
            assert.match(String(result.stderr), /attempt ledger is malformed/);
            assert.equal(readFileSync(ledger, "utf8"), before);
            assert.equal(counted(counter), "");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a conflicting attempt override before any launch", () => {
        // Arrange
        const { root, counter } = campaign();

        try {
            // Act
            const result = run(root, counter, "run.mjs", [
                "--pair-from",
                "1",
                "--pair-to",
                "1",
                "--attempt-id",
                "attempt-001",
                "--trial-command",
                join(root, "trial-stub.sh"),
            ]);

            // Assert
            assert.equal(result.status, 2);
            assert.match(
                String(result.stderr),
                /conflicting attempt selections/,
            );
            assert.equal(
                readFileSync(join(root, "evidence/ATTEMPTS.jsonl"), "utf8"),
                "",
            );
            assert.equal(counted(counter), "");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses an unsettled trial claim from an interrupted invocation", () => {
        // Arrange
        const { root, counter } = campaign();
        const claim = claimBudget(join(root, "evidence"), "trial", 2, {
            stamp: "pd-A-r0-R01",
            at: "2026-11-11T00:00:00Z",
        });
        assert.equal(claim.ok, true);

        try {
            // Act
            const result = run(root, counter, "run.mjs", [
                "--pair-from",
                "1",
                "--pair-to",
                "1",
                "--trial-command",
                join(root, "trial-stub.sh"),
                "--attempt-id",
                "attempt-002",
            ]);

            // Assert
            assert.equal(result.status, 2);
            assert.match(String(result.stderr), /unsettled trial claim/);
            assert.equal(counted(counter), "");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
