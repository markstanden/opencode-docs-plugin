import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    claimBudget,
    claimUsage,
} from "./fixtures/placement-harness/analysis/budget.ts";

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

/** SHA-256 of one file. */
function hashFile(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every file under a directory, root-relative, sorted. */
function filesUnder(dir: string, root: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...filesUnder(path, root));
        else found.push(path.slice(root.length + 1));
    }
    return found.sort();
}

/** Materialise a fresh campaign root with the minimum schedule and identity. */
function campaign(): { root: string; counter: string; bin: string } {
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
                {
                    slot: 3,
                    pairId: "P02",
                    repetition: 0,
                    scenario: "R02",
                    arm: "A",
                    stamp: "pd-A-r0-R02",
                },
                {
                    slot: 4,
                    pairId: "P02",
                    repetition: 0,
                    scenario: "R02",
                    arm: "B",
                    stamp: "pd-B-r0-R02",
                },
            ],
        }),
    );
    write(join(root, "evidence/ATTEMPTS.jsonl"), "");
    const bin = join(root, "fake-bin");
    write(
        join(bin, "podman"),
        `#!/usr/bin/env sh
case "$1" in
  --version) echo "podman 5.0.0" ; exit 0 ;;
  image) echo "sha256:test-image" ; exit 0 ;;
esac
exit 0
`,
    );
    chmodSync(join(bin, "podman"), 0o755);
    // A source repo independent of the test checkout, so the read-only gate
    // scope needs no .git metadata.
    const sourceDir = join(root, "source");
    write(join(sourceDir, "README.md"), "source\n");
    execFileSync("git", ["init", "-q"], { cwd: sourceDir });
    execFileSync("git", ["add", "-A"], { cwd: sourceDir });
    execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "s"],
        { cwd: sourceDir },
    );
    const source = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: sourceDir,
        encoding: "utf8",
    }).trim();
    write(
        join(root, "prepare/manifest.json"),
        JSON.stringify({ assessment: { attemptId: "attempt-001" } }),
    );
    write(
        join(root, "evidence/FROZEN.json"),
        JSON.stringify({
            freeze: {
                schemaVersion: 2,
                campaign: "pd-test",
                sourceRevision: source,
                sourceTree: "tree",
                imageId: "sha256:test-image",
                containerCli: "podman 5.0.0",
                measurementSha256: "m",
                arms: [],
                files: [
                    {
                        path: "evidence/schedule.json",
                        sha256: hashFile(join(root, "evidence/schedule.json")),
                    },
                ],
                inventories: [
                    {
                        path: "prepare",
                        files: filesUnder(join(root, "prepare"), root).map(
                            (path) => ({
                                path,
                                sha256: hashFile(join(root, path)),
                            }),
                        ),
                    },
                ],
                stoppingRules: ["stop on first unusable assessment"],
                ceilings: { trial: 4, judge: 4 },
            },
        }),
    );
    const shim = join(root, "prepare/shim/podman");
    chmodSync(shim, 0o755);
    const stub = join(root, "trial-stub.sh");
    write(stub, `#!/usr/bin/env sh\nprintf 'trial\\n' >>"\${STUB_COUNTER}"\n`);
    chmodSync(stub, 0o755);
    return { root, counter, bin };
}

/** Run one materialised command with a counting trial stub. */
function run(
    root: string,
    counter: string,
    bin: string,
    script: string,
    args: readonly string[],
    extraEnv: Readonly<Record<string, string>> = {},
): ReturnType<typeof spawnSync> {
    return spawnSync(
        process.execPath,
        [join(root, "prepare", script), ...args],
        {
            env: {
                ...process.env,
                CAMPAIGN_ROOT: root,
                CAMPAIGN_SOURCE_REPO: join(root, "source"),
                STUB_COUNTER: counter,
                ZAI_API_KEY: "stub",
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                ...extraEnv,
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
        const { root, counter, bin } = campaign();
        const ledger = join(root, "evidence/ATTEMPTS.jsonl");
        write(
            ledger,
            `${JSON.stringify({ event: "campaign-closed", at: "2026-11-11T00:00:00Z" })}\n`,
        );
        const before = readFileSync(ledger, "utf8");

        try {
            // Act
            const result = run(root, counter, bin, "run.mjs", [
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
        const { root, counter, bin } = campaign();
        const ledger = join(root, "evidence/ATTEMPTS.jsonl");
        write(ledger, '{"event":"launch","stamp":"pd-A-r0-R01"');
        const before = readFileSync(ledger, "utf8");

        try {
            // Act
            const result = run(root, counter, bin, "run.mjs", [
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
        const { root, counter, bin } = campaign();

        try {
            // Act
            const result = run(root, counter, bin, "run.mjs", [
                "--pair-from",
                "1",
                "--pair-to",
                "1",
                "--attempt-id",
                "attempt-002",
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

    it("does not burn an allowance when the judge wrapper refuses", () => {
        // Arrange
        const { root, counter, bin } = campaign();
        const caseDir = join(root, "gen/a/results/pd-A-r0-R01/R01");
        write(
            join(caseDir, "meta.json"),
            JSON.stringify({ exit: 0, answerValid: true }),
        );
        const stub = join(
            root,
            "measurement/tests/fixtures/placement-harness/ac/run.mjs",
        );
        write(stub, `process.exit(2);\n`);
        try {
            // Act
            const result = run(root, counter, bin, "rejudge.mjs", []);

            // Assert
            assert.equal(result.status, 2);
            assert.equal(
                claimUsage(join(root, "evidence"), "judge").claimed,
                0,
            );
            const ledger = readFileSync(
                join(root, "evidence/ATTEMPTS.jsonl"),
                "utf8",
            );
            assert.ok(!ledger.includes('"event":"judge-launch"'));
            assert.ok(ledger.includes('"event":"judge-refused"'));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("records a judge launch only when dispatch actually happened", () => {
        // Arrange
        const { root, counter, bin } = campaign();
        const caseDir = join(root, "gen/a/results/pd-A-r0-R01/R01");
        write(
            join(caseDir, "meta.json"),
            JSON.stringify({ exit: 0, answerValid: true }),
        );
        write(
            join(root, "gen/b/results/pd-B-r0-R01/R01/meta.json"),
            JSON.stringify({ exit: 0, answerValid: true }),
        );
        write(
            join(root, "gen/a/results/pd-A-r0-R02/R02/meta.json"),
            JSON.stringify({ exit: 0, answerValid: true }),
        );
        write(
            join(root, "gen/b/results/pd-B-r0-R02/R02/meta.json"),
            JSON.stringify({ exit: 0, answerValid: true }),
        );
        const stub = join(
            root,
            "measurement/tests/fixtures/placement-harness/ac/run.mjs",
        );
        write(
            stub,
            `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const attemptDir = join(value("--base"), "results", value("--stamp"), value("--case"), "ac", value("--attempt"));
mkdirSync(attemptDir, { recursive: true });
writeFileSync(join(attemptDir, "dispatch.json"), "{}");
writeFileSync(join(attemptDir, "judgement.json"), JSON.stringify({ status: "judged", documentationOutcome: "none" }));
`,
        );
        try {
            // Act
            const result = run(root, counter, bin, "rejudge.mjs", []);

            // Assert
            assert.equal(result.status, 0, String(result.stderr));
            assert.equal(
                claimUsage(join(root, "evidence"), "judge").claimed,
                4,
            );
            assert.ok(
                readFileSync(
                    join(root, "evidence/ATTEMPTS.jsonl"),
                    "utf8",
                ).includes('"event":"judge-launch"'),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("never marks the host describe as an in-container trial", () => {
        // Arrange
        const { root, counter, bin } = campaign();
        const envFile = join(root, "trial-env.json");
        const stub = join(root, "trial-env.sh");
        write(
            stub,
            `#!/usr/bin/env sh
node -e 'const fs=require("fs");fs.writeFileSync(process.env.ENV_FILE,JSON.stringify({image:process.env.PLACEMENT_IMAGE??null,imageId:process.env.PLACEMENT_TRIAL_IMAGE_ID??null}))'
`,
        );
        chmodSync(stub, 0o755);

        try {
            // Act
            run(
                root,
                counter,
                bin,
                "run.mjs",
                ["--pair-from", "1", "--pair-to", "1", "--trial-command", stub],
                { ENV_FILE: envFile },
            );
            const env = JSON.parse(readFileSync(envFile, "utf8")) as {
                image: string | null;
                imageId: string | null;
            };

            // Assert
            assert.equal(env.image, null);
            assert.equal(env.imageId, "sha256:test-image");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("blocks a dispatch while a campaign close is in progress", () => {
        // Arrange
        const { root, counter, bin } = campaign();
        write(join(root, "evidence/CLOSING.lock"), `${String(process.pid)}\n`);

        try {
            // Act
            const result = run(root, counter, bin, "run.mjs", [
                "--pair-from",
                "1",
                "--pair-to",
                "1",
                "--trial-command",
                join(root, "trial-stub.sh"),
            ]);

            // Assert
            assert.equal(result.status, 2);
            assert.match(String(result.stderr), /close is in progress/);
            assert.equal(counted(counter), "");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not resume a later range past an incomplete slot", () => {
        // Arrange
        const { root, counter, bin } = campaign();

        try {
            // Act
            const result = run(root, counter, bin, "run.mjs", [
                "--pair-from",
                "2",
                "--pair-to",
                "2",
                "--trial-command",
                join(root, "trial-stub.sh"),
            ]);

            // Assert
            assert.equal(result.status, 2);
            assert.match(String(result.stderr), /a later range cannot skip it/);
            assert.equal(counted(counter), "");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses an unsettled trial claim from an interrupted invocation", () => {
        // Arrange
        const { root, counter, bin } = campaign();
        const claim = claimBudget(join(root, "evidence"), "trial", 2, {
            stamp: "pd-A-r0-R01",
            at: "2026-11-11T00:00:00Z",
        });
        assert.equal(claim.ok, true);

        try {
            // Act
            const result = run(root, counter, bin, "run.mjs", [
                "--pair-from",
                "1",
                "--pair-to",
                "1",
                "--trial-command",
                join(root, "trial-stub.sh"),
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
