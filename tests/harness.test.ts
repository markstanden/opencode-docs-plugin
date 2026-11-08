#!/usr/bin/env node
/**
 * Black-box regression suite for the placement harness (harness.mts) and
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
const HARNESS = join(HERE, "fixtures", "placement-harness", "harness.mts");
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
        const created = mkdtempSync(
            "/tmp/opencode/probe-" + prefix.slice(0, 12),
        );
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
    return (
        '{"part":{"type":"text","text":' +
        JSON.stringify(JSON.stringify(verdict)) +
        "}}\n"
    );
};

/** Events JSONL the harness parses as CLI echo; one tool call line each. */
const TOOL_JSONL = (
    tool: string,
    id: string,
    status: string,
    input: unknown,
    output?: string,
) =>
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
    '    if [ -n "$FAKE_JUDGE_SIGTERM_DELAY" ]; then trap \'\' TERM; sleep "$FAKE_JUDGE_SIGTERM_DELAY"; exit 0; fi',
    '    [ -n "$FAKE_JUDGE_DELAY" ] && exec sleep "$FAKE_JUDGE_DELAY"',
    '    exit "${FAKE_JUDGE_EXIT:-0}" ;;',
    "  placement-*)",
    '    case "$title" in',
    '      *"$FAKE_FAIL_CASE"*) [ -n "$FAKE_FAIL_CASE" ] && exit "${FAKE_FAIL_CASE_EXIT:-3}" ;;',
    "    esac",
    '    [ -n "$FAKE_TRIAL_OUT" ] && cat "$FAKE_TRIAL_OUT"',
    '    [ -n "$FAKE_TRIAL_ERR" ] && cat "$FAKE_TRIAL_ERR" >&2',
    '    [ -n "$FAKE_TRIAL_HOOK" ] && sh "$FAKE_TRIAL_HOOK"',
    '    if [ -n "$FAKE_TRIAL_SIGTERM_DELAY" ]; then trap \'\' TERM; sleep "$FAKE_TRIAL_SIGTERM_DELAY"; exit 0; fi',
    '    [ -n "$FAKE_TRIAL_DELAY" ] && exec sleep "$FAKE_TRIAL_DELAY"',
    '    exit "${FAKE_TRIAL_EXIT:-0}" ;;',
    "esac",
];

const writeFakeOpencode = (root: string) => {
    const path = file(
        root,
        "fake-opencode",
        FAKE_OPENCODE_LINES.join("\n") + "\n",
    );
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

/** Run the harness exactly as production does: as a subprocess, watchdog-bounded. */
const runHarness = (
    root: string,
    fake: string,
    args: string[],
    extraEnv: Env = {},
    watchdogMs?: number,
) =>
    spawnSync(process.execPath, [HARNESS, ...args], {
        cwd: root,
        encoding: "utf8",
        env: envFor(root, fake, extraEnv),
        timeout: watchdogMs,
        killSignal: "SIGKILL",
    });

/** Generate one corpus; the corpus name decides whether a test shares it. */
function generate(
    root: string,
    fake: string,
    cases: unknown[],
    options: GenerateOptions = {},
) {
    const paths = layout(root);
    const corpusPath = writeCorpus(root, cases, options.corpusName);
    const argv = [
        "generate",
        ...(options.ids ?? cases.map((entry) => (entry as { id: string }).id)),
        "--fixture",
        corpusPath,
        "--prompts",
        paths.prompts,
        "--fixtures",
        paths.fixtures,
        "--rubrics",
        paths.rubrics,
        "--results",
        paths.results,
    ];
    if (options.force === true) argv.push("--force");
    if (options.model) argv.push("--model", options.model);
    const result = runHarness(root, fake, argv, options.env);
    return { paths, corpusPath, result };
}

/** The standard argv set for a non-generate harness command. */
const commandArgs = (paths: ReturnType<typeof layout>) => [
    "--fixture",
    paths.corpus,
    "--prompts",
    paths.prompts,
    "--fixtures",
    paths.fixtures,
    "--rubrics",
    paths.rubrics,
    "--results",
    paths.results,
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
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: emptyOut },
    );
    assert.notEqual(
        run.status,
        0,
        "an infrastructure failure must fail the sweep",
    );
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
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
            FAKE_JUDGE_HOOK: markerHook(root, marker),
        },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(caseDir, "verdict.json"));
    assert.equal(verdict.verdict, "invalid");
    assert.equal(
        readFileSync(marker, "utf8"),
        "",
        "judge binary must not be invoked",
    );
    rmRoot(root);
});

test("F08: whitespace-only answer is invalid", () => {
    const root = newRoot("f08-ws");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const run = runHarness(
        root,
        fake,
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
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "garbage.jsonl", "this is not json\n") },
    );
    assert.notEqual(run.status, 0);
    const meta = readJson(join(paths.results, "s1", "T01", "meta.json"));
    assert.equal(
        meta.invalidReason,
        "trial produced no parsable completion events",
    );
    assert.equal(meta.telemetry.parseFailures, 1);
    rmRoot(root);
});

test("F08: nonzero trial exit with text is a failing run and an invalid judge", () => {
    const root = newRoot("f08-exit7");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            FAKE_TRIAL_EXIT: "7",
        },
    );
    assert.notEqual(run.status, 0);
    const meta = readJson(join(paths.results, "s1", "T01", "meta.json"));
    assert.equal(meta.exit, 7);
    assert.equal(meta.invalidReason, "trial did not complete (exit 7)");
    const marker = file(root, "judge-invoked", "");
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_HOOK: markerHook(root, marker) },
    );
    assert.notEqual(judge.status, 0);
    assert.equal(
        readJson(join(paths.results, "s1", "T01", "verdict.json")).verdict,
        "invalid",
    );
    assert.equal(readFileSync(marker, "utf8"), "");
    rmRoot(root);
});

test("F08: timed-out trial is invalid and reports the timeout", () => {
    const root = newRoot("f08-timeout");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const run = runHarness(
        root,
        fake,
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

/* ------------------------------------------------------------------ *
 * M03 — a timeout is failure regardless of exit code, and driveway
 * completion evidence must be real
 * ------------------------------------------------------------------ */

test("M03: a SIGTERM-ignoring CLI that exits 0 after the timeout is still invalid", () => {
    const root = newRoot("m03-ignore-term");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const result = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            FAKE_TRIAL_SIGTERM_DELAY: "10",
            TRIAL_TIMEOUT_MS: "400",
            TRIAL_TERM_GRACE_MS: "350",
        },
        20_000,
    );
    assert.match(result.stdout + result.stderr, /timed out after 400/);
    assert.notEqual(result.status, 0, result.stderr);
    const meta = readJson(join(paths.results, "s1", "T01", "meta.json"));
    assert.equal(meta.timedOut, true);
    assert.equal(meta.answerValid, false);
    assert.match(meta.invalidReason, /timed out after 400 ms/);
    assert.equal(meta.killEscalated, true, "an ignored SIGTERM must escalate");
    rmRoot(root);
});

test("M03: judge with a SIGTERM-ignoring CLI is judge-error, never a pass", () => {
    const root = newRoot("m03-judge-ignore");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        [
            "judge",
            "T01",
            "--stamp",
            "s1",
            "--judge-model",
            "x/ignorer",
            ...commandArgs(paths),
        ],
        {
            FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
            FAKE_JUDGE_SIGTERM_DELAY: "10",
            TRIAL_TIMEOUT_MS: "400",
            TRIAL_TERM_GRACE_MS: "350",
        },
        20_000,
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "judge-error");
    assert.match(verdict.reason, /timed out/);
    rmRoot(root);
});

test("M03: output beyond the capture cap is visible overflow and invalid evidence", () => {
    const root = newRoot("m03-overflow");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const bigPart = "x".repeat(66 * 1024 * 1024);
    const out =
        JSON.stringify({ part: { type: "text", text: bigPart } }) + "\n";
    const results = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "huge.jsonl", out) },
        60_000,
    );
    assert.notEqual(results.status, 0);
    const meta = readJson(join(paths.results, "s1", "T01", "meta.json"));
    assert.equal(meta.outputOverflow, true);
    assert.match(meta.invalidReason, /capture limit/);
    if (existsSync(join(root, "huge.jsonl"))) rmRoot(root);
});

test("M03: a judge exceeding the capture cap is judge-error", () => {
    const root = newRoot("m03-judge-overflow");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    const bigPart = "x".repeat(66 * 1024 * 1024);
    const out =
        JSON.stringify({ part: { type: "text", text: bigPart } }) + "\n";
    const judge = runHarness(
        root,
        fake,
        [
            "judge",
            "T01",
            "--stamp",
            "s1",
            "--judge-model",
            "x/flood",
            ...commandArgs(paths),
        ],
        { FAKE_JUDGE_OUT: file(root, "judges.jsonl", out) },
        60_000,
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "judge-error");
    assert.match(verdict.reason, /capture limit/);
    rmRoot(root);
});

test("M03: text plus malformed JSONL is invalid — a broken trail is not completed evidence", () => {
    const root = newRoot("m03-partial");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const out = ANSWER_JSONL() + "this line is not json\n";
    const results = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "partial.jsonl", out) },
    );
    assert.notEqual(results.status, 0);
    const meta = readJson(join(paths.results, "s1", "T01", "meta.json"));
    assert.equal(meta.telemetry.parseFailures, 1);
    assert.equal(meta.answerValid, false);
    assert.match(meta.invalidReason, /unparsable output line/);
    rmRoot(root);
});

test("M03: a tool trail without a final completion event is not a completed answer", () => {
    const root = newRoot("m03-tool-last");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const out =
        ANSWER_JSONL("Working piece of an answer.") +
        TOOL_JSONL("read", "call-1", "completed", { path: "/etc/hosts" }, "ok");
    const results = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "tool-last.jsonl", out) },
    );
    assert.notEqual(results.status, 0);
    const meta = readJson(join(paths.results, "s1", "T01", "meta.json"));
    assert.equal(
        meta.invalidReason,
        "trial produced no final completion event",
    );
    rmRoot(root);
});

test("F08: mixed selection keeps the good case judgeable and fails the sweep", () => {
    const root = newRoot("f08-mixed");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        baselineCase("T01"),
        baselineCase("T02"),
    ]);
    // One sweep, two cases: the fake fails only the case named in
    // FAKE_FAIL_CASE, so the aggregate failure is a per-case outcome.
    const run = runHarness(
        root,
        fake,
        ["run", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            FAKE_FAIL_CASE: "T02",
        },
    );
    assert.notEqual(run.status, 0);
    assert.ok(
        existsSync(join(paths.results, "s1", "T02", "meta.json")),
        "bad case still recorded",
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(
        judge.status,
        0,
        "aggregate status must fail with one invalid case",
    );
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
 * M06 — natural prompts carry no documentation framing at all
 * ------------------------------------------------------------------ */

test("M06: the natural template asks nothing about destinations, lakes or documents", () => {
    const root = newRoot("m06-natural");
    const fake = writeFakeOpencode(root);
    const natural = {
        ...baselineCase("N01"),
        claim: "The retry loop here must cap at three attempts.",
        evidence: "A reproduced trace in this repository.",
        expected: "Recording proposed",
        promptKind: "natural",
    };
    const { paths, result } = generate(root, fake, [natural]);
    assert.equal(result.status, 0, result.stderr);
    const prompt = readFileSync(join(paths.prompts, "N01.md"), "utf8");
    assert.equal(
        !/doc|lake|destination|record|State:/i.test(prompt),
        true,
        "natural prompt must not frame documentation:\n" + prompt,
    );
    assert.match(prompt, /What do you recommend we do, if anything\?/);
    rmRoot(root);
});

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
    assert.equal(
        readFileSync(join(paths.prompts, "T01.md"), "utf8"),
        promptBefore,
    );
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
        "generate",
        "T01",
        "--plugin",
        otherPlugin,
        "--fixture",
        join(root, "cases.json"),
        "--prompts",
        join(root, "prompts"),
        "--fixtures",
        join(root, "fixtures"),
        "--rubrics",
        join(root, "rubrics"),
        "--results",
        join(root, "results"),
    ]);
    assert.equal(second.status, 1);
    assert.match(second.stdout, /stale/);
    rmRoot(root);
});

test("F03: --force recreates with a fresh fingerprint", () => {
    const root = newRoot("f03-force");
    const fake = writeFakeOpencode(root);
    const first = generate(root, fake, [baselineCase("T01")]);
    const hashBefore = readJson(
        join(first.paths.fixtures, "T01", "generation.json"),
    ).inputsHash;
    const changed = baselineCase("T01");
    changed.claim = "A DIFFERENT claim for the forced regeneration.";
    const second = generate(root, fake, [changed], { force: true });
    assert.equal(second.result.status, 0);
    assert.match(second.result.stdout, /T01: created/);
    const hashAfter = readJson(
        join(first.paths.fixtures, "T01", "generation.json"),
    ).inputsHash;
    assert.notEqual(hashAfter, hashBefore);
    assert.match(
        readFileSync(join(first.paths.prompts, "T01.md"), "utf8"),
        /DIFFERENT/,
    );
    rmRoot(root);
});

test("F03: a run refuses a missing prompt instead of regenerating it", () => {
    const root = newRoot("f03-missing");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    rmSync(join(paths.prompts, "T01.md"));
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no prompt generated/);
    assert.ok(
        !existsSync(join(paths.prompts, "T01.md")),
        "run must not regenerate",
    );
    rmRoot(root);
});

test("F03: a run refuses a tampered prompt (generation identity mismatch)", () => {
    const root = newRoot("f03-tamper");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    writeFileSync(join(paths.prompts, "T01.md"), "TAMPERED PROMPT\n");
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not match the recorded generation/);
    rmRoot(root);
});

test("F03: a run refuses a tampered fixture config", () => {
    const root = newRoot("f03-config");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    writeFileSync(join(paths.fixtures, "T01", "work", "opencode.json"), "{}\n");
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
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
        const run = runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", stamp, ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        );
        assert.equal(run.status, 0);
    }
    const summary = runHarness(root, fake, ["summary", ...commandArgs(paths)]);
    assert.equal(summary.status, 0);
    assert.match(summary.stdout, /# Placement trial alpha/);
    const judge = runHarness(root, fake, ["judge", ...commandArgs(paths)], {
        FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
    });
    assert.equal(judge.status, 0);
    assert.ok(existsSync(join(paths.results, "alpha", "T01", "verdict.json")));
    rmRoot(root);
});

test("F06: explicit --stamp must name an existing run", () => {
    const root = newRoot("f06-explicit");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const missing = runHarness(root, fake, [
        "summary",
        "--stamp",
        "nope",
        ...commandArgs(paths),
    ]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no results at/);
    const good = runHarness(root, fake, [
        "summary",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
    assert.equal(good.status, 0);
    assert.match(good.stdout, /# Placement trial s1/);
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * M02 — runs certify current inputs and the prepared tree
 * ------------------------------------------------------------------ */

test("M02: a changed corpus case refuses a run instead of executing the stale prompt", () => {
    const root = newRoot("m02-changed-case");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    const changed = baselineCase("T01");
    changed.claim = "A DIFFERENT claim the run must not silently adopt.";
    writeCorpus(root, [changed]);
    const rerun = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    assert.notEqual(rerun.status, 0);
    assert.match(
        rerun.stderr,
        /definition of T01 differs from the frozen experiment/,
    );
    rmRoot(root);
});

test("M02: a different plugin at run time refuses both the generation and the stamp", () => {
    const root = newRoot("m02-plugin");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const otherPlugin = join(root, "other-plugin");
    mkdirSync(join(otherPlugin, "src"), { recursive: true });
    writeFileSync(join(otherPlugin, "package.json"), "{}\n");
    writeFileSync(join(otherPlugin, "src", "index.ts"), "// other\n");
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    const rerun = runHarness(root, fake, [
        "run",
        "T01",
        "--stamp",
        "s1",
        "--plugin",
        otherPlugin,
        ...commandArgs(paths),
    ]);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /orchestration: .*vs/);
    rmRoot(root);
});

test("M02: a mutated, missing or added prepared file refuses the run", () => {
    const root = newRoot("m02-tree");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [recordingCase("T01")]);
    const base = ["run", "T01", "--stamp", "s1", ...commandArgs(paths)];
    const env = { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) };

    writeFileSync(
        join(paths.fixtures, "T01", "lakes", "kb", "existing.md"),
        "# Tampered seed\n",
    );
    const tampered = runHarness(root, fake, base, env);
    assert.notEqual(tampered.status, 0);
    assert.match(
        tampered.stderr,
        /prepared file lakes\/kb\/existing\.md does not match the recorded generation/,
    );

    rmSync(join(paths.fixtures, "T01", "lakes", "kb", "existing.md"));
    const missing = runHarness(root, fake, base, env);
    assert.notEqual(missing.status, 0);
    assert.match(
        missing.stderr,
        /prepared file lakes\/kb\/existing\.md is missing/,
    );

    file(root, "regenerate-placeholder", "");
    // Restore the seed by regenerating, then add an unrecorded file.
    generate(root, fake, [recordingCase("T01")], { force: true });
    writeFileSync(
        join(paths.fixtures, "T01", "lakes", "kb", "stray.md"),
        "# stray\n",
    );
    const added = runHarness(root, fake, base, env);
    assert.notEqual(added.status, 0);
    assert.match(
        added.stderr,
        /prepared tree contains an unrecorded entry lakes\/kb\/stray\.md/,
    );
    rmRoot(root);
});

test("M02: unchanged prepared inputs keep being reusable", () => {
    const root = newRoot("m02-kept");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const again = generate(root, fake, [baselineCase("T01")]);
    assert.equal(again.result.status, 0);
    assert.match(again.result.stdout, /T01: kept/);
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * M07 — the freeze must be verifiable, and the wrapper's limits are honest
 * ------------------------------------------------------------------ */

test("M07: a container-keyed run without a verifiable host freeze refuses", () => {
    const root = newRoot("m07-freeze");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            PLACEMENT_IMAGE: "localhost/trial-image:latest",
        },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no verified host freeze/);
    assert.ok(!existsSync(join(paths.results, "s1", "T01", "meta.json")));
    rmRoot(root);
});

test("M07: an unwritable results root fails a host run instead of assuming a freeze", () => {
    const root = newRoot("m07-ro");
    if (typeof process.getuid === "function" && process.getuid() === 0) {
        return; // root ignores directory modes; the refusal is not exercisable
    }
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    mkdirSync(paths.results, { recursive: true });
    chmodSync(paths.results, 0o555);
    try {
        const run = runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        );
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /cannot freeze/);
    } finally {
        chmodSync(paths.results, 0o755);
        rmRoot(root);
    }
});

test("M07: the wrapper refuses a >1 worker request instead of feigning parallelism", () => {
    const root = newRoot("m07-jobs");
    const fake = writeFakeOpencode(root);
    const stubDir = join(root, "stub");
    mkdirSync(stubDir, { recursive: true });
    chmodSync(writeStubPodman(stubDir), 0o755);
    generate(root, fake, [baselineCase("T01")]);
    const run = runWrapper(root, fake, ["run", "T01", "--jobs", "2"], {
        PATH: stubDir + ":" + process.env.PATH,
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /not supported by the wrapper/);
    const log = existsSync(join(root, "podman.log"))
        ? readFileSync(join(root, "podman.log"), "utf8")
        : "";
    assert.ok(
        !log.includes(":/fixtures/"),
        "no per-case container may be dispatched after the refusal",
    );
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * M01 — judging answers the frozen experiment, not today's corpus
 * (tests below; the F02 reporting tests continue after them)
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
    const baseA = [
        "--fixture",
        expA.corpus,
        "--prompts",
        expA.prompts,
        "--fixtures",
        expA.fixtures,
        "--rubrics",
        expA.rubrics,
        "--results",
        expA.results,
        "--plugin",
        pluginA,
        "--model",
        "provider/model-one",
    ];
    assert.equal(
        runHarness(root, fake, ["generate", "T01", ...baseA]).status,
        0,
    );
    assert.equal(
        runHarness(root, fake, ["run", "T01", "--stamp", "stampA", ...baseA], {
            FAKE_TRIAL_OUT: file(root, "trialA.jsonl", ANSWER_JSONL()),
        }).status,
        0,
    );

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
    const baseB = [
        "--fixture",
        expB.corpus,
        "--prompts",
        expB.prompts,
        "--fixtures",
        expB.fixtures,
        "--rubrics",
        expB.rubrics,
        "--results",
        expB.results,
        "--plugin",
        pluginB,
        "--model",
        "provider/model-two",
    ];
    assert.equal(runHarness(root, fake, ["generate", ...baseB]).status, 0);
    assert.equal(
        runHarness(root, fake, ["run", "T99", "--stamp", "stampB", ...baseB], {
            FAKE_TRIAL_OUT: file(root, "trialB.jsonl", ANSWER_JSONL()),
        }).status,
        0,
    );

    // Report stamp A with B's roots and current inputs in play: every label
    // must come from A's own frozen run.json.
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        "stampA",
        ...baseB,
    ]);
    assert.equal(summary.status, 0);
    assert.match(summary.stdout, /Model: provider\/model-one/);
    assert.match(summary.stdout, /\| T01 \| Repository \|/);
    assert.doesNotMatch(summary.stdout, /T99/);
    assert.doesNotMatch(summary.stdout, /model-two/);
    const exportRun = runHarness(root, fake, [
        "export",
        "--stamp",
        "stampA",
        ...baseB,
    ]);
    assert.equal(exportRun.status, 0);
    const dossier = readFileSync(
        join(expB.results, "stampA", "dossier.md"),
        "utf8",
    );
    assert.match(dossier, /Trial model: provider\/model-one/);
    assert.match(dossier, /Expected: Repository/);
    assert.doesNotMatch(dossier, /model-two/);

    // Stamp B renders with its own labels from the same shared results root.
    const summaryB = runHarness(root, fake, [
        "summary",
        "--stamp",
        "stampB",
        ...baseB,
    ]);
    assert.match(summaryB.stdout, /Model: provider\/model-two/);
    assert.match(summaryB.stdout, /\| T99 \| Repository \|/);
    rmRoot(root);
});

test("F02: the trial container boundary is recorded when the run is wrapped", () => {
    const root = newRoot("f02-boundary");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    // M07: the wrapper reaches the harness with the TRIAL image facts, so the
    // frozen description names the containers the cases run in — not the
    // orchestrating host process.
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            PLACEMENT_TRIAL_IMAGE: "localhost/trial-image:latest",
            PLACEMENT_TRIAL_IMAGE_ID: "sha256:fake",
        },
    );
    assert.equal(run.status, 0, run.stderr);
    const runJson = readJson(join(paths.results, "s1", "run.json"));
    assert.equal(runJson.trialBoundary.containerised, true);
    assert.equal(runJson.trialBoundary.image, "localhost/trial-image:latest");
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
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
    const base = (plugin: string) => [
        "--fixture",
        paths.corpus,
        "--prompts",
        paths.prompts,
        "--fixtures",
        paths.fixtures,
        "--rubrics",
        paths.rubrics,
        "--results",
        paths.results,
        "--plugin",
        plugin,
    ];
    for (const stamp of ["d1", "d2"]) {
        withSkill("# skill v1\n");
        assert.equal(
            runHarness(root, fake, [
                "generate",
                "T01",
                "--force",
                ...base(dirtyPlugin),
            ]).status,
            0,
        );
        assert.equal(
            runHarness(
                root,
                fake,
                ["run", "T01", "--stamp", stamp, ...base(dirtyPlugin)],
                { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
            ).status,
            0,
        );
    }
    const hash1 = readJson(join(paths.results, "d1", "run.json")).orchestration
        .pluginHash;
    const hash2 = readJson(join(paths.results, "d2", "run.json")).orchestration
        .pluginHash;
    assert.equal(hash1, hash2, "same content must produce the same identity");
    withSkill("# skill v2 — edited\n");
    assert.equal(
        runHarness(root, fake, [
            "generate",
            "T01",
            "--force",
            ...base(dirtyPlugin),
        ]).status,
        0,
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "d3", ...base(dirtyPlugin)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    const hash3 = readJson(join(paths.results, "d3", "run.json")).orchestration
        .pluginHash;
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
        ...("docsCriterion" in extra
            ? { docsCriterion: extra.docsCriterion as unknown }
            : {}),
    };
}

test("F04: symlink and config-home mutations are detected with kinds", () => {
    const root = newRoot("f04-symlinks");
    const fake = writeFakeOpencode(root);
    const hook = file(
        root,
        "mutate.sh",
        [
            "#!/bin/sh",
            "ln -s /etc/hostname ./work-link",
            "echo state > ../config-home/unexpected.txt",
        ].join("\n") + "\n",
    );
    const { paths } = generate(root, fake, [recordingCase("T01")]);
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            FAKE_TRIAL_HOOK: hook,
        },
    );
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
    const hook = file(
        root,
        "mutate.sh",
        [
            "#!/bin/sh",
            "rm ../lakes/kb/existing.md",
            "ln -s /etc/hostname ../lakes/kb/existing.md",
        ].join("\n") + "\n",
    );
    const { paths } = generate(root, fake, [recordingCase("T01")]);
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            FAKE_TRIAL_HOOK: hook,
        },
    );
    assert.equal(run.status, 0);
    const writes = readFileSync(
        join(paths.results, "s1", "T01", "writes.txt"),
        "utf8",
    );
    assert.match(writes, /modified: lakes\/kb\/existing\.md \(kind\)/);
    rmRoot(root);
});

test("F04: git-state changes are reported separately from trial writes", () => {
    const root = newRoot("f04-git");
    const fake = writeFakeOpencode(root);
    const hook = file(
        root,
        "mutate.sh",
        [
            "#!/bin/sh",
            "mkdir -p .git/refs/heads",
            "echo 0000000000000000000000000000000000000000 > .git/refs/heads/master",
        ].join("\n") + "\n",
    );
    const { paths } = generate(root, fake, [recordingCase("T01")]);
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            FAKE_TRIAL_HOOK: hook,
        },
    );
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
    const inPolicy = file(
        root,
        "in-policy.sh",
        [
            "#!/bin/sh",
            'echo "- fresh knowledge" >> ../lakes/kb/existing.md',
        ].join("\n") + "\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "ok", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: inPolicy,
            },
        ).status,
        0,
    );
    const judgeOk = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "ok", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.equal(judgeOk.status, 0);
    assert.equal(
        readJson(join(paths.results, "ok", "T01", "verdict.json")).verdict,
        "pass",
    );

    // Out-of-policy: a work-tree file is outside the recording surface, and
    // --allow-writes must not excuse it for a policy-bearing case.
    const outPolicy = file(
        root,
        "out-policy.sh",
        ["#!/bin/sh", "echo stray > ./stray.txt"].join("\n") + "\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "bad", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: outPolicy,
            },
        ).status,
        0,
    );
    const judgeBad = runHarness(
        root,
        fake,
        [
            "judge",
            "T01",
            "--stamp",
            "bad",
            "--allow-writes",
            ...commandArgs(paths),
        ],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judgeBad.status, 0);
    const verdict = readJson(join(paths.results, "bad", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /outside its policy/);
    rmRoot(root);
});

test("F04: decision-only baseline keeps the legacy --allow-writes semantics", () => {
    const root = newRoot("f04-legacy");
    const fake = writeFakeOpencode(root);
    const hook = file(
        root,
        "mutate.sh",
        "#!/bin/sh\necho stray > ./stray.txt\n",
    );
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
        ).status,
        0,
    );
    const strict = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(strict.status, 0);
    assert.equal(
        readJson(join(paths.results, "s1", "T01", "verdict.json")).verdict,
        "invalid",
    );
    const lenient = runHarness(
        root,
        fake,
        [
            "judge",
            "T01",
            "--stamp",
            "s1",
            "--allow-writes",
            "--judge-model",
            "x/lenient",
            ...commandArgs(paths),
        ],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.equal(
        lenient.status,
        0,
        "legacy baseline stays judgeable with the flag",
    );
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * M08 — permission modes are mutation evidence; labels use structured data
 * ------------------------------------------------------------------ */

test("M08: a chmod-only change is a detected mutation and invalidates a decision-only run", () => {
    const root = newRoot("m08-mode");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const hook = file(root, "chmod.sh", "#!/bin/sh\nchmod 640 opencode.json\n");
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    const caseDir = join(paths.results, "s1", "T01");
    const meta = readJson(join(caseDir, "meta.json"));
    assert.equal(
        meta.writes,
        1,
        "a permission-only change must count as a write",
    );
    assert.match(
        readFileSync(join(caseDir, "writes.txt"), "utf8"),
        /modified: work\/opencode\.json \(mode\)/,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(
        judge.status,
        0,
        "a decision-only trial that changed a file is invalid",
    );
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
    assert.match(
        summary.stdout,
        /\| 1 file\(s\)( \+ 1 violation\(s\))? \|/,
        "the Writes column must come from structured mutation evidence",
    );
    assert.doesNotMatch(summary.stdout, /\| 2 file/);
    rmRoot(root);
});

test("M08: an unreadable directory is recorded as evidence, not an empty success", () => {
    const root = newRoot("m08-unreadable");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [recordingCase("T01")]);
    const hook = file(
        root,
        "hide-dir.sh",
        "#!/bin/sh\nmkdir ../lakes/kb/subdir\nmkdir ../lakes/kb/subdir/deep\nchmod 000 ../lakes/kb/subdir\n",
    );
    try {
        assert.equal(
            runHarness(
                root,
                fake,
                ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
                {
                    FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                    FAKE_TRIAL_HOOK: hook,
                },
                20_000,
            ).status,
            0,
        );
        const caseDir = join(paths.results, "s1", "T01");
        assert.match(
            readFileSync(join(caseDir, "writes.txt"), "utf8"),
            /subdir/,
            "the snapshot must not silently document an unreadable subtree as empty",
        );
    } finally {
        // Restore traversal so the temp root can be removed.
        for (const candidate of [
            join(root, "results", "s1", "T01", "live", "lakes", "kb", "subdir"),
        ]) {
            try {
                chmodSync(candidate, 0o755);
            } catch {
                /* already gone */
            }
        }
        rmRoot(root);
    }
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
        TOOL_JSONL(
            "docs",
            "call-1",
            "pending",
            { search: "placement" },
            undefined,
        ),
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            { search: "placement" },
            "3 results",
        ),
        // The Code Mode twin's registration name surfacing natively.
        TOOL_JSONL(
            "docs_search",
            "call-2",
            "completed",
            { read: "kb/x.md" },
            "contents",
        ),
        // A code-mode attempt: the nested docs op is NOT separately observed.
        TOOL_JSONL(
            "execute",
            "call-3",
            "completed",
            {
                code: "const r = await tools.docs.docs_search({search:'x'}); return r;",
            },
            "done",
        ),
        // A failed docs probe: attempted, not a successful exposure.
        TOOL_JSONL("docs", "call-4", "error", { read: "rubric.md" }, "denied"),
        "this line is not json\n",
    ].join("");
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trail.jsonl", trail) },
    );
    // M03: a trailing tool part after the answer plus an unparsable line is
    // an incomplete trail — the run is invalid, but every attempt count and
    // exposure classification below is still recorded evidence.
    assert.notEqual(run.status, 0);
    const caseDir = join(paths.results, "s1", "T01");
    const toolsLines = readFileSync(join(caseDir, "tools.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean);
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
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
    assert.match(
        summary.stdout,
        /1 native\+1 twin\+1 code-mode|2 native\+1 twin\+1 code-mode/,
    );
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
        TOOL_JSONL(
            "execute",
            "call-1",
            "completed",
            { code: "tools.docs.docs_search({search: 'help'})" },
            "ok",
        ),
    ].join("");
    runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trail.jsonl", trail) },
    );
    const telemetry = readJson(
        join(paths.results, "s1", "T01", "meta.json"),
    ).telemetry;
    assert.equal(telemetry.codeModeAttempted, 1);
    assert.equal(telemetry.nativeDocs, 0);
    assert.equal(
        telemetry.verbs.help,
        1,
        "the help verb is read from the code text",
    );
    rmRoot(root);
});

test("F07: an absent trail renders unknown, not zero", () => {
    const root = newRoot("f07-absent");
    const fake = writeFakeOpencode(root);
    const paths = layout(root);
    // A legacy-shaped result dir with an answer but no tools.jsonl.
    mkdirSync(join(paths.results, "old", "T01"), { recursive: true });
    writeFileSync(join(paths.results, "old", "T01", "final.md"), "answer\n");
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        "old",
        ...commandArgs(paths),
    ]);
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
        manyCalls.push(
            TOOL_JSONL(
                "read",
                "call-" + i,
                "completed",
                { path: "/x" + i },
                "ok",
            ),
        );
    }
    const trail = ANSWER_JSONL() + manyCalls.join("");
    runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trail.jsonl", trail) },
    );
    runHarness(root, fake, ["export", "--stamp", "s1", ...commandArgs(paths)]);
    const dossier = readFileSync(
        join(paths.results, "s1", "dossier.md"),
        "utf8",
    );
    assert.match(
        dossier,
        /projection is truncated; tools\.jsonl is the authoritative full trail/,
    );
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
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "R01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "R01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_JUDGE_OUT: file(
                root,
                "judge.jsonl",
                VERDICT_JSONL({ verdict: "fail", destination: "doclake" }),
            ),
        },
    );
    assert.equal(judge.status, 1);
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
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
        "describe",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
    assert.equal(describe.status, 0);
    // The in-container kernel: an id-only redacted corpus (with the
    // instrumentation fields) selecting the same prepared generation.
    const redacted = writeCorpus(
        root,
        [
            {
                id: "R01",
                mutationPolicy: case1.mutationPolicy,
                docsCriterion: null,
            },
        ],
        "redacted.json",
    );
    const run = runHarness(
        root,
        fake,
        [
            "run",
            "R01",
            "--stamp",
            "s1",
            "--fixture",
            redacted,
            "--prompts",
            paths.prompts,
            "--fixtures",
            paths.fixtures,
            "--rubrics",
            paths.rubrics,
            "--results",
            paths.results,
        ],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
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
    const { paths } = generate(root, fake, [
        baselineCase("T01"),
        baselineCase("T02"),
    ]);
    const env = {
        FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
        FAKE_TRIAL_DELAY: "0.7",
    };
    const parallel = runHarness(
        root,
        fake,
        ["run", "--stamp", "par", "--jobs", "2", ...commandArgs(paths)],
        env,
    );
    assert.equal(parallel.status, 0);
    const t1 = readJson(join(paths.results, "par", "T01", "meta.json"));
    const t2 = readJson(join(paths.results, "par", "T02", "meta.json"));
    assert.ok(
        Date.parse(t2.startedAt) < Date.parse(t1.finishedAt),
        "jobs=2 must overlap the two trial sessions",
    );
    const serial = runHarness(
        root,
        fake,
        ["run", "--stamp", "ser", ...commandArgs(paths)],
        env,
    );
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
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
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
                cwd: root,
                env,
                stdio: ["ignore", "pipe", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", (chunk) => {
                stderr += String(chunk);
            });
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
    runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const marker = file(root, "judge-invoked", "");
    const judgeEnv = {
        FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
        FAKE_JUDGE_HOOK: markerHook(root, marker),
    };
    const first = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        judgeEnv,
    );
    assert.equal(first.status, 0);
    assert.equal(readFileSync(marker, "utf8").trim(), "invoked");
    const second = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        judgeEnv,
    );
    assert.equal(second.status, 0);
    assert.match(second.stdout, /resumed attempt-001/);
    // A different judge model is a different input key: a fresh attempt.
    const third = runHarness(
        root,
        fake,
        [
            "judge",
            "T01",
            "--stamp",
            "s1",
            "--judge-model",
            "x/other",
            ...commandArgs(paths),
        ],
        judgeEnv,
    );
    assert.equal(third.status, 0);
    assert.ok(
        existsSync(join(paths.results, "s1", "T01", "judge", "attempt-002")),
    );
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
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    assert.equal(run.status, 0, run.stderr);
    const judge = runHarness(
        root,
        fake,
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
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        [
            "judge",
            "T01",
            "--stamp",
            "s1",
            "--judge-model",
            "x/one",
            ...commandArgs(paths),
        ],
        {
            FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
            FAKE_JUDGE_EXIT: "9",
        },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "judge-error");
    assert.match(verdict.reason, /process failed/);
    const attempt = readJson(
        join(paths.results, "s1", "T01", "judge", "attempt-001", "meta.json"),
    );
    assert.equal(attempt.judgeStatus, "process-failed");
    assert.equal(attempt.exit, 9);
    rmRoot(root);
});

test("F01: judge killed by timeout is judge-error", () => {
    const root = newRoot("f01-signal");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const judge = runHarness(
        root,
        fake,
        [
            "judge",
            "T01",
            "--stamp",
            "s1",
            "--judge-model",
            "x/s",
            ...commandArgs(paths),
        ],
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
    const attempt = readJson(
        join(paths.results, "s1", "T01", "judge", "attempt-001", "meta.json"),
    );
    assert.equal(attempt.timedOut, true);
    rmRoot(root);
});

test("F01: judge spawn failure is judge-error", () => {
    const root = newRoot("f01-spawn");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const judge = runHarness(
        root,
        fake,
        [
            "judge",
            "T01",
            "--stamp",
            "s1",
            "--opencode",
            join(root, "missing-bin"),
            ...commandArgs(paths),
        ],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdictPath = join(paths.results, "s1", "T01", "verdict.json");
    assert.ok(
        existsSync(verdictPath),
        "verdict.json missing; judge stderr: " + judge.stderr,
    );
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
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const judge = runHarness(
        root,
        fake,
        [
            "judge",
            "T01",
            "--stamp",
            "s1",
            "--judge-model",
            "x/nojson",
            ...commandArgs(paths),
        ],
        {
            FAKE_JUDGE_OUT: file(
                root,
                "judge.jsonl",
                '{"part":{"type":"text","text":"no JSON here"}}\n',
            ),
        },
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
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const payloads = [
        '{"part":{"type":"text","text":"{\\"verdict\\":\\"pass\\""}\n', // truncated
        '{"part":{"type":"text","text":"{\\"verdict\\":\\"pass\\"}"}\n', // missing fields
    ];
    payloads.forEach((payload, i) => {
        const attemptJudgeModel = "x/short-" + i;
        const judge = runHarness(
            root,
            fake,
            [
                "judge",
                "T01",
                "--stamp",
                "s1",
                "--judge-model",
                attemptJudgeModel,
                ...commandArgs(paths),
            ],
            {
                FAKE_JUDGE_OUT: file(
                    root,
                    "judge-short-" + i + ".jsonl",
                    payload,
                ),
            },
        );
        assert.notEqual(
            judge.status,
            0,
            "payload " + i + " should be judged failed",
        );
        const verdict = readJson(
            join(paths.results, "s1", "T01", "verdict.json"),
        );
        assert.equal(
            verdict.verdict,
            "judge-error",
            "payload " + i + " must be judge-error",
        );
    });
    assert.notEqual(
        readJson(join(paths.results, "s1", "T01", "verdict.json")).verdict,
        "pass",
    );
    rmRoot(root);
});

test("F01: valid fail verdict records fail with rc 1, evidence intact", () => {
    const root = newRoot("f01-fail");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    const judge = runHarness(
        root,
        fake,
        [
            "judge",
            "T01",
            "--stamp",
            "s1",
            "--judge-model",
            "x/f",
            ...commandArgs(paths),
        ],
        {
            FAKE_JUDGE_OUT: file(
                root,
                "judge.jsonl",
                VERDICT_JSONL({
                    verdict: "fail",
                    destination: "doclake",
                    reason: "wrong lake",
                }),
            ),
        },
    );
    assert.equal(judge.status, 1);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "fail");
    assert.equal(verdict.destination, "doclake");
    const attempt = readJson(
        join(paths.results, "s1", "T01", "judge", "attempt-001", "meta.json"),
    );
    assert.equal(attempt.judgeStatus, "judged");
    assert.ok(
        existsSync(
            join(
                paths.results,
                "s1",
                "T01",
                "judge",
                "attempt-001",
                "stdout.jsonl",
            ),
        ),
    );
    assert.ok(
        existsSync(
            join(paths.results, "s1", "T01", "judge", "attempt-001", "raw.md"),
        ),
    );
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
    return file(
        root,
        "podman",
        [
            "#!/bin/sh",
            'echo "$*" >> "${FAKE_PODMAN_LOG:?}"',
            'if [ "$1" = "image" ]; then echo "sha256:fake-image-id"; exit 0; fi',
            'exit "${FAKE_PODMAN_EXIT:-0}"',
        ].join("\n") + "\n",
    );
}

/** A PATH with the wrapper's host-side staples but never podman. */
function sanitisedPath(root: string) {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of [
        "node",
        "git",
        "sha256sum",
        "awk",
        "date",
        "mkdir",
        "cp",
        "rm",
        "basename",
        "dirname",
        "cat",
        "sleep",
        "id",
    ]) {
        const found = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
        const source = (found.stdout ?? "").split("\n")[0];
        if (source) {
            try {
                symlinkSync(source, join(bin, name));
            } catch {
                /* exists */
            }
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

const runWrapper = (
    root: string,
    fake: string,
    args: string[],
    overrides: Env = {},
) =>
    spawnSync("/usr/bin/bash", [WRAPPER, ...args], {
        cwd: root,
        encoding: "utf8",
        env: wrapperEnv(root, fake, overrides),
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
        cwd: root,
        encoding: "utf8",
        env,
    });
    assert.equal(summary.status, 2);
    assert.match(summary.stderr, /no results root/);
    assert.doesNotMatch(summary.stderr, /podman/);
    // generate still requires the container toolbox.
    const generate = spawnSync("/usr/bin/bash", [WRAPPER, "generate"], {
        cwd: root,
        encoding: "utf8",
        env,
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
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "wj", ...commandArgs(gen)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    const marker = file(root, "judge-invoked", "");
    const judgeEnv = { FAKE_JUDGE_HOOK: markerHook(root, marker) };
    runWrapper(root, fake, ["all", "--stamp", "wj", "--no-judge"], {
        PATH: stubDir + ":" + process.env.PATH,
        ...judgeEnv,
    });
    assert.ok(
        existsSync(join(paths.results, "wj", "summary.md")),
        "reports still render",
    );
    assert.ok(existsSync(join(paths.results, "wj", "dossier.md")));
    assert.ok(
        !existsSync(join(paths.results, "wj", "T01", "verdict.json")),
        "no verdict may appear without the judge stage",
    );
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
    assert.match(
        log,
        new RegExp("-v [^\\s]*run-fixtures/wx/T01:/fixtures/T01:ro"),
    );
    // The redacted case list carries ids and instrumentation only.
    const redactedPath = readdirSync(join(root, "run-fixtures")).find((name) =>
        name.startsWith("cases-"),
    );
    assert.ok(redactedPath, "redacted list is corpus-hash keyed");
    const redacted = readJson(join(root, "run-fixtures", redactedPath));
    assert.deepEqual(Object.keys(redacted[0]).sort(), [
        "docsCriterion",
        "generationInputsHash",
        "id",
        "mutationPolicy",
    ]);
    // The frozen stamp description records the TRIAL boundary from the
    // wrapper's image facts, not the host orchestrator (M07).
    const staged = join(root, "run-fixtures", "wx", "T01");
    const runJson = readJson(join(layout(root).results, "wx", "run.json"));
    assert.equal(runJson.trialBoundary.containerised, true);
    assert.equal(
        runJson.trialBoundary.image,
        "localhost/opencode-placement-trials",
    );
    // Each staged case carries a nonsecret freeze receipt naming this
    // stamp and case — the container-verifiable proof of a host freeze.
    const receipt = readJson(join(staged, "frozen.json"));
    assert.equal(receipt.kind, "placement-freeze-receipt");
    assert.equal(receipt.stamp, "wx");
    assert.equal(receipt.caseId, "T01");
    assert.match(receipt.runJsonSha256, /^[0-9a-f]{64}$/);
    // The staged fixture carries the generation fingerprint, never rubrics.
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
    const perCase = log
        .split("\n")
        .filter((line) => /\/fixtures\/T0\d:ro/.test(line));
    assert.equal(
        perCase.length,
        2,
        "one container per corpus case, any id namespace",
    );
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * M01 — judging answers the frozen experiment, not today's corpus
 * ------------------------------------------------------------------ */

/** A recording case with an explicit replace/create artefact expectation. */
function docGateCase(
    id: string,
    expectedDocs: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
) {
    return {
        ...baselineCase(id),
        seeds: [
            {
                surface: "lakes",
                path: "kb/existing.md",
                contents:
                    "---\nArea: kb\nKeywords: existing, seed\nSummary: The seeded knowledge doc.\n---\n\n# Existing\n\n### Facts\n\n- prior knowledge\n- Retained open question line.\n- Stale outdated claim\n",
            },
        ],
        mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 1 },
        expectedDocs,
        ...extra,
    };
}

const VALID_CREATE_DOC =
    [
        "---",
        "Area: kb",
        "Keywords: trial, creation, gate",
        "Summary: A deterministically valid trial creation.",
        "---",
        "",
        "# Trial Creation",
        "",
        "### Facts",
        "",
        "- Recorded by the trial.",
    ].join("\n") + "\n";

test("M01: loosening today's corpus cannot resurrect a frozen recording minimum", () => {
    const root = newRoot("m01-loosen");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [docGateCase("T01", null)]);
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    // The CURRENT corpus is loosened after the run: judging must still use
    // the frozen definition, which required the write.
    const loosened: Record<string, unknown> = { ...docGateCase("T01", null) };
    delete loosened.mutationPolicy;
    writeCorpus(root, [loosened]);
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /wrote 0 file\(s\)/);
    rmRoot(root);
});

test("M01: an explicit id outside the saved experiment is refused", () => {
    const root = newRoot("m01-ids");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T02", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.equal(judge.status, 2);
    assert.match(judge.stderr, /not part of experiment s1/);
    rmRoot(root);
});

test("M01: an edited recorded answer refuses judging instead of being adopted", () => {
    const root = newRoot("m01-answer");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    writeFileSync(
        join(paths.results, "s1", "T01", "final.md"),
        "Rewritten answer claiming the personal lake.\n",
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /recorded answer altered after the run/);
    rmRoot(root);
});

test("M01: an edited recorded rubric refuses judging instead of being adopted", () => {
    const root = newRoot("m01-rubric");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [docGateCase("T01", null)]);
    const hook = file(
        root,
        "create-rubric-rig.sh",
        "#!/bin/sh\ncat > ../lakes/kb/trial-doc.md <<'EOD'\n" +
            VALID_CREATE_DOC +
            "EOD\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    writeFileSync(
        join(paths.results, "s1", "T01", "rubric.md"),
        "# Replaced rubric\n\nAccepts: anything at all.",
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /recorded rubric does not match/);
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * M04 — gates consume verified completions, not attempts or dead code
 * ------------------------------------------------------------------ */

test("M04: a failed docs read does not satisfy a verified read gate", () => {
    const root = newRoot("m04-denied");
    const fake = writeFakeOpencode(root);
    const docCase = docGateCase("T01", null, {
        docsCriterion: { minVerifiedCalls: 1, verbs: ["read"] },
        mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
    });
    const { paths } = generate(root, fake, [docCase]);
    const trail = [
        TOOL_JSONL(
            "docs",
            "call-1",
            "error",
            { read: "kb/existing.md" },
            "denied",
        ),
        ANSWER_JSONL(),
    ].join("");
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trail.jsonl", trail) },
    );
    // The denied read alone does not make the run incomplete: the answer
    // still trails the trail properly. The rejection happens at the gate.
    assert.equal(run.status, 0);
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /0 verified docs op/);
    rmRoot(root);
});

test("M04: a completed read of an unrelated doc does not satisfy a relevant-path gate", () => {
    const root = newRoot("m04-unrelated");
    const fake = writeFakeOpencode(root);
    const docCase = docGateCase("T01", null, {
        docsCriterion: {
            minVerifiedCalls: 1,
            verbs: ["read"],
            paths: ["kb/existing.md"],
        },
        mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
    });
    const { paths } = generate(root, fake, [docCase]);
    const trail = [
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            { read: "kb/other.md" },
            "contents",
        ),
        ANSWER_JSONL(),
    ].join("");
    runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trail.jsonl", trail) },
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.match(verdict.reason, /no completed docs operation references/);
    rmRoot(root);
});

test("M04: code-mode-only attempts make the docs gate inconclusive, never satisfied", () => {
    const root = newRoot("m04-codemode");
    const fake = writeFakeOpencode(root);
    const docCase = docGateCase("T01", null, {
        docsCriterion: { minVerifiedCalls: 1, verbs: ["read"] },
        mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
    });
    const { paths } = generate(root, fake, [docCase]);
    const trail = [
        TOOL_JSONL(
            "execute",
            "call-1",
            "completed",
            {
                code: "const r = await tools.docs.docs_search({read:'kb/existing.md'}); return r;",
            },
            "ok",
        ),
        ANSWER_JSONL(),
    ].join("");
    runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trail.jsonl", trail) },
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.match(verdict.reason, /unobservable nested operations/);
    assert.match(verdict.reason, /inconclusive/);
    rmRoot(root);
});

test("M04: discovery distinguishes attempted from verified help in the summary", () => {
    const root = newRoot("m04-discovery");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const trail = [
        TOOL_JSONL(
            "execute",
            "call-1",
            "completed",
            {
                code: "if (false) { await tools.docs.docs_search({ search: 'help' }); }",
            },
            "ok",
        ),
        ANSWER_JSONL(),
    ].join("");
    runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trail.jsonl", trail) },
    );
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
    assert.match(summary.stdout, /no help \(1 attempted\)/);
    assert.doesNotMatch(summary.stdout, /help×1/);
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * M05 — recording gates verify the actual artefacts
 * ------------------------------------------------------------------ */

test("M05: a junk non-Markdown file cannot satisfy a required knowledge write", () => {
    const root = newRoot("m05-junk");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", { kind: "create" }),
    ]);
    const hook = file(
        root,
        "junk.sh",
        "#!/bin/sh\nmkdir -p ../lakes/kb\necho 'not a doc at all' > ../lakes/kb/notes.txt\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.match(verdict.reason, /no created knowledge doc/);
    rmRoot(root);
});

test("M05: directory-only changes cannot satisfy a required knowledge write", () => {
    const root = newRoot("m05-dirs");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", { kind: "create" }),
    ]);
    const hook = file(
        root,
        "dirs.sh",
        "#!/bin/sh\nmkdir ../lakes/kb/empty-dir\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.match(verdict.reason, /no created knowledge doc/);
    rmRoot(root);
});

test("M05: structurally invalid Markdown cannot satisfy a required knowledge write", () => {
    const root = newRoot("m05-structure");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", { kind: "create" }),
    ]);
    const hook = file(
        root,
        "flat.sh",
        "#!/bin/sh\ncat > ../lakes/kb/trial-doc.md <<'EOD'\n# No front-matter at all\n\nJust prose with no claim section.\nEOD\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.match(verdict.reason, /structurally valid knowledge doc/);
    rmRoot(root);
});

test("M05: a valid creation passes the gate and reaches the semantic judge", () => {
    const root = newRoot("m05-valid-create");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", { kind: "create" }),
    ]);
    const hook = file(
        root,
        "create.sh",
        "#!/bin/sh\nmkdir -p ../lakes/kb\ncat > ../lakes/kb/trial-doc.md <<'EOD'\n" +
            VALID_CREATE_DOC +
            "EOD\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    const marker = file(root, "judge-invoked", "");
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
            FAKE_JUDGE_HOOK: markerHook(root, marker),
        },
    );
    assert.equal(judge.status, 0, judge.stderr);
    assert.equal(
        readJson(join(paths.results, "s1", "T01", "verdict.json")).verdict,
        "pass",
    );
    assert.equal(readFileSync(marker, "utf8"), "invoked\n");
    rmRoot(root);
});

test("M05: an unrelated change beside a valid replacement cannot satisfy the case", () => {
    const root = newRoot("m05-unrelated");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", {
            kind: "replace",
            target: "lakes/kb/existing.md",
            retains: ["Retained open question line."],
            omits: ["Stale outdated claim"],
        }),
    ]);
    // Valid in-place replacement of the target AND an extra in-policy edit.
    const hook = file(
        root,
        "replace-plus.sh",
        "#!/bin/sh\ncat > ../lakes/kb/existing.md <<'EOD'\n---\nArea: kb\nKeywords: existing, seed\nSummary: The seeded knowledge doc.\n---\n\n# Existing\n\n### Facts\n\n- prior knowledge\n- Retained open question line.\nEOD\n" +
            'echo "extra churn" > ../lakes/kb/scratch-note.md\n',
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.match(verdict.reason, /unrelated change/);
    rmRoot(root);
});

test("M05: writing beside the target does not satisfy a replace case, but a valid in-place replacement does", () => {
    const root = newRoot("m05-replace");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", {
            kind: "replace",
            target: "lakes/kb/existing.md",
            retains: ["Retained open question line."],
            omits: ["Stale outdated claim"],
        }),
    ]);

    // Wrong target: a NEW doc beside the unchanged existing one.
    const beside = file(
        root,
        "beside.sh",
        "#!/bin/sh\ncat > ../lakes/kb/other.md <<'EOD'\n" +
            VALID_CREATE_DOC +
            "EOD\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "wrong", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: beside,
            },
            20_000,
        ).status,
        0,
    );
    const wrongJudged = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "wrong", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(wrongJudged.status, 0);
    const wrong = readJson(join(paths.results, "wrong", "T01", "verdict.json"));
    assert.match(
        wrong.reason,
        /expected replacement of lakes\/kb\/existing\.md did not happen/,
    );

    // Deleting the target does not satisfy the case either.
    const deletion = file(
        root,
        "delete.sh",
        "#!/bin/sh\nrm ../lakes/kb/existing.md\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "deleted", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: deletion,
            },
            20_000,
        ).status,
        0,
    );
    runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "deleted", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    const deleted = readJson(
        join(paths.results, "deleted", "T01", "verdict.json"),
    );
    assert.match(deleted.reason, /was deleted/);

    // Valid in-place replacement retains the open question, drops the stale
    // claim, and passes to the semantic judge.
    const marked = file(
        root,
        "replace.sh",
        "#!/bin/sh\ncat > ../lakes/kb/existing.md <<'EOD'\n---\nArea: kb\nKeywords: existing, seed\nSummary: The seeded knowledge doc.\n---\n\n# Existing\n\n### Facts\n\n- prior knowledge\n- Retained open question line.\nEOD\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "good", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: marked,
            },
            20_000,
        ).status,
        0,
    );
    const goodJudged = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "good", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.equal(goodJudged.status, 0, goodJudged.stderr);
    assert.equal(
        readJson(join(paths.results, "good", "T01", "verdict.json")).verdict,
        "pass",
    );
    rmRoot(root);
});

test("M05: a replacement that loses required content fails the gate", () => {
    const root = newRoot("m05-lost");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", {
            kind: "replace",
            target: "lakes/kb/existing.md",
            retains: ["Retained open question line."],
            omits: ["Stale outdated claim"],
        }),
    ]);
    const hook = file(
        root,
        "lossy.sh",
        "#!/bin/sh\ncat > ../lakes/kb/existing.md <<'EOD'\n---\nArea: kb\nKeywords: existing, seed\nSummary: The seeded knowledge doc.\n---\n\n# Existing\n\n### Facts\n\n- Rewritten while dropping the retained line.\nEOD\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.match(verdict.reason, /lost required content/);
    rmRoot(root);
});

test("M05: a preserved path edited alongside the expected write fails the gate", () => {
    const root = newRoot("m05-preserve");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase(
            "T01",
            {
                kind: "create",
                link: "org/signed-commits.md",
                preserve: ["lakes/org/signed-commits.md"],
            },
            {
                mutationPolicy: { allowed: ["lakes/**"], minWrites: 2 },
                seeds: [
                    ...docGateCase("T01", null).seeds,
                    {
                        surface: "lakes",
                        path: "org/signed-commits.md",
                        contents:
                            "# Signed commits policy\n\n### Facts\n\n- The organisation mandates signed commits.\n",
                    },
                ],
            },
        ),
    ]);
    const hook = file(
        root,
        "messy.sh",
        "#!/bin/sh\nmkdir -p ../lakes/kb ../lakes/org\n" +
            "cat > ../lakes/kb/trial-doc.md <<'EOD'\n" +
            VALID_CREATE_DOC +
            "EOD\n" +
            "echo tempered > ../lakes/org/signed-commits.md\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.match(
        verdict.reason,
        /preserved lakes\/org\/signed-commits\.md was modified/,
    );
    rmRoot(root);
});

test("M05: mutation evidence edited after the run is refused, not graded", () => {
    const root = newRoot("m05-tamper");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", { kind: "create" }),
    ]);
    const hook = file(
        root,
        "create.sh",
        "#!/bin/sh\ncat > ../lakes/kb/trial-doc.md <<'EOD'\n" +
            VALID_CREATE_DOC +
            "EOD\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    writeFileSync(
        join(paths.results, "s1", "T01", "live", "lakes", "kb", "trial-doc.md"),
        VALID_CREATE_DOC.replace(
            "Recorded by the trial.",
            "Forged afterwards.",
        ),
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.match(verdict.reason, /final-state digest mismatch/);
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * C01 — the recording gate does not punish necessary ancestors, and
 * rejects docs the plugin would never collect
 * ------------------------------------------------------------------ */

/** The actual corpus case, so the regressions exercise the shipped shapes. */
const corpusCaseById = (id: string): Record<string, unknown> => {
    const cases = readJson(
        join(HERE, "fixtures", "trial-cases.json"),
    ) as Array<Record<string, unknown>>;
    const found = cases.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`no corpus case ${id}`);
    return found;
};

/** A deterministically valid record.md body (the W01 finding). */
const VALID_RECORD_DOC =
    [
        "---",
        "Area: docs",
        "Keywords: publication, lock, rename",
        "Summary: The publication lock only coordinates beside its target.",
        "---",
        "",
        "# Publication lock beside its target",
        "",
        "### Facts",
        "",
        "- The cross-device rename proved the lock must sit beside its target.",
    ].join("\n") + "\n";

test("C01: a valid doc in a new subdirectory judges — its ancestor directory is necessary, not unrelated", () => {
    const root = newRoot("c01-new-area");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("W01")]);
    const hook = file(
        root,
        "record.sh",
        "#!/bin/sh\nmkdir -p ../lakes/docs/decisions\ncat > ../lakes/docs/decisions/record.md <<'EOD'\n" +
            VALID_RECORD_DOC +
            "EOD\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "W01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    const marker = file(root, "judge-invoked", "");
    const judge = runHarness(
        root,
        fake,
        ["judge", "W01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
            FAKE_JUDGE_HOOK: markerHook(root, marker),
        },
    );
    assert.equal(judge.status, 0, judge.stderr);
    assert.equal(
        readJson(join(paths.results, "s1", "W01", "verdict.json")).verdict,
        "pass",
    );
    assert.equal(
        readFileSync(marker, "utf8"),
        "invoked\n",
        "the artefact gate must not block a necessary ancestor directory",
    );
    rmRoot(root);
});

test("C01: a valid doc created in the existing docs area judges", () => {
    const root = newRoot("c01-existing-area");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("W01")]);
    const hook = file(
        root,
        "record.sh",
        "#!/bin/sh\ncat > ../lakes/docs/w01-record.md <<'EOD'\n" +
            VALID_RECORD_DOC +
            "EOD\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "W01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
            20_000,
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "W01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.equal(judge.status, 0, judge.stderr);
    assert.equal(
        readJson(join(paths.results, "s1", "W01", "verdict.json")).verdict,
        "pass",
    );
    rmRoot(root);
});

test("C01: an extra unrelated directory beside a valid creation fails the gate", () => {
    const root = newRoot("c01-extra-dir");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("W01")]);
    const hook = file(
        root,
        "record.sh",
        "#!/bin/sh\nmkdir -p ../lakes/docs/decisions ../lakes/docs/extra-dir\ncat > ../lakes/docs/decisions/record.md <<'EOD'\n" +
            VALID_RECORD_DOC +
            "EOD\n",
    );
    runHarness(
        root,
        fake,
        ["run", "W01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            FAKE_TRIAL_HOOK: hook,
        },
        20_000,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "W01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "W01", "verdict.json"));
    assert.match(verdict.reason, /unrelated change/);
    assert.match(verdict.reason, /extra-dir/);
    rmRoot(root);
});

test("C01: a hidden doc is an uncollectable target, refused before any semantic judge", () => {
    const root = newRoot("c01-hidden");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("W01")]);
    const hook = file(
        root,
        "hidden.sh",
        "#!/bin/sh\ncat > ../lakes/docs/.hidden.md <<'EOD'\n" +
            VALID_RECORD_DOC +
            "EOD\n",
    );
    runHarness(
        root,
        fake,
        ["run", "W01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            FAKE_TRIAL_HOOK: hook,
        },
        20_000,
    );
    const marker = file(root, "judge-invoked", "");
    const judge = runHarness(
        root,
        fake,
        ["judge", "W01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
            FAKE_JUDGE_HOOK: markerHook(root, marker),
        },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "W01", "verdict.json"));
    assert.match(verdict.reason, /collectable/);
    assert.equal(
        readFileSync(marker, "utf8"),
        "",
        "the collection rule must fire before the semantic judge",
    );
    rmRoot(root);
});

test("C01: a doc in an excluded knowledge area is an uncollectable target", () => {
    const root = newRoot("c01-excluded-area");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("W01")]);
    const hook = file(
        root,
        "plans.sh",
        "#!/bin/sh\nmkdir -p ../lakes/docs/plans\ncat > ../lakes/docs/plans/record.md <<'EOD'\n" +
            VALID_RECORD_DOC +
            "EOD\n",
    );
    runHarness(
        root,
        fake,
        ["run", "W01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
            FAKE_TRIAL_HOOK: hook,
        },
        20_000,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "W01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "W01", "verdict.json"));
    assert.match(verdict.reason, /collectable/);
    rmRoot(root);
});

test("F04: a recording minimum invalidates a run that wrote nothing", () => {
    const root = newRoot("f04-minwrites");
    const fake = writeFakeOpencode(root);
    const case0 = {
        ...recordingCase("T01"),
        mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 1 },
    };
    const { paths } = generate(root, fake, [case0]);
    // No writes at all: the recording gate fires before any judging.
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        ).status,
        0,
    );
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /wrote 0 file\(s\)/);
    // One in-policy write satisfies the minimum and judges.
    const hook = file(
        root,
        "write.sh",
        [
            "#!/bin/sh",
            "mkdir -p ../lakes/kb",
            "cat > ../lakes/kb/trial-doc.md <<'EOD'",
            "---",
            "Area: kb",
            "Keywords: trial, write, one",
            "Summary: A trial write.",
            "---",
            "",
            "# Trial Write",
            "",
            "### Facts",
            "",
            "- Recorded.",
            "EOD",
        ].join("\n") + "\n",
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s2", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                FAKE_TRIAL_HOOK: hook,
            },
        ).status,
        0,
    );
    const judge2 = runHarness(
        root,
        fake,
        [
            "judge",
            "T01",
            "--stamp",
            "s2",
            "--judge-model",
            "x/m2",
            ...commandArgs(paths),
        ],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    assert.equal(judge2.status, 0);
    rmRoot(root);
});
