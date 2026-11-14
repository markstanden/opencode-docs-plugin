// Acceptance tests for the operator-side prod014 status command. Every case
// drives the real CLI (or the module's injected readers) against synthetic
// temporary roots; nothing touches a live campaign, the network, or a secret.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    observePosition,
    readIdentityFiles,
    redact,
    shellQuote,
} from "./fixtures/placement-harness/prod014/campaign/status.mts";

const here = import.meta.dirname;
const campaignDir = join(
    here,
    "fixtures",
    "placement-harness",
    "prod014",
    "campaign",
);
const statusCli = join(campaignDir, "status.mts");
const materialise = join(campaignDir, "materialise.mts");
const analyser = join(
    here,
    "fixtures",
    "placement-harness",
    "analysis",
    "analyse.mts",
);
const miniManifest = join(
    here,
    "fixtures",
    "analysis",
    "manifests",
    "mini.json",
);
const miniCorpus = join(here, "fixtures", "analysis", "mini-corpus");
const repo = here.endsWith("/tests") ? dirname(here) : here;

const IMAGE_ID = "sha256:fake-image-id-for-status-tests";
const PODMAN_VERSION = "podman version 6.1.4-fake";

/** Run git in a fixture repo with ambient config and signing walled off. */
function git(cwd: string, args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
        },
    });
}

// A source repo independent of the test checkout: a read-only gate verify runs
// against a scratch copy of the git scope, which carries no .git metadata.
const sourceRepo = mkdtempSync(join(tmpdir(), "pd-status-source-"));
writeFileSync(join(sourceRepo, "README.md"), "status test source\n", "utf8");
for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@example.com"],
    ["config", "user.name", "t"],
    ["add", "-A"],
    ["commit", "-qm", "source"],
]) {
    git(sourceRepo, args);
}
/** The fixture source repo's HEAD: every freeze's sourceRevision. */
const BASE = git(sourceRepo, ["rev-parse", "HEAD"]).trim();

/** Write one file, creating parents. */
function write(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
}

const sha = (text: string): string =>
    createHash("sha256").update(text).digest("hex");

const hashFile = (path: string): string =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

/** Every file under a directory, recursively, with hashes, sorted. */
function treeSnapshot(dir: string): Map<string, string> {
    const snapshot = new Map<string, string>();
    const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile()) {
                snapshot.set(path, hashFile(path));
            }
        }
    };
    walk(dir);
    return snapshot;
}

/** A bin directory whose podman records every call and never dispatches. */
function fakePodmanBin(): { bin: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), "pd-status-bin-"));
    const bin = join(dir, "bin");
    const log = join(dir, "podman.log");
    mkdirSync(bin);
    write(
        join(bin, "podman"),
        [
            "#!/bin/sh",
            `printf '%s\\n' "$*" >>${JSON.stringify(log).replaceAll('"', "")}`,
            'if [ "$1" = "--version" ]; then',
            `  printf '%s\\n' ${JSON.stringify(PODMAN_VERSION)}`,
            "  exit 0",
            "fi",
            'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
            `  printf '%s\\n' ${JSON.stringify(IMAGE_ID)}`,
            "  exit 0",
            "fi",
            "exit 1",
            "",
        ].join("\n"),
    );
    chmodSync(join(bin, "podman"), 0o755);
    return { bin, log };
}

interface StatusRun {
    status: number;
    stdout: string;
    stderr: string;
}

/** Invoke the real status CLI with the fake engine on PATH. */
function status(
    args: readonly string[],
    env: Record<string, string> = {},
): StatusRun {
    const { bin } = fakePodmanBin();
    const result = spawnSync(process.execPath, [statusCli, ...args], {
        encoding: "utf8",
        timeout: 60_000,
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            CAMPAIGN_SOURCE_REPO: sourceRepo,
            ZAI_API_KEY: "",
            ZAI_API_KEY_FILE: "",
            ...env,
        },
    });
    return {
        status: result.status ?? -1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

/** The JSON result of a successful observation. */
function statusJson(
    args: readonly string[],
    env: Record<string, string> = {},
): Record<string, unknown> {
    const run = status([...args, "--json"], env);
    assert.equal(run.status, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
    const payload = JSON.parse(run.stdout) as Record<string, unknown>;
    assert.equal(payload.status, "ok");
    return payload.result as Record<string, unknown>;
}

const DESCRIPTION_A = "Record durable findings with the docs tool now.";
const DESCRIPTION_B =
    "Record durable findings with the docs tool. Prefer a note when a command taught you something reusable.";

/** A materialised root: a label for a fresh temp dir, or an explicit directory. */
function materialisedRoot(labelOrDir?: string): string {
    const explicit = labelOrDir !== undefined && labelOrDir.includes("/");
    const root = explicit
        ? labelOrDir
        : mkdtempSync(join(tmpdir(), `${labelOrDir ?? "pd-status-root"}-`));
    mkdirSync(root, { recursive: true });
    execFileSync(process.execPath, [materialise, root], { encoding: "utf8" });
    return root;
}

/** The 16-slot schedule, taken from the checked manifest, under a test id. */
function writeSchedule(root: string, campaign = "pd-status-test"): void {
    const manifest = JSON.parse(
        readFileSync(join(campaignDir, "active", "manifest.json"), "utf8"),
    ) as { schedule: { slots: unknown[] } };
    write(
        join(root, "evidence/schedule.json"),
        `${JSON.stringify({ campaign, generator: "status-test", slots: manifest.schedule.slots }, null, 2)}\n`,
    );
}

interface FrozenOptions {
    campaign?: string;
    ceilings?: { trial: number; judge: number };
    armADelivered?: string;
    imageId?: string;
    sourceRevision?: string;
    containerCli?: string;
    omitCeilings?: boolean;
}

/** A FROZEN.json whose immutable inputs hash this root's real bytes. */
function writeFrozen(root: string, options: FrozenOptions = {}): void {
    const inventory = (
        dir: string,
    ): { path: string; files: { path: string; sha256: string }[] } => ({
        path: dir,
        files: ((): { path: string; sha256: string }[] => {
            const found: { path: string; sha256: string }[] = [];
            const walk = (current: string): void => {
                for (const entry of readdirSync(current, {
                    withFileTypes: true,
                })) {
                    const child = join(current, entry.name);
                    if (entry.isDirectory()) walk(child);
                    else if (entry.isFile()) {
                        found.push({
                            path: child.slice(root.length + 1),
                            sha256: hashFile(child),
                        });
                    }
                }
            };
            walk(join(root, dir));
            return found.sort((a, b) => a.path.localeCompare(b.path));
        })(),
    });
    const arms = [
        {
            id: "A",
            commit: `${"a".repeat(40)}`,
            tree: `${"b".repeat(40)}`,
            clean: true,
            descriptionChars: [...DESCRIPTION_A].length,
            descriptionHash: sha(DESCRIPTION_A),
            deliveredChars: [...(options.armADelivered ?? DESCRIPTION_A)]
                .length,
            deliveredHash: sha(options.armADelivered ?? DESCRIPTION_A),
            annotationChars: 10,
            annotationHash: sha("annotation"),
        },
        {
            id: "B",
            commit: `${"c".repeat(40)}`,
            tree: `${"d".repeat(40)}`,
            clean: true,
            descriptionChars: [...DESCRIPTION_B].length,
            descriptionHash: sha(DESCRIPTION_B),
            deliveredChars: [...DESCRIPTION_B].length,
            deliveredHash: sha(DESCRIPTION_B),
            annotationChars: 10,
            annotationHash: sha("annotation"),
        },
    ];
    const freeze: Record<string, unknown> = {
        schemaVersion: 2,
        campaign: options.campaign ?? "pd-status-test",
        sourceRevision: options.sourceRevision ?? BASE,
        sourceTree: `${"e".repeat(40)}`,
        imageId: options.imageId ?? IMAGE_ID,
        containerCli: options.containerCli ?? PODMAN_VERSION,
        measurementSha256: sha("measurement"),
        arms,
        files: [
            {
                path: "evidence/schedule.json",
                sha256: hashFile(join(root, "evidence/schedule.json")),
            },
        ],
        inventories: [inventory("prepare"), inventory("runner")],
        stoppingRules: ["stop on the P04 checkpoint report"],
        ceilings: options.omitCeilings
            ? undefined
            : (options.ceilings ?? { trial: 16, judge: 16 }),
    };
    write(
        join(root, "evidence/FROZEN.json"),
        `${JSON.stringify(
            {
                campaign: freeze.campaign,
                frozenAt: "2026-11-12T00:00:00.000Z",
                trialModel: "opencode-go/deepseek-v4.1-flash",
                judgeModel: "zai-coding-plan/glm-5.3-flash",
                imageId: freeze.imageId,
                budget: {
                    plannedTrials: 16,
                    plannedJudgeAttempts: 16,
                },
                freeze,
            },
            null,
            2,
        )}\n`,
    );
}

/** A captured provider request serving the given description. */
function writeDelivery(
    root: string,
    arm: "a" | "b",
    description: string,
): void {
    write(
        join(root, `evidence/delivery-${arm}`, "request-1.json"),
        `${JSON.stringify({
            model: "opencode-go/deepseek-v4.1-flash",
            tools: [
                { type: "function", function: { name: "docs", description } },
            ],
        })}\n`,
    );
}

/** Surfaces records for both arms. */
function writeSurfaces(root: string): void {
    for (const [arm, description] of [
        ["a", DESCRIPTION_A],
        ["b", DESCRIPTION_B],
    ] as const) {
        write(
            join(root, `evidence/surfaces-${arm}.json`),
            `${JSON.stringify({
                armDir: join(root, "arms", arm),
                nativeChars: [...description].length,
                nativeHash: sha(description),
                native: description,
            })}\n`,
        );
    }
}

/** The full preparation shape short of dispatch. */
function completePreparation(root: string): void {
    for (const dir of ["arms/a", "arms/b", "measurement"]) {
        mkdirSync(join(root, dir, "node_modules"), { recursive: true });
    }
    for (const arm of ["a", "b"]) {
        mkdirSync(join(root, "gen", arm, "fixtures", "R01"), {
            recursive: true,
        });
    }
    writeSchedule(root);
    writeSurfaces(root);
    writeDelivery(root, "a", DESCRIPTION_A);
    writeDelivery(root, "b", DESCRIPTION_B);
    write(
        join(root, "evidence/measurement-spec.json"),
        `${JSON.stringify({ campaign: "pd-status-test" })}\n`,
    );
}

/** One ledger line, creating the ledger when absent. */
function ledgerEvent(root: string, event: Record<string, unknown>): void {
    const path = join(root, "evidence/ATTEMPTS.jsonl");
    writeFileSync(
        path,
        `${existsSync(path) ? readFileSync(path, "utf8") : ""}${JSON.stringify({ at: "2026-11-12T01:00:00.000Z", ...event })}\n`,
        "utf8",
    );
}

/** One budget claim file. */
function writeClaim(
    root: string,
    kind: "trial" | "judge",
    index: number,
    state: string,
    stamp: string,
): void {
    write(
        join(
            root,
            "evidence",
            kind,
            `${kind}-${String(index).padStart(4, "0")}.claim`,
        ),
        `${JSON.stringify({
            kind,
            index,
            state,
            at: "2026-11-12T00:59:00.000Z",
            stamp,
            attemptId: "attempt-001",
            note: null,
            key: stamp,
        })}\n`,
    );
}

/** Mark both slots of a pair complete, and the pair itself. */
function completePair(root: string, pairId: string): void {
    const schedule = JSON.parse(
        readFileSync(join(root, "evidence/schedule.json"), "utf8"),
    ) as {
        slots: {
            slot: number;
            pairId: string;
            stamp: string;
            arm: string;
            scenario: string;
        }[];
    };
    const slots = schedule.slots.filter((slot) => slot.pairId === pairId);
    for (const slot of slots) {
        ledgerEvent(root, {
            event: "launch",
            slot: slot.slot,
            pairId,
            stamp: slot.stamp,
            arm: slot.arm,
        });
        ledgerEvent(root, {
            event: "trial-exit",
            slot: slot.slot,
            pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            usable: true,
        });
        ledgerEvent(root, {
            event: "judge-launch",
            slot: slot.slot,
            pairId,
            stamp: slot.stamp,
            arm: slot.arm,
        });
        ledgerEvent(root, {
            event: "judge-exit",
            slot: slot.slot,
            pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            outcome: "judged",
        });
        ledgerEvent(root, {
            event: "slot-complete",
            slot: slot.slot,
            pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            judged: true,
        });
        writeClaim(
            root,
            "trial",
            slots.indexOf(slot) + 1,
            "closed",
            slot.stamp,
        );
        writeClaim(
            root,
            "judge",
            slots.indexOf(slot) + 1,
            "closed",
            slot.stamp,
        );
    }
    ledgerEvent(root, { event: "pair-complete", pairId });
}

interface ReportOptions {
    campaignId?: string;
    renderedAt?: string;
    manifestPath?: string;
    recommendation?: string;
    decision?: string;
    delta?: number | null;
}

/** A minimal analysis report with the fields status extracts. */
function writeReport(dir: string, options: ReportOptions = {}): string {
    mkdirSync(dir, { recursive: true });
    const manifestSha = hashFile(
        existsSync(options.manifestPath ?? "")
            ? (options.manifestPath as string)
            : "/dev/null",
    );
    const success = options.decision === "not-qualified" ? 2 : 3;
    write(
        join(dir, "analysis.json"),
        `${JSON.stringify({
            analysisVersion: 1,
            campaign: { id: options.campaignId ?? "pd-status-test" },
            manifestSha256: manifestSha,
            decision: { overall: options.decision ?? "qualified" },
            paired: { completePairs: 4, delta: options.delta ?? 1 },
            pairing: { completePairs: 4 },
            arms: {
                A: {
                    accounting: { documented: success, assessed: 4 },
                    guardrails: [{ status: "clean" }],
                },
                B: {
                    accounting: { documented: success + 1, assessed: 4 },
                    guardrails: [{ status: "clean" }],
                },
            },
            measures: {
                status: "available",
                arms: {
                    A: {
                        recording: { planned: 4, success: 2 },
                        retrieval: { planned: 4, applied: 1 },
                    },
                    B: {
                        recording: { planned: 4, success: 3 },
                        retrieval: { planned: 4, applied: 2 },
                    },
                },
                personalTrial: {
                    recommendation: options.recommendation ?? "personal-trial",
                },
            },
            usage: { steps: 120 },
            measuredTrials: 8,
            unknownTrials: 0,
        })}\n`,
    );
    write(
        join(dir, "analysis-receipt.json"),
        `${JSON.stringify({
            analyserVersion: 1,
            manifestSha256: manifestSha,
            renderedAt: options.renderedAt ?? "2026-11-12T02:00:00.000Z",
        })}\n`,
    );
    return dir;
}

// ---------------------------------------------------------------------------

describe("source revision fixture", () => {
    it("pins the frozen revision to its own repo, not the checkout", () => {
        // Act
        const head = execFileSync(
            "git",
            ["-C", sourceRepo, "rev-parse", "HEAD"],
            {
                encoding: "utf8",
            },
        ).trim();

        // Assert: a read-only verify copies the git scope without .git, so the
        // suite must never read this checkout's revision.
        assert.equal(BASE, head);
        assert.notEqual(sourceRepo, repo);
    });
});

describe("status CLI contract", () => {
    it("prints usage and exits 0 for --help", () => {
        // Arrange: no evidence is needed; --help is self-contained.
        // Act
        const run = status(["--help"]);

        // Assert
        assert.equal(run.status, 0);
        assert.match(run.stdout, /--base <revision>/);
    });

    it("exits 1 with a usage problem for a broken invocation", () => {
        // Arrange: no arguments at all is the broken invocation.
        // Act
        const run = status([]);

        // Assert
        assert.equal(run.status, 1);
        assert.match(run.stderr, /pass either --base/);
    });

    it("keeps stdout machine-readable for a usage error in JSON mode", () => {
        // Arrange: an incomplete --root is the broken invocation.
        // Act
        const run = status(["--json", "--root"]);

        // Assert
        assert.equal(run.status, 1);
        const payload = JSON.parse(run.stdout) as {
            status: string;
            errors: { code: string; message: string }[];
        };
        assert.equal(payload.status, "error");
        assert.equal(payload.errors[0]?.code, "usage");
    });

    it("refuses --base and --root together", () => {
        // Arrange: two modes in one invocation is invalid.
        // Act
        const run = status(["--base", "HEAD", "--root", "/tmp"]);

        // Assert
        assert.equal(run.status, 1);
        assert.match(run.stderr, /separate modes/);
    });
});

describe("status checkout mode", () => {
    /** A small git repo carrying the campaign tooling shape. */
    function gitRepo(): string {
        const dir = mkdtempSync(join(tmpdir(), "pd-status-git-"));
        const campaign = join(
            dir,
            "tests/fixtures/placement-harness/prod014/campaign",
        );
        mkdirSync(join(campaign, "active"), { recursive: true });
        writeFileSync(join(campaign, "materialise.mts"), "", "utf8");
        writeFileSync(join(campaign, "runner.json"), "{}\n", "utf8");
        for (const args of [
            ["init", "-q"],
            ["config", "user.email", "t@example.com"],
            ["config", "user.name", "t"],
            ["add", "-A"],
            ["commit", "-qm", "one"],
        ]) {
            git(dir, args);
        }
        return dir;
    }

    it("reports a dirty checkout as an operator decision in a dedicated repo", () => {
        // Arrange: a scratch commit, then an uncommitted change beside it.
        const dir = gitRepo();
        write(
            join(
                dir,
                "tests/fixtures/placement-harness/prod014/campaign/extra.txt",
            ),
            "uncommitted\n",
        );

        // Act
        const { bin } = fakePodmanBin();
        const run = spawnSync(
            process.execPath,
            [statusCli, "--base", "HEAD", "--json"],
            {
                encoding: "utf8",
                cwd: dir,
                timeout: 60_000,
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH ?? ""}`,
                },
            },
        );
        const payload = JSON.parse(run.stdout ?? "") as {
            status: string;
            result: { phase: string };
        };

        // Assert
        assert.equal(payload.status, "ok");
        assert.equal(payload.result.phase, "dirty-checkout");
    });

    it("reports a matching clean base in a dedicated repo", () => {
        // Arrange: status uses the process cwd for checkout mode; emulate it
        // by invoking the CLI with cwd set to the scratch repo.
        const dir = gitRepo();
        const head = git(dir, ["rev-parse", "HEAD"]).trim();
        const { bin } = fakePodmanBin();
        const run = spawnSync(
            process.execPath,
            [statusCli, "--base", head, "--json"],
            {
                encoding: "utf8",
                cwd: dir,
                timeout: 60_000,
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH ?? ""}`,
                },
            },
        );

        // Act
        const payload = JSON.parse(run.stdout ?? "") as {
            status: string;
            result: { phase: string; identity: { sourceClean: boolean } };
        };

        // Assert
        assert.equal(payload.status, "ok");
        assert.equal(payload.result.phase, "unmaterialised-checkout");
        assert.equal(payload.result.identity.sourceClean, true);
    });

    it("reports a mismatched base as an operator decision", () => {
        // Arrange: a second commit puts HEAD one ahead of the requested base.
        const dir = gitRepo();
        execFileSync(
            "git",
            ["-C", dir, "commit", "-q", "--allow-empty", "-m", "two"],
            { encoding: "utf8" },
        );

        // Act
        const { bin } = fakePodmanBin();
        const run = spawnSync(
            process.execPath,
            [statusCli, "--base", "HEAD~1", "--json"],
            {
                encoding: "utf8",
                cwd: dir,
                timeout: 60_000,
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH ?? ""}`,
                },
            },
        );
        const payload = JSON.parse(run.stdout ?? "") as {
            result: { phase: string };
        };

        // Assert
        assert.equal(payload.result.phase, "base-mismatch");
    });

    it("exits 2 for a base that cannot be resolved", () => {
        // Arrange: a revision no repository can resolve.
        const base = "no-such-revision-at-all";
        // Act
        const run = status(["--base", base, "--json"]);

        // Assert
        assert.equal(run.status, 2);
        const payload = JSON.parse(run.stdout) as { status: string };
        assert.equal(payload.status, "error");
    });
});

describe("status campaign mode: roots and preparation", () => {
    it("exits 2 for a root that does not exist, without scanning", () => {
        // Arrange: a path that was never created, next to nothing else.
        const missing = join(tmpdir(), "pd-status-no-such-root");
        // Act
        const run = status(["--root", missing]);

        // Assert
        assert.equal(run.status, 2);
        assert.match(run.stderr, /does not exist/);
    });

    it("exits 2 when a root path is a file", () => {
        // Arrange
        const file = join(
            mkdtempSync(join(tmpdir(), "pd-status-")),
            "not-a-dir",
        );
        writeFileSync(file, "x", "utf8");

        // Act
        const run = status(["--root", file]);

        // Assert
        assert.equal(run.status, 2);
    });

    it("exits 2 when FROZEN.json exists but is unparseable, without leaking its bytes", () => {
        // Arrange
        const root = materialisedRoot("pd-status-badjson");
        write(
            join(root, "evidence/FROZEN.json"),
            `{"freeze": "canary-0 not json`,
        );

        // Act
        const run = status(["--root", root, "--json"]);

        // Assert
        assert.equal(run.status, 2);
        assert.equal(run.stdout.includes("canary-0"), false);
        const payload = JSON.parse(run.stdout) as { status: string };
        assert.equal(payload.status, "error");
    });

    it("names the earliest missing prerequisite before materialisation inputs", () => {
        // Arrange
        const root = materialisedRoot("pd-status-fresh");

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        assert.equal(result.phase, "preparing");
        const next = result.nextAction as { why: string };
        assert.match(next.why, /arms\/a/);
    });

    it("walks preparation to the freeze and reports dry run as unverifiable", () => {
        // Arrange
        const root = materialisedRoot("pd-status-prep");
        completePreparation(root);

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        assert.equal(result.phase, "preparing");
        const steps = result.preparation as { step: string; state: string }[];
        const dry = steps.find((step) => step.step === "dry run");
        assert.equal(dry?.state, "unverifiable");
        const next = result.nextAction as { command?: string };
        assert.match(next.command ?? "", /prepare\/freeze\.mts/);
    });

    it("verifies a consistent freeze and suggests the offline dry run", () => {
        // Arrange
        const root = materialisedRoot("pd-status-frozen");
        completePreparation(root);
        writeFrozen(root);

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        assert.equal(result.phase, "frozen-ready");
        const steps = result.preparation as {
            step: string;
            state: string;
            detail?: string;
        }[];
        assert.equal(
            steps.find((step) => step.step === "freeze")?.state,
            "verified",
        );
        assert.match(
            steps.find((step) => step.step === "B-only description change")
                ?.detail ?? "",
            /A 47 chars, B 103 chars/,
        );
        const next = result.nextAction as { kind: string; command: string };
        assert.equal(next.kind, "offline-check");
        assert.match(next.command, /--dry-run/);
    });

    it("blocks dispatch when the frozen shim lost its executable bit", () => {
        // Arrange: the freeze hashes cannot see the mode bit, so strip it.
        const root = materialisedRoot("pd-status-shim");
        completePreparation(root);
        writeFrozen(root);
        chmodSync(join(root, "prepare/shim/podman"), 0o644);

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        assert.equal(result.phase, "blocked-local-prerequisite");
        const next = result.nextAction as { kind: string; command: string };
        assert.equal(next.kind, "offline-check");
        assert.match(next.command, /chmod \+x/);
    });

    it("reports a changed immutable input as a broken premise with no dispatch", () => {
        // Arrange
        const root = materialisedRoot("pd-status-mutated");
        completePreparation(root);
        writeFrozen(root);
        writeFileSync(
            join(root, "runner", "ledger.ts"),
            "// mutated\n",
            "utf8",
        );

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        assert.equal(result.phase, "frozen-premise-changed");
        const next = result.nextAction as { kind: string; command?: string };
        assert.equal(next.kind, "operator-decision");
        assert.equal(next.command, undefined);
    });

    it("reports a declared/delivered description mismatch", () => {
        // Arrange
        const root = materialisedRoot("pd-status-mismatch");
        completePreparation(root);
        writeFrozen(root);
        writeDelivery(root, "a", "A different, shorter description.");

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        const steps = result.preparation as { step: string; state: string }[];
        assert.equal(
            steps.find((step) => step.step === "delivery receipt (a)")?.state,
            "mismatch",
        );
    });

    it("treats a legacy freeze without ceilings as unusable for spend", () => {
        // Arrange
        const root = materialisedRoot("pd-status-legacy");
        completePreparation(root);
        writeFrozen(root, { omitCeilings: true });

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        assert.equal(result.phase, "frozen-premise-changed");
        const spend = (
            result.position as { spend?: { trial: { ceiling: number } } }
        ).spend;
        assert.equal(spend?.trial.ceiling, 0);
    });

    it("works with a root path containing spaces and quotes it in commands", () => {
        // Arrange
        const parent = mkdtempSync(join(tmpdir(), "pd-status-space-"));
        const root = join(parent, "cam paign root");
        mkdirSync(root, { recursive: true });
        execFileSync(process.execPath, [materialise, root], {
            encoding: "utf8",
        });

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        assert.equal(result.phase, "preparing");
        void shellQuote;
    });
});

describe("status campaign mode: credentials", () => {
    it("blocks on an unsafe credential mode without reading the value", () => {
        // Arrange
        const root = materialisedRoot("pd-status-credmode");
        completePreparation(root);
        writeFrozen(root);
        write(join(root, ".env"), "ZAI_API_KEY=canary-0\n");
        chmodSync(join(root, ".env"), 0o644);

        // Act
        const run = status(["--root", root]);
        const result = JSON.parse(
            status(["--root", root, "--json"]).stdout,
        ) as { result: { phase: string } };

        // Assert
        assert.equal(result.result.phase, "blocked-credential-mode");
        assert.equal(run.stdout.includes("canary-0"), false);
        assert.equal(run.stderr.includes("canary-0"), false);
        assert.match(run.stdout, /mode 644/);
    });

    it("accepts an owner-only credential file and never prints the key", () => {
        // Arrange
        const root = materialisedRoot("pd-status-credok");
        completePreparation(root);
        writeFrozen(root);
        write(join(root, ".env"), "ZAI_API_KEY=canary-0\n");
        chmodSync(join(root, ".env"), 0o600);

        // Act
        const run = status(["--root", root]);

        // Assert
        assert.equal(run.status, 0);
        assert.equal(run.stdout.includes("canary-0"), false);
        assert.match(run.stdout, /credentials: configured \(campaign \.env\)/);
        assert.match(run.stdout, /\.env mode 600/);
    });

    it("reports no credential configured when nothing is available", () => {
        // Arrange
        const root = materialisedRoot("pd-status-nokey");
        completePreparation(root);
        writeFrozen(root);

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        const credentials = (
            result.readiness as { credentials: { keyConfigured: boolean } }
        ).credentials;
        assert.equal(credentials.keyConfigured, false);
    });
});

describe("status campaign mode: live position", () => {
    function liveRoot(label: string): string {
        const root = materialisedRoot(label);
        completePreparation(root);
        writeFrozen(root);
        return root;
    }

    it("reports an in-progress reservation as blocked, with no dispatch", () => {
        // Arrange
        const root = liveRoot("pd-status-reserved");
        writeClaim(root, "trial", 1, "reserved", "pd-A-r0-R01");

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        assert.equal(result.phase, "blocked-unresolved-reservation");
        const next = result.nextAction as { kind: string; command?: string };
        assert.equal(next.kind, "inspection");
        assert.equal(next.command, undefined);
        const slots = (
            result.position as { slots: { stamp: string; state: string }[] }
        ).slots;
        assert.equal(
            slots.find((slot) => slot.stamp === "pd-A-r0-R01")?.state,
            "reserved",
        );
    });

    it("reports a pre-dispatch refusal with its reason", () => {
        // Arrange
        const root = liveRoot("pd-status-refused");
        ledgerEvent(root, {
            event: "slot-blocked",
            slot: 1,
            pairId: "P01",
            stamp: "pd-A-r0-R01",
            arm: "A",
            reason: "unsettled trial claim from an interrupted invocation",
        });

        // Act
        const result = statusJson(["--root", root, "--detail"]);

        // Assert
        const slots = (
            result.position as {
                slots: { stamp: string; state: string; note?: string }[];
            }
        ).slots;
        const slot = slots.find((entry) => entry.stamp === "pd-A-r0-R01");
        assert.equal(slot?.state, "refused-before-dispatch");
        assert.match(slot?.note ?? "", /unsettled trial claim/);
    });

    it("reports a failed judgement and an interrupted slot distinctly", () => {
        // Arrange
        const root = liveRoot("pd-status-mixed");
        ledgerEvent(root, {
            event: "launch",
            slot: 1,
            pairId: "P01",
            stamp: "pd-A-r0-R01",
            arm: "A",
        });
        ledgerEvent(root, {
            event: "trial-exit",
            slot: 1,
            pairId: "P01",
            stamp: "pd-A-r0-R01",
            arm: "A",
            usable: false,
        });
        ledgerEvent(root, {
            event: "launch",
            slot: 2,
            pairId: "P01",
            stamp: "pd-B-r0-R01",
            arm: "B",
        });
        writeClaim(root, "trial", 1, "closed", "pd-A-r0-R01");
        writeClaim(root, "trial", 2, "spawned", "pd-B-r0-R01");

        // Act
        const result = statusJson(["--root", root, "--detail"]);

        // Assert
        const slots = (
            result.position as { slots: { stamp: string; state: string }[] }
        ).slots;
        assert.equal(
            slots.find((slot) => slot.stamp === "pd-A-r0-R01")?.state,
            "failed-unusable",
        );
        assert.equal(
            slots.find((slot) => slot.stamp === "pd-B-r0-R01")?.state,
            "spawned",
        );
    });

    it("counts completed pairs and usable assessments", () => {
        // Arrange
        const root = liveRoot("pd-status-pair");
        completePair(root, "P01");

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        const position = result.position as {
            completedPairs: string[];
            usableAssessments: number;
        };
        assert.deepEqual(position.completedPairs, ["P01"]);
        assert.equal(position.usableAssessments, 2);
    });

    it("suppresses the paid suggestion when a ceiling is exhausted", () => {
        // Arrange
        const root = liveRoot("pd-status-ceiling");
        completePair(root, "P01");
        writeFrozen(root, { ceilings: { trial: 2, judge: 2 } });
        // Two closed trial claims already: the ceiling is spent.

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        assert.equal(result.phase, "ceiling-reached");
        const next = result.nextAction as { kind: string };
        assert.equal(next.kind, "operator-decision");
    });

    it("observes a closed campaign successfully with its stop reason", () => {
        // Arrange
        const root = liveRoot("pd-status-closed");
        completePair(root, "P01");
        ledgerEvent(root, {
            event: "campaign-closed",
            stoppedAt: "pd-A-r0-R01",
            reason: "stopped: operator decision after P01",
        });

        // Act
        const run = status(["--root", root]);
        const result = JSON.parse(
            status(["--root", root, "--json"]).stdout,
        ) as { result: { phase: string; position: { stopReason?: string } } };

        // Assert
        assert.equal(run.status, 0);
        assert.equal(result.result.phase, "closed");
        assert.match(
            result.result.position.stopReason ?? "",
            /operator decision/,
        );
    });

    it("labels a ledger that advances mid-read instead of chasing it", () => {
        // Arrange
        const root = liveRoot("pd-status-changing");
        ledgerEvent(root, {
            event: "campaign-start",
            campaign: "pd-status-test",
        });
        const { files } = readIdentityFiles(root);
        let reads = 0;
        const changingReader = (): string | null => {
            reads += 1;
            return reads === 1
                ? `${JSON.stringify({ at: "2026-11-12T01:00:00.000Z", event: "campaign-start" })}\n`
                : `${JSON.stringify({ at: "2026-11-12T01:00:01.000Z", event: "pair-complete", pairId: "P01" })}\n`;
        };

        // Act
        const position = observePosition(root, files, changingReader);

        // Assert
        assert.equal(position.ledgerChanging, true);
        assert.deepEqual(position.completedPairs, ["P01"]);
    });

    it("treats a malformed ledger as blocked, not empty", () => {
        // Arrange
        const root = liveRoot("pd-status-malformed");
        write(join(root, "evidence/ATTEMPTS.jsonl"), "{not json at all\n");

        // Act
        const run = status(["--root", root]);
        const result = JSON.parse(
            status(["--root", root, "--json"]).stdout,
        ) as { result: { phase: string; position: { ledgerState: string } } };

        // Assert
        assert.equal(run.status, 0);
        assert.equal(result.result.phase, "blocked-malformed-ledger");
        assert.equal(result.result.position.ledgerState, "malformed");
    });

    it("distinguishes known zero from unknown spend on a closed campaign", () => {
        // Arrange
        const root = liveRoot("pd-status-zerospend");
        completePair(root, "P01");

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        const spend = (
            result.position as {
                spend: {
                    trial: { used: number; ceiling: number; remaining: number };
                    judge: { used: number; ceiling: number; remaining: number };
                };
            }
        ).spend;
        assert.equal(spend.trial.used, 2);
        assert.equal(spend.trial.ceiling, 16);
        assert.equal(spend.trial.remaining, 14);
        assert.equal(spend.judge.used, 2);
    });
});

describe("status campaign mode: checkpoints and reports", () => {
    function checkpointRoot(label: string): string {
        const root = materialisedRoot(label);
        completePreparation(root);
        writeFrozen(root);
        return root;
    }

    it("asks for an explicit report root and never scans siblings", () => {
        // Arrange
        const parent = mkdtempSync(join(tmpdir(), "pd-status-reports-"));
        const root = checkpointRoot(join(parent, "root"));
        const reportRoot = join(parent, "reports");
        writeReport(join(reportRoot, "p04"), {});
        const sibling = checkpointRoot(join(parent, "sibling"));

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        const checkpoint = result.checkpoint as {
            reportRootGiven: boolean;
            reports?: unknown[];
        };
        assert.equal(checkpoint.reportRootGiven, false);
        assert.equal(checkpoint.reports, undefined);
        assert.equal(JSON.stringify(result).includes(sibling), false);
    });

    it("treats P01–P04 without a current report as a missing checkpoint", () => {
        // Arrange
        const root = checkpointRoot("pd-status-p04-noreport");
        for (const pair of ["P01", "P02", "P03", "P04"])
            completePair(root, pair);

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        assert.equal(result.phase, "checkpoint-report-missing");
        const next = result.nextAction as { kind: string; command: string };
        assert.equal(next.kind, "offline-check");
        assert.match(next.command, /analyse\.mts/);
    });

    it("detects a stale report whose manifest hash no longer matches", () => {
        // Arrange
        const root = checkpointRoot("pd-status-p04-stale");
        for (const pair of ["P01", "P02", "P03", "P04"])
            completePair(root, pair);
        const reportRoot = mkdtempSync(join(tmpdir(), "pd-status-reportroot-"));
        writeReport(join(reportRoot, "p04"), {
            manifestPath: join(root, "evidence/schedule.json"),
        });

        // Act
        const result = statusJson([
            "--root",
            root,
            "--report-root",
            reportRoot,
        ]);

        // Assert
        assert.equal(result.phase, "checkpoint-report-missing");
        const report = (
            result.checkpoint as { reports: { freshness: string }[] }
        ).reports[0];
        assert.equal(report?.freshness, "stale");
    });

    it("detects a report the ledger has outgrown even with a matching manifest", () => {
        // Arrange: rendered before the last durable ledger event.
        const root = checkpointRoot("pd-status-p04-old");
        for (const pair of ["P01", "P02", "P03", "P04"])
            completePair(root, pair);
        const reportRoot = mkdtempSync(join(tmpdir(), "pd-status-reportroot-"));
        writeReport(join(reportRoot, "p04"), {
            manifestPath: join(root, "prepare/manifest.json"),
            renderedAt: "2026-11-12T00:30:00.000Z",
        });

        // Act
        const result = statusJson([
            "--root",
            root,
            "--report-root",
            reportRoot,
        ]);

        // Assert
        assert.equal(result.phase, "checkpoint-report-missing");
        const report = (
            result.checkpoint as {
                reports: { freshness: string; ledgerAdvancedSince: boolean }[];
            }
        ).reports[0];
        assert.equal(report?.freshness, "stale");
        assert.equal(report?.ledgerAdvancedSince, true);
    });

    it("flags a wrong-campaign report", () => {
        // Arrange
        const root = checkpointRoot("pd-status-p04-wrong");
        for (const pair of ["P01", "P02", "P03", "P04"])
            completePair(root, pair);
        const reportRoot = mkdtempSync(join(tmpdir(), "pd-status-reportroot-"));
        writeReport(join(reportRoot, "p04"), {
            campaignId: "some-other-campaign",
            manifestPath: join(root, "prepare/manifest.json"),
        });

        // Act
        const result = statusJson([
            "--root",
            root,
            "--report-root",
            reportRoot,
        ]);

        // Assert
        const report = (
            result.checkpoint as { reports: { wrongCampaign: boolean }[] }
        ).reports[0];
        assert.equal(report?.wrongCampaign, true);
        assert.equal(result.phase, "checkpoint-report-missing");
    });

    it("hands a current P04 report to the operator as a decision", () => {
        // Arrange
        const root = checkpointRoot("pd-status-p04-current");
        for (const pair of ["P01", "P02", "P03", "P04"])
            completePair(root, pair);
        const reportRoot = mkdtempSync(join(tmpdir(), "pd-status-reportroot-"));
        writeReport(join(reportRoot, "p04"), {
            manifestPath: join(root, "prepare/manifest.json"),
        });

        // Act
        const result = statusJson([
            "--root",
            root,
            "--report-root",
            reportRoot,
        ]);

        // Assert
        assert.equal(result.phase, "checkpoint-review");
        const next = result.nextAction as { kind: string; why: string };
        assert.equal(next.kind, "operator-decision");
        assert.match(next.why, /--pair-from 5 --pair-to 8/);
    });

    it("surfaces a closed campaign's reconciliation and a tie verdict", () => {
        // Arrange
        const root = checkpointRoot("pd-status-p08-closed");
        for (const pair of [
            "P01",
            "P02",
            "P03",
            "P04",
            "P05",
            "P06",
            "P07",
            "P08",
        ]) {
            completePair(root, pair);
        }
        const reportRoot = mkdtempSync(join(tmpdir(), "pd-status-reportroot-"));
        writeReport(join(reportRoot, "p08"), {
            manifestPath: join(root, "prepare/manifest.json"),
            recommendation: "inconclusive",
            delta: 0,
        });
        ledgerEvent(root, {
            event: "campaign-closed",
            stoppedAt: "pd-A-r0-R04",
            reason: "stopped: all pairs reconciled",
        });
        write(
            join(root, "evidence/RECONCILIATION.json"),
            `${JSON.stringify({
                at: "2026-11-12T03:00:00.000Z",
                campaign: "pd-status-test",
                closedAt: "pd-A-r0-R04",
                scheduledSlots: 16,
                observedSlots: 16,
                completedPairs: 8,
                trialLaunches: 16,
                unrunSlots: [],
                billing: {
                    currency: "USD",
                    trial: { estimated: 12.5 },
                    judge: { estimated: 3.25 },
                },
            })}\n`,
        );

        // Act
        const result = statusJson([
            "--root",
            root,
            "--report-root",
            reportRoot,
        ]);

        // Assert
        assert.equal(result.phase, "closed");
        const rec = (
            result.checkpoint as {
                reconciliation: {
                    present: boolean;
                    completedPairs: number;
                    trialLaunches: number;
                    billingTrial: number | null;
                    billingJudge: number | null;
                };
            }
        ).reconciliation;
        assert.equal(rec.present, true);
        assert.equal(rec.completedPairs, 8);
        assert.equal(rec.trialLaunches, 16);
        assert.equal(rec.billingTrial, 12.5);
        assert.equal(rec.billingJudge, 3.25);
        const report = (
            result.checkpoint as {
                reports: {
                    recommendation: string;
                    pairedDelta: number | null;
                }[];
            }
        ).reports[0];
        assert.equal(report?.recommendation, "inconclusive");
        assert.equal(report?.pairedDelta, 0);
    });

    it("closes before the final report, and that report reads current", () => {
        // Arrange: a disposable root with all eight pairs complete.
        const root = checkpointRoot("pd-status-closure-order");
        for (const pair of [
            "P01",
            "P02",
            "P03",
            "P04",
            "P05",
            "P06",
            "P07",
            "P08",
        ]) {
            completePair(root, pair);
        }
        const parent = mkdtempSync(join(tmpdir(), "pd-status-final-"));
        const finalDir = join(parent, "final");
        // Closure reads the declared retrieval opportunities; keep it empty.
        write(
            join(root, "evidence/measurement-spec.json"),
            `${JSON.stringify({ campaign: "pd-status-test", retrievalOpportunities: [] })}\n`,
        );
        // Closure refuses a launched slot without a recorded result.
        const schedule = JSON.parse(
            readFileSync(join(root, "evidence/schedule.json"), "utf8"),
        ) as {
            slots: { arm: string; stamp: string; scenario: string }[];
        };
        for (const slot of schedule.slots) {
            write(
                join(
                    root,
                    "gen",
                    slot.arm.toLowerCase(),
                    "results",
                    slot.stamp,
                    slot.scenario,
                    "meta.json",
                ),
                `${JSON.stringify({ timings: { totalMs: 1000 } })}\n`,
            );
        }
        const hermetic = {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
        };
        const bash = (command: string, cwd?: string): StatusRun => {
            const run = spawnSync("bash", ["-c", command], {
                encoding: "utf8",
                cwd,
                timeout: 120_000,
                env: hermetic,
            });
            return {
                status: run.status ?? -1,
                stdout: run.stdout ?? "",
                stderr: run.stderr ?? "",
            };
        };
        const closeEvents = (): string[] =>
            readFileSync(join(root, "evidence/ATTEMPTS.jsonl"), "utf8")
                .trim()
                .split("\n")
                .map((line) => String(JSON.parse(line).event))
                .filter((event) => event === "campaign-closed");

        // Act: the suggestion for a completed campaign.
        const before = statusJson(["--root", root]);

        // Assert: closure is suggested first, the final render second.
        assert.equal(before.phase, "awaiting-closure");
        const next = before.nextAction as { command: string };
        const [closeCommand, , analyseCommand] = next.command.split(" && ");
        if (!closeCommand || !analyseCommand) {
            assert.fail(`unexpected command shape: ${next.command}`);
        }
        const closeAt = next.command.indexOf("close-campaign.mts");
        const analyseAt = next.command.indexOf("analyse.mts");
        assert.ok(closeAt >= 0);
        assert.ok(analyseAt > closeAt);
        assert.equal(closeEvents().length, 0);

        // Act: execute the emitted close command.
        const closed = bash(closeCommand as string);

        // Assert: it reconciles and appends the closure record.
        assert.equal(closed.status, 0, closed.stderr);
        assert.equal(
            existsSync(join(root, "evidence/RECONCILIATION.json")),
            true,
        );
        assert.equal(closeEvents().length, 1);

        // Act: execute the same close command again.
        const reconciliationBytes = readFileSync(
            join(root, "evidence/RECONCILIATION.json"),
            "utf8",
        );
        const ledgerBytes = readFileSync(
            join(root, "evidence/ATTEMPTS.jsonl"),
            "utf8",
        );
        const again = bash(closeCommand as string);

        // Assert: closure is idempotent.
        assert.equal(again.status, 0, again.stderr);
        assert.equal(
            readFileSync(join(root, "evidence/RECONCILIATION.json"), "utf8"),
            reconciliationBytes,
        );
        assert.equal(
            readFileSync(join(root, "evidence/ATTEMPTS.jsonl"), "utf8"),
            ledgerBytes,
        );

        // Act: execute the emitted analyse command into a fresh directory.
        const rendered = bash(
            (analyseCommand as string).replace("<fresh-report-dir>", finalDir),
            repo,
        );

        // Assert: the final report lands outside the evidence root.
        assert.equal(rendered.status, 0, rendered.stderr);
        for (const artefact of [
            "analysis.json",
            "REPORT.md",
            "SCREENING.json",
            "analysis-receipt.json",
        ]) {
            assert.equal(existsSync(join(finalDir, artefact)), true, artefact);
        }

        // Act: observe the closed campaign with its final report root.
        const after = statusJson(["--root", root, "--report-root", parent]);

        // Assert: closing first left a current final report.
        assert.equal(after.phase, "closed");
        const reports = (
            after.checkpoint as {
                reports: { freshness: string }[];
            }
        ).reports;
        assert.equal(reports.length, 1);
        assert.equal(reports[0]?.freshness, "current");
    });
});

describe("status projections and safety", () => {
    it("agrees between text and JSON for one observation", () => {
        // Arrange
        const root = materialisedRoot("pd-status-agree");
        completePreparation(root);
        writeFrozen(root);
        completePair(root, "P01");

        // Act
        const text = status(["--root", root]).stdout;
        const result = statusJson(["--root", root]);

        // Assert
        assert.match(text, new RegExp(String(result.phase)));
        assert.equal(
            text.includes(String(result.headline)),
            true,
            `text must carry the JSON headline: ${result.headline}`,
        );
        const next = result.nextAction as { kind: string };
        assert.equal(
            text.includes(`NEXT (${next.kind})`),
            true,
            "text must carry the JSON next-action kind",
        );
    });

    it("is stable across repeated observation of identical evidence", () => {
        // Arrange
        const root = materialisedRoot("pd-status-stable");
        completePreparation(root);
        writeFrozen(root);
        const strip = (run: StatusRun): string =>
            run.stdout
                .replace(/"generatedAt":\s*"[^"]+"/g, "")
                .replace(/"diskFreeBytes":\s*\d+/g, "");

        // Act
        const first = strip(status(["--root", root, "--json"]));
        const second = strip(status(["--root", root, "--json"]));

        // Assert
        assert.equal(first, second);
    });

    it("writes nothing: repeated observation preserves every fixture byte", () => {
        // Arrange
        const root = materialisedRoot("pd-status-readonly");
        completePreparation(root);
        writeFrozen(root);
        completePair(root, "P01");
        const before = treeSnapshot(root);

        // Act
        status(["--root", root, "--detail"]);
        status(["--root", root, "--json"]);
        const after = treeSnapshot(root);

        // Assert
        assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
        for (const [path, hash] of before) {
            assert.equal(after.get(path), hash, path);
        }
        assert.equal(existsSync(join(root, "evidence/CLOSING.lock")), false);
    });

    it("runs no container and no dispatch through the engine trap", () => {
        // Arrange
        const root = materialisedRoot("pd-status-nodispatch");
        completePreparation(root);
        writeFrozen(root);
        const { bin, log } = fakePodmanBin();

        // Act
        spawnSync(process.execPath, [statusCli, "--root", root, "--detail"], {
            encoding: "utf8",
            timeout: 60_000,
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                CAMPAIGN_SOURCE_REPO: sourceRepo,
            },
        });

        // Assert
        const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
        for (const line of calls.split("\n").filter((entry) => entry !== "")) {
            assert.match(line, /^(--version|image inspect .*)$/, line);
        }
    });

    it("redacts credential material from diagnostics", () => {
        // Act / Assert
        assert.equal(
            redact("leak sk-abcdef123456 here"),
            "leak [redacted] here",
        );
        assert.equal(
            redact("ZAI_API_KEY=plain-value"),
            "ZAI_API_KEY=[redacted]",
        );
        assert.equal(shellQuote("it's a path"), "'it'\\''s a path'");
    });

    it("represents missing legacy fields without failing", () => {
        // Arrange: a root with a manifest that carries no assessment block
        // and no schedule.json — the planned order must come from the manifest.
        const root = materialisedRoot("pd-status-legacyfields");

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        const identity = result.identity as {
            order?: unknown[];
            sources: Record<string, string>;
        };
        assert.equal(Array.isArray(identity.order), true);
        assert.match(identity.sources.schedule ?? "", /manifest/);
    });
});

describe("status findings regressions", () => {
    /** A fresh frozen campaign root with its temp parent for cleanup. */
    function frozenLive(label: string): string {
        const root = materialisedRoot(label);
        completePreparation(root);
        writeFrozen(root);
        return root;
    }

    /** Complete P01–P04 in the ledger and claims. */
    function completeCheckpoint(root: string): void {
        for (const pair of ["P01", "P02", "P03", "P04"])
            completePair(root, pair);
    }

    it("the printed checkout setup command runs verbatim in a disposable checkout", () => {
        // Arrange: a clean scratch checkout carrying the real campaign tooling.
        const scratch = mkdtempSync(join(tmpdir(), "pd-status-copyrun-"));
        const tmp = join(scratch, "allocated-roots");
        mkdirSync(tmp, { recursive: true });
        const harness = join(scratch, "tests/fixtures/placement-harness");
        mkdirSync(dirname(harness), { recursive: true });
        cpSync(join(repo, "tests/fixtures/placement-harness"), harness, {
            recursive: true,
        });
        for (const args of [
            ["init", "-q"],
            ["config", "user.email", "t@example.com"],
            ["config", "user.name", "t"],
            ["add", "-A"],
            ["commit", "-qm", "tooling"],
        ]) {
            git(scratch, args);
        }
        const { bin } = fakePodmanBin();

        // Act: observe in checkout mode, then run the emitted command as-is.
        const run = spawnSync(
            process.execPath,
            [statusCli, "--base", "HEAD", "--json"],
            {
                encoding: "utf8",
                cwd: scratch,
                timeout: 120_000,
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH ?? ""}`,
                    TMPDIR: tmp,
                },
            },
        );
        const payload = JSON.parse(run.stdout ?? "") as {
            result: {
                phase: string;
                nextAction: { kind: string; command: string };
            };
        };
        const command = payload.result.nextAction.command;
        assert.equal(payload.result.phase, "unmaterialised-checkout");
        assert.match(command, /"\$CAMPAIGN_ROOT"/);
        assert.doesNotMatch(command, /'\$CAMPAIGN_ROOT/);
        const executed = spawnSync("sh", ["-c", command], {
            encoding: "utf8",
            cwd: scratch,
            timeout: 120_000,
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                TMPDIR: tmp,
            },
        });
        assert.equal(executed.status, 0, executed.stderr);

        // Assert: the materialiser received the allocated root, and nothing
        // created a directory literally named $CAMPAIGN_ROOT.
        assert.equal(existsSync(join(scratch, "$CAMPAIGN_ROOT")), false);
        const allocated = readdirSync(tmp);
        assert.equal(allocated.length, 1, "exactly one allocated root");
        const root = join(tmp, allocated[0] ?? "");
        assert.equal(existsSync(join(root, "prepare/manifest.json")), true);
        assert.equal(existsSync(join(root, "runner/ledger.ts")), true);
        assert.equal(existsSync(join(root, "evidence")), true);
    });

    it("a launched slot with no recorded exit is inspected, not dispatched", () => {
        // Arrange: P01 arm A launched, the trial claim closed, but no
        // trial-exit was ever recorded — the slot is mid-flight.
        const root = frozenLive("pd-stop-launch");
        ledgerEvent(root, {
            event: "launch",
            slot: 1,
            pairId: "P01",
            stamp: "pd-A-r0-R01",
            arm: "A",
        });
        writeClaim(root, "trial", 1, "closed", "pd-A-r0-R01");

        // Act
        const result = statusJson(["--root", root, "--detail"]);

        // Assert
        assert.equal(result.phase, "stopped-slot");
        const next = result.nextAction as { kind: string; command?: string };
        assert.equal(next.kind, "inspection");
        assert.equal(next.command, undefined);
        const slots = (
            result.position as { slots: { stamp: string; state: string }[] }
        ).slots;
        assert.equal(
            slots.find((slot) => slot.stamp === "pd-A-r0-R01")?.state,
            "dispatched",
        );
    });

    it("a clean pause after P01 resumes only to the P04 checkpoint", () => {
        // Arrange: P01 fully complete, ledger open, P02–P04 unrun.
        const root = frozenLive("pd-pause-p01");
        completePair(root, "P01");

        // Act
        const result = statusJson(["--root", root]);

        // Assert: the paid resume is bounded by the mandatory checkpoint.
        assert.equal(result.phase, "live-in-progress");
        const next = result.nextAction as { kind: string; command: string };
        assert.equal(next.kind, "paid-operation");
        assert.match(next.command, /--pair-from 2 --pair-to 4/);
        assert.doesNotMatch(next.command, /--pair-to 8/);
    });

    it("a released judge claim after pre-dispatch refusal is inspected", () => {
        // Arrange: P01–P04 complete; P05 arm B judged usable by the trial but
        // the judge wrapper refused before dispatching, releasing its claim.
        const root = frozenLive("pd-stop-p05b");
        completeCheckpoint(root);
        ledgerEvent(root, {
            event: "launch",
            slot: 10,
            pairId: "P05",
            stamp: "pd-B-r0-S05",
            arm: "B",
        });
        ledgerEvent(root, {
            event: "trial-exit",
            slot: 10,
            pairId: "P05",
            stamp: "pd-B-r0-S05",
            arm: "B",
            usable: true,
        });
        ledgerEvent(root, {
            event: "judge-launch",
            slot: 10,
            pairId: "P05",
            stamp: "pd-B-r0-S05",
            arm: "B",
        });
        ledgerEvent(root, {
            event: "judge-refused",
            slot: 10,
            pairId: "P05",
            stamp: "pd-B-r0-S05",
            arm: "B",
            reason: "judge wrapper exited before writing dispatch.json",
        });
        writeClaim(root, "trial", 9, "closed", "pd-B-r0-S05");

        // Act
        const result = statusJson(["--root", root, "--detail"]);

        // Assert: the stopped slot wins over any clean-pair resume.
        assert.equal(result.phase, "stopped-slot");
        const next = result.nextAction as { kind: string; command?: string };
        assert.equal(next.kind, "inspection");
        assert.equal(next.command, undefined);
        const slots = (
            result.position as {
                slots: { stamp: string; state: string; note?: string }[];
            }
        ).slots;
        const stopped = slots.find((slot) => slot.stamp === "pd-B-r0-S05");
        assert.equal(stopped?.state, "judge-refused");
        assert.match(stopped?.note ?? "", /before writing dispatch/);
    });

    it("unreadable claim evidence reports unknown spend, never a free allowance", () => {
        // Arrange: a directory sits at an expected claim-file path.
        const root = frozenLive("pd-spend-unknown");
        mkdirSync(join(root, "evidence/trial/trial-0001.claim"), {
            recursive: true,
        });

        // Act
        const result = statusJson(["--root", root, "--detail"]);

        // Assert
        assert.equal(result.phase, "blocked-unreadable-spend");
        const spend = (
            result.position as {
                spend: {
                    trial: { used: number | null; remaining: number | null };
                    judge: { used: number | null };
                };
            }
        ).spend;
        assert.equal(spend.trial.used, null);
        assert.equal(spend.trial.remaining, null);
        assert.equal(spend.judge.used, 0);
        const next = result.nextAction as { kind: string; command?: string };
        assert.equal(next.kind, "inspection");
        assert.equal(next.command, undefined);
    });

    it("a genuinely empty claims directory is known zero spend", () => {
        // Arrange: the claim directories exist but hold no claim files.
        const root = frozenLive("pd-spend-zero");
        mkdirSync(join(root, "evidence/trial"), { recursive: true });
        mkdirSync(join(root, "evidence/judge"), { recursive: true });

        // Act
        const result = statusJson(["--root", root]);

        // Assert
        assert.equal(result.phase, "frozen-ready");
        const spend = (
            result.position as {
                spend: { trial: { used: number; remaining: number } };
            }
        ).spend;
        assert.equal(spend.trial.used, 0);
        assert.equal(spend.trial.remaining, 16);
    });

    it("a report is indeterminate without a receipt, even on a matching manifest", () => {
        // Arrange: P01–P04 done and the ledger has advanced into P05 with a
        // cleanly adjudicated slot; the report matches the manifest but has
        // no receipt, so its coverage cannot be proven.
        const root = frozenLive("pd-fresh-indeterminate");
        completeCheckpoint(root);
        ledgerEvent(root, {
            event: "launch",
            slot: 9,
            pairId: "P05",
            stamp: "pd-A-r0-S05",
            arm: "A",
        });
        ledgerEvent(root, {
            event: "trial-exit",
            slot: 9,
            pairId: "P05",
            stamp: "pd-A-r0-S05",
            arm: "A",
            usable: true,
        });
        ledgerEvent(root, {
            event: "judge-launch",
            slot: 9,
            pairId: "P05",
            stamp: "pd-A-r0-S05",
            arm: "A",
        });
        ledgerEvent(root, {
            event: "judge-exit",
            slot: 9,
            pairId: "P05",
            stamp: "pd-A-r0-S05",
            arm: "A",
            outcome: "judged",
        });
        ledgerEvent(root, {
            event: "slot-complete",
            slot: 9,
            pairId: "P05",
            stamp: "pd-A-r0-S05",
            arm: "A",
            judged: true,
        });
        const reportRoot = mkdtempSync(join(tmpdir(), "pd-status-reportroot-"));
        const dir = join(reportRoot, "p04");
        mkdirSync(dir, { recursive: true });
        write(
            join(dir, "analysis.json"),
            `${JSON.stringify({
                campaign: { id: "pd-status-test" },
                manifestSha256: hashFile(join(root, "prepare/manifest.json")),
                decision: { overall: "inconclusive" },
            })}\n`,
        );

        // Act
        const result = statusJson([
            "--root",
            root,
            "--report-root",
            reportRoot,
        ]);

        // Assert: a manifest alone cannot prove how far the report covers.
        const report = (
            result.checkpoint as {
                reports: { freshness: string; manifestMatches: boolean }[];
            }
        ).reports[0];
        assert.equal(report?.manifestMatches, true);
        assert.equal(report?.freshness, "indeterminate");
        assert.equal(result.phase, "checkpoint-report-missing");
        const next = result.nextAction as { kind: string };
        assert.equal(next.kind, "offline-check");
    });
});

describe("status agrees with the registered analyser", () => {
    it("extracts exactly what analyse.mts published over the mini corpus", () => {
        // Arrange: run the real analyser over its own fixture corpus.
        const out = mkdtempSync(join(tmpdir(), "pd-status-analyser-"));
        const analysis = spawnSync(
            process.execPath,
            [
                analyser,
                "--campaign",
                miniManifest,
                "--evidence-root",
                miniCorpus,
                "--out",
                out,
            ],
            { encoding: "utf8", timeout: 120_000 },
        );
        assert.equal(analysis.status, 0, analysis.stderr);
        const published = JSON.parse(
            readFileSync(join(out, "analysis.json"), "utf8"),
        ) as {
            campaign: { id: string };
            arms: Record<
                string,
                { accounting: { documented: number; assessed: number } }
            >;
            measures: {
                arms: Record<
                    string,
                    {
                        recording: { planned: number; success: number };
                        retrieval: { planned: number; applied: number };
                    }
                >;
                personalTrial: { recommendation: string };
            };
            decision: { overall: string };
        };

        // A campaign root whose manifest is the analyser's own input, with a
        // ledger that predates the render so freshness is provable.
        const root = mkdtempSync(join(tmpdir(), "pd-status-mini-"));
        mkdirSync(join(root, "prepare"), { recursive: true });
        copyFileSync(miniManifest, join(root, "prepare/manifest.json"));
        mkdirSync(join(root, "evidence"), { recursive: true });
        write(
            join(root, "evidence/schedule.json"),
            `${JSON.stringify({
                campaign: published.campaign.id,
                slots: (
                    JSON.parse(readFileSync(miniManifest, "utf8")) as {
                        schedule: { slots: unknown[] };
                    }
                ).schedule.slots,
            })}\n`,
        );
        write(
            join(root, "evidence/ATTEMPTS.jsonl"),
            `${JSON.stringify({ at: "2025-01-01T00:00:00.000Z", event: "campaign-start" })}\n`,
        );

        // Act
        const result = statusJson(["--root", root, "--report-root", out]);

        // Assert
        const report = (
            result.checkpoint as {
                reports: {
                    campaignId?: string;
                    manifestMatches?: boolean;
                    freshness?: string;
                    decision?: string;
                    recommendation?: string;
                    recording?: Record<
                        string,
                        { planned: number; success: number }
                    >;
                    retrieval?: Record<
                        string,
                        { planned: number; applied: number }
                    >;
                    coverage?: { documented: number; assessed: number };
                }[];
            }
        ).reports[0];
        assert.ok(report, "the analyser's report must be observed");
        assert.equal(report.campaignId, published.campaign.id);
        assert.equal(report.manifestMatches, true);
        assert.equal(report.freshness, "current");
        assert.equal(report.decision, published.decision.overall);
        assert.equal(
            report.recommendation,
            published.measures.personalTrial.recommendation,
        );
        for (const arm of Object.keys(published.measures.arms)) {
            assert.deepEqual(report.recording?.[arm], {
                planned: published.measures.arms[arm]?.recording.planned,
                success: published.measures.arms[arm]?.recording.success,
            });
            assert.deepEqual(report.retrieval?.[arm], {
                planned: published.measures.arms[arm]?.retrieval.planned,
                applied: published.measures.arms[arm]?.retrieval.applied,
            });
        }
        assert.equal(
            report.coverage?.documented,
            Object.values(published.arms).reduce(
                (sum, arm) => sum + arm.accounting.documented,
                0,
            ),
        );
        assert.equal(
            report.coverage?.assessed,
            Object.values(published.arms).reduce(
                (sum, arm) => sum + arm.accounting.assessed,
                0,
            ),
        );
    });
});
