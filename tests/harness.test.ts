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

/**
 * A tool call line carrying the plugin-shape result metadata: the real CLI
 * folds each tool result's `metadata` envelope into the part's state, so
 * fixtures that reproduce the plugin's actual result contract carry it.
 */
const TOOL_JSONL_META = (
    tool: string,
    id: string,
    status: string,
    input: unknown,
    output?: string,
    metadata?: unknown,
) =>
    JSON.stringify({
        part: {
            type: "tool",
            id,
            tool,
            state: { status, input, output, metadata },
        },
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
    assert.match(verdict.reason, /0 successful docs op/);
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
    assert.match(verdict.reason, /no completed docs read references/);
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

test("M04: a verbs-only read gate is satisfied by a successful read", () => {
    // Arrange: a gate requiring at least one successful read (no paths).
    const root = newRoot("m04-verbs-success");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: { minVerifiedCalls: 1, verbs: ["read"] },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: run a trail whose only read is a successful retrieval, then judge.
    const { judge, verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            { read: "kb/existing.md" },
            SUCCESSFUL_READ_OUTPUT,
        ) + ANSWER_JSONL(),
    );
    // Assert: the gate passes and the semantic judge decides.
    assert.equal(judge.status, 0, judge.stderr);
    assert.equal(verdict.verdict, "pass");
    rmRoot(root);
});

test("M04: a verbs-only read gate refuses a failed read", () => {
    // Arrange: the same verbs-only gate.
    const root = newRoot("m04-verbs-failed");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: { minVerifiedCalls: 1, verbs: ["read"] },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: run a trail whose read completed but delivered nothing, then judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            { read: "kb/existing.md" },
            "prose and no token",
        ) + ANSWER_JSONL(),
    );
    // Assert: a completed non-retrieval is not a success.
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /0 successful docs op\(s\)/);
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * D01 — the checked-in family corpus, and help discovery as a
 * verifiable criterion
 * ------------------------------------------------------------------ */

const FAMILY_CORPUS = join(HERE, "fixtures", "trial-cases.json");

test("D01: every checked-in family case validates and generates", () => {
    // Arrange: the complete checked-in corpus, including D01's
    // paths-free help-discovery gate.
    const root = newRoot("d01-corpus-generates");
    const fake = writeFakeOpencode(root);
    const ids = readJson(FAMILY_CORPUS).map(
        (entry: { id: string }) => entry.id,
    ) as string[];
    assert.ok(ids.includes("D01"), "the family corpus must carry D01");
    const paths = layout(root);
    // Act: generate every family case from the checked-in file itself.
    const run = runHarness(root, fake, [
        "generate",
        ...ids,
        "--fixture",
        FAMILY_CORPUS,
        "--prompts",
        paths.prompts,
        "--fixtures",
        paths.fixtures,
        "--rubrics",
        paths.rubrics,
        "--results",
        paths.results,
    ]);
    // Assert: the previously schema-blocked corpus now generates cleanly.
    assert.equal(run.status, 0, run.stderr);
    for (const id of ids) {
        assert.ok(
            existsSync(join(paths.fixtures, id, "generation.json")),
            `${id} must have a generation record`,
        );
    }
    rmRoot(root);
});

test("D01: a help-discovery gate is satisfied by a successful native help call", () => {
    // Arrange: the gate as trial-cases D01 declares it — one verified
    // help operation, no paths.
    const root = newRoot("d01-help-success");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: { minVerifiedCalls: 1, verbs: ["help"] },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: run a trail whose help call completed and delivered the lake
    // inventory, then judge.
    const { judge, verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            { search: "help" },
            "- docs (Repository [repo]): this repository's knowledge\n" +
                "- doclake (Personal [machine]): personal setup\n",
        ) + ANSWER_JSONL(),
    );
    // Assert: the gate passes and the semantic judge decides on merits.
    assert.equal(judge.status, 0, judge.stderr);
    assert.equal(verdict.verdict, "pass");
    rmRoot(root);
});

test("D01: a help-discovery gate refuses a completed blank help call", () => {
    // Arrange: the same gate.
    const root = newRoot("d01-help-blank");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: { minVerifiedCalls: 1, verbs: ["help"] },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: run a trail whose help call completed but delivered nothing,
    // then judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL("docs", "call-1", "completed", { search: "help" }, "") +
            ANSWER_JSONL(),
    );
    // Assert: a completed empty inventory is not a success.
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /0 successful docs op\(s\)/);
    rmRoot(root);
});

test("D01: a nonblank failed help result is not a successful help call", () => {
    // Arrange: the same gate.
    const root = newRoot("d01-help-failed");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: { minVerifiedCalls: 1, verbs: ["help"] },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: run a trail whose help call failed while still delivering
    // nonblank output, then judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL(
            "docs",
            "call-1",
            "error",
            { search: "help" },
            "help lookup failed: lakes unreachable",
        ) + ANSWER_JSONL(),
    );
    // Assert: a nonblank failure is delivery, not success.
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /0 successful docs op\(s\)/);
    rmRoot(root);
});

test("D01: an observable twin help call satisfies the help gate", () => {
    // Arrange: the same gate, with the twin registration name the plugin
    // advertises.
    const root = newRoot("d01-help-twin");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: { minVerifiedCalls: 1, verbs: ["help"] },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: run a trail whose twin help call completed with the inventory,
    // then judge.
    const { judge, verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL(
            "docs_search",
            "call-1",
            "completed",
            { search: "help" },
            "- docs (Repository [repo]): this repository's knowledge\n",
        ) + ANSWER_JSONL(),
    );
    // Assert: the observable twin counts like the native tool.
    assert.equal(judge.status, 0, judge.stderr);
    assert.equal(verdict.verdict, "pass");
    rmRoot(root);
});

test("D01: a successful unrelated read cannot cover a failed help call", () => {
    // Arrange: the same gate, floor met by an unrelated verb.
    const root = newRoot("d01-help-mixed");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: { minVerifiedCalls: 1, verbs: ["help"] },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: one successful read plus a failed help call, then judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            { read: "kb/test-commands.md" },
            SUCCESSFUL_READ_OUTPUT,
        ) +
            TOOL_JSONL(
                "docs",
                "call-2",
                "error",
                { search: "help" },
                "help lookup failed: lakes unreachable",
            ) +
            ANSWER_JSONL(),
    );
    // Assert: the floor counts the read, the verb gate refuses.
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /no successful help operation/);
    rmRoot(root);
});

test("D01: a path criterion still refuses verbs beside read", () => {
    // Arrange: regression for the #38 invariant — a read-verification
    // with paths may not demand other verbs.
    const root = newRoot("d01-paths-refuses-other-verbs");
    const fake = writeFakeOpencode(root);
    const { result } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: {
                minVerifiedCalls: 1,
                verbs: ["read", "search"],
                paths: ["kb/existing.md"],
            },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Assert: the same refusal message as before the widening.
    assert.notEqual(result.status, 0);
    assert.match(
        result.stderr,
        /paths gate read targets; verbs must be undefined or \["read"\]/,
    );
    rmRoot(root);
});

test("M04: a floor-only criterion counts successes, never completed failures", () => {
    // Arrange: a gate with a floor and no verb/path requirements.
    const root = newRoot("m04-floor-only");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: { minVerifiedCalls: 1 },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: one completed-but-failed read, then judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        R01_TRAIL({ read: "kb/existing.md" }, "No doc at kb/existing.md."),
    );
    // Assert: a completed not-found never becomes the verified floor.
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /0 successful docs op\(s\), required 1/);
    rmRoot(root);
});

test("M04: one successful operation plus one refusal cannot satisfy a floor of two", () => {
    // Arrange: a floor-of-two gate.
    const root = newRoot("m04-floor-two");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: { minVerifiedCalls: 2 },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: one successful read plus one completed not-found read, then judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            { read: "kb/existing.md" },
            SUCCESSFUL_READ_OUTPUT,
        ) +
            TOOL_JSONL(
                "docs",
                "call-2",
                "completed",
                { read: "kb/absent.md" },
                "No doc at kb/absent.md.",
            ) +
            ANSWER_JSONL(),
    );
    // Assert: 1 success < 2 failures equal one success: the floor refuses.
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /1 successful docs op\(s\), required 2/);
    rmRoot(root);
});

test("M04: folded duplicate events do not inflate the successful count", () => {
    // Arrange: a floor-of-one gate; one call id emitted twice, latest-wins.
    const root = newRoot("m04-dedup");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: { minVerifiedCalls: 1 },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: pending event that looks successful, then its completing
    // not-found event — the folded entry is the not-found, then judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL(
            "docs",
            "call-1",
            "pending",
            { read: "kb/existing.md" },
            SUCCESSFUL_READ_OUTPUT,
        ) +
            TOOL_JSONL(
                "docs",
                "call-1",
                "completed",
                { read: "kb/existing.md" },
                "No doc at kb/existing.md.",
            ) +
            ANSWER_JSONL(),
    );
    // Assert: one deduplicated operation, zero successes.
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /0 successful docs op\(s\), required 1/);
    rmRoot(root);
});

test("M04: required-path diagnostics aggregate — one met read never conceals another failed read", () => {
    // Arrange: a two-path gate; the first read succeeds, the second misses.
    const root = newRoot("m04-paths-mixed");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: {
                minVerifiedCalls: 2,
                paths: ["kb/one.md", "kb/two.md"],
            },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: a successful read of one.md and a completed not-found of two.md,
    // then judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            { read: "kb/one.md" },
            SUCCESSFUL_READ_OUTPUT,
        ) +
            TOOL_JSONL(
                "docs",
                "call-2",
                "completed",
                { read: "kb/two.md" },
                "No doc at kb/two.md.",
            ) +
            ANSWER_JSONL(),
    );
    // Assert: the unmet path is named with its own outcome; one.md's success
    // conceals nothing.
    assert.equal(verdict.verdict, "invalid");
    assert.doesNotMatch(verdict.reason, /kb\/one\.md/);
    assert.match(
        verdict.reason,
        /no successful retrieval of kb\/two\.md — not found/,
    );
    rmRoot(root);
});

test("M04: required-path diagnostics aggregate — every unmet fragment is named when both reads fail", () => {
    // Arrange: the same two-path gate; both reads complete as not-founds.
    const root = newRoot("m04-paths-both-fail");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: {
                minVerifiedCalls: 2,
                paths: ["kb/one.md", "kb/two.md"],
            },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: two completed not-found reads, then judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            { read: "kb/one.md" },
            "No doc at kb/one.md.",
        ) +
            TOOL_JSONL(
                "docs",
                "call-2",
                "completed",
                { read: "kb/two.md" },
                "No doc at kb/two.md.",
            ) +
            ANSWER_JSONL(),
    );
    // Assert: both unmet fragments appear in one aggregated refusal.
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /kb\/one\.md/);
    assert.match(verdict.reason, /kb\/two\.md/);
    rmRoot(root);
});

test("M04: an add body naming the target path is not a typed read of it", () => {
    // Arrange: a gate whose paths must be READ targets.
    const root = newRoot("m04-add-body");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", null, {
            docsCriterion: {
                minVerifiedCalls: 1,
                verbs: ["read"],
                paths: ["kb/test-commands.md"],
            },
            mutationPolicy: { allowed: ["lakes/kb/**"], minWrites: 0 },
        }),
    ]);
    // Act: an add whose body text mentions the required path — no read —
    // then judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "T01",
        "s1",
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            {
                add: {
                    mode: "create",
                    body: "See kb/test-commands.md for the details.",
                },
            },
            SUCCESSFUL_READ_OUTPUT,
        ) + ANSWER_JSONL(),
    );
    // Assert: no typed read targets the fragment; the semantic judge never
    // sees the case.
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /no completed docs read references/);
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * C02 — a completed tool response is not necessarily a successful read
 * ------------------------------------------------------------------ */

/**
 * A successful knowledge-doc read's content: body plus the revision token.
 * The token sits at the end, as the plugin really serves it.
 */
const SUCCESSFUL_READ_OUTPUT =
    "kb/test-commands.md — Running the suite\n\n" +
    "---\nArea: kb\nKeywords: node, test, runner, commands\n" +
    "Summary: How this repo is tested and typechecked.\n---\n\n" +
    "# Running the suite\n\n### Facts\n\n- npm test runs everything.\n" +
    "\n\ndocs: revision " +
    "a".repeat(64) +
    " — these bytes; " +
    "cite it as expectedRevision when replacing (a stale token refuses).";

/**
 * A real plugin-core wiki read capture (exercise: the packed plugin against
 * a real wiki lake, docs.execute({read}) → content + metadata). Wiki pages
 * are read-only reference and deliberately carry NO revision token.
 */
const WIKI_READ_OUTPUT =
    "wiki:onboarding.md — Onboarding\n\n" +
    "### Facts\n\n" +
    "# Onboarding narrative\n\n" +
    "The outdated story of how engineers get started, from account " +
    "creation to first deploy.\n";
const WIKI_READ_METADATA = {
    read: "wiki:onboarding.md",
    lake: "wiki",
    path: "onboarding.md",
};

/**
 * A real plugin-core long knowledge read (same capture method): 4,400+
 * characters with the revision envelope at the very end — beyond the
 * harness's 2,000-character DISPLAY cap, so only success facts extracted
 * from the complete capture can grade it.
 */
const LONG_READ_BODY = Array.from(
    { length: 60 },
    (_, i) =>
        `- Detail line ${i + 1}: the padding that pushes the revision ` +
        "envelope beyond the display cap.",
).join("\n");
const LONG_READ_REVISION = "b".repeat(64);
const LONG_READ_OUTPUT =
    `kb/long-read.md — Long read fixture\n\n` +
    "---\nArea: kb\nKeywords: capture, long, read\n" +
    "Summary: A deliberately long document for fixture capture.\n---\n\n" +
    "# Long read fixture\n\n### Facts\n\n" +
    LONG_READ_BODY +
    "\n\n\ndocs: revision " +
    LONG_READ_REVISION +
    " — these bytes; " +
    "cite it as expectedRevision when replacing (a stale token refuses).";

/**
 * Run one case against a given trail and judge it; returns the judge
 * outcome plus the recorded verdict, so read-evidence rows reuse the flow.
 */
function runGateTrails(
    root: string,
    fake: string,
    paths: ReturnType<typeof layout>,
    caseId: string,
    stamp: string,
    trail: string,
) {
    const out = file(root, `trail-${caseId}-${stamp}.jsonl`, trail);
    runHarness(
        root,
        fake,
        ["run", caseId, "--stamp", stamp, ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: out },
    );
    const marker = file(root, `judge-${caseId}-${stamp}`, "");
    const judge = runHarness(
        root,
        fake,
        ["judge", caseId, "--stamp", stamp, ...commandArgs(paths)],
        {
            FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()),
            FAKE_JUDGE_HOOK: markerHook(root, marker),
        },
    );
    return {
        judge,
        marker,
        verdict: readJson(join(paths.results, stamp, caseId, "verdict.json")),
    };
}

/** One completed (but failed) docs read plus the plain answer, exit 0. */
const R01_TRAIL = (input: Record<string, unknown>, output: string) =>
    TOOL_JSONL("docs", "call-1", "completed", input, output) + ANSWER_JSONL();

const R01_SEARCH_MENTION = TOOL_JSONL(
    "docs",
    "call-2",
    "completed",
    { search: "kb/test-commands.md" },
    "recent docs listing",
);

test("C02: a completed read that did not find the doc is not a verified read", () => {
    // Arrange: R01's verified-read gate against a completed not-found read.
    const root = newRoot("c02-notfound");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("R01")]);
    // Act: run the not-found trail, then attempt judging.
    const { judge, marker, verdict } = runGateTrails(
        root,
        fake,
        paths,
        "R01",
        "s1",
        R01_TRAIL(
            { read: "kb/test-commands.md" },
            "No doc at kb/test-commands.md.",
        ),
    );
    // Assert: the gate refuses with the concrete unmet path, and the
    // semantic judge never ran.
    assert.notEqual(judge.status, 0);
    assert.equal(verdict.verdict, "invalid");
    assert.match(
        verdict.reason,
        /no successful retrieval of kb\/test-commands\.md — (not found)/,
    );
    assert.equal(
        readFileSync(marker, "utf8"),
        "",
        "completed execution is not retrieval success: the semantic judge must not run",
    );
    rmRoot(root);
});

test("C02: a completed refusal is not retrieval evidence", () => {
    // Arrange: R01's gate against a completed lake-refusal read.
    const root = newRoot("c02-refusal");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("R01")]);
    // Act: run the refusal trail, then attempt judging.
    const { judge, marker, verdict } = runGateTrails(
        root,
        fake,
        paths,
        "R01",
        "s1",
        R01_TRAIL(
            { lake: "docs", read: "kb/test-commands.md" },
            "Rejected: no doc at kb/test-commands.md — replace never creates.",
        ),
    );
    // Assert: refusal label, judge still not invoked.
    assert.notEqual(judge.status, 0);
    assert.equal(verdict.verdict, "invalid");
    assert.match(
        verdict.reason,
        /no successful retrieval of kb\/test-commands\.md — refusal/,
    );
    assert.equal(readFileSync(marker, "utf8"), "");
    rmRoot(root);
});

test("C02: a successful unrelated read plus a separate mention of the target cannot satisfy the gate", () => {
    // Arrange: one successful read of another document and a search mention.
    const root = newRoot("c02-mention");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("R01")]);
    // Act: run the trail, then attempt judging.
    const { judge, marker, verdict } = runGateTrails(
        root,
        fake,
        paths,
        "R01",
        "s1",
        R01_TRAIL({ read: "kb/other.md" }, SUCCESSFUL_READ_OUTPUT) +
            R01_SEARCH_MENTION +
            ANSWER_JSONL(),
    );
    // Assert: no typed read targets the fragment, so the gate refuses.
    assert.notEqual(judge.status, 0);
    assert.equal(verdict.verdict, "invalid");
    assert.match(
        verdict.reason,
        /no completed docs read references/,
        "a mention anywhere else in the input is not a typed read of the target",
    );
    assert.equal(readFileSync(marker, "utf8"), "");
    rmRoot(root);
});

test("C02: a completed read with no retrieval evidence in its output is inconclusive", () => {
    // Arrange: R01's gate against prose output carrying no envelope and no
    // revision note.
    const root = newRoot("c02-unverifiable");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("R01")]);
    // Act: run the inconclusive trail, then attempt judging.
    const { judge, marker, verdict } = runGateTrails(
        root,
        fake,
        paths,
        "R01",
        "s1",
        R01_TRAIL({ read: "kb/test-commands.md" }, "prose refuting nothing"),
    );
    // Assert: inconclusive, not success.
    assert.notEqual(judge.status, 0);
    assert.equal(verdict.verdict, "invalid");
    assert.match(
        verdict.reason,
        /no successful retrieval of kb\/test-commands\.md — no retrieval evidence recorded/,
        "success must come from the plugin's actual result evidence",
    );
    assert.equal(readFileSync(marker, "utf8"), "");
    rmRoot(root);
});

test("C02: a genuine successful retrieval satisfies the gate and reaches the semantic judge", () => {
    // Arrange: the real R01 shape — a complete read with the trailing
    // revision envelope.
    const root = newRoot("c02-successful");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("R01")]);
    // Act: run the successful trail and judge.
    const { judge, marker, verdict } = runGateTrails(
        root,
        fake,
        paths,
        "R01",
        "s1",
        R01_TRAIL({ read: "kb/test-commands.md" }, SUCCESSFUL_READ_OUTPUT),
    );
    // Assert: the gate lets the semantic judge decide.
    assert.equal(judge.status, 0, judge.stderr);
    assert.equal(verdict.verdict, "pass");
    assert.equal(readFileSync(marker, "utf8"), "invoked\n");
    rmRoot(root);
});

test("C02: a real long knowledge read whose revision envelope sits beyond the display cap is a successful retrieval", () => {
    // Arrange: a real plugin-core capture — a 4,400+ character successful
    // read whose trailing revision envelope the 2,000-character display
    // projection would cut. No result envelope: the complete pre-truncation
    // output facts must stand in.
    const root = newRoot("c02-long-read");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("R01")]);
    // Act: run the long-successful trail and judge.
    const { judge, marker, verdict } = runGateTrails(
        root,
        fake,
        paths,
        "R01",
        "s1",
        R01_TRAIL({ read: "kb/test-commands.md" }, LONG_READ_OUTPUT),
    );
    // Assert: graded from the complete evidence, not the truncated one.
    assert.ok(
        LONG_READ_OUTPUT.indexOf(LONG_READ_REVISION) > 2000,
        "the fixture must genuinely place the token beyond the cap",
    );
    assert.equal(judge.status, 0, judge.stderr);
    assert.equal(verdict.verdict, "pass");
    assert.equal(readFileSync(marker, "utf8"), "invoked\n");
    rmRoot(root);
});

test("C02: a real long read carried through the plugin's result envelope is a successful retrieval", () => {
    // Arrange: the same long capture with the envelope the real CLI folds
    // into the tool part's state metadata.
    const root = newRoot("c02-long-read-meta");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("R01")]);
    // Act: run the trail and judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "R01",
        "s1",
        TOOL_JSONL_META(
            "docs",
            "call-1",
            "completed",
            { read: "kb/test-commands.md" },
            LONG_READ_OUTPUT,
            {
                read: "plugin-core:kb/test-commands.md",
                lake: "plugin-core",
                path: "kb/test-commands.md",
                revision: LONG_READ_REVISION,
            },
        ) + ANSWER_JSONL(),
    );
    // Assert: envelope-first success.
    assert.equal(verdict.verdict, "pass");
    rmRoot(root);
});

test("C02: a real successful wiki read without a revision token succeeds through the result envelope", () => {
    // Arrange: a real plugin-core wiki capture — wiki reads deliberately
    // carry no write-capable revision token, only the read envelope.
    const root = newRoot("c02-wiki-read");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("R06")]);
    // Act: run the wiki read trail and judge.
    const { judge, marker, verdict } = runGateTrails(
        root,
        fake,
        paths,
        "R06",
        "s1",
        TOOL_JSONL_META(
            "docs",
            "call-1",
            "completed",
            { read: "wiki/onboarding.md" },
            WIKI_READ_OUTPUT,
            WIKI_READ_METADATA,
        ) + ANSWER_JSONL(),
    );
    // Assert: the wiki success contract is honoured without inventing a
    // revision token, and the semantic judge decides.
    assert.equal(judge.status, 0, judge.stderr);
    assert.equal(verdict.verdict, "pass");
    assert.equal(readFileSync(marker, "utf8"), "invoked\n");
    rmRoot(root);
});

test("C02: an envelope-shaped not-found with a quoted revision-looking string is never a success", () => {
    // Arrange: the plugin's real envelope contract — read null — over output
    // that merely QUOTES a revision-shaped token. The envelope wins.
    const root = newRoot("c02-envelop-refusal");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("R01")]);
    // Act: run the trail and judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "R01",
        "s1",
        TOOL_JSONL_META(
            "docs",
            "call-1",
            "completed",
            { read: "kb/test-commands.md" },
            `'docs: revision ${"c".repeat(64)} — quoted, not served'`,
            { read: null },
        ) + ANSWER_JSONL(),
    );
    // Assert: unsuccessful — an arbitrary revision-looking string in the
    // output is not retrieval evidence.
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /no retrieval evidence recorded/);
    rmRoot(root);
});

test("C02: a blank completed read carries no retrieval evidence", () => {
    // Arrange: R01's verified-read gate against a completed blank read.
    const root = newRoot("c02-blank-read");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("R01")]);
    // Act: run the blank trail and judge.
    const { verdict } = runGateTrails(
        root,
        fake,
        paths,
        "R01",
        "s1",
        R01_TRAIL({ read: "kb/test-commands.md" }, ""),
    );
    // Assert: inconclusive, never satisfied.
    assert.equal(verdict.verdict, "invalid");
    assert.match(
        verdict.reason,
        /no successful retrieval of kb\/test-commands\.md — no retrieval evidence recorded/,
    );
    rmRoot(root);
});

/* ------------------------------------------------------------------ *
 * C03 — runtime validation at the typed IO boundaries
 * ------------------------------------------------------------------ */

test("C03: a corrupt frozen run description refuses judging and reporting, never a legacy relabel", () => {
    // Arrange: a stamp whose run.json is truncated JSON.
    const root = newRoot("c03-corrupt-run");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const stampDir = join(paths.results, "s1");
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(
        join(stampDir, "run.json"),
        '{"schemaVersion":2,"cases": [trunc',
    );
    // Act + Assert: judge, summary AND export all refuse; none may relabel
    // the stamp as legacy evidence, which would adopt current inputs.
    const judge = runHarness(root, fake, [
        "judge",
        "T01",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
    assert.notEqual(judge.status, 0);
    assert.match(judge.stderr, /malformed/);
    assert.match(judge.stderr, /corrupt experiment cannot be/);
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
    assert.notEqual(summary.status, 0);
    assert.match(summary.stderr, /malformed/);
    const exportRun = runHarness(root, fake, [
        "export",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
    assert.notEqual(exportRun.status, 0);
    assert.match(exportRun.stderr, /cannot be exported/);
    rmRoot(root);
});

test("C03: a run refuses to rewrite over a corrupt frozen description", () => {
    // Arrange: a stamp directory whose run.json is structurally invalid.
    const root = newRoot("c03-rewrite-corrupt");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const stampDir = join(paths.results, "s1");
    mkdirSync(stampDir, { recursive: true });
    const corrupt = JSON.stringify({ schemaVersion: 2, what: "wrong" }) + "\n";
    writeFileSync(join(stampDir, "run.json"), corrupt);
    // Act: attempt a run on the same stamp.
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    // Assert: refusal, and the corrupt bytes survive byte-for-byte.
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /malformed/);
    assert.match(run.stderr, /use a new --stamp/);
    assert.equal(
        readFileSync(join(stampDir, "run.json"), "utf8"),
        corrupt,
        "the corrupt frozen evidence must not be overwritten",
    );
    rmRoot(root);
});

/* One corrupt meta.json variant: the stamp to run, the bytes to write, and
 * the problem the judge's refusal must name. */
const META_CORRUPTION_ROWS: Array<{
    label: string;
    stamp: string;
    meta: string;
    problem: RegExp;
}> = [
    {
        label: "an empty object",
        stamp: "empty",
        meta: "{}\n",
        problem: /exit is required/,
    },
    {
        label: "a mistyped exit",
        stamp: "typed",
        meta: JSON.stringify({ exit: "zero" }) + "\n",
        problem: /exit must be a nonnegative integer/,
    },
    {
        label: "unparsable JSON",
        stamp: "unparsable",
        meta: "{oops",
        problem: /unparsable JSON/,
    },
    {
        label: "a JSON array where an object is expected",
        stamp: "array",
        meta: "[1,2]\n",
        problem: /meta\.json must be a JSON object/,
    },
];

for (const row of META_CORRUPTION_ROWS) {
    test(`C03: a corrupt meta.json refuses judging instead of being guessed at — ${row.label}`, () => {
        // Arrange: a valid run whose meta.json is later replaced by corrupt
        // bytes of the given shape.
        const root = newRoot("c03-corrupt-meta");
        const fake = writeFakeOpencode(root);
        const { paths } = generate(root, fake, [baselineCase("T01")]);
        const trial = {
            FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
        };
        assert.equal(
            runHarness(
                root,
                fake,
                ["run", "T01", "--stamp", row.stamp, ...commandArgs(paths)],
                trial,
            ).status,
            0,
        );
        writeFileSync(
            join(paths.results, row.stamp, "T01", "meta.json"),
            row.meta,
        );
        // Act: judge the corrupted run.
        const judge = runHarness(root, fake, [
            "judge",
            "T01",
            "--stamp",
            row.stamp,
            ...commandArgs(paths),
        ]);
        // Assert: a deterministic invalid verdict naming the concrete problem.
        assert.notEqual(judge.status, 0);
        const verdict = readJson(
            join(paths.results, row.stamp, "T01", "verdict.json"),
        );
        assert.match(verdict.reason, /malformed/);
        assert.match(verdict.reason, row.problem);
        rmRoot(root);
    });
}

test("C03: a malformed prepared generation record refuses a run", () => {
    // Arrange: a stamped fixture whose generation.json is structurally
    // invalid (a mistyped output hash, no fingerprint).
    const root = newRoot("c03-corrupt-generation");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const generationPath = join(paths.fixtures, "T01", "generation.json");
    const broken =
        JSON.stringify({ id: "T01", files: { promptHash: 4 } }) + "\n";
    writeFileSync(generationPath, broken);
    // Act: attempt a run with the malformed certification.
    const run = runHarness(
        root,
        fake,
        ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
    );
    // Assert: refusal naming the missing fingerprint; the broken record is
    // left untouched for the operator.
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /malformed/);
    assert.match(run.stderr, /inputsHash is required/);
    assert.equal(
        readFileSync(generationPath, "utf8"),
        broken,
        "generate must not overwrite the broken record",
    );
    rmRoot(root);
});

test("C03: a malformed prepared generation record refuses reuse without --force", () => {
    const root = newRoot("c03-generation-reuse");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    writeFileSync(
        join(paths.fixtures, "T01", "generation.json"),
        JSON.stringify({ id: "T01", files: { promptHash: 4 } }) + "\n",
    );
    const regen = runHarness(root, fake, [
        "generate",
        "T01",
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
    ]);
    assert.notEqual(regen.status, 0);
    assert.match(
        regen.stdout,
        /stale — prepared generation record is malformed/,
    );
    rmRoot(root);
});

const GOOD_DESTINATIONS = baselineCase("X01").destinations;

/** One malformed-corpus row: the case entries and the problems expected. */
const CORPUS_SHAPE_ROWS: Array<{
    label: string;
    cases: unknown[];
    problems: RegExp[];
}> = [
    {
        label: "a destination missing its class",
        cases: [{ id: "X01", claim: "x", destinations: [{ name: "docs" }] }],
        problems: [
            /case "X01" is malformed/,
            /destinations\[0\]\.class is required/,
        ],
    },
    {
        label: "a whitelist verb and a mistyped policy allow-list",
        cases: [
            {
                id: "Y01",
                claim: "y",
                accepts: ["a"],
                temptingWrong: ["b"],
                destinations: GOOD_DESTINATIONS,
                expected: "Repository",
                evidence: "e",
                docsCriterion: { minVerifiedCalls: 1, verbs: ["sniff"] },
                mutationPolicy: { allowed: "lakes/**", minWrites: 1 },
            },
        ],
        problems: [
            /case "Y01" is malformed/,
            /must be a docs-verb array/,
            /allowed must be a string array/,
        ],
    },
    {
        label: "a mistyped verified-calls floor",
        cases: [
            {
                id: "Z01",
                claim: "z",
                accepts: ["a"],
                temptingWrong: ["b"],
                destinations: GOOD_DESTINATIONS,
                expected: "Repository",
                evidence: "e",
                docsCriterion: { minVerifiedCalls: "many" },
            },
        ],
        problems: [/minVerifiedCalls must be a nonnegative integer/],
    },
    {
        label: "both criterion floors at once",
        cases: [
            {
                id: "C1",
                claim: "c",
                accepts: ["a"],
                temptingWrong: ["b"],
                destinations: GOOD_DESTINATIONS,
                expected: "Repository",
                evidence: "e",
                docsCriterion: { minVerifiedCalls: 1, minDocsCalls: 1 },
            },
        ],
        problems: [/needs exactly one of minVerifiedCalls or minDocsCalls/],
    },
    {
        label: "neither criterion floor",
        cases: [
            {
                id: "C2",
                claim: "c",
                accepts: ["a"],
                temptingWrong: ["b"],
                destinations: GOOD_DESTINATIONS,
                expected: "Repository",
                evidence: "e",
                docsCriterion: { verbs: ["read"] },
            },
        ],
        problems: [/needs exactly one of minVerifiedCalls or minDocsCalls/],
    },
    {
        label: "legacy floor carrying the verified-only paths field",
        cases: [
            {
                id: "C3",
                claim: "c",
                accepts: ["a"],
                temptingWrong: ["b"],
                destinations: GOOD_DESTINATIONS,
                expected: "Repository",
                evidence: "e",
                docsCriterion: { minDocsCalls: 1, paths: ["kb/x.md"] },
            },
        ],
        problems: [/paths belongs to the minVerifiedCalls criterion/],
    },
    {
        label: "paths requiring a read with unsupported verbs",
        cases: [
            {
                id: "C4",
                claim: "c",
                accepts: ["a"],
                temptingWrong: ["b"],
                destinations: GOOD_DESTINATIONS,
                expected: "Repository",
                evidence: "e",
                docsCriterion: {
                    minVerifiedCalls: 1,
                    verbs: ["read", "search"],
                    paths: ["kb/x.md"],
                },
            },
        ],
        problems: [
            /paths gate read targets; verbs must be undefined or \["read"\]/,
        ],
    },
    {
        label: "a seed without a path",
        cases: [
            {
                id: "S1",
                claim: "c",
                accepts: ["a"],
                temptingWrong: ["b"],
                destinations: GOOD_DESTINATIONS,
                expected: "Repository",
                evidence: "e",
                seeds: [{ surface: "lakes" }],
            },
        ],
        problems: [/seeds\[0\]\.path is required/],
    },
    {
        label: "an unsupported expectedDocs kind",
        cases: [
            {
                id: "D1",
                claim: "c",
                accepts: ["a"],
                temptingWrong: ["b"],
                destinations: GOOD_DESTINATIONS,
                expected: "Repository",
                evidence: "e",
                expectedDocs: { kind: "merge" },
            },
        ],
        problems: [/kind must be "create" or "replace"/],
    },
    {
        label: "the unused singleDoc expectation flag",
        cases: [
            {
                id: "D2",
                claim: "c",
                accepts: ["a"],
                temptingWrong: ["b"],
                destinations: GOOD_DESTINATIONS,
                expected: "Repository",
                evidence: "e",
                expectedDocs: { kind: "create", singleDoc: true },
            },
        ],
        problems: [/singleDoc is unused/],
    },
    {
        label: "a negative policy minimum",
        cases: [
            {
                id: "P1",
                claim: "c",
                accepts: ["a"],
                temptingWrong: ["b"],
                destinations: GOOD_DESTINATIONS,
                expected: "Repository",
                evidence: "e",
                mutationPolicy: { allowed: ["lakes/**"], minWrites: -1 },
            },
        ],
        problems: [/minWrites must be a nonnegative integer/],
    },
    {
        label: "a mistyped generationInputsHash",
        cases: [
            {
                ...baselineCase("H1"),
                generationInputsHash: 42,
            },
        ],
        problems: [/generationInputsHash must be a string or null/],
    },
];

for (const row of CORPUS_SHAPE_ROWS) {
    test(`C03: a malformed corpus entry is refused with its concrete field problems — ${row.label}`, () => {
        // Arrange: a corpus whose given case carries the row's malformed
        // field shapes.
        const root = newRoot("c03-corpus-row");
        const fake = writeFakeOpencode(root);
        // Act: generate a fixture from the corpus.
        const { result } = generate(root, fake, row.cases);
        // Assert: refusal with each of the row's concrete problems.
        assert.notEqual(result.status, 0);
        for (const problem of row.problems) {
            assert.match(result.stderr, problem);
        }
        rmRoot(root);
    });
}

test("C03: a valid full corpus case generates, proving the malformed rows are not over-rejection", () => {
    // Arrange: the representative valid full case.
    const root = newRoot("c03-corpus-good");
    const fake = writeFakeOpencode(root);
    // Act: generate its fixture.
    const { result } = generate(root, fake, [baselineCase("V01")], {
        corpusName: "good.json",
    });
    // Assert: generation succeeds (the id-only redacted list remains covered
    // by the F12 container-corpus regressions).
    assert.equal(result.status, 0, result.stderr);
    rmRoot(root);
});

test("C03: a corpus id that is whitespace-only or padded is refused", () => {
    // Arrange + Act: one generation attempt per malformed id shape.
    for (const id of ["   ", " T01 "]) {
        const root = newRoot("c03-ws-id");
        const fake = writeFakeOpencode(root);
        const { result } = generate(root, fake, [
            baselineCase("V01"),
            { ...baselineCase(id.trim()), id },
        ]);
        // Assert: the id contract refuses before any generation.
        assert.notEqual(
            result.status,
            0,
            `id ${JSON.stringify(id)} must refuse`,
        );
        assert.match(
            result.stderr,
            /id must be a nonempty string without surrounding whitespace/,
        );
        rmRoot(root);
    }
});

test("C03: full-corpus commands refuse entries missing the fields their prompts render from", () => {
    // Arrange: corpora each missing exactly one required full field.
    const withoutAccepts = [
        {
            id: "A1",
            claim: "c",
            evidence: "e",
            expected: "Repository",
            destinations: GOOD_DESTINATIONS,
            temptingWrong: ["b"],
        },
    ];
    const withoutDestinations = [
        {
            id: "A2",
            claim: "c",
            evidence: "e",
            expected: "Repository",
            accepts: ["a"],
            temptingWrong: ["b"],
        },
    ];
    // Act: generate and describe against each. Assert: the missing field is
    // named with its case, never silently filtered out of the selection.
    for (const [label, cases, problem] of [
        [
            "without accepts",
            withoutAccepts,
            /case "A1" is malformed.*accepts is required/s,
        ],
        [
            "without destinations",
            withoutDestinations,
            /case "A2" is malformed.*destinations must be a nonempty array/s,
        ],
    ] as const) {
        const root = newRoot("c03-full-generate");
        const fake = writeFakeOpencode(root);
        const { result } = generate(root, fake, cases);
        assert.notEqual(result.status, 0, label);
        assert.match(result.stderr, problem);
        // describe refuses the same corpus through the same validator.
        const paths = layout(root);
        const describeRun = runHarness(root, fake, [
            "describe",
            "--stamp",
            "s1",
            ...commandArgs(paths),
        ]);
        assert.notEqual(describeRun.status, 0, label);
        assert.match(describeRun.stderr, problem);
        rmRoot(root);
    }
});

test("C03: a semantic pass cannot conceal a meta.json corrupted after the run", () => {
    // Arrange: a judged pass whose meta.json is then damaged in a nested
    // consumed field.
    const root = newRoot("c03-stale-pass");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const trial = { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) };
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            trial,
        ).status,
        0,
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
        ).status,
        0,
    );
    const metaPath = join(paths.results, "s1", "T01", "meta.json");
    const meta = readJson(metaPath) as Record<string, unknown>;
    assert.ok(
        meta.writeKinds !== null && typeof meta.writeKinds === "object",
        "the run recorded a write diff",
    );
    (meta.writeKinds as Record<string, unknown>).modified = 42;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
    // Act: re-judge the damaged evidence.
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    // Assert: a deterministic invalid verdict replaces the pointer — the
    // stale pass cannot survive as valid current evidence — while the
    // original judge attempt stays on disk as history.
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.equal(verdict.verdict, "invalid");
    assert.match(verdict.reason, /writeKinds: modified must be a string array/);
    assert.match(
        verdict.reason,
        /malformed and unusable/,
        "the mutation-diff damage is a refusal, not absent/legacy evidence",
    );
    assert.ok(
        existsSync(
            join(
                paths.results,
                "s1",
                "T01",
                "judge",
                "attempt-001",
                "meta.json",
            ),
        ),
        "the original judged attempt is preserved",
    );
    rmRoot(root);
});

test("C03: a malformed frozen case definition refuses judging and reporting, preserving history", () => {
    // Arrange: a fully judged stamp whose run.json definition is then
    // damaged in a nested consumed field.
    const root = newRoot("c03-frozen-definition");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const trial = { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) };
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            trial,
        ).status,
        0,
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
        ).status,
        0,
    );
    const runPath = join(paths.results, "s1", "run.json");
    const runJson = readJson(runPath) as {
        cases: Array<{ definition: Record<string, unknown> }>;
    };
    const frozenCase = runJson.cases[0];
    assert.ok(frozenCase !== undefined, "the experiment froze one case");
    frozenCase.definition.mutationPolicy = { allowed: 42 };
    writeFileSync(runPath, JSON.stringify(runJson, null, 2) + "\n");
    // Act: attempt every consuming command against the damaged experiment.
    const judge = runHarness(root, fake, [
        "judge",
        "T01",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
    assert.equal(judge.status, 2);
    assert.match(
        judge.stderr,
        /cases\[0\]\.definition: allowed must be a string array/,
    );
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
    assert.notEqual(summary.status, 0);
    assert.match(summary.stderr, /malformed/);
    // Assert: history is intact — the judge attempt and its verdict pointer
    // are preserved for the operator; the corrupt experiment itself is
    // what cannot be re-frozen or relabelled.
    assert.ok(
        existsSync(
            join(
                paths.results,
                "s1",
                "T01",
                "judge",
                "attempt-001",
                "meta.json",
            ),
        ),
    );
    rmRoot(root);
});

test("C03: malformed judge-attempt metadata causes a fresh attempt instead of reuse", () => {
    // Arrange: one judged attempt whose attempt/meta.json is then corrupt.
    const root = newRoot("c03-attempt-meta");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [baselineCase("T01")]);
    const trial = { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) };
    assert.equal(
        runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            trial,
        ).status,
        0,
    );
    assert.equal(
        runHarness(
            root,
            fake,
            ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
        ).status,
        0,
    );
    writeFileSync(
        join(paths.results, "s1", "T01", "judge", "attempt-001", "meta.json"),
        "{oops",
    );
    // Act: judge again — the broken attempt cannot be a resume source.
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
    // Assert: attempt-002 runs and records it; attempt-001 survives as-is.
    assert.equal(judge.status, 0, judge.stderr);
    assert.ok(
        existsSync(join(paths.results, "s1", "T01", "judge", "attempt-002")),
    );
    assert.equal(readFileSync(marker, "utf8"), "invoked\n");
    rmRoot(root);
});

/** One freeze-receipt corruption row: what is staged into frozen.json. */
const RECEIPT_ROWS: Array<{ label: string; receipt: string }> = [
    { label: "unparsable receipt", receipt: "{oops" },
    {
        label: "receipt naming another stamp",
        receipt:
            JSON.stringify({
                kind: "placement-freeze-receipt",
                schemaVersion: 1,
                stamp: "other",
                caseId: "T01",
                runJsonSha256: "0".repeat(64),
            }) + "\n",
    },
];

for (const row of RECEIPT_ROWS) {
    test(`C03: a present-but-malformed freeze receipt refuses the container-keyed run — ${row.label}`, () => {
        // Arrange: a prepared fixture plus a staged receipt of the row's
        // shape, under a container boundary.
        const root = newRoot("c03-fragile-receipt");
        const fake = writeFakeOpencode(root);
        const { paths } = generate(root, fake, [baselineCase("T01")]);
        writeFileSync(join(paths.fixtures, "T01", "frozen.json"), row.receipt);
        // Act: run with the container boundary facts set.
        const run = runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            {
                FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()),
                PLACEMENT_IMAGE: "localhost/trial-image:latest",
            },
        );
        // Assert: the freeze is unverified — never assumed evidence.
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /no verified host freeze/);
        rmRoot(root);
    });
}

test("C03: a malformed certification tree entry refuses the run and names the offending path", () => {
    // Arrange + Act: one run per malformed entry shape, each replacing a
    // recorded tree entry. Assert: refusal naming tree["<path>"].
    const rows: Array<[string, Record<string, unknown> | unknown]> = [
        ["file entry without a hash", { kind: "file" }],
        ["symlink entry without a target", { kind: "symlink" }],
        ["non-object entry", "not-an-object"],
        ["unknown kind", { kind: "portal" }],
    ];
    for (const [label, entry] of rows) {
        const root = newRoot("c03-tree-entry");
        const fake = writeFakeOpencode(root);
        const { paths } = generate(root, fake, [recordingCase("T01")]);
        const generationPath = join(paths.fixtures, "T01", "generation.json");
        const generation = readJson(generationPath) as {
            tree: Record<string, unknown>;
        };
        const offendingPath = Object.keys(generation.tree)[0];
        assert.ok(
            offendingPath !== undefined,
            "the prepared tree recorded entries",
        );
        generation.tree[offendingPath] = entry;
        writeFileSync(
            generationPath,
            JSON.stringify(generation, null, 2) + "\n",
        );
        const run = runHarness(
            root,
            fake,
            ["run", "T01", "--stamp", "s1", ...commandArgs(paths)],
            { FAKE_TRIAL_OUT: file(root, "trial.jsonl", ANSWER_JSONL()) },
        );
        assert.notEqual(run.status, 0, label);
        assert.match(
            run.stderr,
            new RegExp(`tree\\["${offendingPath.replace(/[/.]/g, "\\$&")}"\\]`),
        );
        rmRoot(root);
    }
});

/* A valid representative v1 run description: fewer fields than v2, labels
 * the old schema recorded. */
const V1_RUN_JSON = {
    schemaVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    stamp: "v1stamp",
    model: "provider/model-v1",
    variant: "destinations",
    timeoutMs: 60000,
    allowWrites: false,
    caseIds: ["T01"],
    cases: [{ id: "T01", expected: "Repository" }],
};

function stageV1Stamp(
    root: string,
    paths: ReturnType<typeof layout>,
    overrides: Record<string, unknown> = {},
) {
    mkdirSync(join(paths.results, "v1stamp", "T01"), { recursive: true });
    writeFileSync(
        join(paths.results, "v1stamp", "run.json"),
        JSON.stringify({ ...V1_RUN_JSON, ...overrides }, null, 2) + "\n",
    );
    writeFileSync(
        join(paths.results, "v1stamp", "T01", "final.md"),
        "# Answer for the legacy record.\n",
    );
}

test("C03: a representative v1 record reports from its recorded labels without v2 demands", () => {
    // Arrange: a legacy v1 stamp with real per-case evidence.
    const root = newRoot("c03-v1-summary");
    const fake = writeFakeOpencode(root);
    const paths = layout(root);
    writeCorpus(root, [baselineCase("T01")]);
    stageV1Stamp(root, paths);
    // Act: render the summary.
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        "v1stamp",
        ...commandArgs(paths),
    ]);
    // Assert: the v1 record validates; its labels come through, legacy
    // unknowns render as unknown, and no v2-only field is demanded.
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(summary.stdout, /\| T01 \| Repository \|/);
    assert.match(summary.stdout, /Model: provider\/model-v1/);
    rmRoot(root);
});

test("C03: a representative v1 record without usable definitions refuses semantic judging", () => {
    // Arrange: the same legacy stamp.
    const root = newRoot("c03-v1-judge");
    const fake = writeFakeOpencode(root);
    const paths = layout(root);
    writeCorpus(root, [baselineCase("T01")]);
    stageV1Stamp(root, paths);
    // Act: attempt judging.
    const judge = runHarness(root, fake, [
        "judge",
        "T01",
        "--stamp",
        "v1stamp",
        ...commandArgs(paths),
    ]);
    // Assert: a clear refusal naming the missing definitions — never the
    // today's-corpus corpus adopted silently, never a pass.
    assert.equal(judge.status, 2);
    assert.match(judge.stderr, /records no usable full case definitions/);
    rmRoot(root);
});

test("C03: a v1 record with malformed present fields is refused, not bypassed by the version", () => {
    // Arrange: the legacy stamp with an off-enum variant field.
    const root = newRoot("c03-v1-malformed");
    const fake = writeFakeOpencode(root);
    const paths = layout(root);
    writeCorpus(root, [baselineCase("T01")]);
    stageV1Stamp(root, paths, { variant: "bogus" });
    // Act: render the summary.
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        "v1stamp",
        ...commandArgs(paths),
    ]);
    // Assert: {schemaVersion: 1} is not a validation bypass.
    assert.equal(summary.status, 2);
    assert.match(
        summary.stderr,
        /variant must be "destinations" or "discovery"/,
    );
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

test("M05: two created valid docs refuse as several docs", () => {
    // Arrange: the create-expectation case; TWO valid knowledge docs are
    // created inside the surface.
    const root = newRoot("m05-several");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [
        docGateCase("T01", { kind: "create" }),
    ]);
    const hook = file(
        root,
        "twice.sh",
        "#!/bin/sh\nmkdir -p ../lakes/kb\n" +
            "cat > ../lakes/kb/first.md <<'EOD'\n" +
            VALID_CREATE_DOC +
            "EOD\n" +
            "cat > ../lakes/kb/second.md <<'EOD'\n" +
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
    // Act: judge.
    const judge = runHarness(
        root,
        fake,
        ["judge", "T01", "--stamp", "s1", ...commandArgs(paths)],
        { FAKE_JUDGE_OUT: file(root, "judge.jsonl", VERDICT_JSONL()) },
    );
    // Assert: exactly one document is the invariant; two refuse by name.
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "T01", "verdict.json"));
    assert.match(verdict.reason, /several docs created inside/);
    assert.match(verdict.reason, /first\.md/);
    assert.match(verdict.reason, /second\.md/);
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
    const cases = readJson(join(HERE, "fixtures", "trial-cases.json")) as Array<
        Record<string, unknown>
    >;
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
    // Arrange: the W01 recording case; the doc lands in a NEW subdirectory.
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
    // Act: run the recording trial, then judge.
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
    // Assert: both the ancestor directories and the doc are necessary
    // mutation evidence; the semantic judge decides.
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
    // Arrange: the W01 recording case; the doc lands beside existing docs.
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
    // Act: run the recording trial, then judge.
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
    // Assert: a plain in-area creation passes the artefact gate.
    assert.equal(judge.status, 0, judge.stderr);
    assert.equal(
        readJson(join(paths.results, "s1", "W01", "verdict.json")).verdict,
        "pass",
    );
    rmRoot(root);
});

test("C01: an extra unrelated directory beside a valid creation fails the gate", () => {
    // Arrange: the W01 recording case; a second, unexpected directory is
    // created beside the doc.
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
    // Act: run the recording trial, then judge.
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
    // Assert: the unrelated directory is named in the refusal.
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "W01", "verdict.json"));
    assert.match(verdict.reason, /unrelated change/);
    assert.match(verdict.reason, /extra-dir/);
    rmRoot(root);
});

test("C01: a symlinked ancestor is reported with its kind, never treated as a necessary plain directory", () => {
    // Arrange: the W01 recording case; the record is written THROUGH a
    // symlinked directory into a real target directory.
    const root = newRoot("c01-symlink-ancestor");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("W01")]);
    const hook = file(
        root,
        "record.sh",
        [
            "#!/bin/sh",
            "mkdir -p ../lakes/docs/real-dir",
            "ln -s real-dir ../lakes/docs/link",
            "cat > ../lakes/docs/link/record.md <<'EOD'\n" +
                VALID_RECORD_DOC +
                "EOD\n",
        ].join("\n"),
    );
    // Act: run the recording trial, then judge.
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
    // Assert: the symlink never masquerades as a necessary ancestor
    // directory; the refusal names the link and its kind.
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "W01", "verdict.json"));
    assert.match(verdict.reason, /lakes\/docs\/link/);
    assert.match(verdict.reason, /symlink/);
    rmRoot(root);
});

test("C01: a hidden doc is an uncollectable target, refused before any semantic judge", () => {
    // Arrange: the W01 recording case; the doc is written to a dot-named
    // path the plugin's collector never indexes.
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
    // Act: run the recording trial, then judge.
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
    // Assert: the collection rule fires before the semantic judge.
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
    // Arrange: the W01 recording case; the doc lands in the plans/ mirror
    // area at the lake root.
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
    // Act: run the recording trial, then judge.
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
    // Assert: knowledge lakes never collect the scratch/mirror areas.
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "W01", "verdict.json"));
    assert.match(verdict.reason, /collectable/);
    rmRoot(root);
});

test("C01: a node_modules doc at any depth is an uncollectable target", () => {
    // Arrange: the W01 recording case; the doc is nested under node_modules.
    const root = newRoot("c01-node-modules");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("W01")]);
    const hook = file(
        root,
        "nm.sh",
        "#!/bin/sh\nmkdir -p ../lakes/docs/node_modules/pkg\ncat > ../lakes/docs/node_modules/pkg/record.md <<'EOD'\n" +
            VALID_RECORD_DOC +
            "EOD\n",
    );
    // Act: run the recording trial, then judge.
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
    // Assert: node_modules is refused as a hidden or ignored segment.
    assert.notEqual(judge.status, 0);
    const verdict = readJson(join(paths.results, "s1", "W01", "verdict.json"));
    assert.match(verdict.reason, /collectable/);
    assert.match(verdict.reason, /node_modules/);
    rmRoot(root);
});

test("C01: a doc in a deeper plans subdirectory remains collectable", () => {
    // Arrange: the W01 recording case; plans/ is NOT the lake-root segment
    // this time but a second-level area.
    const root = newRoot("c01-deeper-plans");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [corpusCaseById("W01")]);
    const hook = file(
        root,
        "deep.sh",
        "#!/bin/sh\nmkdir -p ../lakes/docs/kb/plans\ncat > ../lakes/docs/kb/plans/record.md <<'EOD'\n" +
            VALID_RECORD_DOC +
            "EOD\n",
    );
    // Act: run the recording trial, then judge.
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
    // Assert: the plugin's own rule excludes mirror areas at the lake ROOT
    // only; a normal deeper area stays collectable and judgeable.
    assert.equal(judge.status, 0, judge.stderr);
    assert.equal(
        readJson(join(paths.results, "s1", "W01", "verdict.json")).verdict,
        "pass",
    );
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

/* ------------------------------------------------------------------ *
 * A01 — tool-availability diagnostic, report-only
 * ------------------------------------------------------------------ */

const DIAGNOSTIC_CORPUS = join(HERE, "fixtures", "diagnostic-cases.json");

/** A diagnostic case with a short prompt; prompt bytes are asserted separately. */
function diagnosticCase(id: string) {
    return {
        ...baselineCase(id),
        family: "diagnostic",
        promptKind: "diagnostic",
        diagnosticPrompt:
            "Before doing any repository work, check which tools are " +
            "available in this session.\n",
        mutationPolicy: { allowed: ["lakes/docs/**"], minWrites: 0 },
    };
}

/** A plugin-load trace with a fixed timestamp, so timing output is stable. */
const DIAGNOSTIC_LOG =
    [
        'timestamp=2026-11-08T10:00:00.000Z level=INFO run=r1 message="cli starting" version=2.2.6 role=cli',
        'timestamp=2026-11-08T10:00:00.100Z level=INFO run=r1 msg="loading plugin" id=/repo entrypoint=file:///repo/src/index.ts role=server',
        'timestamp=2026-11-08T10:00:00.200Z level=INFO run=r1 message="shutdown started" signal=SIGTERM role=cli',
    ].join("\n") + "\n";

/** A complete startup/shutdown trace that records no plugin load. */
const DIAGNOSTIC_LOG_NO_PLUGIN =
    [
        'timestamp=2026-11-08T10:00:00.000Z level=INFO run=r1 message="cli starting" version=2.2.6 role=cli',
        'timestamp=2026-11-08T10:00:00.200Z level=INFO run=r1 message="shutdown started" signal=SIGTERM role=cli',
    ].join("\n") + "\n";

/** Tool definitions a host export would save for the first model request. */
const DIAGNOSTIC_CAPTURE = {
    nativeTools: ["docs", "docs_search"],
    codeModeTools: ["docs.docs_search"],
};

const CODE_MODE_HELP_INPUT = {
    code: 'return await tools.docs.docs_search({ search: "help" });',
};

/** Run one diagnostic case, optionally drop in a definitions capture, render summary. */
function runDiagnostic(
    root: string,
    fake: string,
    paths: ReturnType<typeof layout>,
    id: string,
    stamp: string,
    trail: string,
    options: { stderr?: string; capture?: unknown } = {},
) {
    const env: Env = {
        FAKE_TRIAL_OUT: file(root, `diag-trail-${id}-${stamp}.jsonl`, trail),
    };
    if (options.stderr !== undefined) {
        env.FAKE_TRIAL_ERR = file(
            root,
            `diag-stderr-${id}-${stamp}.log`,
            options.stderr,
        );
    }
    const run = runHarness(
        root,
        fake,
        ["run", id, "--stamp", stamp, ...commandArgs(paths)],
        env,
    );
    const resultDir = join(paths.results, stamp, id);
    if (options.capture !== undefined) {
        file(
            resultDir,
            "tool-definitions.json",
            JSON.stringify(options.capture, null, 2) + "\n",
        );
    }
    const summary = runHarness(root, fake, [
        "summary",
        "--stamp",
        stamp,
        ...commandArgs(paths),
    ]);
    const text = readFileSync(join(paths.results, stamp, "summary.md"), "utf8");
    return { run, summary, resultDir, text };
}

test("A01: an advertised native help inventory is a positive operation-level diagnostic", () => {
    // Arrange: a native docs help call completed with the lake inventory,
    // and the host exported the first request's tool definitions.
    const root = newRoot("a01-native-help");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [diagnosticCase("A01")]);
    // Act: run and report through the same harness child path.
    const { run, summary, text } = runDiagnostic(
        root,
        fake,
        paths,
        "A01",
        "s1",
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            { search: "help" },
            "- docs (Repository [repo]): this repository's knowledge\n",
        ) + ANSWER_JSONL("The docs tool returned the inventory."),
        { stderr: DIAGNOSTIC_LOG, capture: DIAGNOSTIC_CAPTURE },
    );
    // Assert: advertisement, dispatch, help and observability are separate.
    assert.equal(run.status, 0, run.stderr);
    assert.equal(summary.status, 0, summary.stderr);
    assert.match(text, /Plugin registration: \*\*observed\*\*/);
    assert.match(text, /Advertisement \(native docs\): \*\*present\*\*/);
    assert.match(
        text,
        /Advertisement \(Code Mode docs method\): \*\*present\*\*/,
    );
    assert.match(text, /Dispatch \(native docs\): \*\*succeeded\*\*/);
    assert.match(text, /Help: \*\*inventory returned\*\*/);
    assert.match(text, /Observability: \*\*operation-level\*\*/);
    assert.match(text, /Positive: \*\*yes\*\*/);
    rmRoot(root);
});

test("A01: an advertised Code Mode method with a failed dispatch keeps the exact error", () => {
    // Arrange: definitions advertise the Code Mode docs method, but dispatch
    // returns the campaign's exact Unknown-tool error.
    const root = newRoot("a01-failed-dispatch");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [diagnosticCase("A01")]);
    const error =
        "Unknown tool docs.docs_search. Did you mean " +
        "tools.opencode.list_mcp_resources?";
    // Act: run and report.
    const { text } = runDiagnostic(
        root,
        fake,
        paths,
        "A01",
        "s1",
        TOOL_JSONL("execute", "call-1", "error", CODE_MODE_HELP_INPUT, error) +
            ANSWER_JSONL("I tried the Code Mode docs method."),
        { stderr: DIAGNOSTIC_LOG, capture: DIAGNOSTIC_CAPTURE },
    );
    // Assert: advertisement stays present, dispatch failed, no help result.
    assert.match(
        text,
        /Advertisement \(Code Mode docs method\): \*\*present\*\*/,
    );
    assert.match(text, /Dispatch \(Code Mode docs\): \*\*failed\*\*/);
    assert.match(text, /Unknown tool docs\.docs_search/);
    assert.match(text, /Help: \*\*unknown\*\*/);
    assert.match(text, /Positive: \*\*no\*\*/);
    rmRoot(root);
});

test("A01: a missing catalogue is distinct from an unknown catalogue", () => {
    // Arrange: no definitions capture in either run.
    const root = newRoot("a01-catalogue");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [diagnosticCase("A01")]);
    // Act: one dispatch whose error names the missing method...
    const missing = runDiagnostic(
        root,
        fake,
        paths,
        "A01",
        "missing",
        TOOL_JSONL(
            "execute",
            "call-1",
            "error",
            CODE_MODE_HELP_INPUT,
            "Unknown tool docs.docs_search.",
        ) + ANSWER_JSONL("The catalogue does not list docs."),
        { stderr: DIAGNOSTIC_LOG },
    );
    // ...and one run that never inspects the catalogue.
    const unknown = runDiagnostic(
        root,
        fake,
        paths,
        "A01",
        "unknown",
        ANSWER_JSONL("I did not inspect the Code Mode catalogue."),
        { stderr: DIAGNOSTIC_LOG },
    );
    // Assert: a failed dispatch is a missing catalogue; silence is unknown.
    assert.match(missing.text, /Catalogue: \*\*missing\*\*/);
    assert.match(
        missing.text,
        /Advertisement \(Code Mode docs method\): \*\*unknown\*\*/,
    );
    assert.match(unknown.text, /Catalogue: \*\*unknown\*\*/);
    assert.doesNotMatch(unknown.text, /Catalogue: \*\*missing\*\*/);
    rmRoot(root);
});

test("A01: Code Mode help output stays wrapper-only, never a positive diagnostic", () => {
    // Arrange: definitions advertise the Code Mode method and the execute
    // wrapper completed with an inventory, but no nested event exists.
    const root = newRoot("a01-wrapper-only");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [diagnosticCase("A01")]);
    // Act: run and report.
    const { text } = runDiagnostic(
        root,
        fake,
        paths,
        "A01",
        "s1",
        TOOL_JSONL(
            "execute",
            "call-1",
            "completed",
            CODE_MODE_HELP_INPUT,
            "- docs (Repository [repo]): this repository's knowledge\n",
        ) + ANSWER_JSONL("Code Mode help returned the inventory."),
        { stderr: DIAGNOSTIC_LOG, capture: DIAGNOSTIC_CAPTURE },
    );
    // Assert: the wrapper result is preserved but never promoted.
    assert.match(text, /Dispatch \(Code Mode docs\): \*\*succeeded\*\*/);
    assert.match(text, /Help: \*\*inventory returned\*\*/);
    assert.match(text, /Observability: \*\*wrapper-only\*\*/);
    assert.match(text, /Positive: \*\*no\*\*/);
    assert.match(text, /wrapper-only; it is not verified docs use/);
    rmRoot(root);
});

test("A01: a model's inventory claim is supporting evidence, never advertisement", () => {
    // Arrange: no definitions capture and no docs-family call.
    const root = newRoot("a01-model-claim");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [diagnosticCase("A01")]);
    // Act: the answer claims the native docs tool is available.
    const { text } = runDiagnostic(
        root,
        fake,
        paths,
        "A01",
        "s1",
        ANSWER_JSONL("The native docs tool is advertised to me."),
        { stderr: DIAGNOSTIC_LOG },
    );
    // Assert: the claim is recorded as supporting, not authoritative.
    assert.match(text, /Advertisement \(native docs\): \*\*unknown\*\*/);
    assert.match(text, /Supporting model report \(not authoritative\)/);
    assert.match(text, /The native docs tool is advertised to me\./);
    assert.match(text, /Positive: \*\*no\*\*/);
    rmRoot(root);
});

test("A01: registration is absent only in a complete trace, otherwise unknown", () => {
    // Arrange: one complete trace without a plugin-load record, one empty trace.
    const root = newRoot("a01-registration");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [diagnosticCase("A01")]);
    // Act: run each trace.
    const absent = runDiagnostic(
        root,
        fake,
        paths,
        "A01",
        "absent",
        ANSWER_JSONL("No documentation tool is advertised."),
        { stderr: DIAGNOSTIC_LOG_NO_PLUGIN },
    );
    const unknown = runDiagnostic(
        root,
        fake,
        paths,
        "A01",
        "unknown",
        ANSWER_JSONL("No documentation tool is advertised."),
    );
    // Assert: a missing log line is not absence without the complete trace.
    assert.match(
        absent.text,
        /Plugin registration: \*\*absent\*\* — stderr\.log: complete startup\/shutdown trace/,
    );
    assert.match(
        unknown.text,
        /Plugin registration: \*\*unknown\*\* — stderr\.log: no complete plugin-load trace/,
    );
    rmRoot(root);
});

test("A01: the wrapper's redacted run list preserves the diagnostic prompt kind", () => {
    // Arrange: a diagnostic-only wrapper corpus and a stubbed podman.
    const root = newRoot("a01-redacted-kind");
    const fake = writeFakeOpencode(root);
    const stubDir = join(root, "stub");
    mkdirSync(stubDir, { recursive: true });
    chmodSync(writeStubPodman(stubDir), 0o755);
    writeCorpus(root, [diagnosticCase("A01")]);
    // Act: the wrapper stages its id-only run list before the container loop.
    runWrapper(root, fake, ["run", "A01", "--stamp", "wx"], {
        PATH: stubDir + ":" + process.env.PATH,
    });
    // Assert: the run container still knows the case is report-only.
    const redactedPath = readdirSync(join(root, "run-fixtures")).find((name) =>
        name.startsWith("cases-"),
    );
    assert.ok(redactedPath, "redacted list is corpus-hash keyed");
    const redacted = readJson(join(root, "run-fixtures", redactedPath));
    assert.equal(redacted[0].promptKind, "diagnostic");
    rmRoot(root);
});

test("A01: the checked-in diagnostic corpus generates its prompt byte-for-byte", () => {
    // Arrange: the checked-in corpus is the single prompt source.
    const root = newRoot("a01-corpus");
    const fake = writeFakeOpencode(root);
    const cases = readJson(DIAGNOSTIC_CORPUS) as Array<{
        id: string;
        promptKind: string;
        diagnosticPrompt: string;
    }>;
    const diagnostic = cases.find((entry) => entry.id === "A01");
    assert.ok(diagnostic, "the diagnostic corpus must carry A01");
    assert.equal(diagnostic.promptKind, "diagnostic");
    const paths = layout(root);
    // Act: generate from the checked-in file.
    const run = runHarness(root, fake, [
        "generate",
        "A01",
        "--fixture",
        DIAGNOSTIC_CORPUS,
        "--prompts",
        paths.prompts,
        "--fixtures",
        paths.fixtures,
        "--rubrics",
        paths.rubrics,
        "--results",
        paths.results,
    ]);
    // Assert: the prompt is exactly the authored diagnostic bytes.
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
        readFileSync(join(paths.prompts, "A01.md"), "utf8"),
        diagnostic.diagnosticPrompt,
    );
    assert.match(
        diagnostic.diagnosticPrompt,
        /^Before doing any repository work/,
    );
    assert.match(diagnostic.diagnosticPrompt, /JavaScript typeof/);
    rmRoot(root);
});

test("A01: a diagnostic case is report-only, never semantically judged", () => {
    // Arrange: a valid diagnostic run.
    const root = newRoot("a01-no-judge");
    const fake = writeFakeOpencode(root);
    const { paths } = generate(root, fake, [diagnosticCase("A01")]);
    const out = file(
        root,
        "diag-trail.jsonl",
        TOOL_JSONL(
            "docs",
            "call-1",
            "completed",
            { search: "help" },
            "- docs (Repository [repo]): this repository's knowledge\n",
        ) + ANSWER_JSONL("The docs tool returned the inventory."),
    );
    runHarness(
        root,
        fake,
        ["run", "A01", "--stamp", "s1", ...commandArgs(paths)],
        {
            FAKE_TRIAL_OUT: out,
            FAKE_TRIAL_ERR: file(root, "log", DIAGNOSTIC_LOG),
        },
    );
    // Act: ask the harness to judge it.
    const judge = runHarness(root, fake, [
        "judge",
        "A01",
        "--stamp",
        "s1",
        ...commandArgs(paths),
    ]);
    // Assert: no judge call, no verdict, and a visible report-only notice.
    assert.equal(judge.status, 0, judge.stderr);
    assert.match(judge.stderr, /diagnostic case\(s\).*report-only/);
    assert.equal(
        existsSync(join(paths.results, "s1", "A01", "verdict.json")),
        false,
    );
    assert.equal(existsSync(join(paths.results, "s1", "A01", "judge")), false);
    rmRoot(root);
});
