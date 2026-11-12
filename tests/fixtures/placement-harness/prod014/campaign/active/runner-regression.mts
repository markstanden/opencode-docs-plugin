// Focused runner regressions with temporary roots and stub launchers.
//
// 1. A closed ledger prevents run.mts and rejudge.mts from writing launch
//    events or invoking a child.
// 2. A preserved recovery attempt with a non-judged status blocks; a judged
//    attempt resumes without a duplicate call.
// 3. A non-executable logging shim stops the live path before the first launch.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const PREPARE = new URL(".", import.meta.url).pathname;
const STUB_COUNTER = "STUB_COUNTER";
const results: Record<string, unknown> = {};

const write = (path: string, body: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
};
const json = (path: string, value: unknown): void =>
    write(path, `${JSON.stringify(value, null, 2)}\n`);
const temp = (label: string): string => mkdtempSync(join(tmpdir(), `pd-runner-${label}-`));

/** A schedule and the minimum files the commands read before a launch. */
const campaign = (label: string): string => {
    const root = temp(label);
    write(
        join(root, "evidence/schedule.json"),
        JSON.stringify({
            campaign: `runner-${label}`,
            slots: [
                {
                    slot: 1,
                    pairId: "P01",
                    repetition: 0,
                    scenario: "X",
                    arm: "A",
                    stamp: "pd-A-r0-X",
                },
            ],
        }),
    );
    write(join(root, "evidence/ATTEMPTS.jsonl"), "");
    mkdirSync(join(root, "prepare/shim"), { recursive: true });
    write(join(root, "prepare/shim/podman"), "#!/usr/bin/env sh\nexit 0\n");
    chmodSync(join(root, "prepare/shim/podman"), 0o755);
    // If a broken guard reaches the child, this records it.
    write(
        join(root, "measurement/tests/fixtures/placement-harness/ac/run.mts"),
        `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.STUB_COUNTER, "judge\\n");\n`,
    );
    return root;
};

const counter = (root: string): string => {
    const path = join(root, "counter.txt");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
};

const run = (
    root: string,
    script: string,
    args: string[],
    env: Record<string, string> = {},
): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [join(PREPARE, script), ...args], {
        env: { ...process.env, CAMPAIGN_ROOT: root, ...env },
        encoding: "utf8",
        timeout: 60000,
    });

// 1. Closed campaign: neither command writes or launches.
{
    const root = campaign("closed");
    const ledger = join(root, "evidence/ATTEMPTS.jsonl");
    const before = readFileSync(ledger, "utf8");
    write(
        ledger,
        `${before}${JSON.stringify({ event: "campaign-closed", at: "2026-11-11T00:00:00Z" })}\n`,
    );
    const closedBytes = readFileSync(ledger, "utf8");
    const stub = join(root, "trial-stub.sh");
    write(stub, `#!/usr/bin/env sh\nprintf 'trial\\n' >>"\${STUB_COUNTER}"\n`);
    chmodSync(stub, 0o755);
    const trial = run(
        root,
        "run.mts",
        ["--pair-from", "1", "--pair-to", "1", "--trial-command", stub],
        { [STUB_COUNTER]: join(root, "counter.txt") },
    );
    const recovery = run(root, "rejudge.mts", [], {
        [STUB_COUNTER]: join(root, "counter.txt"),
        ZAI_API_KEY: "stub",
    });
    assert.notEqual(trial.status, 0);
    assert.notEqual(recovery.status, 0);
    assert.equal(readFileSync(ledger, "utf8"), closedBytes);
    assert.equal(counter(root), "");
    results.closedCampaign = {
        trialExit: trial.status,
        recoveryExit: recovery.status,
        ledgerUnchanged: true,
        launcherCalls: 0,
    };
    rmSync(root, { recursive: true, force: true });
}

// 2. Preserved recovery attempts: failed blocks, judged resumes.
{
    const root = campaign("recovery");
    const caseDir = join(root, "gen/a/results/pd-A-r0-X/X");
    json(join(caseDir, "meta.json"), {
        exit: 0,
        signal: null,
        answerValid: true,
    });
    json(join(caseDir, "ac/attempt-002/judgement.json"), {
        status: "failed",
    });
    const failed = run(root, "rejudge.mts", [], {
        [STUB_COUNTER]: join(root, "counter.txt"),
        ZAI_API_KEY: "stub",
    });
    const ledgerAfterFailure = readFileSync(
        join(root, "evidence/ATTEMPTS.jsonl"),
        "utf8",
    );
    assert.notEqual(failed.status, 0);
    assert.equal(counter(root), "");
    assert.ok(!ledgerAfterFailure.includes('"event":"recovery-complete"'));

    json(join(caseDir, "ac/attempt-002/judgement.json"), {
        status: "judged",
        documentationOutcome: "none",
        documentationReason: "preserved",
        evidence: ["preserved"],
    });
    const judged = run(root, "rejudge.mts", [], {
        [STUB_COUNTER]: join(root, "counter.txt"),
        ZAI_API_KEY: "stub",
    });
    assert.equal(judged.status, 0);
    assert.equal(counter(root), "");
    assert.ok(
        readFileSync(join(root, "evidence/ATTEMPTS.jsonl"), "utf8").includes(
            '"event":"recovery-complete"',
        ),
    );
    results.recovery = {
        failedExit: failed.status,
        failedLauncherCalls: 0,
        judgedExit: judged.status,
        judgedLauncherCalls: 0,
    };
    rmSync(root, { recursive: true, force: true });
}

// 3. A non-executable shim stops the live path before launch.
{
    const root = campaign("shim");
    const shim = join(root, "prepare/shim/podman");
    chmodSync(shim, 0o644);
    const stub = join(root, "trial-stub.sh");
    write(stub, `#!/usr/bin/env sh\nprintf 'trial\\n' >>"\${STUB_COUNTER}"\n`);
    chmodSync(stub, 0o755);
    const trial = run(
        root,
        "run.mts",
        ["--pair-from", "1", "--pair-to", "1", "--trial-command", stub],
        { [STUB_COUNTER]: join(root, "counter.txt") },
    );
    assert.notEqual(trial.status, 0);
    assert.equal(counter(root), "");
    assert.equal(
        readFileSync(join(root, "evidence/ATTEMPTS.jsonl"), "utf8"),
        "",
    );
    results.shim = {
        exit: trial.status,
        launcherCalls: 0,
        ledgerUnchanged: true,
    };
    rmSync(root, { recursive: true, force: true });
}

write(
    join(PREPARE, "RUNNER-REGRESSIONS.json"),
    `${JSON.stringify(results, null, 2)}\n`,
);
console.log(JSON.stringify(results, null, 2));
