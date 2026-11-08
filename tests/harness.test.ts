#!/usr/bin/env node
/**
 * Black-box regression suite for the placement harness (harness.mjs) and
 * its container wrapper (container-run.sh). No network, no models: every
 * trial session or judge call is a generated fake OpenCode binary that
 * emits canned CLI-shaped JSONL, so the full CLI surface is exercised the
 * way production invokes it while staying deterministic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, "fixtures", "placement-harness", "harness.mjs");
const WRAPPER = join(HERE, "fixtures", "placement-harness", "container-run.sh");

/** Extra env for a harness or wrapper invocation; undefined values deleted. */
type Env = Record<string, string | undefined>;

/** Options for the generate() helper. */
interface GenerateOptions {
    corpusName?: string;
    ids?: string[];
    force?: boolean;
    model?: string;
    env?: Env;
}

let rootSequence = 0;
const newRoot = (label: string): string => {
    rootSequence += 1;
    const prefix = "harness-" + rootSequence + "-" + label + "-";
    // /tmp/opencode is the sanctioned scratch area on this machine; other
    // environments (a gate container where it is absent) fall back to the
    // process tmpdir. The probe genuinely attempts a temp root there so an
    // existing-but-unwritable area is not silently trusted.
    try {
        const created = mkdtempSync("/tmp/opencode/probe-" + prefix.slice(0, 12));
        rmSync(created, { recursive: true, force: true });
        return mkdtempSync("/tmp/opencode/" + prefix);
    } catch {
        return mkdtempSync(join(tmpdirTempDirectory(), prefix));
    }
};

/** The process scratch root, cached: tmpdir() itself is ambient-safe. */
const tmpdirTempDirectory = (): string => tmpdir();

/** A minimal baseline-compatible case with a non-E id. */
const baselineCase = (id: string) => ({
    id,
    claim: "A synthetic claim for " + id + ".",
    evidence: "The harness source and its probe for " + id + ".",
    destinations: [
        {
            name: "docs",
            class: "repo",
            description: "This repository's decisions and traps.",
        },
        {
            name: "doclake",
            class: "machine",
            description: "Personal tooling and devices.",
        },
    ],
    expected: "Repository",
    accepts: ["A repo decision of this codebase."],
    temptingWrong: ["Personal because the author decided it at their desk."],
});

const writeCorpus = (root: string, cases: unknown[], name?: string) => {
    const path = join(root, name ?? "cases.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cases, null, 2) + "\n");
    return path;
};

const file = (root: string, name: string, contents: string) => {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    return path;
};

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const layout = (root: string) => ({
    prompts: join(root, "prompts"),
    fixtures: join(root, "fixtures"),
    rubrics: join(root, "rubrics"),
    results: join(root, "results"),
    corpus: join(root, "cases.json"),
});

/** Answer JSONL: one final text part. */
const ANSWER_JSONL = (text?: string) =>
    JSON.stringify({
        part: { type: "text", text: text ?? "Intended: the repo lake." },
    }) + "\n";

const VERDICT_JSONL = (overrides?: Record<string, string>) => {
    const verdict = {
        verdict: "pass",
        destination: "docs",
        documents: "one",
        clarification: "no",
        reason: "matches the rubric",
        ...(overrides ?? {}),
    };
    return '{"part":{"type":"text","text":' + JSON.stringify(JSON.stringify(verdict)) + '}}\n';
};

/** Events JSONL the harness parses as CLI echo; one tool call line each. */
const TOOL_JSONL = (tool: string, id: string, status: string, input: unknown, output?: string) =>
    JSON.stringify({
        part: { type: "tool", id, tool, state: { status, input, output } },
    }) + "\n";

// The fake OpenCode binary. Env-var interpolation is done by the shell with
// the literal "${VAR:-}" forms kept intact — assembled from plain strings so
// JS templating cannot mangle them.
const FAKE_OPENCODE_LINES = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "fake-opencode-1.2.3"; exit 0; fi',
    'title=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "--title" ]; then title="$a"; fi',
    '  prev="$a"',
    "done",
    'case "$title" in',
    "  placement-judge-*)",
    '    [ -n "$FAKE_JUDGE_OUT" ] && cat "$FAKE_JUDGE_OUT"',
    '    [ -n "$FAKE_JUDGE_ERR" ] && cat "$FAKE_JUDGE_ERR" >&2',
    '    [ -n "$FAKE_JUDGE_HOOK" ] && sh "$FAKE_JUDGE_HOOK"',
    '    [ -n "$FAKE_JUDGE_DELAY" ] && exec sleep "$FAKE_JUDGE_DELAY"',
    '    exit "${FAKE_JUDGE_EXIT:-0}" ;;',
    "  placement-*)",
    '    case "$title" in',
    '      *"$FAKE_FAIL_CASE"*) [ -n "$FAKE_FAIL_CASE" ] && exit "${FAKE_FAIL_CASE_EXIT:-3}" ;;',
    "    esac",
    '    [ -n "$FAKE_TRIAL_OUT" ] && cat "$FAKE_TRIAL_OUT"',
    '    [ -n "$FAKE_TRIAL_ERR" ] && cat "$FAKE_TRIAL_ERR" >&2',
    '    [ -n "$FAKE_TRIAL_HOOK" ] && sh "$FAKE_TRIAL_HOOK"',
    '    [ -n "$FAKE_TRIAL_DELAY" ] && exec sleep "$FAKE_TRIAL_DELAY"',
    '    exit "${FAKE_TRIAL_EXIT:-0}" ;;',
    "esac",
];

const writeFakeOpencode = (root: string) => {
    const path = file(root, "fake-opencode", FAKE_OPENCODE_LINES.join("\n") + "\n");
    chmodSync(path, 0o755);
    return path;
};

/** Env for a harness invocation; deletes undefined entries. */
function envFor(root: string, fake: string, extra: Env = {}): Env {
    const env: Env = {
        ...process.env,
        OPENCODE_BIN: fake,
        TRIAL_TIMEOUT_MS: extra.TRIAL_TIMEOUT_MS ?? "8000",
        ...extra,
    };
    for (const key of Object.keys(env)) {
        if (env[key] === undefined) delete env[key];
    }
    return env;
}

/** Run the harness exactly as production does: as a subprocess. */
const runHarness = (root: string, fake: string, args: string[], extraEnv: Env = {}) =>
    spawnSync(process.execPath, [HARNESS, ...args], {
        cwd: root,
        encoding: "utf8",
        env: envFor(root, fake, extraEnv),
    });

/** Generate one corpus; the corpus name decides whether a test shares it. */
function generate(root: string, fake: string, cases: unknown[], options: GenerateOptions = {}) {
    const paths = layout(root);
    const corpusPath = writeCorpus(root, cases, options.corpusName);
    const argv = [
        "generate",
        ...(options.ids ?? cases.map((entry) => (entry as { id: string }).id)),
        "--fixture", corpusPath,
        "--prompts", paths.prompts,
        "--fixtures", paths.fixtures,
        "--rubrics", paths.rubrics,
        "--results", paths.results,
    ];
    if (options.force === true) argv.push("--force");
    if (options.model) argv.push("--model", options.model);
    const result = runHarness(root, fake, argv, options.env);
    return { paths, corpusPath, result };
}

/** The standard argv set for a non-generate harness command. */
const commandArgs = (paths: ReturnType<typeof layout>) => [
    "--fixture", paths.corpus,
    "--prompts", paths.prompts,
    "--fixtures", paths.fixtures,
    "--rubrics", paths.rubrics,
    "--results", paths.results,
];

const rmRoot = (root: string) => rmSync(root, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * F08 — invalid answers are rejected before any semantic judge
 * ------------------------------------------------------------------ */

test("F08: blank successful trial is invalid evidence, not a placement answer", () => {
    const root = newRoot("f08-blank");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const emptyOut = file(root, "empty.jsonl", "");
    const run = runHarness(
        root, fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: emptyOut },
    );
    assert.notEqual(run.status, 0, "an infrastructure failure must fail the sweep");
    const caseDir = join(paths.results, "s1", "T01");
    // Partial evidence is preserved, never discarded.
    assert.ok(existsSync(join(caseDir, "final.md")));
    assert.ok(existsSync(join(caseDir, "stdout.jsonl")));
    const meta = readJson(join(caseDir, "meta.json"));
    assert.equal(meta.answerValid, false);
    assert.equal(meta.invalidReason, "trial produced a blank answer");
    // Judging rejects the run deterministically, without calling the model.
    const marker = file(root, "judge-invoked", "");
    const judge = runHarness(
        root, fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()), FAKE_JUDGE_HOOK: markerHook(root, marker) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(caseDir, "verdict.json"));
    assert.equal(verdict.verdict, "invalid");
    assert.equal(readFileSync(marker, "utf8"), "", "judge binary must not be invoked");
    rmRoot(root);
});

test("F08: whitespace-only answer is invalid", () => {
    const root = newRoot("f08-ws");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const run = runHarness(
        root, fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "ws.jsonl", ANSWER_JSONL("   \n\t")) },
    );
    assert.notEqual(run.status, 0);
    const meta = readJson(join(paths.results, "s1", "T01", "meta.json"));
    assert.equal(meta.invalidReason, "trial produced a blank answer");
    rmRoot(root);
});

test("F08: unparsable stdout with exit 0 is invalid (no completion evidence)", () => {
    const root = newRoot("f08-garbage");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const run = runHarness(
        root, fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "garbage.jsonl", "this is not json\n") },
    );
    assert.notEqual(run.status, 0);
    const meta = readJson(join(paths.results, "s1", "T01", "meta.json"));
    assert.equal(meta.invalidReason, "trial produced no parsable completion events");
    assert.equal(meta.telemetry.parseFailures, 1);
    rmRoot(root);
});

test("F08: nonzero trial exit with text is a failing run and an invalid judge", () => {
    const root = newRoot("f08-exit7");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const run = runHarness(
        root, fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()), FAKE_TRIAL_EXIT: "7" },
    );
    assert.notEqual(run.status, 0);
    const meta = readJson(join(paths.results, "s1", "T01", "meta.json"));
    assert.equal(meta.exit, 7);
    assert.equal(meta.invalidReason, "trial did not complete (exit 7)");
    const marker = file(root, "judge-invoked", "");
    const judge = runHarness(
        root, fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_HOOK: markerHook(root, marker) },
    );
    assert.notEqual(judge.status, 0);
    assert.equal(readJson(join(paths.results, "s1", "T01", "verdict.json")).verdict, "invalid");
    assert.equal(readFileSync(marker, "utf8"), "");
    rmRoot(root);
});

test("F08: timed-out trial is invalid and reports the timeout", () => {
    const root = newRoot("f08-timeout");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const run = runHarness(
        root, fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            FAKE_TRIAL_DELAY: "5",
            TRIAL_TIMEOUT_MS: "400",
        },
    );
    assert.notEqual(run.status, 0);
    const meta = readJson(join(paths.results, "s1", "T01", "meta.json"));
    assert.equal(meta.timedOut, true);
    assert.match(meta.invalidReason, /timed out after 400 ms/);
    rmRoot(root);
});

test("F08: mixed selection keeps the good case judgeable and fails the sweep", () => {
    const root = newRoot("f08-mixed");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01"), baselineCase("T02")]);
    // One sweep, two cases: the fake fails only the case named in
    // FAKE_FAIL_CASE, so the aggregate failure is a per-case outcome.
    const run = runHarness(
        root, fake,
        ["run", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            FAKE_FAIL_CASE: "T02",
        },
    );
    assert.notEqual(run.status, 0);
    assert.ok(existsSync(join(paths.results, "s1", "T02", "meta.json")), "bad case still recorded");
    const judge = runHarness(
        root, fake,
        ["judge", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0, "aggregate status must fail with one invalid case");
    const t01 = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    const t02 = readJson(join(paths.results, "s1", "T02", "verdict.json"));
    assert.equal(t01.verdict, "pass");
    assert.equal(t02.verdict, "invalid");
    rmRoot(root);
});

/** A hook that appends one line per invocation to the marker file. */
function markerHook(root: string, marker: string) {
    return file(root, "marker-hook.sh", 'echo invoked >> "' + marker + '"\n');
}

/* ------------------------------------------------------------------ *
 * F03 — generation fingerprints: reuse only a matching generation
 * ------------------------------------------------------------------ */

test("F03: unchanged regeneration is kept", () => {
    const root = newRoot("f03-kept");
    const fake = writeFakeOpencode(root);
    const first = generate(root, fake, [baselineCase("T01")]);
    assert.equal(first.result.status, 0);
    const second = generate(root, fake, [baselineCase("T01")]);
    assert.equal(second.result.status, 0);
    assert.match(second.result.stdout, /T01: kept/);
    assert.ok(existsSync(join(first.paths.fixtures, "T01", "generation.json")));
    rmRoot(root);
});

test("F03: changed case inputs refuse without --force and leave fixtures untouched", () => {
    const root = newRoot("f03-stale");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const promptBefore = readFileSync(join(paths.prompts, "T01.md"), "utf8");
    const changed = baselineCase("T01");
    changed.claim = "A DIFFERENT claim that must invalidate the generation.";
    const second = generate(root, fake, [changed]);
    assert.equal(second.result.status, 1);
    assert.match(second.result.stdout, /T01: stale/);
    assert.match(second.result.stdout, /--force/);
    assert.equal(readFileSync(join(paths.prompts, "T01.md"), "utf8"), promptBefore);
    rmRoot(root);
});

test("F03: deleted rubric output is incomplete, not silently kept", () => {
    const root = newRoot("f03-partial");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    rmSync(join(paths.rubrics, "T01", "rubric.md"));
    const second = generate(root, fake, [baselineCase("T01")]);
    assert.equal(second.result.status, 1);
    assert.match(second.result.stdout, /T01: incomplete/);
    rmRoot(root);
});

test("F03: a different plugin identity refuses reuse", () => {
    const root = newRoot("f03-plugin");
    const fake = writeFakeOpencode(root);
    generate(root, fake, [baselineCase("T01")]);
    const otherPlugin = join(root, "other-plugin");
    mkdirSync(join(otherPlugin, "src"), { recursive: true });
    writeFileSync(join(otherPlugin, "package.json"), "{}\n");
    writeFileSync(join(otherPlugin, "src", "index.ts"), "// different\n");
    const second = runHarness(root, fake, [
        "generate", "T01",
        "--plugin", otherPlugin,
        "--fixture", join(root, "cases.json"),
        "--prompts", join(root, "prompts"),
        "--fixtures", join(root, "fixtures"),
        "--rubrics", join(root, "rubrics"),
        "--results", join(root, "results"),
    ]);
    assert.equal(second.status, 1);
    assert.match(second.stdout, /stale/);
    rmRoot(root);
});

test("F03: --force recreates with a fresh fingerprint", () => {
    const root = newRoot("f03-force");
    const fake = writeFakeOpencode(root);
    const first = generate(root, fake, [baselineCase("T01")]);
    const hashBefore = readJson(join(first.paths.fixtures, "T01", "generation.json")).inputsHash;
    const changed = baselineCase("T01");
    changed.claim = "A DIFFERENT claim for the forced regeneration.";
    const second = generate(root, fake, [changed], { force: true });
    assert.equal(second.result.status, 0);
    assert.match(second.result.stdout, /T01: created/);
    const hashAfter = readJson(join(first.paths.fixtures, "T01", "generation.json")).inputsHash;
    assert.notEqual(hashAfter, hashBefore);
    assert.match(readFileSync(join(first.paths.prompts, "T01.md"), "utf8"), /DIFFERENT/);
    rmRoot(root);
});

test("F03: a run refuses a missing prompt instead of regenerating it", () => {
    const root = newRoot("f03-missing");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    rmSync(join(paths.prompts, "T01.md"));
    const run = runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no prompt generated/);
    assert.ok(!existsSync(join(paths.prompts, "T01.md")), "run must not regenerate");
    rmRoot(root);
});

test("F03: a run refuses a tampered prompt (generation identity mismatch)", () => {
    const root = newRoot("f03-tamper");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    writeFileSync(join(paths.prompts, "T01.md"), "TAMPERED PROMPT\n");
    const run = runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not match the recorded generation/);
    rmRoot(root);
});

test("F03: a run refuses a tampered fixture config", () => {
    const root = newRoot("f03-config");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    writeFileSync(join(paths.fixtures, "T01", "work", "opencode.json"), "{}\n");
    const run = runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not match the recorded generation/);
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * F06 — stamp resolution: explicit, or latest by creation metadata
 * ------------------------------------------------------------------ */

test("F06: absent results root and empty root are clear errors", () => {
    const root = newRoot("f06-absent");
    const fake = writeFakeOpencode(root);
    const paths = layout(root);
    writeCorpus(root, [baselineCase("T01")]);
    const noRoot = runHarness(root, fake, ["summary", ...commandArgs(paths)]);
    assert.equal(noRoot.status, 2);
    assert.match(noRoot.stderr, /no results root/);
    mkdirSync(paths.results, { recursive: true });
    const noStamps = runHarness(root, fake, ["summary", ...commandArgs(paths)]);
    assert.equal(noStamps.status, 2);
    assert.match(noStamps.stderr, /no result stamps/);
    rmRoot(root);
});

test("F06: latest resolves by creation order, never name order", () => {
    const root = newRoot("f06-latest");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    // "zebra" is created FIRST but sorts AFTER "alpha": name order would
    // pick zebra, creation order must pick alpha.
    for (const stamp of ["zebra", "alpha"]) {
        const run = runHarness(root, fake, [
            "run", "T01", "--stamp", stamp, ...commandArgs(paths),
        ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) });
        assert.equal(run.status, 0);
    }
    const summary = runHarness(root, fake, ["summary", ...commandArgs(paths)]);
    assert.equal(summary.status, 0);
    assert.match(summary.stdout, /# Placement trial alpha/);
    const judge = runHarness(root, fake, [
        "judge", ...commandArgs(paths),
    ], { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) });
    assert.equal(judge.status, 0);
    assert.ok(existsSync(join(paths.results, "alpha", "T01", "verdict.json")));
    rmRoot(root);
});

test("F06: explicit --stamp must name an existing run", () => {
    const root = newRoot("f06-explicit");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) });
    const missing = runHarness(root, fake, ["summary", "--stamp", "nope", ...commandArgs(paths)]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no results at/);
    const good = runHarness(root, fake, ["summary", "--stamp", "s1", ...commandArgs(paths)]);
    assert.equal(good.status, 0);
    assert.match(good.stdout, /# Placement trial s1/);
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * F02 — reports render frozen run descriptions, never current inputs
 * ------------------------------------------------------------------ */

/** Per-experiment sub-layout so two experiments never share fixture roots. */
const expLayout = (root: string, name: string) => ({
    prompts: join(root, name, "prompts"),
    fixtures: join(root, name, "fixtures"),
    rubrics: join(root, name, "rubrics"),
    results: join(root, "results"),
    corpus: join(root, name, "cases.json"),
});

test("F02: a later experiment cannot relabel an earlier stamp", () => {
    const root = newRoot("f02-freeze");
    const fake = writeFakeOpencode(root);
    // Experiment A: model M1, corpus C1, plugin copy P1.
    const pluginA = join(root, "pluginA");
    mkdirSync(join(pluginA, "src"), { recursive: true });
    writeFileSync(join(pluginA, "package.json"), "{}\n");
    writeFileSync(join(pluginA, "src", "index.ts"), "// plugin A\n");
    writeFileSync(join(pluginA, "src", "SKILL.md"), "# skill A\n");
    writeFileSync(join(pluginA, "CONVENTION.md"), "# convention A\n");
    const expA = expLayout(root, "expA");
    writeCorpus(root, [baselineCase("T01")], "expA/cases.json");
    const baseA = ["--fixture", expA.corpus, "--prompts", expA.prompts,
        "--fixtures", expA.fixtures, "--rubrics", expA.rubrics, "--results", expA.results,
        "--plugin", pluginA, "--model", "provider/model-one"];
    assert.equal(runHarness(root, fake, ["generate", "T01", ...baseA]).status, 0);
    assert.equal(runHarness(root, fake, ["run", "T01", "--stamp", "stampA", ...baseA],
        { FAKE_TRIAL_OUT: file(root, "trialA.jsonl", ANSWER_JSONL()) }).status, 0);

    // Experiment B: different model, edited corpus (expected changed, extra
    // case), different plugin content — into fresh fixture roots.
    const pluginB = join(root, "pluginB");
    mkdirSync(join(pluginB, "src"), { recursive: true });
    writeFileSync(join(pluginB, "package.json"), "{}\n");
    writeFileSync(join(pluginB, "src", "index.ts"), "// plugin B\n");
    writeFileSync(join(pluginB, "src", "SKILL.md"), "# skill B\n");
    writeFileSync(join(pluginB, "CONVENTION.md"), "# convention B — EDITED\n");
    const changed = baselineCase("T01");
    changed.expected = "Personal";
    const expB = expLayout(root, "expB");
    writeCorpus(root, [changed, baselineCase("T99")], "expB/cases.json");
    const baseB = ["--fixture", expB.corpus, "--prompts", expB.prompts,
        "--fixtures", expB.fixtures, "--rubrics", expB.rubrics, "--results", expB.results,
        "--plugin", pluginB, "--model", "provider/model-two"];
    assert.equal(runHarness(root, fake, ["generate", ...baseB]).status, 0);
    assert.equal(runHarness(root, fake, ["run", "T99", "--stamp", "stampB", ...baseB],
        { FAKE_TRIAL_OUT: file(root, "trialB.jsonl", ANSWER_JSONL()) }).status, 0);

    // Report stamp A with B's roots and current inputs in play: every label
    // must come from A's own frozen run.json.
    const summary = runHarness(root, fake, ["summary", "--stamp", "stampA", ...baseB]);
    assert.equal(summary.status, 0);
    assert.match(summary.stdout, /Model: provider\/model-one/);
    assert.match(summary.stdout, /\| T01 \| Repository \|/);
    assert.doesNotMatch(summary.stdout, /T99/);
    assert.doesNotMatch(summary.stdout, /model-two/);
    const exportRun = runHarness(root, fake, ["export", "--stamp", "stampA", ...baseB]);
    assert.equal(exportRun.status, 0);
    const dossier = readFileSync(join(expB.results, "stampA", "dossier.md"), "utf8");
    assert.match(dossier, /Trial model: provider\/model-one/);
    assert.match(dossier, /Expected: Repository/);
    assert.doesNotMatch(dossier, /model-two/);

    // Stamp B renders with its own labels from the same shared results root.
    const summaryB = runHarness(root, fake, ["summary", "--stamp", "stampB", ...baseB]);
    assert.match(summaryB.stdout, /Model: provider\/model-two/);
    assert.match(summaryB.stdout, /\| T99 \| Repository \|/);
    rmRoot(root);
});

test("F02: container boundary is recorded when the run saw an image", () => {
    const root = newRoot("f02-boundary");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const run = runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], {
        FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
        PLACEMENT_IMAGE: "localhost/trial-image:latest",
        PLACEMENT_IMAGE_ID: "sha256:fake",
    });
    assert.equal(run.status, 0);
    const runJson = readJson(join(paths.results, "s1", "run.json"));
    assert.equal(runJson.boundary.containerised, true);
    assert.equal(runJson.boundary.image, "localhost/trial-image:latest");
    const summary = runHarness(root, fake, ["summary", "--stamp", "s1", ...commandArgs(paths)]);
    assert.match(summary.stdout, /Boundary: container/);
    rmRoot(root);
});

test("F02: dirty plugin identity is content-reproducible", () => {
    const root = newRoot("f02-dirty");
    const fake = writeFakeOpencode(root);
    const dirtyPlugin = join(root, "dirty-plugin");
    mkdirSync(join(dirtyPlugin, "src"), { recursive: true });
    writeFileSync(join(dirtyPlugin, "package.json"), "{}\n");
    writeFileSync(join(dirtyPlugin, "src", "index.ts"), "// dirty content\n");
    const withSkill = (text: string) => {
        writeFileSync(join(dirtyPlugin, "src", "SKILL.md"), text);
        return dirtyPlugin;
    };
    const paths = layout(root);
    writeCorpus(root, [baselineCase("T01")]);
    const base = (plugin: string) => ["--fixture", paths.corpus, "--prompts", paths.prompts,
        "--fixtures", paths.fixtures, "--rubrics", paths.rubrics, "--results", paths.results,
        "--plugin", plugin];
    for (const stamp of ["d1", "d2"]) {
        withSkill("# skill v1\n");
        assert.equal(runHarness(root, fake, ["generate", "T01", "--force", ...base(dirtyPlugin)]).status, 0);
        assert.equal(runHarness(root, fake, ["run", "T01", "--stamp", stamp, ...base(dirtyPlugin)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) }).status, 0);
    }
    const hash1 = readJson(join(paths.results, "d1", "run.json")).provenance.pluginHash;
    const hash2 = readJson(join(paths.results, "d2", "run.json")).provenance.pluginHash;
    assert.equal(hash1, hash2, "same content must produce the same identity");
    withSkill("# skill v2 — edited\n");
    assert.equal(runHarness(root, fake, ["generate", "T01", "--force", ...base(dirtyPlugin)]).status, 0);
    assert.equal(runHarness(root, fake, ["run", "T01", "--stamp", "d3", ...base(dirtyPlugin)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) }).status, 0);
    const hash3 = readJson(join(paths.results, "d3", "run.json")).provenance.pluginHash;
    assert.notEqual(hash3, hash1, "edited guidance must change the identity");
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * F04 — mutation snapshot: final state, symlink-aware, policy-gated
 * ------------------------------------------------------------------ */

/** A recording case whose policy allows writes under lakes/kb only. */
function recordingCase(id: string, extra: Record<string, unknown> = {}) {
    const base = baselineCase(id);
    return {
        ...base,
        seeds: [
            {
                surface: "lakes",
                path: "kb/existing.md",
                contents: "# Existing\n\n## Facts\n\n- prior knowledge\n",
            },
            ...("seeds" in extra ? (extra.seeds as unknown[]) : []),
        ],
        mutationPolicy: extra.mutationPolicy ?? { allowed: ["lakes/kb/**"] },
        ...("docsCriterion" in extra ? { docsCriterion: extra.docsCriterion as unknown } : {}),
    };
}

test("F04: symlink and config-home mutations are detected with kinds", () => {
    const root = newRoot("f04-symlinks");
    const fake = writeFakeOpencode(root);
    const hook = file(root, "mutate.sh", [
        "#!/bin/sh",
        'ln -s /etc/hostname ./work-link',
        'echo state > ../config-home/unexpected.txt',
    ].join("\n") + "\n");
    const { paths } = generate(root, fake, [recordingCase("T01")]);
    const run = runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()), FAKE_TRIAL_HOOK: hook });
    assert.equal(run.status, 0);
    const caseDir = join(paths.results, "s1", "T01");
    const writes = readFileSync(join(caseDir, "writes.txt"), "utf8");
    assert.match(writes, /added: work\/[-\w]+ \(symlink\)/);
    assert.match(writes, /added: config-home\/unexpected\.txt \(file\)/);
    const meta = readJson(join(caseDir, "meta.json"));
    assert.ok(meta.writes >= 2);
    rmRoot(root);
});

test("F04: file-to-symlink replacement and retargeting are kind changes", () => {
    const root = newRoot("f04-retarget");
    const fake = writeFakeOpencode(root);
    const hook = file(root, "mutate.sh", [
        "#!/bin/sh",
        'rm ../lakes/kb/existing.md',
        'ln -s /etc/hostname ../lakes/kb/existing.md',
    ].join("\n") + "\n");
    const { paths } = generate(root, fake, [recordingCase("T01")]);
    const run = runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()), FAKE_TRIAL_HOOK: hook });
    assert.equal(run.status, 0);
    const writes = readFileSync(join(paths.results, "s1", "T01", "writes.txt"), "utf8");
    assert.match(writes, /modified: lakes\/kb\/existing\.md \(kind\)/);
    rmRoot(root);
});

test("F04: git-state changes are reported separately from trial writes", () => {
    const root = newRoot("f04-git");
    const fake = writeFakeOpencode(root);
    const hook = file(root, "mutate.sh", [
        "#!/bin/sh",
        'mkdir -p .git/refs/heads',
        'echo 0000000000000000000000000000000000000000 > .git/refs/heads/master',
    ].join("\n") + "\n");
    const { paths } = generate(root, fake, [recordingCase("T01")]);
    const run = runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()), FAKE_TRIAL_HOOK: hook });
    assert.equal(run.status, 0);
    const caseDir = join(paths.results, "s1", "T01");
    const writes = readFileSync(join(caseDir, "writes.txt"), "utf8");
    assert.match(writes, /git: work\/\.git\/refs\/heads\/master/);
    const meta = readJson(join(caseDir, "meta.json"));
    assert.equal(meta.writes, 0, "git state is not a trial write");
    assert.equal(meta.gitStateChanges, 1);
    rmRoot(root);
});

test("F04: in-policy writes judge; out-of-policy writes invalidate despite --allow-writes", () => {
    const root = newRoot("f04-policy");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [recordingCase("T01")]);

    // In-policy: editing the seeded lake doc is permitted by the policy.
    const inPolicy = file(root, "in-policy.sh", [
        "#!/bin/sh",
        'echo "- fresh knowledge" >> ../lakes/kb/existing.md',
    ].join("\n") + "\n");
    assert.equal(runHarness(root, fake, [
        "run", "T01", "--stamp", "ok", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()), FAKE_TRIAL_HOOK: inPolicy }).status, 0);
    const judgeOk = runHarness(root, fake, [
        "judge", "T01", "--stamp", "ok", ...commandArgs(paths),
    ], { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) });
    assert.equal(judgeOk.status, 0);
    assert.equal(readJson(join(paths.results, "ok", "T01", "verdict.json")).verdict, "pass");

    // Out-of-policy: a work-tree file is outside the recording surface, and
    // --allow-writes must not excuse it for a policy-bearing case.
    const outPolicy = file(root, "out-policy.sh", [
        "#!/bin/sh",
        'echo stray > ./stray.txt',
    ].join("\n") + "\n");
    assert.equal(runHarness(root, fake, [
        "run", "T01", "--stamp", "bad", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()), FAKE_TRIAL_HOOK: outPolicy }).status, 0);
    const judgeBad = runHarness(root, fake, [
        "judge", "T01", "--stamp", "bad", "--allow-writes", ...commandArgs(paths),
    ], { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) });
    assert.notEqual(judgeBad.status, 0);
    const verdict = readJson(join(paths.results, "bad", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /outside its policy/);
    rmRoot(root);
});

test("F04: decision-only baseline keeps the legacy --allow-writes semantics", () => {
    const root = newRoot("f04-legacy");
    const fake = writeFakeOpencode(root);
    const hook = file(root, "mutate.sh", '#!/bin/sh\necho stray > ./stray.txt\n');
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    assert.equal(runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()), FAKE_TRIAL_HOOK: hook }).status, 0);
    const strict = runHarness(root, fake, [
        "judge", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) });
    assert.notEqual(strict.status, 0);
    assert.equal(
        readJson(join(paths.results, "s1", "T01", "verdict.json")).verdict,
        "invalid",
    );
    const lenient = runHarness(root, fake, [
        "judge", "T01", "--stamp", "s1", "--allow-writes", "--judge-model", "x/lenient", ...commandArgs(paths),
    ], { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) });
    assert.equal(lenient.status, 0, "legacy baseline stays judgeable with the flag");
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * F07 — telemetry: dedup, twin and code-mode visibility, honest gaps
 * ------------------------------------------------------------------ */

test("F07: trail is deduplicated by call id and classified by surface", () => {
    const root = newRoot("f07-trail");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const trail = [
        ANSWER_JSONL("Intended: the repo lake, after checking docs."),
        // Native docs call, emitted twice (pending then completed): one call.
        TOOL_JSONL("docs", "call-1", "pending", { search: "placement" }, undefined),
        TOOL_JSONL("docs", "call-1", "completed", { search: "placement" }, "3 results"),
        // The Code Mode twin's registration name surfacing natively.
        TOOL_JSONL("docs_search", "call-2", "completed", { read: "kb/x.md" }, "contents"),
        // A code-mode attempt: the nested docs op is NOT separately observed.
        TOOL_JSONL("execute", "call-3", "completed",
            { code: "const r = await tools.docs.docs_search({search:'x'}); return r;" },
            "done"),
        // A failed docs probe: attempted, not a successful exposure.
        TOOL_JSONL("docs", "call-4", "error", { read: "rubric.md" }, "denied"),
        "this line is not json\n",
    ].join("");
    const run = runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trail.jsonl", trail) });
    assert.equal(run.status, 0);
    const caseDir = join(paths.results, "s1", "T01");
    const toolsLines = readFileSync(join(caseDir, "tools.jsonl"), "utf8")
        .split("\n").filter(Boolean);
    assert.equal(toolsLines.length, 4, "one line per unique call id");
    const telemetry = readJson(join(caseDir, "meta.json")).telemetry;
    assert.equal(telemetry.nativeDocs, 2);
    assert.equal(telemetry.twinDocs, 1);
    assert.equal(telemetry.codeModeAttempted, 1);
    assert.equal(telemetry.executeCalls, 1);
    assert.equal(telemetry.parseFailures, 1);
    assert.equal(telemetry.statuses.error, 1);
    assert.equal(telemetry.statuses.completed, 3);
    // The summary renders the composition, not one opaque number.
    const summary = runHarness(root, fake, ["summary", "--stamp", "s1", ...commandArgs(paths)]);
    assert.match(summary.stdout, /1 native\+1 twin\+1 code-mode|2 native\+1 twin\+1 code-mode/);
    // The failed rubric read is labelled an attempt, never a successful leak.
    assert.match(summary.stdout, /rubric-case \(attempt\)/);
    rmRoot(root);
});

test("F07: a code-mode attempt is not claimed as a verified nested docs call", () => {
    const root = newRoot("f07-cm");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const trail = [
        ANSWER_JSONL(),
        TOOL_JSONL("execute", "call-1", "completed",
            { code: "tools.docs.docs_search({search: 'help'})" }, "ok"),
    ].join("");
    runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trail.jsonl", trail) });
    const telemetry = readJson(join(paths.results, "s1", "T01", "meta.json")).telemetry;
    assert.equal(telemetry.codeModeAttempted, 1);
    assert.equal(telemetry.nativeDocs, 0);
    assert.equal(telemetry.verbs.help, 1, "the help verb is read from the code text");
    rmRoot(root);
});

test("F07: an absent trail renders unknown, not zero", () => {
    const root = newRoot("f07-absent");
    const fake = writeFakeOpencode(root);
    const paths = layout(root);
    // A legacy-shaped result dir with an answer but no tools.jsonl.
    mkdirSync(join(paths.results, "old", "T01"), { recursive: true });
    writeFileSync(join(paths.results, "old", "T01", "final.md"), "answer\n");
    const summary = runHarness(root, fake, ["summary", "--stamp", "old", ...commandArgs(paths)]);
    assert.equal(summary.status, 0);
    assert.match(summary.stdout, /\| - \|/, "Docs column shows unknown");
    assert.match(summary.stdout, /no trail/);
    rmRoot(root);
});

test("F07: a truncated dossier trail advertises the truncation", () => {
    const root = newRoot("f07-trunc");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const manyCalls = [];
    for (let i = 0; i < 18; i += 1) {
        manyCalls.push(TOOL_JSONL("read", "call-" + i, "completed", { path: "/x" + i }, "ok"));
    }
    const trail = ANSWER_JSONL() + manyCalls.join("");
    runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trail.jsonl", trail) });
    runHarness(root, fake, ["export", "--stamp", "s1", ...commandArgs(paths)]);
    const dossier = readFileSync(join(paths.results, "s1", "dossier.md"), "utf8");
    assert.match(dossier, /projection is truncated; tools\.jsonl is the authoritative full trail/);
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * F12 — one explicitly selected corpus drives every phase
 * ------------------------------------------------------------------ */

test("F12: a custom corpus id namespace runs end to end", () => {
    const root = newRoot("f12-custom");
    const fake = writeFakeOpencode(root);
    const custom = baselineCase("R01");
    custom.expected = "Personal";
    const { paths } = generate(root, fake, [custom]);
    assert.equal(runHarness(root, fake, [
        "run", "R01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) }).status, 0);
    const judge = runHarness(root, fake, [
        "judge", "R01", "--stamp", "s1", ...commandArgs(paths),
    ], {
        FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL({ verdict: "fail", destination: "doclake" })),
    });
    assert.equal(judge.status, 1);
    const summary = runHarness(root, fake, ["summary", "--stamp", "s1", ...commandArgs(paths)]);
    assert.match(summary.stdout, /\| R01 \| Personal \| fail \| doclake \|/);
    rmRoot(root);
});

test("F12: the redacted run corpus validates a prepared generation and keeps provenance whole", () => {
    const root = newRoot("f12-redacted");
    const fake = writeFakeOpencode(root);
    const case1 = recordingCase("R01");
    const { paths } = generate(root, fake, [case1]);
    // The wrapper freezes the run description host-side with the FULL corpus.
    const describe = runHarness(root, fake, [
        "describe", "--stamp", "s1", ...commandArgs(paths),
    ]);
    assert.equal(describe.status, 0);
    // The in-container kernel: an id-only redacted corpus (with the
    // instrumentation fields) selecting the same prepared generation.
    const redacted = writeCorpus(root, [{
        id: "R01",
        mutationPolicy: case1.mutationPolicy,
        docsCriterion: null,
    }], "redacted.json");
    const run = runHarness(root, fake, [
        "run", "R01", "--stamp", "s1",
        "--fixture", redacted,
        "--prompts", paths.prompts,
        "--fixtures", paths.fixtures,
        "--rubrics", paths.rubrics,
        "--results", paths.results,
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) });
    assert.equal(run.status, 0, run.stderr);
    // The frozen description was not overwritten by the redacted selection.
    const runJson = readJson(join(paths.results, "s1", "run.json"));
    assert.equal(runJson.cases[0].definition.destinations.length, 2);
    assert.equal(runJson.cases[0].definition.expected, "Repository");
    assert.ok(existsSync(join(paths.results, "s1", "R01", "meta.json")));
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * Phase 4 — bounded concurrency, reservation, resumable judging
 * ------------------------------------------------------------------ */

test("P4: --jobs 2 overlaps trial sessions; the default stays serial", () => {
    const root = newRoot("p4-jobs");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01"), baselineCase("T02")]);
    const env = { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()), FAKE_TRIAL_DELAY: "0.7" };
    const parallel = runHarness(root, fake, [
        "run", "--stamp", "par", "--jobs", "2", ...commandArgs(paths),
    ], env);
    assert.equal(parallel.status, 0);
    const t1 = readJson(join(paths.results, "par", "T01", "meta.json"));
    const t2 = readJson(join(paths.results, "par", "T02", "meta.json"));
    assert.ok(
        Date.parse(t2.startedAt) < Date.parse(t1.finishedAt),
        "jobs=2 must overlap the two trial sessions",
    );
    const serial = runHarness(root, fake, [
        "run", "--stamp", "ser", ...commandArgs(paths),
    ], env);
    assert.equal(serial.status, 0);
    const s1 = readJson(join(paths.results, "ser", "T01", "meta.json"));
    const s2 = readJson(join(paths.results, "ser", "T02", "meta.json"));
    assert.ok(
        Date.parse(s2.startedAt) >= Date.parse(s1.finishedAt),
        "serial runs must not overlap",
    );
    rmRoot(root);
});

test("P4: a reserved result directory refuses a second run", () => {
    const root = newRoot("p4-reserve");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    mkdirSync(join(paths.results, "s1", "T01"), { recursive: true });
    writeFileSync(join(paths.results, "s1", "T01", "meta.json"), "{}\n");
    const run = runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /result already exists/);
    rmRoot(root);
});

test("P4: two simultaneous runs of one case cannot share the result directory", async () => {
    const root = newRoot("p4-race");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const args = ["run", "T01", "--stamp", "s1", ...commandArgs(paths)];
    const env = envFor(root, fake, {
        FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
        FAKE_TRIAL_DELAY: "0.5",
    });
    const launch = () =>
        new Promise<{ code: number | null; stderr: string }>((resolve) => {
            const child = spawn(process.execPath, [HARNESS, ...args], {
                cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", (chunk) => { stderr += String(chunk); });
            child.on("close", (code) => resolve({ code, stderr }));
        });
    const [a, b] = await Promise.all([launch(), launch()]);
    const codes = [a.code, b.code].sort();
    assert.deepEqual(codes, [0, 1], "exactly one run may win the reservation");
    const loser = a.code === 1 ? a : b;
    assert.match(loser.stderr, /holds .*reservation|already exists/);
    rmRoot(root);
});

test("P4: resumable judging reuses a matching attempt and preserves evidence", () => {
    const root = newRoot("p4-resume");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) });
    const marker = file(root, "judge-invoked", "");
    const judgeEnv = {
        FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
        FAKE_JUDGE_HOOK: markerHook(root, marker),
    };
    const first = runHarness(root, fake, ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)], judgeEnv);
    assert.equal(first.status, 0);
    assert.equal(readFileSync(marker, "utf8").trim(), "invoked");
    const second = runHarness(root, fake, [
        "judge", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], judgeEnv);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /resumed attempt-001/);
    // A different judge model is a different input key: a fresh attempt.
    const third = runHarness(root, fake, [
        "judge", "T01", "--stamp", "s1", "--judge-model", "x/other", ...commandArgs(paths),
    ], judgeEnv);
    assert.equal(third.status, 0);
    assert.ok(existsSync(join(paths.results, "s1", "T01", "judge", "attempt-002")));
    rmRoot(root);
});





/* ------------------------------------------------------------------ *
 * F01 — judge success needs process success AND a complete verdict
 * ------------------------------------------------------------------ */

test("F01: valid complete pass verdict records pass and rc 0", () => {
    const root = newRoot("f01-pass");
    const fake = writeFakeOpencode(root);
    const { paths, result: gen } = generate(root, fake, [baselineCase("T01")]);
    assert.equal(gen.status, 0, gen.stderr);
    const run = runHarness(
        root, fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    assert.equal(run.status, 0, run.stderr);
    const judge = runHarness(
        root, fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.equal(judge.status, 0, judge.stderr);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "pass");
    assert.equal(verdict.destination, "docs");
    const attempt = readJson(
        join(paths.results, "s1", "T01", "judge", "attempt-001", "meta.json"),
    );
    assert.equal(attempt.judgeStatus, "judged");
    assert.equal(attempt.answerHash.length, 64);
    assert.equal(attempt.rubricHash.length, 64);
    assert.equal(attempt.judgePromptHash.length, 64);
    assert.equal(attempt.exit, 0);
    rmRoot(root);
});

test("F01: nonzero judge exit after valid-looking output is never a pass", () => {
    const root = newRoot("f01-exit9");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    assert.equal(
        runHarness(
            root, fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status, 0);
    const judge = runHarness(
        root, fake,
        ["judge", "T01", "--stamp", "s1", "--judge-model", "x/one", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()), FAKE_JUDGE_EXIT: "9" },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "judge-error");
    assert.match(verdict.reason, /process failed/);
    const attempt = readJson(join(paths.results, "s1", "T01", "judge", "attempt-001", "meta.json"));
    assert.equal(attempt.judgeStatus, "process-failed");
    assert.equal(attempt.exit, 9);
    rmRoot(root);
});

test("F01: judge killed by timeout is judge-error", () => {
    const root = newRoot("f01-signal");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    runHarness(
        root, fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const judge = runHarness(
        root, fake,
        ["judge", "T01", "--stamp", "s1", "--judge-model", "x/s", ...commandArgs(paths)],
        {
            FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
            FAKE_JUDGE_DELAY: "5",
            TRIAL_TIMEOUT_MS: "400",
        },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "judge-error");
    assert.match(verdict.reason, /timed out/);
    const attempt = readJson(join(paths.results, "s1", "T01", "judge", "attempt-001", "meta.json"));
    assert.equal(attempt.timedOut, true);
    rmRoot(root);
});

test("F01: judge spawn failure is judge-error", () => {
    const root = newRoot("f01-spawn");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    runHarness(
        root, fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const judge = runHarness(
        root, fake,
        ["judge", "T01", "--stamp", "s1", "--opencode", join(root, "missing-bin"), ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdictPath = join(paths.results, "s1", "T01", "verdict.json");
    assert.ok(existsSync(verdictPath), "verdict.json missing; judge stderr: " + judge.stderr);
    const verdict = readJson(verdictPath);
    assert.equal(verdict.verdict, "judge-error");
    assert.match(
        verdict.reason,
        /judge process failed/,
        "reason was: " + verdict.reason,
    );
    rmRoot(root);
});

test("F01: empty judge-prose output is judge-error", () => {
    const root = newRoot("f01-nojson");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    runHarness(
        root, fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const judge = runHarness(
        root, fake,
        ["judge", "T01", "--stamp", "s1", "--judge-model", "x/nojson", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", '{"part":{"type":"text","text":"no JSON here"}}\n') },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "judge-error");
    assert.match(verdict.reason, /invalid/);
    rmRoot(root);
});

test("F01: incomplete JSON and short schemas are judge-error, not pass", () => {
    const root = newRoot("f01-short");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    runHarness(
        root, fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const payloads = [
        '{"part":{"type":"text","text":"{\\"verdict\\":\\"pass\\""}\n',       // truncated
        '{"part":{"type":"text","text":"{\\"verdict\\":\\"pass\\"}"}\n',      // missing fields
    ];
    payloads.forEach((payload, i) => {
        const attemptJudgeModel = "x/short-" + i;
        const judge = runHarness(
            root, fake,
            ["judge", "T01", "--stamp", "s1", "--judge-model", attemptJudgeModel, ...commandArgs(paths)],
            { FAKE_JUDGE_OUT: file(root, "judge-short-" + i + ".jsonl", payload) },
        );
        assert.notEqual(judge.status, 0, "payload " + i + " should be judged failed");
        const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
        assert.equal(verdict.verdict, "judge-error", "payload " + i + " must be judge-error");
    });
    assert.notEqual(readJson(join(paths.results, "s1", "T01", "verdict.json")).verdict, "pass");
    rmRoot(root);
});

test("F01: valid fail verdict records fail with rc 1, evidence intact", () => {
    const root = newRoot("f01-fail");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    runHarness(
        root, fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const judge = runHarness(
        root, fake,
        ["judge", "T01", "--stamp", "s1", "--judge-model", "x/f", ...commandArgs(paths)],
        {
            FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL({
                verdict: "fail",
                destination: "doclake",
                reason: "wrong lake",
            })),
        },
    );
    assert.equal(judge.status, 1);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "fail");
    assert.equal(verdict.destination, "doclake");
    const attempt = readJson(join(paths.results, "s1", "T01", "judge", "attempt-001", "meta.json"));
    assert.equal(attempt.judgeStatus, "judged");
    assert.ok(existsSync(join(paths.results, "s1", "T01", "judge", "attempt-001", "stdout.jsonl")));
    assert.ok(existsSync(join(paths.results, "s1", "T01", "judge", "attempt-001", "raw.md")));
    rmRoot(root);
});


test("F06: legacy stamps without run.json resolve by mtime and label unknown", () => {
    const root = newRoot("f06-legacy");
    const fake = writeFakeOpencode(root);
    const paths = layout(root);
    writeCorpus(root, [baselineCase("T01")]);
    mkdirSync(join(paths.results, "legacy-zulu"), { recursive: true });
    mkdirSync(join(paths.results, "legacy-alpha"), { recursive: true });
    // No run.json: these are legacy evidence directories. The newer mtime
    // wins regardless of name order.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(paths.results, "legacy-zulu"), past, past);
    const summary = runHarness(root, fake, ["summary", ...commandArgs(paths)]);
    assert.equal(summary.status, 0);
    assert.match(summary.stdout, /# Placement trial legacy-alpha/);
    assert.match(summary.stdout, /unknown \(legacy\)/);
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * F05/F12 — the container wrapper: dispatch, honour, propagate
 * ------------------------------------------------------------------ */

/** A stub podman: logs argv, honours FAKE_PODMAN_EXIT, fakes image facts. */
function writeStubPodman(root: string) {
    return file(root, "podman", [
        "#!/bin/sh",
        'echo "$*" >> "${FAKE_PODMAN_LOG:?}"',
        'if [ "$1" = "image" ]; then echo "sha256:fake-image-id"; exit 0; fi',
        'exit "${FAKE_PODMAN_EXIT:-0}"',
    ].join("\n") + "\n");
}

/** A PATH with the wrapper's host-side staples but never podman. */
function sanitisedPath(root: string) {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of [
        "node", "git", "sha256sum", "awk", "date", "mkdir", "cp", "rm",
        "basename", "dirname", "cat", "sleep", "id",
    ]) {
        const found = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
        const source = (found.stdout ?? "").split("\n")[0];
        if (source) {
            try { symlinkSync(source, join(bin, name)); } catch { /* exists */ }
        }
    }
    return bin;
}

function wrapperEnv(root: string, fake: string, overrides: Env = {}): Env {
    const env: Env = {
        ...envFor(root, fake),
        HOME: root,
        PLACEMENT_PROMPTS: join(root, "prompts"),
        PLACEMENT_FIXTURES: join(root, "fixtures"),
        PLACEMENT_RUBRICS: join(root, "rubrics"),
        PLACEMENT_RESULTS: join(root, "results"),
        PLACEMENT_RUN_FIXTURES: join(root, "run-fixtures"),
        PLACEMENT_CASES: join(root, "cases.json"),
        FAKE_PODMAN_LOG: join(root, "podman.log"),
        ...overrides,
    };
    for (const key of Object.keys(env)) {
        if (env[key] === undefined) delete env[key];
    }
    return env;
}

const runWrapper = (root: string, fake: string, args: string[], overrides: Env = {}) =>
    spawnSync("/usr/bin/bash", [WRAPPER, ...args], {
        cwd: root, encoding: "utf8", env: wrapperEnv(root, fake, overrides),
    });

test("F05: host-only commands dispatch without podman on PATH", () => {
    const root = newRoot("f05-dispatch");
    const fake = writeFakeOpencode(root);
    writeCorpus(root, [baselineCase("T01")]);
    const bin = sanitisedPath(root);
    const env = wrapperEnv(root, fake, { PATH: bin });
    // summary reaches the harness and fails on the missing root — it must
    // not fail with "podman is required".
    const summary = spawnSync("/usr/bin/bash", [WRAPPER, "summary"], {
        cwd: root, encoding: "utf8", env,
    });
    assert.equal(summary.status, 2);
    assert.match(summary.stderr, /no results root/);
    assert.doesNotMatch(summary.stderr, /podman/);
    // generate still requires the container toolbox.
    const generate = spawnSync("/usr/bin/bash", [WRAPPER, "generate"], {
        cwd: root, encoding: "utf8", env,
    });
    assert.equal(generate.status, 1);
    assert.match(generate.stderr, /podman is required/);
    rmRoot(root);
});

test("F05: all --no-judge never invokes the judge and still reports", () => {
    const root = newRoot("f05-nojudge");
    const fake = writeFakeOpencode(root);
    const stubDir = join(root, "stub");
    mkdirSync(stubDir, { recursive: true });
    chmodSync(writeStubPodman(stubDir), 0o755);
    const paths = layout(root);
    // Record one real run host-side so the judge stage has something to do
    // (or, with --no-judge, something to leave undone).
    const { paths: gen } = generate(root, fake, [baselineCase("T01")]);
    assert.equal(runHarness(root, fake, [
        "run", "T01", "--stamp", "wj", ...commandArgs(gen),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) }).status, 0);
    const marker = file(root, "judge-invoked", "");
    const judgeEnv = { FAKE_JUDGE_HOOK: markerHook(root, marker) };
    runWrapper(root, fake, ["all", "--stamp", "wj", "--no-judge"], {
        PATH: stubDir + ":" + process.env.PATH,
        ...judgeEnv,
    });
    assert.ok(existsSync(join(paths.results, "wj", "summary.md")), "reports still render");
    assert.ok(existsSync(join(paths.results, "wj", "dossier.md")));
    assert.ok(!existsSync(join(paths.results, "wj", "T01", "verdict.json")),
        "no verdict may appear without the judge stage");
    assert.equal(readFileSync(marker, "utf8"), "", "judge binary must not run");
    // Without the flag the judge stage runs host-side and records a verdict.
    runWrapper(root, fake, ["all", "--stamp", "wj2"], {
        PATH: stubDir + ":" + process.env.PATH,
        ...judgeEnv,
        FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
    });
    rmRoot(root);
});

test("F05: a podman failure propagates as the wrapper status", () => {
    const root = newRoot("f05-status");
    const fake = writeFakeOpencode(root);
    const stubDir = join(root, "stub");
    mkdirSync(stubDir, { recursive: true });
    chmodSync(writeStubPodman(stubDir), 0o755);
    writeCorpus(root, [baselineCase("T01")]);
    const failed = runWrapper(root, fake, ["generate"], {
        PATH: stubDir + ":" + process.env.PATH,
        FAKE_PODMAN_EXIT: "3",
    });
    assert.equal(failed.status, 3, "nonzero statuses must not be swallowed");
    rmRoot(root);
});

test("F12: the wrapper mounts the selected corpus and stages per stamp+case", () => {
    const root = newRoot("f12-wrapper");
    const fake = writeFakeOpencode(root);
    const stubDir = join(root, "stub");
    mkdirSync(stubDir, { recursive: true });
    chmodSync(writeStubPodman(stubDir), 0o755);
    // Real fixtures (host harness) so the wrapper's staging step succeeds.
    generate(root, fake, [baselineCase("T01"), baselineCase("T02")]);
    // The wrapper's own generate stage (stubbed podman) records the corpus
    // mount and the single-corpus argv it would run in the container.
    const gen = runWrapper(root, fake, ["generate"], {
        PATH: stubDir + ":" + process.env.PATH,
    });
    assert.equal(gen.status, 0, gen.stderr);
    const run = runWrapper(root, fake, ["run", "T01", "--stamp", "wx"], {
        PATH: stubDir + ":" + process.env.PATH,
    });
    assert.equal(run.status, 0, run.stderr);
    const log = readFileSync(join(root, "podman.log"), "utf8");
    // Generation invocations mount the corpus at one stable container path.
    assert.match(log, /-v [^\s]*cases\.json:\/cases\/cases\.json:ro/);
    // The per-case run mounts the per-stamp staging directory.
    assert.match(log, new RegExp("-v [^\\s]*run-fixtures/wx/T01:/fixtures/T01:ro"));
    // The redacted case list carries ids and instrumentation only.
    const redactedPath = readdirSync(join(root, "run-fixtures"))
        .find((name) => name.startsWith("cases-"));
    assert.ok(redactedPath, "redacted list is corpus-hash keyed");
    const redacted = readJson(join(root, "run-fixtures", redactedPath));
    assert.deepEqual(Object.keys(redacted[0]).sort(),
        ["docsCriterion", "id", "mutationPolicy"]);
    // The staged fixture carries the generation fingerprint, never rubrics.
    const staged = join(root, "run-fixtures", "wx", "T01");
    assert.ok(existsSync(join(staged, "generation.json")));
    assert.ok(!existsSync(join(staged, "rubric.md")));
    rmRoot(root);
});

test("F12: wrapper default selection enumerates the corpus ids", () => {
    const root = newRoot("f12-default");
    const fake = writeFakeOpencode(root);
    const stubDir = join(root, "stub");
    mkdirSync(stubDir, { recursive: true });
    chmodSync(writeStubPodman(stubDir), 0o755);
    generate(root, fake, [baselineCase("T01"), baselineCase("T02")]);
    const run = runWrapper(root, fake, ["run", "--stamp", "wd"], {
        PATH: stubDir + ":" + process.env.PATH,
    });
    assert.equal(run.status, 0, run.stderr);
    const log = readFileSync(join(root, "podman.log"), "utf8");
    const perCase = log.split("\n").filter((line) => /\/fixtures\/T0\d:ro/.test(line));
    assert.equal(perCase.length, 2, "one container per corpus case, any id namespace");
    rmRoot(root);
});

test("F04: a recording minimum invalidates a run that wrote nothing", () => {
    const root = newRoot("f04-minwrites");
    const fake = writeFakeOpencode(root);
    const case0 = { ...recordingCase("T01"), mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 1 } };
    const { paths } = generate(root, fake, [case0]);
    // No writes at all: the recording gate fires before any judging.
    assert.equal(runHarness(root, fake, [
        "run", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) }).status, 0);
    const judge = runHarness(root, fake, [
        "judge", "T01", "--stamp", "s1", ...commandArgs(paths),
    ], { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) });
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /wrote 0 file\(s\)/);
    // One in-policy write satisfies the minimum and judges.
    const hook = file(root, "write.sh", [
        "#!/bin/sh", "mkdir -p ../lakes/kb", "cat > ../lakes/kb/trial-doc.md <<'EOD'",
        "---", "Area: kb", "Keywords: trial, write, one", "Summary: A trial write.",
        "---", "", "# Trial Write", "", "### Facts", "", "- Recorded.",
        "EOD",
    ].join("\n") + "\n");
    assert.equal(runHarness(root, fake, [
        "run", "T01", "--stamp", "s2", ...commandArgs(paths),
    ], { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()), FAKE_TRIAL_HOOK: hook }).status, 0);
    const judge2 = runHarness(root, fake, [
        "judge", "T01", "--stamp", "s2", "--judge-model", "x/m2", ...commandArgs(paths),
    ], { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) });
    assert.equal(judge2.status, 0);
    rmRoot(root);
});
