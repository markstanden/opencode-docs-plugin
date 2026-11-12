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

const here = import.meta.dirname;
const campaign = join(
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

const scenarios = ["R01", "S02", "R02", "R03", "S05", "S06", "S07", "R04"];

/** A schedule with eight interleaved pairs. */
function schedule(): unknown[] {
    return Array.from({ length: 8 }, (_, pair) => [
        {
            slot: pair * 2 + 1,
            pairId: `P0${pair + 1}`,
            repetition: 0,
            scenario: scenarios[pair],
            arm: "A",
            stamp: `pd-A-r0-${scenarios[pair]}`,
        },
        {
            slot: pair * 2 + 2,
            pairId: `P0${pair + 1}`,
            repetition: 0,
            scenario: scenarios[pair],
            arm: "B",
            stamp: `pd-B-r0-${scenarios[pair]}`,
        },
    ]).flat();
}

const trialTrail = [
    {
        type: "step_finish",
        part: {
            tokens: { input: 10, output: 4, reasoning: 1, cache: { read: 2 } },
        },
    },
    {
        type: "step_finish",
        part: {
            tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 1 } },
        },
    },
]
    .map((event) => JSON.stringify(event))
    .join("\n");

const judgeTrail = JSON.stringify({
    type: "step_finish",
    part: {
        tokens: { input: 3, output: 1, reasoning: 0, cache: { read: 0 } },
    },
});

/** One recorded trial with its judge attempts. */
function trial(
    root: string,
    slot: { arm: string; stamp: string; scenario: string },
    options: { failedAuth: boolean },
): void {
    const dir = join(
        root,
        "gen",
        slot.arm.toLowerCase(),
        "results",
        slot.stamp,
        slot.scenario,
    );
    write(
        join(dir, "meta.json"),
        JSON.stringify({ exit: 0, signal: null, answerValid: true }),
    );
    write(join(dir, "gate.json"), JSON.stringify({ status: "pass" }));
    write(
        join(dir, "primary-check.json"),
        JSON.stringify({ status: "pass", exit: 0 }),
    );
    write(join(dir, "final.md"), "answer\n");
    write(join(dir, "prompt.md"), "task\n");
    write(join(dir, "writes.txt"), "none\n");
    write(join(dir, "stdout.jsonl"), `${trialTrail}\n`);
    if (options.failedAuth) {
        write(
            join(dir, "ac/attempt-001/meta.json"),
            JSON.stringify({ status: "finished" }),
        );
        write(join(dir, "ac/attempt-001/output.jsonl"), "");
        write(
            join(dir, "ac/attempt-001/judgement.json"),
            JSON.stringify({ status: "judge-error" }),
        );
        write(
            join(dir, "ac/attempt-002/meta.json"),
            JSON.stringify({ status: "finished" }),
        );
        write(join(dir, "ac/attempt-002/output.jsonl"), `${judgeTrail}\n`);
        write(
            join(dir, "ac/attempt-002/judgement.json"),
            JSON.stringify({ status: "judged", documentationOutcome: "none" }),
        );
        return;
    }
    write(
        join(dir, "ac/attempt-001/meta.json"),
        JSON.stringify({ status: "finished" }),
    );
    write(join(dir, "ac/attempt-001/output.jsonl"), `${judgeTrail}\n`);
    write(
        join(dir, "ac/attempt-001/judgement.json"),
        JSON.stringify({ status: "judged", documentationOutcome: "none" }),
    );
}

/** A campaign root with `completed` recorded slots. */
function fixture(completed: number): string {
    const root = mkdtempSync(join(tmpdir(), "pd-close-"));
    execFileSync(process.execPath, [join(campaign, "materialise.mjs"), root], {
        encoding: "utf8",
    });
    const slots = schedule();
    write(
        join(root, "evidence/schedule.json"),
        JSON.stringify({ campaign: "pd-close", slots }),
    );
    write(
        join(root, "evidence/measurement-spec.json"),
        JSON.stringify({
            recordingOpportunities: [],
            retrievalOpportunities: [],
            scenarios: {},
        }),
    );
    write(
        join(root, "evidence/FROZEN.json"),
        JSON.stringify({
            budget: { plannedTrials: 16, plannedJudgeAttempts: 16 },
        }),
    );
    write(join(root, "evidence/ATTEMPTS.jsonl"), "");
    write(
        join(root, "prepare/shim/podman"),
        "#!/usr/bin/env sh\nexit 0\n",
    );
    chmodSync(join(root, "prepare/shim/podman"), 0o755);
    for (const slot of slots.slice(0, completed)) {
        trial(root, slot as never, { failedAuth: completed === 8 });
    }
    return root;
}

/** Run one materialised command. */
function command(
    root: string,
    script: string,
    env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
    return spawnSync(
        process.execPath,
        [join(root, "prepare", script)],
        {
            env: {
                ...process.env,
                CAMPAIGN_ROOT: root,
                CAMPAIGN_SOURCE_REPO: here,
                ZAI_API_KEY: "stub",
                ...env,
            },
            encoding: "utf8",
            timeout: 120000,
        },
    );
}

describe("materialised campaign closure", () => {
    it("closes P04 from evidence with 4 pairs, 8 launches and 8 inferred judges", () => {
        // Arrange
        const root = fixture(8);

        try {
            // Act
            const run = command(root, "close-campaign.mjs");
            const report = JSON.parse(
                readFileSync(join(root, "evidence/RECONCILIATION.json"), "utf8"),
            );

            // Assert
            assert.equal(run.status, 0, String(run.stderr));
            assert.equal(report.completedPairs, 4);
            assert.equal(report.trialLaunches, 8);
            assert.equal(report.judge.attempts, 16);
            assert.equal(report.judge.reachedInference, 8);
            assert.equal(report.judge.usableJudgements, 8);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("closes P08 with 8 pairs and 16 trial and judge attempts", () => {
        // Arrange
        const root = fixture(16);

        try {
            // Act
            const run = command(root, "close-campaign.mjs");
            const report = JSON.parse(
                readFileSync(join(root, "evidence/RECONCILIATION.json"), "utf8"),
            );

            // Assert
            assert.equal(run.status, 0, String(run.stderr));
            assert.equal(report.completedPairs, 8);
            assert.equal(report.trialLaunches, 16);
            assert.equal(report.judge.attempts, 16);
            assert.equal(report.judge.reachedInference, 16);
            assert.equal(report.judge.usableJudgements, 16);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("leaves the closed ledger byte-identical across run and rejudge", () => {
        // Arrange
        const root = fixture(8);
        const ledger = join(root, "evidence/ATTEMPTS.jsonl");
        const counter = join(root, "counter.txt");
        try {
            assert.equal(command(root, "close-campaign.mjs").status, 0);
            const closedBytes = readFileSync(ledger, "utf8");

            // Act
            const run = command(root, "run.mjs", {
                STUB_COUNTER: counter,
                PATH: `${join(root, "prepare/shim")}:${process.env.PATH ?? ""}`,
            });
            const rejudge = command(root, "rejudge.mjs", {
                STUB_COUNTER: counter,
            });

            // Assert
            assert.notEqual(run.status, 0);
            assert.notEqual(rejudge.status, 0);
            assert.equal(readFileSync(ledger, "utf8"), closedBytes);
            assert.equal(
                existsSync(counter) ? readFileSync(counter, "utf8") : "",
                "",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
