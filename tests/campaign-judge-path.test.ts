// Judge-path exposure: the host evidence path must never reach the judge.
//
// A campaign root under /home carries the operator's name. That path is host
// evidence plumbing, not judge-visible content: it may appear as a container
// mount SOURCE, but the child must see only neutral container paths and
// environment values. Genuine packet leaks still refuse before dispatch.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { labelLeaks } from "./fixtures/placement-harness/ac/campaign.mts";

const HERE = import.meta.dirname;
const HARNESS = join(HERE, "fixtures", "placement-harness");
const RUN = join(HARNESS, "ac", "run.mts");
const LAUNCHER = join(HARNESS, "ac", "judge-launcher.sh");
const MATERIALISE = join(HARNESS, "prod014", "campaign", "materialise.mts");
const MODEL = "opencode-go/deepseek-v4.1-flash";
const STAMP = "pd-A-r0-R01";
const CASE = "R01";

const sha256 = (text: string): string =>
    createHash("sha256").update(text, "utf8").digest("hex");

/** One canary campaign root and the operator name it carries. */
interface CanaryRoot {
    /** The campaign root: `<temp>/home/<canary>`. */
    root: string;
    /** The operator-name segment the judge child must never see. */
    canary: string;
}

/**
 * A campaign root containing a literal `/home/<canary>/` segment beneath a
 * writable temporary root. The path exercises the host-path leak detector
 * without depending on the runner's real HOME.
 * @returns The fresh root and its canary segment.
 */
function operatorRoot(): CanaryRoot {
    const base = mkdtempSync(join(tmpdir(), "pd-judge-path-"));
    const canary = `operator-${basename(base)}`;
    const root = join(base, "home", canary);
    mkdirSync(root, { recursive: true });
    // Prove the constructed path is a real canary for the original detector.
    assert.deepEqual(labelLeaks(root), ["/\\/home\\/[^/\\s]+/"]);
    return { root, canary };
}

/**
 * A fake podman at the last external boundary. It records the container view
 * and answers `run` as an offline judge with a valid `none` judgement.
 */
function fakePodman(root: string): { bin: string; captures: string } {
    const bin = join(root, "fake-bin");
    const captures = join(root, "podman-captures");
    mkdirSync(bin, { recursive: true });
    mkdirSync(captures, { recursive: true });
    const script = join(bin, "podman");
    writeFileSync(
        script,
        `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
    process.stdout.write("podman version 6.1.4\\n");
    process.exit(0);
}
if (argv[0] === "image") {
    process.stdout.write("sha256:test-image\\n");
    process.exit(0);
}
if (argv[0] !== "run") process.exit(0);
const after = (flag) => argv[argv.indexOf(flag) + 1];
const env = {};
for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "-e") continue;
    const entry = argv[index + 1];
    const equals = entry.indexOf("=");
    if (equals < 0) env[entry] = process.env[entry] ?? null;
    else env[entry.slice(0, equals)] = entry.slice(equals + 1);
}
const mounts = [];
for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "-v") mounts.push(argv[index + 1]);
}
const dir = process.env.FAKE_CAPTURE_DIR;
mkdirSync(dir, { recursive: true });
writeFileSync(
    join(dir, process.pid + "-" + Date.now() + "-" + Math.random() + ".json"),
    JSON.stringify(
        { argv, workdir: after("-w"), env, mounts, prompt: argv.at(-1) },
        null,
        2,
    ) + "\\n",
);
const answer = JSON.stringify({
    documentationOutcome: "none",
    documentationReason: "No lake document changed.",
    evidence: ["The trial made no documentation change."],
});
process.stdout.write(
    JSON.stringify({ type: "text", part: { type: "text", text: answer } }) +
        "\\n",
);
`,
        "utf8",
    );
    chmodSync(script, 0o755);
    return { bin, captures };
}

/** Every capture written by the fake podman. */
function capturesOf(dir: string): Array<Record<string, unknown>> {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

/** Seed one recorded trial result the judge path can read. */
function seedTrial(root: string, answer: string): string {
    const dir = join(root, "gen/a/results", STAMP, CASE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "final.md"), answer, "utf8");
    writeFileSync(
        join(dir, "meta.json"),
        JSON.stringify({
            exit: 0,
            answerValid: true,
            answerHash: sha256(answer),
        }),
        "utf8",
    );
    writeFileSync(join(dir, "prompt.md"), "Fix the CSV importer.\n", "utf8");
    writeFileSync(join(dir, "writes.txt"), "", "utf8");
    writeFileSync(
        join(dir, "primary-check.json"),
        JSON.stringify({ status: "pass", exit: 0, stdout: "", stderr: "" }),
        "utf8",
    );
    return dir;
}

/** The neutral run directory the host supplies for one attempt. */
const hostRunDir = (root: string): string =>
    join(root, "evidence/ac-runs", sha256(`${STAMP}/${CASE}`).slice(0, 16));

/** Assert the child-visible view carries none of the host path. */
function assertBlind(received: Record<string, unknown>, canary: string): void {
    const env = received.env as Record<string, string | null>;
    const visible = [
        received.workdir,
        env.PWD,
        env.XDG_CONFIG_HOME,
        env.HOME,
        env.XDG_DATA_HOME,
        env.XDG_CACHE_HOME,
        received.prompt,
    ];
    assert.deepEqual(
        visible.filter(
            (value) => typeof value === "string" && value.includes(canary),
        ),
        [],
        "the judge-visible context carried the host operator name",
    );
}

/** Run the real judge wrapper with a fake podman at the boundary. */
function judge(root: string, bin: string, captures: string) {
    writeFileSync(join(root, "truth.json"), "{}\n", "utf8");
    writeFileSync(join(root, "spec.json"), "{}\n", "utf8");
    return spawnSync(
        process.execPath,
        [
            RUN,
            "judge",
            "--base",
            join(root, "gen/a"),
            "--stamp",
            STAMP,
            "--case",
            CASE,
            "--truth",
            join(root, "truth.json"),
            "--spec",
            join(root, "spec.json"),
            "--launcher",
            LAUNCHER,
            "--model",
            MODEL,
            "--workdir",
            join(root, "evidence/ac-runs"),
            "--timeout",
            "30000",
        ],
        {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                FAKE_CAPTURE_DIR: captures,
                OPENCODE_CONFIG_CONTENT: "{}",
            },
        },
    );
}

describe("judge path exposure", () => {
    it("reaches the offline judge with the operator name only in the host mount source", () => {
        // Arrange
        const { root, canary } = operatorRoot();
        const { bin, captures } = fakePodman(root);
        const attemptDir = join(
            root,
            "gen/a/results",
            STAMP,
            CASE,
            "ac/attempt-001",
        );
        seedTrial(root, "No documentation change was needed.\n");

        try {
            // Act
            const result = judge(root, bin, captures);

            // Assert: the judge ran and the host received its evidence.
            assert.equal(result.status, 0, result.stderr);
            const received = capturesOf(captures);
            assert.equal(
                received.length,
                1,
                "the offline judge was not reached",
            );
            const evidence = JSON.parse(
                readFileSync(join(attemptDir, "judgement.json"), "utf8"),
            );
            assert.equal(evidence.status, "judged");
            assert.equal(evidence.documentationOutcome, "none");
            assert.ok(existsSync(join(attemptDir, "dispatch.json")));
            assert.match(
                readFileSync(join(attemptDir, "output.jsonl"), "utf8"),
                /documentationOutcome/,
            );

            // Assert: the child sees only neutral paths and env values.
            const view = received[0] as Record<string, unknown>;
            const env = view.env as Record<string, string>;
            assert.equal(view.workdir, "/judge/work");
            assert.equal(env.PWD, "/judge/work");
            assert.equal(env.XDG_CONFIG_HOME, "/judge/config-home");
            assertBlind(view, canary);

            // Assert: the host path is still the mount SOURCE, proving the
            // canary was really present and neutralised, not merely absent.
            const mounts = view.mounts as string[];
            const neutralMount = mounts.find((entry) =>
                entry.includes(":/judge:"),
            );
            assert.ok(neutralMount !== undefined, "no neutral judge mount");
            assert.ok(neutralMount.startsWith(hostRunDir(root)));
            assert.ok(neutralMount.includes(canary));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a genuine packet leak before any provider request", () => {
        // Arrange
        const { root } = operatorRoot();
        const { bin, captures } = fakePodman(root);
        const attemptDir = join(
            root,
            "gen/a/results",
            STAMP,
            CASE,
            "ac/attempt-001",
        );
        seedTrial(
            root,
            `The note lives at ${join(root, "private/answer.md")}\n`,
        );

        try {
            // Act
            const result = judge(root, bin, captures);

            // Assert: refusal precedes spawn; no provider request was made.
            assert.equal(result.status, 3, result.stderr);
            assert.match(String(result.stderr), /experiment labels/);
            assert.deepEqual(capturesOf(captures), []);
            assert.equal(existsSync(join(attemptDir, "dispatch.json")), false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps the materialised run-card layout judge-blind end to end", () => {
        // Arrange: a fresh materialised campaign under the operator's home.
        const { root, canary } = operatorRoot();
        const { bin, captures } = fakePodman(root);
        execFileSync(process.execPath, [MATERIALISE, root], {
            encoding: "utf8",
        });
        const write = (path: string, body: string): void => {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, body, "utf8");
        };
        const slots = ["A", "B"].map((arm, index) => ({
            slot: index + 1,
            pairId: "P01",
            repetition: 0,
            scenario: CASE,
            arm,
            stamp: `pd-${arm}-r0-${CASE}`,
        }));
        write(
            join(root, "evidence/schedule.json"),
            JSON.stringify({ campaign: "pd-path", slots }, null, 2),
        );
        write(join(root, "evidence/ATTEMPTS.jsonl"), "");
        write(join(root, "evidence/measurement-spec.json"), "{}\n");
        write(
            join(root, "prepare/manifest.json"),
            JSON.stringify({ assessment: { attemptId: "attempt-001" } }),
        );
        const sourceDir = join(root, "source");
        write(join(sourceDir, "README.md"), "source\n");
        execFileSync("git", ["init", "-q"], { cwd: sourceDir });
        execFileSync("git", ["add", "-A"], { cwd: sourceDir });
        execFileSync(
            "git",
            [
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-qm",
                "s",
            ],
            { cwd: sourceDir },
        );
        const source = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: sourceDir,
            encoding: "utf8",
        }).trim();
        const hash = (path: string): string =>
            createHash("sha256").update(readFileSync(path)).digest("hex");
        write(
            join(root, "evidence/FROZEN.json"),
            JSON.stringify({
                freeze: {
                    schemaVersion: 2,
                    campaign: "pd-path",
                    sourceRevision: source,
                    sourceTree: "tree",
                    imageId: "sha256:test-image",
                    containerCli: "podman version 6.1.4",
                    measurementSha256: "m",
                    arms: [],
                    files: [
                        {
                            path: "evidence/schedule.json",
                            sha256: hash(join(root, "evidence/schedule.json")),
                        },
                    ],
                    inventories: [
                        {
                            path: "prepare",
                            files: readdirSync(join(root, "prepare"), {
                                recursive: true,
                                withFileTypes: true,
                            })
                                .filter((entry) => entry.isFile())
                                .map((entry) =>
                                    join(entry.parentPath, entry.name).slice(
                                        root.length + 1,
                                    ),
                                )
                                .sort()
                                .map((path) => ({
                                    path,
                                    sha256: hash(join(root, path)),
                                })),
                        },
                    ],
                    stoppingRules: ["stop on first unusable assessment"],
                    ceilings: { trial: 2, judge: 2 },
                },
            }),
        );
        // The materialised measurement tree: the decision files the judge
        // wrapper imports, at the documented layout.
        for (const path of [
            "ac/run.mts",
            "ac/campaign.mts",
            "ac/evidence-guard.mts",
            "ac/judge-launcher.sh",
            "ac-scoring.mts",
            "analysis/journal.ts",
            "analysis/blinding.ts",
        ]) {
            write(
                join(
                    root,
                    "measurement/tests/fixtures/placement-harness",
                    path,
                ),
                readFileSync(join(HARNESS, path), "utf8"),
            );
        }
        chmodSync(
            join(
                root,
                "measurement/tests/fixtures/placement-harness/ac/judge-launcher.sh",
            ),
            0o755,
        );
        for (const arm of ["a", "b"]) {
            const armRoot = join(root, "arms", arm);
            write(join(armRoot, "src/index.ts"), "export default {};\n");
            write(join(armRoot, "package-lock.json"), "{}\n");
            write(
                join(
                    armRoot,
                    "tests/fixtures/placement-harness/container-run.sh",
                ),
                "#!/bin/sh\n",
            );
            write(
                join(
                    armRoot,
                    "tests/fixtures/placement-harness/prod014/cases.json",
                ),
                "[]\n",
            );
            write(
                join(root, "gen", arm, "prompts", `${CASE}.md`),
                "Fix the CSV importer.\n",
            );
            write(
                join(root, "gen", arm, "fixtures", CASE, "generation.json"),
                "{}\n",
            );
            mkdirSync(join(root, "gen", arm, "rubrics", CASE), {
                recursive: true,
            });
        }
        write(
            join(
                root,
                "arms/a/tests/fixtures/placement-harness/prod014/truth.json",
            ),
            JSON.stringify({ R01: "A durable BOM finding." }),
        );
        const stub = join(root, "trial-stub.mjs");
        writeFileSync(
            stub,
            `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const caseId = argv[1];
const stamp = argv[argv.indexOf("--stamp") + 1];
const dir = join(process.env.PLACEMENT_RESULTS, stamp, caseId);
mkdirSync(dir, { recursive: true });
const answer = "No documentation change was needed.\\n";
writeFileSync(join(dir, "final.md"), answer);
writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
        exit: 0,
        signal: null,
        timedOut: false,
        outputOverflow: false,
        answerValid: true,
        answerHash: createHash("sha256").update(answer).digest("hex"),
    }),
);
writeFileSync(join(dir, "prompt.md"), "Fix the CSV importer.\\n");
writeFileSync(join(dir, "writes.txt"), "");
writeFileSync(
    join(dir, "primary-check.json"),
    JSON.stringify({ status: "pass", exit: 0, stdout: "", stderr: "" }),
);
`,
            "utf8",
        );
        chmodSync(stub, 0o755);

        try {
            // Act: the documented run-card entry point, one pair.
            const result = spawnSync(
                process.execPath,
                [
                    join(root, "prepare/run.mts"),
                    "--pair-from",
                    "1",
                    "--pair-to",
                    "1",
                    "--trial-command",
                    stub,
                ],
                {
                    encoding: "utf8",
                    timeout: 120000,
                    env: {
                        ...process.env,
                        CAMPAIGN_ROOT: root,
                        CAMPAIGN_SOURCE_REPO: sourceDir,
                        PATH: `${bin}:${join(root, "prepare/shim")}:${process.env.PATH ?? ""}`,
                        PODMAN_BIN: join(bin, "podman"),
                        FAKE_CAPTURE_DIR: captures,
                        OPENCODE_CONFIG_CONTENT: "{}",
                        ZAI_API_KEY: "stub",
                    },
                },
            );

            // Assert: both slots completed with usable judgements.
            assert.equal(result.status, 0, result.stderr);
            const ledger = readFileSync(
                join(root, "evidence/ATTEMPTS.jsonl"),
                "utf8",
            )
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            assert.equal(
                ledger.filter((event) => event.event === "slot-complete")
                    .length,
                2,
            );
            assert.equal(
                ledger.filter((event) => event.event === "judge-launch").length,
                2,
            );

            // Assert: the host received two judged attempts...
            const received = capturesOf(captures);
            assert.equal(received.length, 2);
            for (const stamp of ["pd-A-r0-R01", "pd-B-r0-R01"]) {
                const judgement = JSON.parse(
                    readFileSync(
                        join(
                            root,
                            `gen/${stamp.startsWith("pd-A") ? "a" : "b"}/results`,
                            stamp,
                            CASE,
                            "ac/attempt-001/judgement.json",
                        ),
                        "utf8",
                    ),
                );
                assert.equal(judgement.status, "judged");
            }
            // ...and every judge-visible value stayed neutral.
            for (const view of received) assertBlind(view, canary);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
