// Registered recovery through the real campaign driver: a malformed judge
// answer is recovered once under a frozen policy, the first attempt is
// preserved, trial launches are untouched, and every ineligible case stops
// exactly as before.
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
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
    claimBudget,
    readClaims,
} from "./fixtures/placement-harness/analysis/budget.ts";

const HERE = import.meta.dirname;
const HARNESS = join(HERE, "fixtures", "placement-harness");
const MATERIALISE = join(HARNESS, "prod014", "campaign", "materialise.mts");
const OBSERVED = join(HERE, "fixtures", "judge-recovery", "observed-output.jsonl");
const CASE = "R01";

/** The prospective policy, scaled to this suite's two-slot campaign. */
const POLICY = {
    version: 1,
    eligibleFailureClasses: ["json-syntax"],
    requiresCompletionEvidence: true,
    maxRecoveriesPerSlot: 1,
    recoveryCeiling: 1,
    totalJudgeAttempts: 3,
    providerRequestLimit: null,
};

const sha256 = (body: string | Buffer): string =>
    createHash("sha256").update(body).digest("hex");

/** The malformed judge text from the observed campaign. */
function malformedText(): string {
    const line = readFileSync(OBSERVED, "utf8").trim().split("\n")[1]!;
    return (JSON.parse(line) as { part: { text: string } }).part.text;
}

/** The same response with the structurally valid closing sequence. */
function validText(): string {
    const text = malformedText();
    assert.ok(text.endsWith('"}]'));
    return `${text.slice(0, -3)}"]}`;
}

/** A complete JSONL judge trail. */
function trail(text: string, terminal = true): string {
    const events: Array<Record<string, unknown>> = [
        { type: "step_start", part: { type: "step-start" } },
        { type: "text", part: { type: "text", text } },
    ];
    if (terminal) {
        events.push({
            type: "step_finish",
            part: { type: "step-finish", reason: "stop" },
        });
    }
    return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

/**
 * A fake podman at the external boundary. It captures the container view and
 * replays one planned judge response per call, or a valid default.
 */
function fakePodman(root: string): { bin: string; captures: string; plan: string } {
    const bin = join(root, "fake-bin");
    const captures = join(root, "podman-captures");
    const plan = join(root, "response-plan");
    mkdirSync(bin, { recursive: true });
    mkdirSync(captures, { recursive: true });
    mkdirSync(plan, { recursive: true });
    const script = join(bin, "podman");
    writeFileSync(
        script,
        `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const counter = process.env.FAKE_COUNTER;
const calls = existsSync(counter) ? readFileSync(counter, "utf8").split("\\n").filter(Boolean).length : 0;
appendFileSync(counter, "call\\n");
const mount = mounts.find((entry) => entry.endsWith(":/judge:rw"));
const configPath = mount
    ? join(mount.slice(0, -":/judge:rw".length), "config-home/opencode/opencode.json")
    : null;
const dir = process.env.FAKE_CAPTURE_DIR;
mkdirSync(dir, { recursive: true });
writeFileSync(
    join(dir, String(calls + 1).padStart(4, "0") + ".json"),
    JSON.stringify({
        argv,
        workdir: after("-w"),
        env,
        mounts,
        prompt: argv.at(-1),
        config: configPath !== null && existsSync(configPath) ? readFileSync(configPath, "utf8") : null,
    }, null, 2) + "\\n",
);
const planned = join(process.env.FAKE_PLAN, String(calls + 1).padStart(4, "0") + ".json");
const response = existsSync(planned)
    ? JSON.parse(readFileSync(planned, "utf8"))
    : { body: process.env.FAKE_DEFAULT_BODY, exit: 0 };
process.stdout.write(response.body ?? "");
process.exit(response.exit ?? 0);
`,
        "utf8",
    );
    chmodSync(script, 0o755);
    return { bin, captures, plan };
}

/** Every capture written by the fake podman, in call order. */
function capturesOf(dir: string): Array<Record<string, unknown>> {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

/** Write one planned response for call `index` (one-based). */
function planResponse(
    plan: string,
    index: number,
    body: string,
    exit = 0,
): void {
    writeFileSync(
        join(plan, `${String(index).padStart(4, "0")}.json`),
        JSON.stringify({ body, exit }),
        "utf8",
    );
}

/** Write a file, creating parents. */
function write(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
}

/** A fixture git checkout independent of the campaign checkout. */
function sourceRepo(root: string): string {
    const dir = join(root, "source");
    write(join(dir, "README.md"), "source\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
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
        { cwd: dir },
    );
    return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf8",
    }).trim();
}

/** The trial stub: records one usable trial result per stamp. */
function trialStub(root: string): string {
    const stub = join(root, "trial-stub.mjs");
    write(
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
const answer = "The importer was fixed; no note was written.\\n";
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
writeFileSync(join(dir, "writes.txt"), "none\\n");
writeFileSync(
    join(dir, "primary-check.json"),
    JSON.stringify({ status: "pass", exit: 0, stdout: "", stderr: "" }),
);
`,
    );
    chmodSync(stub, 0o755);
    return stub;
}

/** One fully materialised two-slot campaign under an operator-style root. */
interface Campaign {
    root: string;
    bin: string;
    captures: string;
    plan: string;
    stub: string;
    source: string;
}

/**
 * Materialise a disposable campaign: schedule, freeze, measurement tree, arm
 * inputs and the documented run-card entry point.
 */
function campaign(options: {
    recovery?: unknown;
    manifest?: Record<string, unknown>;
    measurement?: unknown;
} = {}): Campaign {
    const root = mkdtempSync(join(tmpdir(), "pd-recovery-driver-"));
    const { bin, captures, plan } = fakePodman(root);
    execFileSync(process.execPath, [MATERIALISE, root], { encoding: "utf8" });
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
        JSON.stringify({ campaign: "pd-recovery", slots }, null, 2),
    );
    write(join(root, "evidence/ATTEMPTS.jsonl"), "");
    write(
        join(root, "evidence/measurement-spec.json"),
        `${JSON.stringify(options.measurement ?? {}, null, 2)}\n`,
    );
    write(
        join(root, "prepare/manifest.json"),
        JSON.stringify(
            options.manifest ?? {
                assessment: {
                    attemptId: "attempt-001",
                    ...(options.recovery === undefined
                        ? {}
                        : { recovery: options.recovery }),
                },
            },
        ),
    );
    const source = sourceRepo(root);
    const hash = (path: string): string =>
        createHash("sha256").update(readFileSync(path)).digest("hex");
    write(
        join(root, "evidence/FROZEN.json"),
        JSON.stringify({
            freeze: {
                schemaVersion: 2,
                campaign: "pd-recovery",
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
            join(root, "measurement/tests/fixtures/placement-harness", path),
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
            join(armRoot, "tests/fixtures/placement-harness/prod014/cases.json"),
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
        mkdirSync(join(root, "gen", arm, "rubrics", CASE), { recursive: true });
    }
    write(
        join(root, "arms/a/tests/fixtures/placement-harness/prod014/truth.json"),
        JSON.stringify({ [CASE]: "A durable BOM finding." }),
    );
    return { root, bin, captures, plan, stub: trialStub(root), source };
}

/** Run the documented driver entry point for the first pair. */
function runDriver(
    root: string,
    args: string[] = [],
): ReturnType<typeof spawnSync> {
    const bin = join(root, "fake-bin");
    const captures = join(root, "podman-captures");
    const plan = join(root, "response-plan");
    const stub = join(root, "trial-stub.mjs");
    const source = join(root, "source");
    return spawnSync(
        process.execPath,
        [
            join(root, "prepare/run.mts"),
            "--pair-from",
            "1",
            "--pair-to",
            "1",
            "--trial-command",
            stub,
            ...args,
        ],
        {
            encoding: "utf8",
            timeout: 120000,
            env: {
                ...process.env,
                CAMPAIGN_ROOT: root,
                CAMPAIGN_SOURCE_REPO: source,
                PATH: `${bin}:${join(root, "prepare/shim")}:${process.env.PATH ?? ""}`,
                PODMAN_BIN: join(bin, "podman"),
                FAKE_CAPTURE_DIR: captures,
                FAKE_COUNTER: join(root, "podman-counter"),
                FAKE_PLAN: plan,
                FAKE_DEFAULT_BODY: trail(validText()),
                OPENCODE_CONFIG_CONTENT: "{}",
                ZAI_API_KEY: "stub",
            },
        },
    );
}

/** The ledger events of one campaign. */
function ledgerOf(root: string): Array<Record<string, unknown>> {
    return readFileSync(join(root, "evidence/ATTEMPTS.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The selection record of one slot's trial. */
function selectionOf(
    root: string,
    arm: "a" | "b",
): Record<string, unknown> {
    return JSON.parse(
        readFileSync(
            join(
                root,
                `gen/${arm}/results/pd-${arm.toUpperCase()}-r0-${CASE}/${CASE}/ac/selection.json`,
            ),
            "utf8",
        ),
    ) as Record<string, unknown>;
}

/** The attempt directory of one slot. */
function attemptDir(root: string, arm: "a" | "b", attemptId: string): string {
    return join(
        root,
        `gen/${arm}/results/pd-${arm.toUpperCase()}-r0-${CASE}/${CASE}/ac`,
        attemptId,
    );
}

const ANALYSE = join(HARNESS, "analysis", "analyse.mts");
const STATUS = join(HARNESS, "prod014", "campaign", "status.mts");

/** A full analyser manifest for the two-slot recovered campaign. */
function analyserManifest(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        campaign: {
            id: "pd-recovery",
            question: "does a bounded recovery keep the accounting honest?",
        },
        arms: [
            { id: "A", label: "arm A" },
            { id: "B", label: "arm B" },
        ],
        scenarios: [{ id: CASE, kind: "create" }],
        schedule: {
            slots: [
                {
                    slot: 1,
                    pairId: "P01",
                    repetition: 0,
                    scenario: CASE,
                    arm: "A",
                    stamp: "pd-A-r0-R01",
                },
                {
                    slot: 2,
                    pairId: "P01",
                    repetition: 0,
                    scenario: CASE,
                    arm: "B",
                    stamp: "pd-B-r0-R01",
                },
            ],
        },
        evidence: {
            layout: "ac-v1",
            resultRoots: { A: "gen/a/results", B: "gen/b/results" },
            inputs: { attempts: "evidence/ATTEMPTS.jsonl" },
        },
        assessment: {
            selectionPolicy: "resolution-then-judgement",
            attemptId: "attempt-001",
            recovery: POLICY,
        },
        policy: {
            policyId: "pd-recovery-test",
            weights: {
                useful: 5,
                transient: -1,
                duplicate: -2,
                misleading: -5,
                taskFailure: -5,
            },
            guardrails: [
                {
                    id: "destructive-loss",
                    kind: "destructive-loss",
                    requirement: "no loss of still-valid facts",
                },
            ],
            selection: {
                controlArm: "A",
                candidateArm: "B",
                threshold: 0,
                requireCompleteCoverage: true,
            },
        },
    };
}

describe("recovery accounting across surfaces", () => {
    it("agrees between the analyser, status, reconciliation and reports", () => {
        // Arrange: one recovered slot and one clean slot.
        const { root, captures, plan, source } = campaign({
            manifest: analyserManifest(),
            measurement: { retrievalOpportunities: [], scenarios: {} },
        });
        planResponse(plan, 1, trail(malformedText()));
        const out = mkdtempSync(join(tmpdir(), "pd-recovery-analysis-"));

        try {
            const driver = runDriver(root);
            assert.equal(driver.status, 0, String(driver.stderr));

            // Act: the analyser reads the published selections.
            const analysed = spawnSync(
                process.execPath,
                [
                    ANALYSE,
                    "--campaign",
                    join(root, "prepare/manifest.json"),
                    "--evidence-root",
                    root,
                    "--out",
                    out,
                ],
                { encoding: "utf8", timeout: 120000 },
            );

            // Assert: the analyser agrees with the driver's selection.
            assert.equal(analysed.status, 0, String(analysed.stderr));
            const analysis = JSON.parse(
                readFileSync(join(out, "analysis.json"), "utf8"),
            ) as {
                assessmentSelection: {
                    slots: Array<{
                        stamp: string;
                        selectedAttemptId: string | null;
                        recovered: boolean;
                    }>;
                    recovered: number;
                };
            };
            const recovered = analysis.assessmentSelection.slots.find(
                (slot) => slot.stamp === "pd-A-r0-R01",
            );
            const clean = analysis.assessmentSelection.slots.find(
                (slot) => slot.stamp === "pd-B-r0-R01",
            );
            assert.equal(recovered?.selectedAttemptId, "attempt-002");
            assert.equal(recovered?.recovered, true);
            assert.equal(clean?.selectedAttemptId, "attempt-001");
            assert.equal(clean?.recovered, false);
            assert.equal(analysis.assessmentSelection.recovered, 1);

            // Assert: the receipt binds the selection records it read.
            const receipt = JSON.parse(
                readFileSync(join(out, "analysis-receipt.json"), "utf8"),
            ) as {
                inputs: Array<{
                    reference: string;
                    sha256: string | null;
                    state: string;
                }>;
            };
            const bound = receipt.inputs.filter((input) =>
                input.reference.includes("selection.json"),
            );
            assert.equal(bound.length, 2);
            assert.ok(
                bound.every(
                    (input) =>
                        input.sha256 !== null && input.state === "available",
                ),
            );

            // Assert: the Markdown report names the recovered slot.
            assert.match(
                readFileSync(join(out, "REPORT.md"), "utf8"),
                /## Assessment selection[\s\S]*pd-A-r0-R01 → attempt-002/,
            );

            // Act: closure derives the reconciliation from the same evidence.
            const closed = spawnSync(
                process.execPath,
                [join(root, "prepare/close-campaign.mts")],
                {
                    encoding: "utf8",
                    timeout: 120000,
                    env: {
                        ...process.env,
                        CAMPAIGN_ROOT: root,
                        CAMPAIGN_SOURCE_REPO: source,
                    },
                },
            );

            // Assert: recovery counts and the selection agree, and unknown
            // judge telemetry stays unknown rather than zero.
            assert.equal(closed.status, 0, String(closed.stderr));
            const reconciliation = JSON.parse(
                readFileSync(join(root, "evidence/RECONCILIATION.json"), "utf8"),
            ) as {
                judge: {
                    initialAttempts: number;
                    recoveryAttempts: number;
                    tokens: { input: number | null };
                };
                selectedAttempts: Array<{
                    slot: number;
                    selectedAttemptId: string;
                }>;
                budgets: {
                    recoveryCeiling: number | null;
                    recoveryUsed: number;
                    judgeCeiling: number;
                };
            };
            assert.equal(reconciliation.judge.initialAttempts, 2);
            assert.equal(reconciliation.judge.recoveryAttempts, 1);
            assert.deepEqual(reconciliation.selectedAttempts, [
                { slot: 1, stamp: "pd-A-r0-R01", selectedAttemptId: "attempt-002" },
                { slot: 2, stamp: "pd-B-r0-R01", selectedAttemptId: "attempt-001" },
            ]);
            assert.equal(reconciliation.budgets.recoveryCeiling, 1);
            assert.equal(reconciliation.budgets.recoveryUsed, 1);
            assert.equal(reconciliation.budgets.judgeCeiling, 3);
            assert.equal(reconciliation.judge.tokens.input, null);

            // Act: the status command observes the closed campaign.
            const status = spawnSync(
                process.execPath,
                [STATUS, "--root", root, "--detail"],
                { encoding: "utf8", timeout: 120000 },
            );
            const statusJson = spawnSync(
                process.execPath,
                [STATUS, "--root", root, "--json"],
                { encoding: "utf8", timeout: 120000 },
            );

            // Assert: text and JSON agree on recovery spend and selection.
            assert.equal(status.status, 0, String(status.stderr));
            assert.match(String(status.stdout), /recoveries: 1 of 1/);
            assert.match(String(status.stdout), /selected attempt-002/);
            const projection = JSON.parse(String(statusJson.stdout)) as {
                status: string;
                result: {
                    position: {
                        spend: {
                            recovery?: { used: number; ceiling: number };
                        };
                        slots: Array<{
                            stamp: string;
                            selectedAttemptId?: string | null;
                        }>;
                    };
                };
            };
            assert.equal(projection.status, "ok");
            assert.equal(projection.result.position.spend.recovery?.used, 1);
            assert.equal(
                projection.result.position.spend.recovery?.ceiling,
                1,
            );
            assert.equal(
                projection.result.position.slots.find(
                    (slot) => slot.stamp === "pd-A-r0-R01",
                )?.selectedAttemptId,
                "attempt-002",
            );
        } finally {
            rmSync(out, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("registered recovery through the real driver", () => {
    it("recovers a complete syntax failure once and selects attempt-002", () => {
        // Arrange: call 1 is the observed malformed capture, then valid.
        const { root, captures, plan } = campaign({ recovery: POLICY });
        planResponse(plan, 1, trail(malformedText()));

        try {
            // Act
            const result = runDriver(root);

            // Assert: the campaign completed both slots.
            assert.equal(result.status, 0, String(result.stderr));
            const ledger = ledgerOf(root);
            assert.equal(
                ledger.filter((event) => event.event === "slot-complete")
                    .length,
                2,
            );

            // Assert: exactly one recovery, and no extra trial launch.
            assert.equal(
                ledger.filter((event) => event.event === "recovery-launch")
                    .length,
                1,
            );
            assert.equal(
                ledger.filter((event) => event.event === "recovery-exit")
                    .length,
                1,
            );
            assert.equal(
                ledger.filter((event) => event.event === "launch").length,
                2,
            );
            assert.equal(
                ledger.filter((event) => event.event === "judge-launch")
                    .length,
                2,
            );

            // Assert: the first attempt is preserved, the second is usable.
            const first = JSON.parse(
                readFileSync(
                    join(attemptDir(root, "a", "attempt-001"), "judgement.json"),
                    "utf8",
                ),
            ) as Record<string, unknown>;
            const second = JSON.parse(
                readFileSync(
                    join(attemptDir(root, "a", "attempt-002"), "judgement.json"),
                    "utf8",
                ),
            ) as Record<string, unknown>;
            assert.equal(first.status, "invalid-verdict");
            assert.equal(first.failureClass, "json-syntax");
            assert.equal(second.status, "judged");
            assert.equal(
                readFileSync(
                    join(attemptDir(root, "a", "attempt-001"), "finalAnswer.txt"),
                    "utf8",
                ),
                malformedText(),
            );

            // Assert: the selection names attempt-002 with matching packets.
            const selection = selectionOf(root, "a");
            assert.equal(selection.selectedAttemptId, "attempt-002");
            const attempts = selection.attempts as Array<
                Record<string, unknown>
            >;
            assert.equal(attempts.length, 2);
            assert.equal(attempts[0]?.packetSha256, attempts[1]?.packetSha256);
            assert.equal(selectionOf(root, "b").selectedAttemptId, "attempt-001");

            // Assert: the blind packet is identical for both assessments and
            // the judge config carries the model and a deny-all permission.
            const [firstCall, secondCall, thirdCall] = capturesOf(captures);
            assert.equal(
                firstCall?.prompt,
                secondCall?.prompt,
                "the recovery was not the same blind packet",
            );
            assert.equal((thirdCall?.prompt as string).length > 0, true);
            for (const call of [firstCall, secondCall]) {
                const config = JSON.parse(String(call?.config)) as Record<
                    string,
                    unknown
                >;
                assert.equal(config.model, "zai-coding-plan/glm-5.3-flash");
                assert.deepEqual(config.permissions, [
                    { action: "*", resource: "*", effect: "deny" },
                ]);
                const env = call?.env as Record<string, string>;
                assert.equal(call?.workdir, "/judge/work");
                assert.equal(env.PWD, "/judge/work");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("stops after a second unusable assessment and never sends a third", () => {
        // Arrange
        const { root, captures, plan } = campaign({ recovery: POLICY });
        planResponse(plan, 1, trail(malformedText()));
        planResponse(plan, 2, trail(malformedText()));

        try {
            // Act
            const result = runDriver(root);

            // Assert: the campaign paused at the failed slot.
            assert.equal(result.status, 2);
            assert.equal(capturesOf(captures).length, 2);
            assert.match(
                String(result.stderr),
                /recovery judgement is invalid-verdict/,
            );
            assert.deepEqual(
                readdirSync(join(root, "gen/a/results/pd-A-r0-R01/R01/ac")).filter(
                    (name) => name.startsWith("attempt-"),
                ),
                ["attempt-001", "attempt-002"],
            );
            const blocked = ledgerOf(root).find(
                (event) => event.event === "slot-blocked",
            );
            assert.match(
                String(blocked?.reason),
                /second unusable assessment/,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps the historical stop when no policy is registered", () => {
        // Arrange: no recovery declaration.
        const { root, captures, plan } = campaign();
        planResponse(plan, 1, trail(malformedText()));

        try {
            // Act
            const result = runDriver(root);

            // Assert: one judge call, no recovery, the frozen stop.
            assert.equal(result.status, 2);
            assert.equal(capturesOf(captures).length, 1);
            assert.equal(
                existsSync(attemptDir(root, "a", "attempt-002")),
                false,
            );
            assert.equal(readClaims(join(root, "evidence"), "recovery").length, 0);
            assert.match(String(result.stderr), /no usable attempt-001 judgement/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("dispatches nothing when the recovery budget is already spent", () => {
        // Arrange: the single recovery slot is claimed before the run.
        const { root, captures, plan } = campaign({ recovery: POLICY });
        claimBudget(join(root, "evidence"), "recovery", 1, {
            stamp: "pd-A-r0-R01",
            attemptId: "attempt-002",
            key: "earlier-recovery",
        });
        planResponse(plan, 1, trail(malformedText()));

        try {
            // Act
            const result = runDriver(root);

            // Assert
            assert.equal(result.status, 2);
            assert.equal(capturesOf(captures).length, 1);
            assert.equal(
                existsSync(attemptDir(root, "a", "attempt-002")),
                false,
            );
            assert.match(String(result.stderr), /recovery ceiling reached/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not treat an incomplete capture as a syntax failure", () => {
        // Arrange: the trail never terminates on a step finish.
        const { root, captures, plan } = campaign({ recovery: POLICY });
        planResponse(plan, 1, trail(malformedText(), false));

        try {
            // Act
            const result = runDriver(root);

            // Assert
            assert.equal(result.status, 2);
            assert.equal(capturesOf(captures).length, 1);
            assert.equal(
                existsSync(attemptDir(root, "a", "attempt-002")),
                false,
            );
            assert.match(
                String(result.stderr),
                /(completion of the final assessed response cannot be established|empty-or-truncated.*not eligible)/,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a closed campaign before any dispatch", () => {
        // Arrange
        const { root, captures, plan } = campaign({ recovery: POLICY });
        write(
            join(root, "evidence/ATTEMPTS.jsonl"),
            `${JSON.stringify({
                at: "2026-11-14T00:00:00.000Z",
                event: "campaign-closed",
                stoppedAt: "pd-A-r0-R01",
                scope: 1,
                reason: "closed",
            })}\n`,
        );

        try {
            // Act
            const result = runDriver(root);

            // Assert: no container call, no trial, no recovery.
            assert.equal(result.status, 2);
            assert.equal(capturesOf(captures).length, 0);
            assert.match(String(result.stderr), /campaign is closed/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not re-dispatch a completed campaign on a repeated run", () => {
        // Arrange: one recovery, then the same command again.
        const { root, captures, plan } = campaign({ recovery: POLICY });
        planResponse(plan, 1, trail(malformedText()));

        try {
            const first = runDriver(root);
            assert.equal(first.status, 0, String(first.stderr));
            const callsAfterFirst = capturesOf(captures).length;
            const selectionAfterFirst = selectionOf(root, "a");

            // Act
            const second = runDriver(root);

            // Assert: no new judge call and the same selection.
            assert.equal(second.status, 0, String(second.stderr));
            assert.equal(capturesOf(captures).length, callsAfterFirst);
            assert.deepEqual(selectionOf(root, "a"), selectionAfterFirst);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
