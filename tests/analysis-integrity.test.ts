import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const cli = join(
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

const runCli = (args: readonly string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        timeout: 120000,
    });

interface Workspace {
    dir: string;
    evidence: string;
    out: string;
    manifest: string;
}

/** A disposable copy of the committed corpus and manifest. */
function workspace(label: string): Workspace {
    const dir = mkdtempSync(join(tmpdir(), `${label}-`));
    const evidence = join(dir, "evidence");
    cpSync(miniCorpus, evidence, { recursive: true });
    const manifest = join(dir, "campaign.json");
    cpSync(miniManifest, manifest);
    return { dir, evidence, out: join(dir, "out"), manifest };
}

const analyse = (space: Workspace, extra: readonly string[] = []) =>
    runCli([
        "--campaign",
        space.manifest,
        "--evidence-root",
        space.evidence,
        "--out",
        space.out,
        ...extra,
    ]);

const readJson = <T>(path: string): T =>
    JSON.parse(readFileSync(path, "utf8")) as T;

interface Receipt {
    renderedAt: string;
    inputs: Array<{
        reference: string;
        kind: "file" | "directory";
        sha256: string | null;
        state: "available" | "missing" | "not-a-directory" | "malformed";
    }>;
}

interface Analysis {
    arms: Record<string, { accounting: { utilityTotal: number } }>;
    totals: { documented: number; utilityTotal: number };
    usage: {
        input: number | null;
        output: number | null;
        reasoning: number | null;
        cacheRead: number | null;
        steps: number | null;
        measuredSteps: number;
        unknownSteps: number;
        measuredTrials: number;
        unknownTrials: number;
    };
    cost: { available: boolean; note: string };
    ledger: null | {
        reference: string;
        state: string;
        events: Record<string, number>;
        scheduled: number;
        launched: number;
        judged: number;
        missingLaunches: string[];
        missingJudgeAttempts: string[];
        unknownStamps: string[];
        duplicateLaunches: string[];
    };
    limitations: string[];
}

interface Screening {
    findings: Array<{
        ruleId: string;
        category: string;
        excerpt: string;
        visibility?: string;
        source: { reference: string; sha256: string };
        trial: { stamp: string; arm: string; scenario: string };
        role: string;
    }>;
}

const findingsFor = (screening: Screening, stamp: string) =>
    screening.findings.filter((finding) => finding.trial.stamp === stamp);

describe("analysis receipt binding", () => {
    it("is byte-stable for an unchanged replay, apart from the rendering time", () => {
        // Arrange
        const space = workspace("receipt-stable");
        const second = join(space.dir, "out-two");
        try {
            // Act
            assert.equal(analyse(space).status, 0);
            const rerun = runCli([
                "--campaign",
                space.manifest,
                "--evidence-root",
                space.evidence,
                "--out",
                second,
            ]);
            assert.equal(rerun.status, 0, rerun.stderr);

            // Assert
            assert.equal(
                readFileSync(join(space.out, "analysis.json"), "utf8"),
                readFileSync(join(second, "analysis.json"), "utf8"),
            );
            const first = readJson<Receipt>(
                join(space.out, "analysis-receipt.json"),
            );
            const later = readJson<Receipt>(
                join(second, "analysis-receipt.json"),
            );
            assert.deepEqual(first.inputs, later.inputs);
            assert.notEqual(first.renderedAt, later.renderedAt);
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("binds a directory observation to the receipt when a missing lake becomes an empty one", () => {
        // Arrange
        const space = workspace("receipt-directory");
        const beforeDir = "a/fixtures/R01/lakes/docs";
        try {
            assert.equal(analyse(space).status, 0);
            const beforeReceipt = readJson<Receipt>(
                join(space.out, "analysis-receipt.json"),
            );
            const beforeAnalysis = readJson<Analysis>(
                join(space.out, "analysis.json"),
            );
            const beforeEntry = beforeReceipt.inputs.find(
                (input) => input.reference === beforeDir,
            );
            assert.equal(beforeEntry?.kind, "directory");
            assert.equal(beforeEntry?.state, "missing");
            assert.equal(beforeEntry?.sha256, null);
            assert.ok(
                beforeAnalysis.limitations.some((line) =>
                    line.includes("missing before/after lake snapshots for 2"),
                ),
            );
            mkdirSync(join(space.evidence, beforeDir), { recursive: true });

            // Act
            const rerun = analyse(space, ["--rerender"]);

            // Assert
            assert.equal(rerun.status, 0, rerun.stderr);
            const afterReceipt = readJson<Receipt>(
                join(space.out, "analysis-receipt.json"),
            );
            const afterAnalysis = readJson<Analysis>(
                join(space.out, "analysis.json"),
            );
            const afterEntry = afterReceipt.inputs.find(
                (input) => input.reference === beforeDir,
            );
            assert.equal(afterEntry?.kind, "directory");
            assert.equal(afterEntry?.state, "available");
            assert.equal(
                afterEntry?.sha256,
                // SHA-256 of the JSON-serialised sorted, empty entry list.
                "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            );
            assert.ok(
                afterAnalysis.limitations.some((line) =>
                    line.includes("missing before/after lake snapshots for 1"),
                ),
            );
            const beforeByKey = new Map(
                beforeReceipt.inputs.map((input) => [
                    `${input.kind}\u0000${input.reference}`,
                    input,
                ]),
            );
            const afterByKey = new Map(
                afterReceipt.inputs.map((input) => [
                    `${input.kind}\u0000${input.reference}`,
                    input,
                ]),
            );
            const differing = [
                ...new Set([...beforeByKey.keys(), ...afterByKey.keys()]),
            ].filter(
                (key) =>
                    JSON.stringify(beforeByKey.get(key)) !==
                    JSON.stringify(afterByKey.get(key)),
            );
            assert.deepEqual(differing, [`directory\u0000${beforeDir}`]);
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("binds the receipt to the selected judgement that determines the score", () => {
        // Arrange
        const space = workspace("receipt-binding");
        const changed = workspace("receipt-changed");
        const judgement =
            "a/results/cc-A-r0-R01/R01/ac/attempt-001/judgement.json";
        try {
            assert.equal(analyse(space).status, 0);
            const raw = readJson<Record<string, unknown>>(
                join(changed.evidence, judgement),
            );
            raw.documentationOutcome = "duplicate";
            writeFileSync(
                join(changed.evidence, judgement),
                `${JSON.stringify(raw, null, 4)}\n`,
            );
            assert.equal(analyse(changed).status, 0);

            // Act
            const before = readJson<Receipt>(
                join(space.out, "analysis-receipt.json"),
            );
            const after = readJson<Receipt>(
                join(changed.out, "analysis-receipt.json"),
            );
            const beforeByReference = new Map(
                before.inputs.map((input) => [input.reference, input]),
            );
            const afterByReference = new Map(
                after.inputs.map((input) => [input.reference, input]),
            );
            const differing = [
                ...new Set([
                    ...beforeByReference.keys(),
                    ...afterByReference.keys(),
                ]),
            ].filter(
                (reference) =>
                    JSON.stringify(beforeByReference.get(reference)) !==
                    JSON.stringify(afterByReference.get(reference)),
            );

            // Assert
            assert.deepEqual(differing, [judgement]);
            assert.equal(beforeByReference.get(judgement)?.state, "available");
            assert.notEqual(
                beforeByReference.get(judgement)?.sha256,
                afterByReference.get(judgement)?.sha256,
            );
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
            rmSync(changed.dir, { recursive: true, force: true });
        }
    });

    it("distinguishes findings from two trials with byte-identical answers", () => {
        // Arrange
        const space = workspace("receipt-identical");
        const answer =
            "I did not write anything; the task needed no documentation.\n";
        const judgements = [
            "a/results/cc-A-r0-R01/R01/final.md",
            "b/results/cc-B-r0-R01/R01/final.md",
        ];
        try {
            for (const path of judgements) {
                writeFileSync(join(space.evidence, path), answer);
            }
            // Both lakes need an observable before state for the mutation
            // comparison; the mini corpus records none for R01.
            mkdirSync(join(space.evidence, "a/fixtures/R01/lakes/docs"), {
                recursive: true,
            });
            mkdirSync(join(space.evidence, "b/fixtures/R01/lakes/docs"), {
                recursive: true,
            });

            // Act
            const run = analyse(space);

            // Assert
            assert.equal(run.status, 0, run.stderr);
            const screening = readJson<Screening>(
                join(space.out, "SCREENING.json"),
            );
            const a = findingsFor(screening, "cc-A-r0-R01").find(
                (finding) => finding.ruleId === "claim-mutation-contradiction",
            );
            const b = findingsFor(screening, "cc-B-r0-R01").find(
                (finding) => finding.ruleId === "claim-mutation-contradiction",
            );
            assert.ok(a, "A R01 must report the contradicted claim");
            assert.ok(b, "B R01 must report the contradicted claim");
            assert.equal(a.excerpt, b.excerpt);
            assert.equal(a.source.sha256, b.source.sha256);
            assert.equal(
                a.source.reference,
                "a/results/cc-A-r0-R01/R01/final.md",
            );
            assert.equal(
                b.source.reference,
                "b/results/cc-B-r0-R01/R01/final.md",
            );
            assert.deepEqual(a.trial, {
                stamp: "cc-A-r0-R01",
                arm: "A",
                scenario: "R01",
            });
            assert.deepEqual(b.trial, {
                stamp: "cc-B-r0-R01",
                arm: "B",
                scenario: "R01",
            });
            assert.equal(a.role, "response");
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });
});

describe("analysis publication safety", () => {
    const interpretationBytes = "Authored interpretation: B looks promising.\n";

    it("refuses an output name symlinked to the authored interpretation", () => {
        // Arrange
        const space = workspace("publish-interpretation");
        try {
            assert.equal(analyse(space).status, 0);
            const interpretation = join(space.out, "INTERPRETATION.md");
            writeFileSync(interpretation, interpretationBytes);
            rmSync(join(space.out, "analysis.json"));
            symlinkSync(interpretation, join(space.out, "analysis.json"));

            // Act
            const run = analyse(space, ["--rerender"]);

            // Assert
            assert.notEqual(run.status, 0);
            assert.match(run.stderr, /symlink/);
            assert.equal(
                readFileSync(interpretation, "utf8"),
                interpretationBytes,
            );
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("refuses an output name symlinked to the campaign manifest", () => {
        // Arrange
        const space = workspace("publish-manifest");
        const manifestBytes = readFileSync(space.manifest, "utf8");
        try {
            mkdirSync(space.out, { recursive: true });
            writeFileSync(
                join(space.out, "INTERPRETATION.md"),
                interpretationBytes,
            );
            symlinkSync(space.manifest, join(space.out, "REPORT.md"));

            // Act
            const run = analyse(space, ["--rerender"]);

            // Assert
            assert.notEqual(run.status, 0);
            assert.match(run.stderr, /symlink/);
            assert.equal(readFileSync(space.manifest, "utf8"), manifestBytes);
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("refuses an output name symlinked to consumed evidence", () => {
        // Arrange
        const space = workspace("publish-evidence");
        const evidenceFile =
            "a/results/cc-A-r0-R01/R01/ac/attempt-001/judgement.json";
        const evidenceBytes = readFileSync(
            join(space.evidence, evidenceFile),
            "utf8",
        );
        try {
            mkdirSync(space.out, { recursive: true });
            symlinkSync(
                join(space.evidence, evidenceFile),
                join(space.out, "analysis-receipt.json"),
            );

            // Act
            const run = analyse(space, ["--rerender"]);

            // Assert
            assert.notEqual(run.status, 0);
            assert.match(run.stderr, /symlink/);
            assert.equal(
                readFileSync(join(space.evidence, evidenceFile), "utf8"),
                evidenceBytes,
            );
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("preserves authored interpretation and evidence on a normal rerender", () => {
        // Arrange
        const space = workspace("publish-rerender");
        const evidenceFile =
            "a/results/cc-A-r0-R01/R01/ac/attempt-001/judgement.json";
        try {
            assert.equal(analyse(space).status, 0);
            const interpretation = join(space.out, "INTERPRETATION.md");
            writeFileSync(interpretation, interpretationBytes);
            const evidenceBytes = readFileSync(
                join(space.evidence, evidenceFile),
                "utf8",
            );

            // Act
            const run = analyse(space, ["--rerender"]);

            // Assert
            assert.equal(run.status, 0, run.stderr);
            assert.equal(
                readFileSync(interpretation, "utf8"),
                interpretationBytes,
            );
            assert.equal(
                readFileSync(join(space.evidence, evidenceFile), "utf8"),
                evidenceBytes,
            );
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("leaves every output unchanged when a rerender is refused", () => {
        // Arrange
        const space = workspace("publish-refused");
        try {
            assert.equal(analyse(space).status, 0);
            const reportBefore = readFileSync(
                join(space.out, "REPORT.md"),
                "utf8",
            );
            const screeningBefore = readFileSync(
                join(space.out, "SCREENING.json"),
                "utf8",
            );
            const interpretation = join(space.out, "INTERPRETATION.md");
            writeFileSync(interpretation, interpretationBytes);
            rmSync(join(space.out, "analysis.json"));
            symlinkSync(interpretation, join(space.out, "analysis.json"));

            // Act
            const run = analyse(space, ["--rerender"]);

            // Assert
            assert.notEqual(run.status, 0);
            assert.equal(
                readFileSync(join(space.out, "REPORT.md"), "utf8"),
                reportBefore,
            );
            assert.equal(
                readFileSync(join(space.out, "SCREENING.json"), "utf8"),
                screeningBefore,
            );
            assert.equal(
                lstatSync(join(space.out, "analysis.json")).isSymbolicLink(),
                true,
            );
            assert.equal(
                readFileSync(interpretation, "utf8"),
                interpretationBytes,
            );
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });
});

describe("capture, usage and ledger observability", () => {
    it("keeps absent token telemetry and cost unknown, never zero", () => {
        // Arrange
        const space = workspace("usage-absent");
        const empty = join(space.dir, "empty-evidence");
        mkdirSync(empty);
        try {
            // Act
            const run = runCli([
                "--campaign",
                space.manifest,
                "--evidence-root",
                empty,
                "--out",
                space.out,
            ]);

            // Assert
            assert.equal(run.status, 0, run.stderr);
            const analysis = readJson<Analysis>(
                join(space.out, "analysis.json"),
            );
            assert.equal(analysis.usage.input, null);
            assert.equal(analysis.usage.output, null);
            assert.equal(analysis.usage.reasoning, null);
            assert.equal(analysis.usage.cacheRead, null);
            assert.equal(analysis.usage.steps, null);
            assert.equal(analysis.usage.measuredSteps, 0);
            assert.equal(analysis.usage.unknownSteps, 0);
            assert.equal(analysis.usage.measuredTrials, 0);
            assert.equal(analysis.usage.unknownTrials, 4);
            assert.equal(analysis.cost.available, false);
            assert.match(analysis.cost.note, /without an invented price/);
            const report = readFileSync(join(space.out, "REPORT.md"), "utf8");
            assert.match(report, /## Capture, integrity and costs/);
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("reports captured tokens for the mini corpus", () => {
        // Arrange
        const space = workspace("usage-recorded");
        try {
            // Act
            assert.equal(analyse(space).status, 0);

            // Assert
            const analysis = readJson<Analysis>(
                join(space.out, "analysis.json"),
            );
            assert.equal(analysis.usage.steps, 4);
            assert.equal(analysis.usage.measuredSteps, 4);
            assert.equal(analysis.usage.unknownSteps, 0);
            assert.equal(analysis.usage.measuredTrials, 4);
            assert.equal(analysis.usage.unknownTrials, 0);
            assert.equal(typeof analysis.usage.input, "number");
            assert.ok((analysis.usage.input ?? 0) > 0);
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("reconciles a declared attempt ledger without changing trial accounting", () => {
        // Arrange
        const base = workspace("ledger-base");
        const space = workspace("ledger-declared");
        const manifest = readJson<{
            evidence: { inputs?: Record<string, string> };
        }>(space.manifest);
        manifest.evidence.inputs = {
            attempts: "evidence/ATTEMPTS.jsonl",
        };
        writeFileSync(space.manifest, `${JSON.stringify(manifest, null, 4)}\n`);
        mkdirSync(join(space.evidence, "evidence"), { recursive: true });
        writeFileSync(
            join(space.evidence, "evidence/ATTEMPTS.jsonl"),
            [
                '{"event":"launch","stamp":"cc-A-r0-R01"}',
                '{"event":"launch","stamp":"cc-A-r0-R01"}',
                '{"event":"launch","stamp":"cc-X-r0-R09"}',
                '{"event":"campaign-start"}',
                "",
            ].join("\n"),
        );
        try {
            assert.equal(analyse(base).status, 0);

            // Act
            const run = analyse(space);

            // Assert
            assert.equal(run.status, 0, run.stderr);
            const baseline = readJson<Analysis>(
                join(base.out, "analysis.json"),
            );
            const analysis = readJson<Analysis>(
                join(space.out, "analysis.json"),
            );
            assert.deepEqual(analysis.arms, baseline.arms);
            assert.deepEqual(analysis.totals, baseline.totals);
            assert.equal(analysis.ledger?.state, "available");
            assert.equal(analysis.ledger?.reference, "evidence/ATTEMPTS.jsonl");
            assert.equal(analysis.ledger?.scheduled, 4);
            assert.equal(analysis.ledger?.launched, 1);
            assert.equal(analysis.ledger?.judged, 0);
            assert.deepEqual(analysis.ledger?.duplicateLaunches, [
                "cc-A-r0-R01",
            ]);
            assert.deepEqual(analysis.ledger?.unknownStamps, ["cc-X-r0-R09"]);
            assert.equal(analysis.ledger?.missingLaunches.length, 3);
            assert.equal(analysis.ledger?.missingJudgeAttempts.length, 4);
            assert.equal(analysis.ledger?.events.launch, 3);
            assert.ok(
                analysis.limitations.some((line) =>
                    line.includes("no recorded launch"),
                ),
            );
        } finally {
            rmSync(base.dir, { recursive: true, force: true });
            rmSync(space.dir, { recursive: true, force: true });
        }
    });
});

describe("token coverage through the CLI", () => {
    /** The four mini trials' session trails. */
    const trails = [
        "a/results/cc-A-r0-R01/R01/stdout.jsonl",
        "a/results/cc-A-r0-R02/R02/stdout.jsonl",
        "b/results/cc-B-r0-R01/R01/stdout.jsonl",
        "b/results/cc-B-r0-R02/R02/stdout.jsonl",
    ];
    const step = (tokens?: string): string =>
        tokens === undefined
            ? '{"type":"step_finish","part":{}}'
            : `{"type":"step_finish","part":{"tokens":${tokens}}}`;
    const writeTrail = (
        space: Workspace,
        trail: string,
        lines: readonly string[],
    ): void => {
        writeFileSync(join(space.evidence, trail), `${lines.join("\n")}\n`);
    };

    it("counts a step with no token fields as an observed step, not a measured zero", () => {
        // Arrange
        const space = workspace("usage-no-tokens");
        try {
            for (const trail of trails) {
                writeTrail(space, trail, [step(), step(), step(), step()]);
            }

            // Act
            const run = analyse(space);

            // Assert
            assert.equal(run.status, 0, run.stderr);
            const analysis = readJson<Analysis>(
                join(space.out, "analysis.json"),
            );
            assert.equal(analysis.usage.steps, 16);
            assert.equal(analysis.usage.measuredSteps, 0);
            assert.equal(analysis.usage.unknownSteps, 16);
            assert.equal(analysis.usage.measuredTrials, 4);
            assert.equal(analysis.usage.unknownTrials, 0);
            assert.equal(analysis.usage.input, null);
            assert.equal(analysis.usage.output, null);
            const report = readFileSync(join(space.out, "REPORT.md"), "utf8");
            assert.match(report, /\| Steps observed \| 16 \|/);
            assert.match(report, /0 observed step\(s\) measured/);
            assert.match(
                report,
                /16 observed step\(s\) without token telemetry/,
            );
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("keeps explicit zero token counts measured", () => {
        // Arrange
        const space = workspace("usage-explicit-zero");
        const zero = '{"input":0,"output":0,"reasoning":0,"cache":{"read":0}}';
        try {
            for (const trail of trails) {
                writeTrail(space, trail, [
                    step(zero),
                    step(zero),
                    step(zero),
                    step(zero),
                ]);
            }

            // Act
            const run = analyse(space);

            // Assert
            assert.equal(run.status, 0, run.stderr);
            const analysis = readJson<Analysis>(
                join(space.out, "analysis.json"),
            );
            assert.equal(analysis.usage.steps, 16);
            assert.equal(analysis.usage.measuredSteps, 16);
            assert.equal(analysis.usage.unknownSteps, 0);
            assert.equal(analysis.usage.input, 0);
            assert.equal(analysis.usage.output, 0);
            assert.equal(analysis.usage.reasoning, 0);
            assert.equal(analysis.usage.cacheRead, 0);
            const report = readFileSync(join(space.out, "REPORT.md"), "utf8");
            assert.match(report, /16 observed step\(s\) measured/);
            assert.match(
                report,
                /0 observed step\(s\) without token telemetry/,
            );
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("reports a known subtotal with its coverage when telemetry is mixed", () => {
        // Arrange — one trial has four tokenless steps, three keep their
        // measured step data.
        const space = workspace("usage-mixed");
        try {
            writeTrail(space, trails[0]!, [step(), step(), step(), step()]);

            // Act
            const run = analyse(space);

            // Assert
            assert.equal(run.status, 0, run.stderr);
            const analysis = readJson<Analysis>(
                join(space.out, "analysis.json"),
            );
            assert.equal(analysis.usage.steps, 7);
            assert.equal(analysis.usage.measuredSteps, 3);
            assert.equal(analysis.usage.unknownSteps, 4);
            assert.equal(analysis.usage.input, 300);
            assert.equal(analysis.usage.output, 60);
            assert.equal(analysis.usage.reasoning, 0);
            assert.equal(analysis.usage.cacheRead, 30);
            const report = readFileSync(join(space.out, "REPORT.md"), "utf8");
            assert.match(report, /3 observed step\(s\) measured/);
            assert.match(
                report,
                /4 observed step\(s\) without token telemetry/,
            );
            assert.match(
                report,
                /Token totals are subtotals over measured steps/,
            );
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });
});

describe("screening evidence states through the CLI", () => {
    /** Replace one trial's lake trees with the given state. */
    const setLake = (
        space: Workspace,
        beforeDir: string,
        afterDir: string,
        state: "empty" | "absent",
    ): void => {
        if (state === "absent") {
            rmSync(join(space.evidence, afterDir), {
                recursive: true,
                force: true,
            });
            return;
        }
        mkdirSync(join(space.evidence, beforeDir), { recursive: true });
        rmSync(join(space.evidence, afterDir), {
            recursive: true,
            force: true,
        });
        mkdirSync(join(space.evidence, afterDir), { recursive: true });
    };

    it("treats a recorded empty lake as observed and an absent lake as unknown", () => {
        // Arrange
        const empty = workspace("lake-empty");
        const absent = workspace("lake-absent");
        const beforeDir = "a/fixtures/R01/lakes/docs";
        const afterDir = "a/results/cc-A-r0-R01/R01/live/lakes/docs";
        try {
            setLake(empty, beforeDir, afterDir, "empty");
            setLake(absent, beforeDir, afterDir, "absent");

            // Act
            assert.equal(analyse(empty).status, 0);
            assert.equal(analyse(absent).status, 0);

            // Assert
            const observed = readJson<Screening>(
                join(empty.out, "SCREENING.json"),
            );
            const unobserved = readJson<Screening>(
                join(absent.out, "SCREENING.json"),
            );
            assert.equal(
                findingsFor(observed, "cc-A-r0-R01").filter(
                    (finding) =>
                        finding.ruleId === "claim-mutation-contradiction",
                ).length,
                1,
            );
            assert.equal(
                findingsFor(unobserved, "cc-A-r0-R01").filter(
                    (finding) =>
                        finding.ruleId === "claim-mutation-contradiction",
                ).length,
                0,
            );
            const absentAnalysis = readJson<Analysis>(
                join(absent.out, "analysis.json"),
            );
            assert.ok(
                absentAnalysis.limitations.some((line) =>
                    line.includes("missing before/after lake snapshots"),
                ),
            );
        } finally {
            rmSync(empty.dir, { recursive: true, force: true });
            rmSync(absent.dir, { recursive: true, force: true });
        }
    });

    it("wires a recorded mutation policy into the permission finding", () => {
        // Arrange
        const space = workspace("lake-permission");
        const manifest = readJson<{
            scenarios: Array<{
                id: string;
                mutationPolicy?: {
                    allowed: string[];
                    visibleConstraints: string[];
                };
            }>;
        }>(space.manifest);
        const scenario = manifest.scenarios.find((one) => one.id === "R01");
        assert.ok(scenario);
        scenario.mutationPolicy = {
            allowed: ["work/.tmp/**"],
            visibleConstraints: ["Remove the stale runtime artifact."],
        };
        writeFileSync(space.manifest, `${JSON.stringify(manifest, null, 4)}\n`);
        try {
            // Act
            const run = analyse(space);

            // Assert
            assert.equal(run.status, 0, run.stderr);
            const screening = readJson<Screening>(
                join(space.out, "SCREENING.json"),
            );
            const permission = findingsFor(screening, "cc-A-r0-R01").find(
                (finding) => finding.category === "permission-visibility",
            );
            assert.ok(permission);
            assert.equal(permission.visibility, "hidden");
            assert.equal(permission.role, "writes");
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });
});
