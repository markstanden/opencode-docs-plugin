#!/usr/bin/env node
/**
 * Behavioural trial harness for the trial case corpora.
 *
 * `generate` materialises the reusable harness on disk:
 *   - one prompt per case under ~/tmp/docs-placement/prompts/
 *   - one fixture tree per case under ~/test-dir/docs-placement/
 *   - an out-of-band rubric per case, never mounted into a trial
 *   - a generation fingerprint per case, so a run never silently
 *     regenerates or reuses stale shared inputs
 *
 * `run` copies a pristine fixture into a results directory, runs one headless
 * OpenCode session there, and records the answer, deduplicated tool trail,
 * telemetry and any filesystem mutations (work, lakes and config-home,
 * symlink-aware, git state reported separately). A run validates the prepared
 * generation and refuses to regenerate shared inputs itself.
 *
 * `judge` scores each recorded answer against the case rubric with a second,
 * plugin-free model call. A judge attempt only produces a pass/fail verdict
 * when the judge process completed successfully AND emitted a complete, valid
 * verdict object; process failure, malformed output and semantic failure are
 * distinct states and a failed judge attempt never becomes a pass.
 *
 * `summary` and `export` render a stamp from its own saved evidence
 * (`run.json` plus per-case artefacts), never from the reporting CLI's
 * current model, corpus or guidance. Legacy stamps without `run.json` are
 * rendered with visibly unknown labels.
 *
 * The repository, the user's OpenCode config and the fixture trees are never
 * modified by a run: each session works on its own copy.
 */
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = resolve(HERE, "..", "placement-cases.json");
const DEFAULT_PLUGIN = resolve(HERE, "..", "..", "..");
const HOME = homedir();
const COMMANDS = [
    "generate",
    "run",
    "judge",
    "summary",
    "export",
    "describe",
    "all",
];

/**
 * Harness behaviour version — bump when prompts, mutation policy, telemetry
 * or provenance change shape, so fingerprints and provenance never silently
 * mix generations.
 */
const HARNESS_VERSION = 2;
/** Generation fingerprint version — bump when generation inputs/outputs change. */
const GENERATION_VERSION = 2;
/** Run-description schema version (`run.json`). */
const RUN_SCHEMA_VERSION = 1;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** A positive per-call timeout; a malformed env value falls back loudly. */
function timeoutFromEnv() {
    const value = Number(process.env.TRIAL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** A positive integer option from env, defaulting to 1 (serial). */
function jobsFromEnv(name) {
    const value = Number(process.env[name] ?? 1);
    return Number.isInteger(value) && value > 0 ? value : 1;
}

const DEFAULTS = {
    prompts: join(HOME, "tmp", "docs-placement", "prompts"),
    fixtures: join(HOME, "test-dir", "docs-placement"),
    rubrics: join(HOME, "tmp", "docs-placement", "rubrics"),
    results: join(HOME, "tmp", "docs-placement", "results"),
    model: process.env.TRIAL_MODEL || "opencode-go/deepseek-v4.1-flash",
    judgeModel: process.env.TRIAL_JUDGE_MODEL || "",
    opencode:
        process.env.TRIAL_OPENCODE || process.env.OPENCODE_BIN || "opencode",
    fixture: DEFAULT_FIXTURE,
    plugin: DEFAULT_PLUGIN,
    timeoutMs: timeoutFromEnv(),
    jobs: jobsFromEnv("TRIAL_JOBS"),
    judgeJobs: jobsFromEnv("TRIAL_JUDGE_JOBS"),
};

const SWITCHES = {
    "--force": "force",
    "--no-judge": "noJudge",
    "--allow-writes": "allowWrites",
    "--discovery": "discovery",
    "--help": "help",
    "-h": "help",
};
const VALUE_FLAGS = {
    "--model": { key: "model" },
    "--judge-model": { key: "judgeModel" },
    "--stamp": { key: "stamp" },
    "--opencode": { key: "opencode" },
    "--jobs": { key: "jobs", number: true },
    "--judge-jobs": { key: "judgeJobs", number: true },
    "--prompts": { key: "prompts", path: true },
    "--fixtures": { key: "fixtures", path: true },
    "--rubrics": { key: "rubrics", path: true },
    "--results": { key: "results", path: true },
    "--plugin": { key: "plugin", path: true },
    "--fixture": { key: "fixture", path: true },
};

function stampNow() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return (
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    );
}

function usage(message) {
    if (message) console.error(message);
    console.error(`usage:
  harness.mjs generate [CASE ...] [--force]
  harness.mjs run      [CASE ...]
  harness.mjs judge    [CASE ...] [--stamp NAME]
  harness.mjs summary  [--stamp NAME]
  harness.mjs export   [--stamp NAME]
  harness.mjs describe --stamp NAME  (write the immutable run description)
  harness.mjs all

common options:
  --model provider/model   workhorse model for trials (default ${DEFAULTS.model})
  --judge-model MODEL      model for local judging; defaults to --model. Use a
                           stronger model here, or skip judging and run
                           'export' to deep-scan a sweep with an external model
  --prompts DIR            prompt output (default ${DEFAULTS.prompts})
  --fixtures DIR           fixture root (default ${DEFAULTS.fixtures})
  --rubrics DIR            rubric/case output, kept out of the run sandbox
                           (default ${DEFAULTS.rubrics})
  --results DIR            result root (default ${DEFAULTS.results})
  --stamp NAME             result stamp. 'run'/'all' default to a fresh stamp;
                           'judge'/'summary'/'export' require --stamp or resolve
                           the most recently created run (never name order)
  --fixture FILE           case corpus — the single source for generation,
                           selection, the redacted run list and reporting
  --plugin DIR             plugin package the trials load (default ${DEFAULTS.plugin})
  --opencode BIN           OpenCode binary (default ${DEFAULTS.opencode})
  --jobs N                 trial sessions in parallel (default 1 = serial)
  --judge-jobs N           judge calls in parallel (default 1 = serial)
  --allow-writes           legacy baseline only: judge a decision-only run that
                           changed files. A scenario with its own mutation
                           policy never passes out-of-policy writes, with or
                           without this flag
  --discovery              omit destinations from prompts; the lakes are then
                           discoverable only through 'docs help', which the
                           prompt mentions without requiring

  TRIAL_TIMEOUT_MS         per-session timeout (default ${DEFAULTS.timeoutMs} ms)
  TRIAL_JOBS/TRIAL_JUDGE_JOBS  default worker counts`);
    process.exit(2);
}

/** Apply one CLI flag; false when the argument is not a flag. */
function applyFlag(options, arg, argv) {
    const flag = SWITCHES[arg];
    if (flag === "help") usage();
    if (flag) {
        options[flag] = true;
        return true;
    }
    const spec = VALUE_FLAGS[arg];
    if (!spec) return false;
    if (argv.length === 0) usage(`${arg} needs a value`);
    const raw = argv.shift();
    if (spec.number) {
        const value = Number(raw);
        if (!Number.isInteger(value) || value <= 0) {
            usage(`${arg} needs a positive integer`);
        }
        options[spec.key] = value;
        return true;
    }
    options[spec.key] = spec.path ? resolve(raw) : raw;
    return true;
}

function parseArgs(argv) {
    const command = argv.shift();
    const options = {
        ...DEFAULTS,
        force: false,
        noJudge: false,
        allowWrites: false,
        discovery: false,
        ids: [],
    };
    while (argv.length > 0) {
        const arg = argv.shift();
        if (!applyFlag(options, arg, argv)) options.ids.push(arg);
    }
    if (!command || command === "help") usage();
    if (!COMMANDS.includes(command)) usage(`unknown command ${command}`);
    return { command, options };
}

function loadCases(fixturePath) {
    return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function select(options) {
    const cases = loadCases(options.fixture);
    if (options.ids.length === 0) return cases;
    const unknown = options.ids.filter(
        (id) => !cases.some((entry) => entry.id === id),
    );
    if (unknown.length > 0) usage(`unknown case(s): ${unknown.join(", ")}`);
    return cases.filter((entry) => options.ids.includes(entry.id));
}

const write = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = (path) => sha256(readFileSync(path));

function readJson(path) {
    if (!existsSync(path)) return undefined;
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

/**
 * Read a directory, returning no entries when it is unreadable. Dirent
 * entries carry lstat semantics, so symlinks report as symlinks.
 */
function readDirectory(directory) {
    try {
        return readdirSync(directory, { withFileTypes: true });
    } catch {
        return [];
    }
}

const parseLine = (line) => {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
};

function toolOutput(value) {
    return typeof value === "string" ? value.slice(0, 2000) : value;
}

/**
 * Turn `opencode run --format json` JSONL into the final text and a
 * deduplicated tool trail. The CLI can emit several events for one tool
 * operation (pending → completed); calls are keyed by their stable call id
 * and merged, keeping the latest state. Malformed lines are counted, not
 * hidden — an unparsable trail is evidence, not an empty one.
 * @param stdout Raw CLI stdout.
 * @returns Text, deduplicated tool calls and completion evidence.
 */
/** The call state after folding one tool part over the previous entry: latest state wins. */
function mergedToolCall(previous, part, id) {
    return {
        ...previous,
        id,
        tool: part.tool ?? previous.tool,
        input: part.state?.input ?? previous.input,
        status: part.state?.status ?? previous.status,
        output: toolOutput(part.state?.output ?? previous.output),
    };
}

/**
 * One parsed CLI event, folded into the accumulators: text parts join the
 * answer, tool parts merge into the deduplicated call map. The `unkeyed`
 * counter fills stable ids for tool parts that arrive without one.
 */
function extractEvent(event, texts, calls, unkeyed) {
    const part = event.part ?? event;
    if (part?.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
    }
    if (part?.type === "tool") {
        const id =
            typeof part.id === "string" && part.id !== ""
                ? part.id
                : `unkeyed-${++unkeyed.count}`;
        calls.set(id, mergedToolCall(calls.get(id) ?? {}, part, id));
    }
}

function extract(stdout) {
    const texts = [];
    const calls = new Map();
    const unkeyed = { count: 0 };
    let events = 0;
    let parseFailures = 0;
    for (const line of stdout.split("\n").filter(Boolean)) {
        const event = parseLine(line);
        if (!event) {
            parseFailures += 1;
            continue;
        }
        events += 1;
        extractEvent(event, texts, calls, unkeyed);
    }
    const tools = [...calls.values()];
    return {
        text: texts.join("\n").trim() + "\n",
        tools:
            tools.map((entry) => JSON.stringify(entry)).join("\n") +
            (tools.length > 0 ? "\n" : ""),
        events,
        parseFailures,
        toolCalls: tools,
    };
}

/* ------------------------------------------------------------------ *
 * Telemetry: what the trail says about docs usage and exposure
 * ------------------------------------------------------------------ */

/** Whether one code-mode `execute` input attempts the docs twin. */
const CODE_MODE_DOCS = /tools\s*\.\s*docs\s*\.\s*docs_search\s*\(/;

/** Whether an execute call's code attempts the docs twin (Code Mode). */
const isCodeModeDocs = (entry) =>
    entry.tool === "execute" &&
    typeof entry.input?.code === "string" &&
    CODE_MODE_DOCS.test(entry.input.code);

/** The docs family an entry belongs to: "code-mode", "native", "twin", or null. */
function docsEntryKind(entry) {
    const native = entry.tool === "docs" || entry.tool === "docs_search";
    if (isCodeModeDocs(entry)) return "code-mode";
    return native ? (entry.tool === "docs" ? "native" : "twin") : null;
}

/** The status bucket name for one docs call: completed, error, or other. */
function docsStatusBucket(status) {
    if (status === "completed") return "completed";
    if (status === "error") return "error";
    return "other";
}

/** The verb counted for one docs-family entry. */
function docsEntryVerb(kind, entry) {
    return kind === "code-mode"
        ? codeModeVerbOf(entry.input.code)
        : docsVerbOf(entry.input);
}

/** Advance the running docs tallies for one trail entry. */
function tallyDocsEntry(entry, tallies) {
    const kind = docsEntryKind(entry);
    if (kind === null) return;
    if (kind === "code-mode") {
        tallies.codeModeAttempted += 1;
        if (entry.status === "completed") tallies.codeModeCompleted += 1;
    } else if (kind === "native") {
        tallies.nativeDocs += 1;
    } else {
        tallies.twinDocs += 1;
    }
    tallies.verbs[docsEntryVerb(kind, entry)] += 1;
    tallies.statuses[docsStatusBucket(entry.status)] += 1;
}

/**
 * Docs-usage telemetry for one trail. Native `docs` calls, the native-facing
 * twin registration name `docs_search`, and Code Mode `execute` calls whose
 * code attempts `tools.docs.docs_search(…)` are counted separately. A
 * code-mode attempt is NOT proof the nested operation ran: the nested call
 * happens inside the execute runtime and emits no separate event, so it is
 * reported as attempted, with the outer call's completion status.
 * @param entries Deduplicated tool calls.
 * @param parseFailures Unparsable trail lines.
 * @returns Counts and per-verb detail for reporting and criteria.
 */
function docsTelemetry(entries, parseFailures = 0) {
    const tallies = {
        verbs: { search: 0, read: 0, add: 0, check: 0, help: 0, other: 0 },
        statuses: { completed: 0, error: 0, other: 0 },
        nativeDocs: 0,
        twinDocs: 0,
        codeModeAttempted: 0,
        codeModeCompleted: 0,
        executeCalls: 0,
    };
    for (const entry of entries) {
        if (entry.tool === "execute") tallies.executeCalls += 1;
        tallyDocsEntry(entry, tallies);
    }
    return {
        nativeDocs: tallies.nativeDocs,
        twinDocs: tallies.twinDocs,
        codeModeAttempted: tallies.codeModeAttempted,
        codeModeCompleted: tallies.codeModeCompleted,
        executeCalls: tallies.executeCalls,
        verbs: tallies.verbs,
        statuses: tallies.statuses,
        unparsedLines: parseFailures,
        docsCalls:
            tallies.nativeDocs + tallies.twinDocs + tallies.codeModeAttempted,
    };
}

const isHelpQuery = (value) => value.trim().toLowerCase() === "help";

/** The verb of a native docs/docs_search input. */
function docsVerbOf(input) {
    if (typeof input === "object" && input !== null) {
        if (input.add !== undefined) return "add";
        if (input.check !== undefined) return "check";
        if (input.read !== undefined) return "read";
        if (typeof input.search === "string") {
            return isHelpQuery(input.search) ? "help" : "search";
        }
        if (input.search !== undefined) return "search";
    }
    return "other";
}

/** Best-effort verb of a code-mode attempt from its source text. */
function codeModeVerbOf(code) {
    if (/\.add\s*\(/.test(code)) return "add";
    if (/\.check\s*\(/.test(code)) return "check";
    if (/\.read\s*\(/.test(code)) return "read";
    if (/search\s*[(:]/.test(code)) {
        return /search\s*[(:]\s*["'`]\s*help\s*["'`]/.test(code)
            ? "help"
            : "search";
    }
    return "other";
}

/** The Docs column: composition, not one opaque number. */
function docsLabel(telemetry) {
    if (telemetry === null) return "-";
    const { nativeDocs, twinDocs, codeModeAttempted } = telemetry;
    if (nativeDocs + twinDocs + codeModeAttempted === 0) return "none";
    const parts = [];
    if (nativeDocs > 0) parts.push(`${nativeDocs} native`);
    if (twinDocs > 0) parts.push(`${twinDocs} twin`);
    if (codeModeAttempted > 0) parts.push(`${codeModeAttempted} code-mode`);
    return parts.join("+");
}

/**
 * Discovery observation for one case: docs-family calls and how many asked
 * for help (the verb that lists the configured lakes with names, classes and
 * descriptions). Deliberately separate from the placement verdict.
 */
function discoveryFor(resultDir) {
    const trail = readTrail(resultDir);
    if (trail === null) return null;
    const telemetry = docsTelemetry(trail.entries, trail.parseFailures);
    return {
        calls: telemetry.docsCalls,
        help: telemetry.verbs.help,
        telemetry,
    };
}

/** The Discovery column value: a help call is the observed discovery step. */
function discoveryLabel(discovery) {
    if (discovery === null) return "-";
    if (discovery.calls === 0) return "none";
    if (discovery.help === 0) return `no help (${discovery.calls})`;
    return `help×${discovery.help}`;
}

/**
 * What a completed tool call exposes beyond the prompt, most specific first.
 * Overlapping paths stay labelled: a rubric read is never mistaken for the
 * redacted case list. A `glob` naming a guidance file is discovery, not a
 * read. Only completed calls count as exposure; attempts are labelled
 * separately so a failed probe is never reported as a successful leak.
 */
const EXPOSURE_RULES = [
    ["rubric-case", /rubric\.md|case\.json|\/rubrics\//i],
    ["repo cases", /\/repo\/tests\/|placement-cases\.json|trial-cases\.json/i],
    ["case list", /\/fixtures\/cases\.json|cases-run/i],
    ["session config", /opencode\.json/i],
    [
        "harness surfaces",
        /\/fixtures\/manifest\.json|generation\.json|\/prompts\//i,
    ],
    ["guidance", /CONVENTION\.md|AGENTS\.md|SKILL\.md|\/\.opencode\//i],
];

/**
 * Record one trail entry's exposures into `found`: every matching rule with
 * completed beats attempt, a glob naming a guidance file re-labelled as
 * discovery rather than a read, plus the skill-load marker.
 */
function recordExposure(entry, found) {
    const input = JSON.stringify(entry.input ?? "");
    for (const [label, pattern] of EXPOSURE_RULES) {
        if (!pattern.test(input)) continue;
        const completed = entry.status === "completed";
        const key =
            label === "guidance" && entry.tool === "glob"
                ? "guidance-discovery"
                : label;
        if (completed || !found.has(key)) found.set(key, completed);
    }
    if (entry.tool === "skill") found.set("skill load", true);
}

/** Exposure labels for one case's tool trail, or [] when the trail is clean. */
function exposureFor(resultDir) {
    const trail = readTrail(resultDir);
    if (trail === null) return [];
    const found = new Map();
    for (const entry of trail.entries) recordExposure(entry, found);
    return [...found.entries()].map(([label, completed]) =>
        completed ? label : `${label} (attempt)`,
    );
}

/** Read one result's deduplicated trail, or null when absent/unreadable. */
function readTrail(resultDir) {
    const path = join(resultDir, "tools.jsonl");
    if (!existsSync(path)) return null;
    let parseFailures = 0;
    const entries = [];
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        const entry = parseLine(line);
        if (!entry) parseFailures += 1;
        else entries.push(entry);
    }
    return { entries, parseFailures };
}

/* ------------------------------------------------------------------ *
 * Provenance and identity
 * ------------------------------------------------------------------ */

function childEnv(configHome) {
    const env = { ...process.env };
    for (const key of [
        "OPENCODE_SESSION_ID",
        "OPENCODE_TERMINAL",
        "OPENCODE",
        "AI_AGENT",
    ]) {
        delete env[key];
    }
    env.XDG_CONFIG_HOME = configHome;
    return env;
}

function opencodeVersion(options) {
    if (!options.cliVersion) {
        options.cliVersion = "unknown";
        try {
            const probe = spawnSync(options.opencode, ["--version"], {
                encoding: "utf8",
            });
            options.cliVersion = (probe.stdout ?? "").trim() || "unknown";
        } catch {
            /* recorded as unknown */
        }
    }
    return options.cliVersion;
}

/** One git fact, or "unknown" when the probe fails. */
function gitFact(directory, args) {
    try {
        const probe = spawnSync("git", args, {
            cwd: directory,
            encoding: "utf8",
        });
        return probe.status === 0 ? (probe.stdout ?? "").trim() : "unknown";
    } catch {
        return "unknown";
    }
}

/** Minimal quiet git scaffolding: init the fixture work tree, failures ignored. */
function gitInitQuiet(work) {
    try {
        spawnSync("git", ["init", "-q"], { cwd: work, stdio: "ignore" });
    } catch {
        /* fixture scaffolding only */
    }
}

/** The real fixture hash, even when a run container sees only a redacted list. */
function fixtureHashOf(options) {
    if (process.env.PLACEMENT_FIXTURE_HASH) {
        return process.env.PLACEMENT_FIXTURE_HASH;
    }
    if (existsSync(options.fixture)) return fileHash(options.fixture);
    const manifest = readJson(join(options.fixtures, "manifest.json"));
    return manifest?.fixtureHash ?? "unknown";
}

/** The plugin files whose bytes make a trial's guidance identity. */
const PLUGIN_IDENTITY_FILES = [
    "package.json",
    join("src", "index.ts"),
    join("src", "SKILL.md"),
    "CONVENTION.md",
];

/**
 * The plugin's content identity: one hash over the exact bytes a trial
 * loads — the runtime skill and convention included, not just the entry
 * module — so a dirty checkout is represented by reproducible content
 * identity, not a boolean.
 */
function pluginIdentity(options) {
    const parts = PLUGIN_IDENTITY_FILES.filter((name) =>
        existsSync(join(options.plugin, name)),
    );
    const lock = join(options.plugin, "package-lock.json");
    const lockHash = existsSync(lock) ? fileHash(lock) : "absent";
    if (parts.length === 0) {
        return { contentHash: "unknown", lockHash, files: [] };
    }
    const contentHash = sha256(
        parts
            .map((name) => readFileSync(join(options.plugin, name)))
            .join("\n"),
    );
    return { contentHash, lockHash, files: parts };
}

function pluginCommitOf(options) {
    const commit = gitFact(options.plugin, ["rev-parse", "HEAD"]);
    if (commit !== "unknown") return commit;
    return process.env.PLACEMENT_PLUGIN_COMMIT || "unknown";
}

function pluginDirtyOf(options) {
    const status = gitFact(options.plugin, ["status", "--porcelain"]);
    if (status === "unknown") return process.env.PLACEMENT_PLUGIN_DIRTY === "1";
    return status !== "";
}

/** Content hashes and versions that make a result reproducible. */
function provenance(options) {
    const fixtureHash = fixtureHashOf(options);
    const identity = pluginIdentity(options);
    return {
        fixture: options.fixture,
        fixtureHash,
        fixtureVersion: `sha256:${fixtureHash.slice(0, 12)}`,
        plugin: options.plugin,
        pluginHash: identity.contentHash,
        pluginFiles: identity.files,
        lockHash: identity.lockHash,
        pluginCommit: pluginCommitOf(options),
        pluginDirty: pluginDirtyOf(options),
        opencode: opencodeVersion(options),
        image: process.env.PLACEMENT_IMAGE ?? "",
        imageId: process.env.PLACEMENT_IMAGE_ID ?? "",
        args: process.argv.slice(2),
    };
}

/** The actual execution boundary of this process. */
function boundaryOf() {
    const containerised =
        process.env.PLACEMENT_IMAGE !== undefined ||
        process.env.PLACEMENT_IMAGE_ID !== undefined;
    return {
        containerised,
        kind: containerised ? "container" : "host",
        image: process.env.PLACEMENT_IMAGE ?? "",
        imageId: process.env.PLACEMENT_IMAGE_ID ?? "",
    };
}

/* ------------------------------------------------------------------ *
 * Prompt, rubric and fixture generation (with fingerprints)
 * ------------------------------------------------------------------ */

const promptFor = (testCase, options) => {
    // Discovery variant: the prompt names no destination and no tool — the
    // lakes are reachable only through the session's normal tool inventory
    // (the docs tool's own description points at `help`).
    const kind =
        testCase.promptKind ??
        (testCase.mutationPolicy ? "recording" : "baseline");
    const destinations =
        kind === "natural" || options.discovery
            ? ""
            : `Available documentation destinations:
${testCase.destinations
    .map(
        (destination) =>
            `- ${destination.name} (\`${destination.class}\`): ${destination.description}`,
    )
    .join("\n")}`;
    // Baseline decisions suppress writes; recording authorises them inside
    // the trial's own surfaces; natural prompts carry no documentation
    // framing at all — they measure whether the trigger happens.
    const closing =
        kind === "natural"
            ? "What do you recommend we do, if anything?"
            : kind === "recording"
              ? "Use your normal documentation guidance for this finding. For this trial, you are authorised to record documentation; changes are permitted only inside the trial's own documentation surfaces."
              : "Use your normal documentation guidance to decide how to preserve this finding. For this trial, do not change files.";
    return `We have established the following finding.

Finding:
${testCase.claim}

Evidence:
${testCase.evidence}

${destinations ? `${destinations}\n\n` : ""}${closing}

State:
- Your intended action.
- The exact destination lake, or other documentation workflow.
- Whether this needs one document or several.
- A brief reason.
- Any clarification needed before proceeding.

Treat the evidence descriptions as supplied facts for this synthetic trial.
`;
};

const rubricFor = (testCase) => `# ${testCase.id} rubric

Claim: ${testCase.claim}

Expected: ${testCase.expected}

Accepts:
${testCase.accepts.map((line) => `- ${line}`).join("\n")}

Tempting wrong answers:
${testCase.temptingWrong.map((line) => `- ${line}`).join("\n")}
`;

/**
 * The requested sandbox permission set. Trails have shown these denials are
 * not reliably enforced in every run context, so the container mount stays
 * the real boundary.
 */
const SANDBOX_PERMISSIONS = [
    { action: "shell", resource: "*", effect: "deny" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "*", effect: "deny" },
];

const WORK_FILES_E06 = {
    "package.json":
        JSON.stringify(
            {
                name: "trial-app",
                private: true,
                scripts: { test: "node --test", typecheck: "tsc --noEmit" },
            },
            null,
            2,
        ) + "\n",
    "README.md": "# Trial app\n\n```sh\nnpm test\nnpm run typecheck\n```\n",
};

const WORK_FILES_E17 = {
    "package.json":
        JSON.stringify(
            {
                name: "trial-app",
                private: true,
                scripts: { build: "node build.mjs" },
            },
            null,
            2,
        ) + "\n",
    "build.sh":
        "#!/usr/bin/env bash\nset -euo pipefail\n" +
        "# The trap this case is about: the flag must stay inside this repo's wrapper.\n" +
        "npm run build -- --legacy-peer-deps\n",
};

function writeWorkFiles(work, files) {
    for (const [name, contents] of Object.entries(files))
        write(join(work, name), contents);
}

/** Lake specs for the trial config; roots are relative to the work directory. */
function lakesFor(testCase) {
    const listed = testCase.destinations.map((destination) => ({
        class: destination.class,
        // E17 nests the repo lake inside the wider outer repo lake.
        root:
            testCase.id === "E17" && destination.name === "docs"
                ? "../lakes/outer/docs"
                : `../lakes/${destination.name}`,
        name: destination.name,
        description: destination.description,
    }));
    if (
        testCase.destinations.some(
            (destination) => destination.class === "repo",
        )
    )
        return listed;
    return [
        ...listed,
        {
            class: "repo",
            root: "docs",
            name: "docs",
            writable: false,
            description:
                "Read-only placeholder; not a listed destination in this trial.",
        },
    ];
}

/** Create the case's work and lake directories, plus its code-shaped context. */
function buildFixtureTree(testCase, caseDir) {
    const work = join(caseDir, "work");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(caseDir, "lakes"), { recursive: true });
    mkdirSync(join(caseDir, "config-home", "opencode"), { recursive: true });

    for (const destination of testCase.destinations) {
        mkdirSync(join(caseDir, "lakes", destination.name), {
            recursive: true,
        });
    }
    // E17 deliberately nests the repo lake "docs" inside the wider repo lake "outer".
    if (testCase.id === "E17")
        mkdirSync(join(caseDir, "lakes", "outer", "docs"), { recursive: true });

    // The plugin adds an implicit writable repo lake at <location>/docs when no
    // repo lake is configured. E13 and E16 list no repo destination, so pin a
    // read-only placeholder: it suppresses the implicit writable lake without
    // offering a destination the case does not list.
    if (
        !testCase.destinations.some(
            (destination) => destination.class === "repo",
        )
    ) {
        mkdirSync(join(work, "docs"), { recursive: true });
    }

    if (testCase.id === "E06") writeWorkFiles(work, WORK_FILES_E06);
    if (testCase.id === "E17") writeWorkFiles(work, WORK_FILES_E17);
    seedFixture(testCase, caseDir);
    gitInitQuiet(work);
}

/** Seed documents and links a case relies on (families beyond the baseline). */
function seedFixture(testCase, caseDir) {
    for (const seed of testCase.seeds ?? []) {
        const path = join(caseDir, seed.surface, seed.path);
        if (seed.target !== undefined) {
            mkdirSync(dirname(path), { recursive: true });
            symlinkSync(seed.target, path);
            continue;
        }
        write(path, seed.contents ?? "");
    }
}

/**
 * Fingerprint every input that affects a case's generated content or
 * configuration: the case definition, the generator/template version, the
 * model baked into the config, the plugin identity and the variant flags.
 */
function generationInputsHash(testCase, options) {
    return sha256(
        JSON.stringify({
            generationVersion: GENERATION_VERSION,
            caseEntry: testCase,
            model: options.model,
            plugin: pluginIdentity(options).contentHash,
            lockHash: pluginIdentity(options).lockHash,
            discovery: options.discovery === true,
            permissions: SANDBOX_PERMISSIONS,
        }),
    );
}

/** The file identities a generation record certifies. */
function generationOutputs(testCase, options) {
    const promptText = promptFor(testCase, options);
    const rubricText = rubricFor(testCase);
    const caseJson = JSON.stringify(testCase, null, 2) + "\n";
    const configJson =
        JSON.stringify(
            {
                $schema: "https://opencode.ai/config.json",
                model: options.model,
                plugins: [
                    {
                        package: options.plugin,
                        options: { lakes: lakesFor(testCase) },
                    },
                ],
                permissions: SANDBOX_PERMISSIONS,
            },
            null,
            2,
        ) + "\n";
    return { promptText, rubricText, caseJson, configJson };
}

/** Whether the recorded prompt, config and (when present) rubric are byte-intact. */
function fixtureOutputsIntact(options, fixture, outputs) {
    const matches = (path, text) =>
        existsSync(path) && readFileSync(path, "utf8") === text;
    return (
        matches(fixture.promptPath, outputs.promptText) &&
        matches(fixture.configPath, outputs.configJson) &&
        (!existsSync(options.rubrics) ||
            matches(fixture.rubricPath, outputs.rubricText))
    );
}

/**
 * Refusal for reusing a recorded fixture: the fingerprint went stale, the
 * recorded outputs were altered, or a pre-fingerprint fixture exists with no
 * generation record. Null when the recorded fixture may be kept.
 */
function reusedFixtureRefusal(testCase, options, stored, fingerprint, fixture) {
    if (stored !== undefined) {
        if (stored.inputsHash !== fingerprint) {
            return {
                status: "stale",
                detail:
                    "case definition, model, plugin or variant changed " +
                    "since this fixture was generated; rerun generate --force",
            };
        }
        const outputs = generationOutputs(testCase, options);
        if (!fixtureOutputsIntact(options, fixture, outputs)) {
            return {
                status: "incomplete",
                detail:
                    "recorded generation outputs are missing or altered " +
                    `(prompt, config${existsSync(options.rubrics) ? ", rubric" : ""}); rerun generate --force`,
            };
        }
        return null;
    }
    return existsSync(fixture.promptPath)
        ? {
              status: "stale",
              detail:
                  "existing fixture has no generation fingerprint " +
                  "(pre-fingerprint harness); rerun generate --force",
          }
        : null;
}

/** Write one case's generated prompt, rubric, case.json, config and generation record. */
function writeGeneratedFixture(testCase, options, fingerprint, fixture) {
    const outputs = generationOutputs(testCase, options);
    buildFixtureTree(testCase, fixture.caseDir);
    write(fixture.promptPath, outputs.promptText);
    write(fixture.rubricPath, outputs.rubricText);
    write(join(fixture.rubricDir, "case.json"), outputs.caseJson);
    write(join(fixture.caseDir, "work", "opencode.json"), outputs.configJson);
    write(
        join(fixture.caseDir, "generation.json"),
        JSON.stringify(
            {
                schemaVersion: 1,
                id: testCase.id,
                inputsHash: fingerprint,
                generationVersion: GENERATION_VERSION,
                createdAt: new Date().toISOString(),
                files: {
                    promptHash: sha256(outputs.promptText),
                    configHash: sha256(outputs.configJson),
                    rubricHash: sha256(outputs.rubricText),
                },
                pluginHash: pluginIdentity(options).contentHash,
            },
            null,
            2,
        ) + "\n",
    );
}

/**
 * Generate (or verify) one case fixture. Reuse requires a matching
 * fingerprint AND intact recorded outputs; anything else refuses clearly —
 * `--force` recreates deliberately. The returned status object tells
 * generateAll what happened; callers never silently regenerate.
 */
function generateCase(testCase, options) {
    const caseDir = join(options.fixtures, testCase.id);
    const rubricDir = join(options.rubrics, testCase.id);
    const fixture = {
        caseDir,
        rubricDir,
        promptPath: join(options.prompts, `${testCase.id}.md`),
        rubricPath: join(rubricDir, "rubric.md"),
        configPath: join(caseDir, "work", "opencode.json"),
        generationPath: join(caseDir, "generation.json"),
    };

    const fingerprint = generationInputsHash(testCase, options);
    const stored = readJson(fixture.generationPath);
    if (!options.force) {
        const refusal = reusedFixtureRefusal(
            testCase,
            options,
            stored,
            fingerprint,
            fixture,
        );
        if (refusal !== null) return refusal;
        if (stored !== undefined) return { status: "kept" };
    }
    if (options.force) {
        rmSync(caseDir, { recursive: true, force: true });
        rmSync(rubricDir, { recursive: true, force: true });
        rmSync(fixture.promptPath, { force: true });
    }

    writeGeneratedFixture(testCase, options, fingerprint, fixture);
    return { status: "created" };
}

function generateAll(options) {
    const selected = select(options);
    const rows = [];
    let failures = 0;
    for (const testCase of selected) {
        const outcome = generateCase(testCase, options);
        rows.push([testCase.id, outcome]);
        if (outcome.status !== "kept" && outcome.status !== "created")
            failures += 1;
    }
    const manifest = {
        generatedAt: new Date().toISOString(),
        harnessVersion: HARNESS_VERSION,
        generationVersion: GENERATION_VERSION,
        ...provenance(options),
        model: options.model,
        prompts: options.prompts,
        fixture: options.fixture,
        plugin: options.plugin,
        cases: selected.map((testCase) => {
            const prompt = join(options.prompts, `${testCase.id}.md`);
            const fixture = join(options.fixtures, testCase.id);
            const rubric = join(options.rubrics, testCase.id, "rubric.md");
            return {
                id: testCase.id,
                prompt,
                promptHash: existsSync(prompt) ? fileHash(prompt) : "unknown",
                fixture,
                generation: join(fixture, "generation.json"),
                rubric,
                rubricHash: existsSync(rubric) ? fileHash(rubric) : "unknown",
                expected: testCase.expected,
            };
        }),
    };
    write(
        join(options.fixtures, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
    );
    for (const [id, outcome] of rows) {
        const detail =
            outcome.status === "kept" || outcome.status === "created"
                ? outcome.status
                : `${outcome.status} — ${outcome.detail}`;
        console.log(`${id}: ${detail}`);
    }
    console.log(`prompts:  ${options.prompts}`);
    console.log(`fixtures: ${options.fixtures}`);
    if (failures > 0) {
        console.error(
            `generate: ${failures} case(s) refused; the recorded fixtures were left untouched`,
        );
        return 1;
    }
    return 0;
}

/**
 * Validate that a run's prepared generation is the current one. A run never
 * regenerates shared inputs: missing or stale preparation is an error.
 * Inside the per-case run container only the prompt, config and generation
 * record are mounted, so verification covers exactly those surfaces.
 */
function validateGeneration(testCase, options) {
    const problems = [];
    const promptPath = join(options.prompts, `${testCase.id}.md`);
    const generationPath = join(
        options.fixtures,
        testCase.id,
        "generation.json",
    );
    const configPath = join(
        options.fixtures,
        testCase.id,
        "work",
        "opencode.json",
    );
    const stored = readJson(generationPath);
    if (stored === undefined) {
        problems.push("no generation fingerprint; run generate first");
        return { problems, generation: undefined };
    }
    if (!existsSync(promptPath)) problems.push("no prompt generated");
    else if (stored.files?.promptHash !== fileHash(promptPath))
        problems.push("prompt does not match the recorded generation");
    if (!existsSync(configPath)) problems.push("no fixture config generated");
    else if (stored.files?.configHash !== fileHash(configPath))
        problems.push("fixture config does not match the recorded generation");
    return { problems, generation: stored };
}

/* ------------------------------------------------------------------ *
 * Mutation snapshot: final-state proof, symlink-aware
 * ------------------------------------------------------------------ */

/** Git files whose changes are reported as git state, not trial writes. */
function gitStateEntries(workRoot) {
    const git = join(workRoot, ".git");
    const entries = new Map();
    if (!existsSync(git)) return entries;
    const hashFile = (path) => {
        try {
            return fileHash(path);
        } catch {
            return "unreadable";
        }
    };
    for (const name of ["HEAD", "index"]) {
        const path = join(git, name);
        if (existsSync(path)) entries.set(name, hashFile(path));
    }
    const refs = join(git, "refs");
    const walk = (directory, prefix) => {
        for (const item of readDirectory(directory)) {
            const path = join(directory, item.name);
            if (item.isFile())
                entries.set(`${prefix}${item.name}`, hashFile(path));
            else if (item.isDirectory()) walk(path, `${prefix}${item.name}/`);
        }
    };
    walk(refs, "refs/");
    return entries;
}

/**
 * Hash every trial-visible surface — work, lakes and config-home — by lstat,
 * never following a link out of the tree. Files hash their bytes, symlinks
 * their target, directories only their presence and mode. The snapshot
 * proves final-state changes: a transient write that reverts between two
 * snapshots is invisible without execution instrumentation (stated, not
 * hidden). `.git` content is tracked separately as git state.
 */
function snapshotLive(live) {
    const entries = new Map();
    for (const surface of ["work", "lakes", "config-home"]) {
        const root = join(live, surface);
        const walk = (directory) => {
            for (const item of readDirectory(directory)) {
                const path = join(directory, item.name);
                const name = relative(join(live, surface), path)
                    .split(sep)
                    .join("/");
                if (surface === "work" && name.split("/")[0] === ".git")
                    continue;
                if (item.isSymbolicLink()) {
                    let target = "(unreadable)";
                    try {
                        target = readlinkSync(path);
                    } catch {
                        /* recorded as unreadable */
                    }
                    entries.set(`${surface}/${name}`, {
                        kind: "symlink",
                        target,
                    });
                    continue;
                }
                if (item.isDirectory()) {
                    entries.set(`${surface}/${name}`, { kind: "dir" });
                    walk(path);
                    continue;
                }
                if (item.isFile()) {
                    let hash = "unreadable";
                    try {
                        hash = fileHash(path);
                    } catch {
                        /* recorded as unreadable */
                    }
                    entries.set(`${surface}/${name}`, { kind: "file", hash });
                    continue;
                }
                entries.set(`${surface}/${name}`, { kind: "other" });
            }
        };
        if (existsSync(root)) walk(root);
    }
    return { entries, git: gitStateEntries(join(live, "work")) };
}

/** Kind change (file→symlink replacement, etc.) or content/target change. */
function entryChanged(before, after) {
    if (before.kind !== after.kind) return "kind";
    if (before.kind === "file")
        return before.hash !== after.hash ? "content" : "";
    if (before.kind === "symlink")
        return before.target !== after.target ? "target" : "";
    return "";
}

function snapshotDiff(before, after) {
    const added = [];
    const modified = [];
    const removed = [];
    const kinds = new Map();
    for (const [path, value] of after.entries) {
        if (!before.entries.has(path)) {
            added.push(path);
            kinds.set(path, value.kind);
        } else {
            const change = entryChanged(before.entries.get(path), value);
            if (change !== "") {
                modified.push(path);
                kinds.set(path, change);
            }
        }
    }
    for (const path of before.entries.keys()) {
        if (!after.entries.has(path)) removed.push(path);
    }
    const git = [];
    for (const [path, hash] of after.git) {
        if (before.git.get(path) !== hash) git.push(path);
    }
    for (const [path] of before.git) {
        if (!after.git.has(path)) git.push(`${path} (removed)`);
    }
    return {
        added: added.sort(),
        modified: modified.sort(),
        removed: removed.sort(),
        kinds,
        git: git.sort(),
    };
}

const writeCount = (diff) =>
    diff.added.length + diff.modified.length + diff.removed.length;

/** Glob match with `*` within a segment and `**` across segments. */
function globMatch(pattern, path) {
    const patternParts = pattern.split("/");
    const pathParts = path.split("/");
    const match = (p, s) => {
        if (p.length === 0) return s.length === 0;
        if (p[0] === "**") {
            for (let skip = 0; skip <= s.length; skip += 1) {
                if (match(p.slice(1), s.slice(skip))) return true;
            }
            return false;
        }
        if (s.length === 0) return false;
        const part = p[0]
            .split("*")
            .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*");
        if (!new RegExp(`^${part}$`).test(s[0])) return false;
        return match(p.slice(1), s.slice(1));
    };
    return match(patternParts, pathParts);
}

/**
 * Whether a mutation is permitted by the case's explicit policy. Cases
 * without a policy are decision-only: no path is permitted. Git-state
 * changes are reported separately and never count as trial writes.
 */
function policyViolation(diff, testCase) {
    const allowed = testCase.mutationPolicy?.allowed ?? [];
    const runtime = testCase.mutationPolicy?.runtimeAllow ?? [];
    const paths = [
        ...diff.added.map((path) => [path, "added"]),
        ...diff.modified.map((path) => [path, "modified"]),
        ...diff.removed.map((path) => [path, "removed"]),
    ];
    const violations = [];
    for (const [path, action] of paths) {
        const permitted = [...allowed, ...runtime].some((pattern) =>
            globMatch(pattern, path),
        );
        if (!permitted) violations.push(`${action}: ${path}`);
    }
    return violations;
}

function writesReport(diff, violations) {
    const lines = [
        ...diff.added.map(
            (path) => `added: ${path} (${diff.kinds.get(path) ?? "file"})`,
        ),
        ...diff.modified.map(
            (path) =>
                `modified: ${path} (${diff.kinds.get(path) ?? "content"})`,
        ),
        ...diff.removed.map((path) => `removed: ${path}`),
    ];
    if (diff.git.length > 0) {
        lines.push(
            "",
            "# git-state changes (reported separately, not trial writes):",
        );
        lines.push(...diff.git.map((path) => `git: work/.git/${path}`));
    }
    if (violations.length > 0) {
        lines.push("", "# out-of-policy mutations:");
        lines.push(...violations.map((line) => `violation: ${line}`));
    }
    return lines.length > 0 ? lines.join("\n") + "\n" : "none\n";
}

/** The Writes column value for one run's writes.txt content. */
function writesLabel(report) {
    return report === ""
        ? "-"
        : report === "none"
          ? "none"
          : `${report.split("\n").filter(Boolean).length} file(s)`;
}

/* ------------------------------------------------------------------ *
 * The immutable run description (run.json)
 * ------------------------------------------------------------------ */

/**
 * The frozen description of one experiment: every input identity and
 * setting that labels its evidence, captured at run time and never
 * recomputed from reporting-time defaults.
 */
function runDescription(options, stamp, selected, command) {
    return {
        schemaVersion: RUN_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        stamp,
        harnessVersion: HARNESS_VERSION,
        command,
        variant: options.discovery ? "discovery" : "destinations",
        model: options.model,
        judgeModel: options.judgeModel || null,
        timeoutMs: options.timeoutMs,
        allowWrites: options.allowWrites === true,
        jobs: options.jobs,
        boundary: boundaryOf(),
        provenance: provenance(options),
        caseIds: selected.map((testCase) => testCase.id),
        cases: selected.map((testCase) => ({
            id: testCase.id,
            expected: testCase.expected,
            mutationPolicy: testCase.mutationPolicy ?? null,
            docsCriterion: testCase.docsCriterion ?? null,
            definition: testCase,
        })),
    };
}

/**
 * Unwritable-stamp handling after a failed run.json write. A per-case run
 * container mounts only its own result directory, so the stamp root is
 * read-only there. The wrapper ALWAYS froze the description host-side before
 * the loop (TESTING.md), so EROFS/EACCES records its case against that
 * frozen evidence. Any other unwritable root without a prior freeze fails
 * the run rather than silently yielding a legacy-rendered stamp.
 */
function keepDescriptionOnFailure(path, error) {
    if (error?.code === "EROFS" || error?.code === "EACCES") {
        console.error(
            `${path} is not writable from this context — a stamp-level ` +
                "run description must have been frozen host-side " +
                "('describe'); continuing per-case recording",
        );
        return true;
    }
    throw error;
}

/**
 * Write the stamp's run description once. An existing identical description
 * is a no-op; a conflicting one is an error — a stamp is immutable evidence
 * and never relabelled.
 */
function ensureRunDescription(options, stamp, selected, command) {
    const path = join(options.results, stamp, "run.json");
    const existing = readJson(path);
    const description = runDescription(options, stamp, selected, command);
    if (existing !== undefined) {
        const sameSet =
            JSON.stringify(existing.caseIds) ===
                JSON.stringify(description.caseIds) &&
            existing.model === description.model &&
            existing.variant === description.variant;
        if (!sameSet) {
            console.error(
                `run.json at ${path} already describes a different run ` +
                    `(${existing.model}/${existing.variant}/${existing.caseIds?.join(",")}); ` +
                    "use a new --stamp",
            );
            return false;
        }
        return true;
    }
    try {
        write(path, JSON.stringify(description, null, 2) + "\n");
    } catch (error) {
        return keepDescriptionOnFailure(path, error);
    }
    return true;
}

/** The saved run description, or null for a legacy stamp. */
function loadRunDescription(options, stamp) {
    return readJson(join(options.results, stamp, "run.json")) ?? null;
}

/* ------------------------------------------------------------------ *
 * Running trials
 * ------------------------------------------------------------------ */

/**
 * Spawn one OpenCode session call and collect its output. Bounds: the
 * per-call timeout kills the child; buffers cap at MAX_BUFFER. Returns
 * completion metadata (status/signal/error) alongside stdout/stderr.
 */
function opencodeCall({ cwd, env, model, title, prompt, opencode, timeoutMs }) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(
                opencode,
                [
                    "run",
                    "--standalone",
                    "--auto",
                    "--archived",
                    "--title",
                    title,
                    "--model",
                    model,
                    "--format",
                    "json",
                    prompt,
                ],
                { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
            );
        } catch (error) {
            resolve({
                stdout: "",
                stderr: "",
                status: null,
                signal: null,
                error,
                timedOut: false,
            });
            return;
        }
        let stdout = "";
        let stderr = "";
        let killed = false;
        let settled = false;
        const timer = setTimeout(() => {
            killed = true;
            child.kill("SIGTERM");
        }, timeoutMs);
        const cap = (value, chunk) =>
            value.length < MAX_BUFFER ? value + chunk : value;
        child.stdout.on("data", (chunk) => {
            stdout = cap(stdout, String(chunk));
        });
        child.stderr.on("data", (chunk) => {
            stderr = cap(stderr, String(chunk));
        });
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ ...result, timedOut: killed });
        };
        child.on("error", (error) =>
            finish({ stdout, stderr, status: null, signal: null, error }),
        );
        child.on("close", (status, signal) =>
            finish({ stdout, stderr, status, signal, error: null }),
        );
    });
}

/** Copy only the sandbox surfaces; rubric.md and case.json stay out of reach. */
function copySandbox(caseFixture, live) {
    for (const surface of ["work", "lakes", "config-home"]) {
        cpSync(join(caseFixture, surface), join(live, surface), {
            recursive: true,
        });
    }
}

/** Whether a recorded run already occupies this result directory. */
function resultExists(resultDir) {
    return (
        existsSync(join(resultDir, "meta.json")) ||
        existsSync(join(resultDir, "final.md"))
    );
}

/**
 * Reserve one case's result directory atomically: the create either wins or
 * reports a rival, so simultaneous workers can never share evidence paths.
 */
function reserveResultDir(resultDir) {
    // Parallel workers reserve the same path atomically: the parent exists,
    // the case directory is claimed exactly once — first with the directory
    // create, then with an exclusively-created marker file, so a pre-staged
    // empty mount point is claimable but a rival mid-run is not. Recorded
    // evidence always refuses: a stamp is immutable.
    mkdirSync(dirname(resultDir), { recursive: true });
    try {
        mkdirSync(resultDir, { recursive: false });
    } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (resultExists(resultDir)) {
            return {
                reserved: false,
                reason:
                    `result already exists at ${resultDir}; ` +
                    "use a new --stamp instead of overwriting a run",
            };
        }
    }
    try {
        writeFileSync(
            join(resultDir, ".reservation"),
            JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) +
                "\n",
            { flag: "wx" },
        );
    } catch (error) {
        if (error?.code === "EEXIST") {
            return {
                reserved: false,
                reason:
                    `another run holds ${resultDir} (reservation in progress); ` +
                    "use a new --stamp instead of overwriting a run",
            };
        }
        throw error;
    }
    return { reserved: true };
}

function metaFor(
    testCase,
    options,
    promptPath,
    caseFixture,
    startedAt,
    finishedAt,
    result,
    diff,
    violations,
    answerHash,
    answerValid,
    telemetry,
    timings,
    generation,
    invalidReason,
) {
    return (
        JSON.stringify(
            {
                ...provenance(options),
                case: testCase.id,
                model: options.model,
                prompt: promptPath,
                promptHash: existsSync(promptPath)
                    ? fileHash(promptPath)
                    : "unknown",
                caseFixture,
                generation: generation?.inputsHash ?? "unknown",
                startedAt,
                finishedAt,
                exit: result.status,
                signal: result.signal ?? null,
                error: result.error
                    ? (result.error.code ?? String(result.error))
                    : null,
                timedOut: result.timedOut === true,
                writes: writeCount(diff),
                gitStateChanges: diff.git.length,
                writeKinds: diff,
                policyViolations: violations,
                answerHash,
                answerValid,
                ...(invalidReason !== null ? { invalidReason } : {}),
                telemetry,
                timings,
            },
            null,
            2,
        ) + "\n"
    );
}

/**
 * Copy the rubric and case after the answer exists, never before the run. In
 * the per-case run container the rubric root is not mounted, so this is a
 * no-op and the host copies them after the container exits.
 */
function copyCaseEvidence(options, testCase, resultDir) {
    const sourceDir = join(options.rubrics, testCase.id);
    for (const name of ["rubric.md", "case.json"]) {
        const source = join(sourceDir, name);
        if (existsSync(source)) cpSync(source, join(resultDir, name));
    }
}

/**
 * Why a recorded answer is not valid evidence, or null. Validity is
 * deterministic and checked before any semantic judge: the process must have
 * completed (exit 0, no signal, no spawn error, no timeout), the answer must
 * be nonblank, and the trail must contain parsable events.
 */
function answerInvalidReason(resultDir) {
    const finalPath = join(resultDir, "final.md");
    if (!existsSync(finalPath)) return "no final.md recorded";
    const meta = readJson(join(resultDir, "meta.json"));
    if (meta?.answerValid === false) {
        return meta.invalidReason ?? "answer failed validity checks";
    }
    return null;
}

/** Deterministic docs criterion of a case, from its trail. */
function docsCriterionProblem(testCase, resultDir) {
    const criterion = testCase.docsCriterion;
    if (!criterion) return null;
    const trail = readTrail(resultDir);
    if (trail === null) return "no tool trail recorded";
    const telemetry = docsTelemetry(trail.entries, trail.parseFailures);
    if (telemetry.docsCalls < (criterion.minDocsCalls ?? 1)) {
        return (
            `docs criterion unmet: ${telemetry.docsCalls} docs call(s), ` +
            `required ${criterion.minDocsCalls ?? 1}`
        );
    }
    if (criterion.verbs !== undefined) {
        const used = Object.entries(telemetry.verbs)
            .filter(([, count]) => count > 0)
            .map(([verb]) => verb);
        if (!criterion.verbs.some((verb) => used.includes(verb))) {
            return `docs criterion unmet: no ${criterion.verbs.join("/")} call observed`;
        }
    }
    return null;
}

/** A blank answer: one unparsable trail is different evidence from an empty completion. */
function trialBlankAnswerReason(parseFailures, events) {
    return parseFailures > 0 && events === 0
        ? "trial produced no parsable completion events"
        : "trial produced a blank answer";
}

/**
 * Why a completed run is not a valid trial answer, or null when it is:
 * spawn failure, signal, non-zero exit, or a blank answer.
 */
function trialInvalidReason(result, text, parseFailures, events, options) {
    if (result.error !== null && result.error !== undefined) {
        return `trial failed to start (${result.error.code ?? result.error})`;
    }
    if (result.signal !== null && result.signal !== undefined) {
        return result.timedOut
            ? `trial timed out after ${options.timeoutMs} ms`
            : `trial killed by signal ${result.signal}`;
    }
    if (result.status !== 0) {
        return `trial did not complete (exit ${result.status})`;
    }
    if (text.trim() === "") {
        return trialBlankAnswerReason(parseFailures, events);
    }
    return null;
}

/**
 * Persist one run's evidence into its result directory: streams, exit
 * status, writes report, answer, tool trail and the run meta record.
 */
function writeRunEvidence(
    resultDir,
    promptPath,
    caseFixture,
    startedAt,
    testCase,
    options,
    result,
    diff,
    violations,
    text,
    tools,
    answerHash,
    answerValid,
    telemetry,
    timings,
    generation,
    invalidReason,
) {
    write(join(resultDir, "stdout.jsonl"), result.stdout ?? "");
    write(join(resultDir, "stderr.log"), result.stderr ?? "");
    write(
        join(resultDir, "exit-code"),
        `${result.status ?? `signal:${result.signal}`}\n`,
    );
    write(join(resultDir, "writes.txt"), writesReport(diff, violations));
    write(join(resultDir, "final.md"), text);
    write(join(resultDir, "tools.jsonl"), tools);
    write(
        join(resultDir, "meta.json"),
        metaFor(
            testCase,
            options,
            promptPath,
            caseFixture,
            startedAt,
            new Date().toISOString(),
            result,
            diff,
            violations,
            answerHash,
            answerValid,
            telemetry,
            timings,
            generation,
            invalidReason,
        ),
    );
}

/** The one-line report printed after one trial completes. */
function runReportLine(
    testCase,
    resultDir,
    result,
    diff,
    violations,
    answerValid,
    invalidReason,
) {
    const writes = writeCount(diff);
    return (
        `${testCase.id}: exit ${result.status ?? "signal"}, writes ${writes}` +
        `${violations.length > 0 ? `, ${violations.length} out-of-policy` : ""}` +
        `${answerValid ? "" : `, INVALID (${invalidReason})`}` +
        ` -> ${resultDir}`
    );
}

async function runOne(testCase, options, stamp) {
    const startedAt = new Date().toISOString();
    const timings = { prepareMs: 0, modelMs: 0, snapshotMs: 0, totalMs: 0 };
    const totalStart = Date.now();
    const prepareStart = Date.now();
    const promptPath = join(options.prompts, `${testCase.id}.md`);
    const { problems, generation } = validateGeneration(testCase, options);
    if (problems.length > 0) {
        console.error(
            `${testCase.id}: prepared generation is not usable — ${problems.join("; ")}`,
        );
        return 1;
    }

    const caseFixture = join(options.fixtures, testCase.id);
    const resultDir = join(options.results, stamp, testCase.id);
    // A run is evidence, not scratch: rerunning the same stamp would mix
    // answers, tool trails and verdicts. A fresh stamp is the only way to
    // repeat a case. The reservation is atomic, so parallel workers cannot
    // share a result directory.
    const reservation = reserveResultDir(resultDir);
    if (!reservation.reserved) {
        console.error(`${testCase.id}: ${reservation.reason}`);
        return 1;
    }

    const live = join(resultDir, "live");
    rmSync(live, { recursive: true, force: true });
    copySandbox(caseFixture, live);
    cpSync(promptPath, join(resultDir, "prompt.md"));
    timings.prepareMs = Date.now() - prepareStart;

    const before = snapshotLive(live);
    const modelStart = Date.now();
    const result = await opencodeCall({
        cwd: join(live, "work"),
        env: childEnv(join(live, "config-home")),
        model: options.model,
        title: `placement-${testCase.id}`,
        prompt: readFileSync(promptPath, "utf8"),
        opencode: options.opencode,
        timeoutMs: options.timeoutMs,
    });
    timings.modelMs = Date.now() - modelStart;

    const snapshotStart = Date.now();
    const diff = snapshotDiff(before, snapshotLive(live));
    const violations = policyViolation(diff, testCase);
    timings.snapshotMs = Date.now() - snapshotStart;

    const { text, tools, events, parseFailures, toolCalls } = extract(
        result.stdout ?? "",
    );
    const telemetry = {
        ...docsTelemetry(toolCalls, parseFailures),
        events,
        parseFailures,
    };
    const answerHash = sha256(text);
    const invalidReason = trialInvalidReason(
        result,
        text,
        parseFailures,
        events,
        options,
    );
    const answerValid = invalidReason === null;
    timings.totalMs = Date.now() - totalStart;

    writeRunEvidence(
        resultDir,
        promptPath,
        caseFixture,
        startedAt,
        testCase,
        options,
        result,
        diff,
        violations,
        text,
        tools,
        answerHash,
        answerValid,
        telemetry,
        timings,
        generation,
        invalidReason,
    );
    // The rubric stays out of the sandbox until the answer exists. The same
    // applies to case.json, which carries the rubric's expectations.
    copyCaseEvidence(options, testCase, resultDir);

    console.log(
        runReportLine(
            testCase,
            resultDir,
            result,
            diff,
            violations,
            answerValid,
            invalidReason,
        ),
    );
    // Invalid runs (infrastructure failures) fail the sweep; judging gates on
    // the recorded validity and reports an invalid run, never a placement
    // failure or a pass.
    return answerValid ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * Judging
 * ------------------------------------------------------------------ */

function judgePrompt(resultDir) {
    const rubric = readFileSync(join(resultDir, "rubric.md"), "utf8");
    const answer = existsSync(join(resultDir, "final.md"))
        ? readFileSync(join(resultDir, "final.md"), "utf8")
        : "(no answer recorded)";
    const writes = existsSync(join(resultDir, "writes.txt"))
        ? readFileSync(join(resultDir, "writes.txt"), "utf8")
        : "(unknown)";
    return `Score one placement-guidance trial against its rubric. Judge only the stated intended action; a trial is not required to write a file.

Return ONE JSON object and nothing else:
{"verdict":"pass"|"fail","destination":"...","documents":"one"|"several"|"none","clarification":"yes"|"no","reason":"..."}

A pass means the destination or workflow matches Expected and Accepts, and does not rely on a tempting wrong answer. For Expected "clarify", a pass must ask a focused question and leave the destination explicitly deferred: naming a destination lake while ownership is unresolved is a guess and fails, unless the Accepts explicitly permit naming it (for example, with an independent ownership justification).

Rubric:
${rubric}

Trial answer:
${answer}

Files changed during the trial:
${writes}`;
}

function copyRubric(options, resultDir, caseId) {
    const target = join(resultDir, "rubric.md");
    if (existsSync(target)) return;
    // The rubric root is the current home; fixture-local copies keep older
    // results judgeable after the move.
    const source = [
        join(options.rubrics, caseId, "rubric.md"),
        join(options.fixtures, caseId, "rubric.md"),
    ].find((path) => existsSync(path));
    if (source !== undefined) cpSync(source, target);
}

function prepareJudgeRoot(resultDir, judgeModel) {
    const judgeRoot = join(resultDir, "judge");
    mkdirSync(join(judgeRoot, "work"), { recursive: true });
    mkdirSync(join(judgeRoot, "config-home", "opencode"), { recursive: true });
    write(
        join(judgeRoot, "config-home", "opencode", "opencode.json"),
        JSON.stringify(
            { $schema: "https://opencode.ai/config.json", model: judgeModel },
            null,
            2,
        ) + "\n",
    );
    return judgeRoot;
}

/** Pull the one JSON verdict object out of the judge's prose, if any. */
function parseVerdict(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return undefined;
    }
}

const VERDICT_ENUMS = {
    verdict: ["pass", "fail"],
    documents: ["one", "several", "none"],
    clarification: ["yes", "no"],
};

/** Enum-field problems for a parsed verdict: missing, non-string or off-enum. */
function verdictEnumProblems(value) {
    const problems = [];
    for (const [field, allowed] of Object.entries(VERDICT_ENUMS)) {
        if (value[field] === undefined) {
            problems.push(`${field} is missing`);
        } else if (
            typeof value[field] !== "string" ||
            !allowed.includes(value[field])
        ) {
            problems.push(`${field} must be one of ${allowed.join("|")}`);
        }
    }
    return problems;
}

/** Problems for fields that must be present, nonblank strings. */
function verdictNonBlankProblems(value) {
    const problems = [];
    for (const field of ["destination", "reason"]) {
        if (typeof value[field] !== "string" || value[field].trim() === "") {
            problems.push(`${field} must be a nonblank string`);
        }
    }
    return problems;
}

/**
 * Validate a parsed judge verdict against the required schema: complete
 * fields, string types, nonblank destination and reason, exact enums.
 * `{"verdict":"pass"}` alone is not a verdict.
 * @param value The parsed object.
 * @returns The problems; empty means a complete valid verdict.
 */
function validateVerdict(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return ["not a JSON object"];
    }
    return [...verdictEnumProblems(value), ...verdictNonBlankProblems(value)];
}

/**
 * Whether the judge process itself succeeded: completed (not signalled,
 * not timed out, not failed to spawn) and exited zero.
 */
function judgeProcessOk(result) {
    if (result.error !== null && result.error !== undefined) return false;
    if (result.signal !== null && result.signal !== undefined) return false;
    return result.status === 0;
}

function verdictLabel(verdict) {
    const parsed = verdict ?? {};
    const destination = parsed.destination ?? "";
    return `${parsed.verdict ?? "unparsed"}${destination ? ` -> ${destination}` : ""}`;
}

/** The next judge attempt number, so rejudging never overwrites evidence. */
function nextAttempt(resultDir) {
    const root = join(resultDir, "judge");
    if (!existsSync(root)) return "001";
    const attempts = readdirSync(root, { withFileTypes: true })
        .filter(
            (entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name),
        )
        .map((entry) => Number(entry.name.slice("attempt-".length)))
        .filter(Number.isFinite);
    return String(Math.max(0, ...attempts) + 1).padStart(3, "0");
}

function writeInvalidVerdict(caseId, resultDir, reason, answerHash) {
    const verdict = {
        verdict: "invalid",
        reason,
        answerHash,
        judgeModel: "none",
    };
    write(
        join(resultDir, "verdict.json"),
        JSON.stringify(verdict, null, 2) + "\n",
    );
    console.log(`${caseId}: invalid — ${reason}`);
    return 1;
}

/**
 * Why a recorded run is not judgeable, or null when it is complete. The
 * deterministic gates: answer validity, exit status, and the case's mutation
 * policy — out-of-policy writes fail a policy-bearing case regardless of
 * --allow-writes, which only widens the legacy decision-only baseline.
 */
/**
 * The refusal for a policy-bearing case, or null. The policy is the
 * authorisation: in-policy writes judge without any flag; out-of-policy
 * writes invalidate regardless of `--allow-writes`, which only widens the
 * legacy decision-only baseline. `minWrites` is a deterministic recording
 * expectation — a "record this" case that wrote nothing is invalid before
 * any semantic judge, because the model claiming a write is not a write.
 */
function policyReason(meta, testCase) {
    const policy =
        testCase && testCase.mutationPolicy ? testCase.mutationPolicy : null;
    if (!policy) return null;
    const violations = meta.policyViolations ?? [];
    if (violations.length > 0) {
        return `run mutated ${violations.length} file(s) outside its policy`;
    }
    const writes = meta.writes ?? 0;
    const minimum = policy.minWrites ?? 0;
    if (writes < minimum) {
        return `recording case wrote ${writes} file(s), policy requires ${minimum}`;
    }
    return null;
}

/**
 * Why a recorded run is not judgeable, or null when it is complete. The
 * deterministic gates: answer validity, exit status, and the case's mutation
 * policy ({@link policyReason}).
 */
function runInvalidReason(resultDir, options, testCase) {
    const answer = answerInvalidReason(resultDir);
    if (answer !== null) return answer;
    const meta = readJson(join(resultDir, "meta.json"));
    if (!meta) return "no meta.json recorded";
    if (meta.exit !== 0) return `trial did not complete (exit ${meta.exit})`;
    // A policy-bearing case is answered by the policy alone; only the
    // legacy decision-only baseline consults --allow-writes.
    if (testCase?.mutationPolicy) return policyReason(meta, testCase);
    if (options.allowWrites) return null;
    if (meta.writes !== 0) {
        return `decision-only trial changed ${meta.writes} file(s)`;
    }
    return null;
}

/** Terminal status of one judge attempt: process-failed, invalid-verdict or judged. */
function judgeStatusOf(result, problems) {
    if (!judgeProcessOk(result)) return "process-failed";
    return problems.length > 0 ? "invalid-verdict" : "judged";
}

/**
 * The attempt-local meta.json body: identities, timings, terminal state and
 * the parsed verdict when one survived parsing.
 */
function judgeAttemptMeta({
    resultDir,
    judgeDir,
    judgeModel,
    attemptKey,
    identities,
    startedAt,
    judgeMs,
    result,
    parsed,
    problems,
    judgeStatus,
}) {
    return {
        attempt: relative(resultDir, judgeDir),
        judgeModel,
        judgeKey: attemptKey,
        judgePromptHash: identities.judgePromptHash,
        answerHash: identities.answerHash,
        rubricHash: identities.rubricHash,
        startedAt,
        finishedAt: new Date().toISOString(),
        exit: result.status,
        signal: result.signal ?? null,
        error: result.error
            ? (result.error.code ?? String(result.error))
            : null,
        timedOut: result.timedOut === true,
        timings: { judgeMs },
        judgeStatus,
        ...(parsed === undefined ? {} : { parsedVerdict: parsed }),
        ...(problems.length > 0 ? { problems } : {}),
    };
}

/** Why an attempt was not judged: the judge process failure or the invalid output. */
function judgeFailureReason(result, problems) {
    if (judgeProcessOk(result)) {
        return `judge output invalid (${problems.join("; ")})`;
    }
    return (
        `judge process failed (exit ${result.status ?? "?"}` +
        `${result.signal ? `, signal ${result.signal}` : ""}` +
        `${result.error ? `, error ${result.error.code ?? result.error}` : ""}` +
        `${result.timedOut ? ", timed out" : ""})`
    );
}

/** Record the result-level judge-error pointer and report it; always a failure. */
function writeJudgeErrorVerdict(
    caseId,
    resultDir,
    judgeModel,
    identities,
    attempt,
    why,
) {
    write(
        join(resultDir, "verdict.json"),
        JSON.stringify(
            {
                verdict: "judge-error",
                reason: why,
                judgeModel,
                ...identities,
                attempt,
            },
            null,
            2,
        ) + "\n",
    );
    console.error(`${caseId}: judge-error — ${why}`);
    return 1;
}

/** Record the result-level verdict pointer for a genuinely judged attempt. */
function writeJudgedVerdict(
    resultDir,
    parsed,
    judgeModel,
    identities,
    attempt,
) {
    write(
        join(resultDir, "verdict.json"),
        JSON.stringify(
            { ...parsed, judgeModel, ...identities, attempt },
            null,
            2,
        ) + "\n",
    );
}

/**
 * Record one judge attempt. The attempt directory preserves everything:
 * stdout, stderr, raw text, timings, completion metadata, the identities of
 * every input (answer, rubric, judge prompt) and the parsed or failed
 * verdict. The result-level pointer is written only for a real judged
 * verdict; a failed judge becomes `judge-error`, never a pass.
 */
async function judgeAttempt(
    caseId,
    resultDir,
    judgeDir,
    result,
    judgeModel,
    identities,
    judgeMs,
    attemptKey,
    startedAt,
) {
    write(join(judgeDir, "stdout.jsonl"), result.stdout ?? "");
    write(join(judgeDir, "stderr.log"), result.stderr ?? "");
    const { text } = extract(result.stdout ?? "");
    write(join(judgeDir, "raw.md"), text);

    const parsed = parseVerdict(text);
    const problems =
        parsed === undefined
            ? ["no JSON object in output"]
            : validateVerdict(parsed);
    const judgeStatus = judgeStatusOf(result, problems);
    const attemptMeta = judgeAttemptMeta({
        resultDir,
        judgeDir,
        judgeModel,
        attemptKey,
        identities,
        startedAt,
        judgeMs,
        result,
        parsed,
        problems,
        judgeStatus,
    });
    write(
        join(judgeDir, "verdict.json"),
        JSON.stringify(
            {
                ...(parsed ?? { raw: text.trim() }),
                judgeStatus,
                ...(problems.length > 0 ? { problems } : {}),
                judgeModel,
                ...identities,
                attempt: attemptMeta.attempt,
            },
            null,
            2,
        ) + "\n",
    );
    write(
        join(judgeDir, "meta.json"),
        JSON.stringify(attemptMeta, null, 2) + "\n",
    );

    if (judgeStatus !== "judged") {
        return writeJudgeErrorVerdict(
            caseId,
            resultDir,
            judgeModel,
            identities,
            attemptMeta.attempt,
            judgeFailureReason(result, problems),
        );
    }

    // Convenience pointer for summary/export; the attempt directory is the
    // durable evidence.
    writeJudgedVerdict(
        resultDir,
        parsed,
        judgeModel,
        identities,
        attemptMeta.attempt,
    );
    console.log(`${caseId}: ${verdictLabel(parsed)}`);
    return parsed.verdict === "pass" ? 0 : 1;
}

/** Identity key for resumable judging: inputs plus judge settings. */
function judgeKey(identities) {
    return sha256(JSON.stringify(identities));
}

/**
 * Resume an identical earlier judge attempt: rewrite the result-level pointer
 * with the resume provenance and return the prior verdict's exit code. Null
 * when no attempt with matching inputs and settings was judged.
 */
function resumePriorAttempt(caseId, resultDir, judgeRoot, key, identities) {
    for (const entry of readdirSync(judgeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^attempt-\d+$/.test(entry.name)) continue;
        const prior = readJson(join(judgeRoot, entry.name, "meta.json"));
        if (prior?.judgeKey === key && prior?.judgeStatus === "judged") {
            const verdict = readJson(
                join(judgeRoot, entry.name, "verdict.json"),
            );
            write(
                join(resultDir, "verdict.json"),
                JSON.stringify(
                    {
                        ...verdict,
                        resumedFrom: entry.name,
                        ...identities,
                    },
                    null,
                    2,
                ) + "\n",
            );
            console.log(
                `${caseId}: ${verdictLabel(verdict)} (resumed ${entry.name})`,
            );
            return verdict?.verdict === "pass" ? 0 : 1;
        }
    }
    return null;
}

async function judgeOne(testCase, options, stamp) {
    const resultDir = join(options.results, stamp, testCase.id);
    if (!existsSync(resultDir)) {
        console.log(`${testCase.id}: no run recorded, skipping judge`);
        return 1;
    }
    const answerHash = existsSync(join(resultDir, "final.md"))
        ? fileHash(join(resultDir, "final.md"))
        : "unknown";
    const invalid = runInvalidReason(resultDir, options, testCase);
    if (invalid !== null) {
        return writeInvalidVerdict(testCase.id, resultDir, invalid, answerHash);
    }
    const criterion = docsCriterionProblem(testCase, resultDir);
    if (criterion !== null) {
        return writeInvalidVerdict(
            testCase.id,
            resultDir,
            criterion,
            answerHash,
        );
    }
    copyRubric(options, resultDir, testCase.id);
    if (!existsSync(join(resultDir, "rubric.md"))) {
        return writeInvalidVerdict(
            testCase.id,
            resultDir,
            "no rubric recorded",
            answerHash,
        );
    }
    const rubricHash = fileHash(join(resultDir, "rubric.md"));
    const judgeModel = options.judgeModel || options.model;
    const prompt = judgePrompt(resultDir);
    const judgePromptHash = sha256(prompt);
    const identities = { answerHash, rubricHash, judgePromptHash, judgeModel };
    const key = judgeKey(identities);

    // Resumable judging: an earlier attempt with the same inputs and judge
    // settings already holds the verdict; preserve it instead of respending.
    const judgeRoot = join(resultDir, "judge");
    if (existsSync(judgeRoot)) {
        const resumed = resumePriorAttempt(
            testCase.id,
            resultDir,
            judgeRoot,
            key,
            identities,
        );
        if (resumed !== null) return resumed;
    }

    const root = prepareJudgeRoot(resultDir, judgeModel);
    const attempt = nextAttempt(resultDir);
    const judgeDir = join(resultDir, "judge", `attempt-${attempt}`);
    mkdirSync(judgeDir, { recursive: true });
    const startedAt = new Date().toISOString();
    const modelStart = Date.now();
    const result = await opencodeCall({
        cwd: join(root, "work"),
        env: childEnv(join(root, "config-home")),
        model: judgeModel,
        title: `placement-judge-${testCase.id}-${attempt}`,
        prompt,
        opencode: options.opencode,
        timeoutMs: options.timeoutMs,
    });
    return await judgeAttempt(
        testCase.id,
        resultDir,
        judgeDir,
        result,
        judgeModel,
        identities,
        Date.now() - modelStart,
        key,
        startedAt,
    );
}

/* ------------------------------------------------------------------ *
 * Reporting from saved evidence
 * ------------------------------------------------------------------ */

/** The Expected column: the case's expectation, or why the run has none. */
function summaryExpected(caseInfo, runDescription) {
    return (
        caseInfo?.expected ??
        (runDescription === null ? "(legacy run)" : "(missing from run.json)")
    );
}

/** The Verdict column: the recorded verdict, or why there is no verdict. */
function summaryVerdict(verdict, resultDir) {
    return verdict?.verdict ?? (existsSync(resultDir) ? "unjudged" : "not run");
}

/** The ` [model: …]` suffix for a result produced by a different model. */
function summaryModelMismatch(runDescription, meta) {
    return runDescription !== null &&
        meta?.model !== undefined &&
        meta.model !== runDescription.model
        ? ` [model: ${meta.model}]`
        : "";
}

/** The Exposure column: no trail, the classified labels, or "none". */
function summaryExposure(resultDir, trail) {
    return trail === null
        ? "no trail"
        : exposureFor(resultDir).join(" + ") || "none";
}

function summaryRow(runDescription, caseInfo, resultDir) {
    const verdict = readJson(join(resultDir, "verdict.json"));
    const report = existsSync(join(resultDir, "writes.txt"))
        ? readFileSync(join(resultDir, "writes.txt"), "utf8").trim()
        : "";
    const trail = readTrail(resultDir);
    const telemetry =
        trail === null
            ? null
            : docsTelemetry(trail.entries, trail.parseFailures);
    const meta = readJson(join(resultDir, "meta.json"));
    return {
        id: caseInfo?.id ?? "?",
        expected: summaryExpected(caseInfo, runDescription),
        verdict: summaryVerdict(verdict, resultDir),
        destination: verdict?.destination ?? "",
        writes: writesLabel(report),
        docs: docsLabel(telemetry),
        discovery: discoveryLabel(discoveryFor(resultDir)),
        exposure: summaryExposure(resultDir, trail),
        modelMismatch: summaryModelMismatch(runDescription, meta),
    };
}

/** The stamped case ids: the recorded list, else the sorted result directories. */
function stampedCaseIds(run, stampDir) {
    return (
        run?.caseIds ??
        (existsSync(stampDir)
            ? readdirSync(stampDir, { withFileTypes: true })
                  .filter((entry) => entry.isDirectory())
                  .map((entry) => entry.name)
                  .sort()
            : [])
    );
}

/** The two-line legacy notice shown when a stamp has no run.json. */
function legacyStampNotice(run) {
    return run === null
        ? [
              "Provenance: unknown — legacy stamp without run.json; labels come from saved artefacts only.",
              "",
          ]
        : [];
}

/** The boundary sentence of the summary header, or its legacy counterpart. */
function summaryBoundary(run) {
    return run
        ? `${run.boundary?.containerised === true ? "container" : "host"}${run.boundary?.image ? ` (${run.boundary.image})` : ""}`
        : "unknown (legacy)";
}

/** The provenance identity lines, when the stamp recorded them. */
function summaryProvenanceLines(provenanceInfo) {
    return provenanceInfo
        ? [
              `Fixture: ${provenanceInfo.fixtureVersion ?? "unknown"}`,
              `Plugin: ${provenanceInfo.pluginCommit ?? "unknown"} (${provenanceInfo.pluginHash ?? "unknown"})`,
              `CLI: ${provenanceInfo.opencode ?? "unknown"}`,
          ]
        : [];
}

/** The context lines between the title and the case table of summary.md. */
function summaryHeaderLines(run, stamp) {
    const described = run ?? {};
    return [
        `# Placement trial ${stamp}`,
        "",
        `Run created: ${described.createdAt ?? "unknown (legacy)"}`,
        `Reported: ${new Date().toISOString()} (rendering time, not run time)`,
        `Model: ${described.model ?? "unknown (legacy)"}`,
        `Variant: ${described.variant ?? "unknown (legacy)"}`,
        `Boundary: ${summaryBoundary(run)}`,
        ...summaryProvenanceLines(described.provenance),
        ...legacyStampNotice(run),
    ];
}

/** The markdown case table of the summary. */
function summaryTable(rows) {
    return [
        "| Case | Expected | Verdict | Destination | Writes | Docs | Discovery | Exposure |",
        "| ---- | -------- | ------- | ----------- | ------ | ---- | --------- | -------- |",
        ...rows.map(
            (row) =>
                `| ${row.id} | ${row.expected} | ${row.verdict}${row.modelMismatch} | ${row.destination || "-"} | ${row.writes} | ${row.docs} | ${row.discovery} | ${row.exposure} |`,
        ),
    ];
}

/** The tally lines under the summary table. */
function summaryTallies(rows) {
    return [
        `Passed: ${rows.filter((row) => row.verdict === "pass").length}/${rows.length}`,
        `Failed: ${rows.filter((row) => row.verdict === "fail").length}`,
        `Invalid: ${rows.filter((row) => row.verdict === "invalid").length}`,
        `Judge errors: ${rows.filter((row) => row.verdict === "judge-error").length}`,
        `Discovered: ${rows.filter((row) => row.discovery.startsWith("help")).length}/${rows.length}`,
        `Exposed: ${rows.filter((row) => row.exposure !== "none" && row.exposure !== "no trail").length}/${rows.length}`,
    ];
}

function renderSummary(options, stamp) {
    const stampDir = join(options.results, stamp);
    const run = loadRunDescription(options, stamp);
    const caseList = run?.cases ?? [];
    const rows = stampedCaseIds(run, stampDir).map((id) =>
        summaryRow(
            run,
            caseList.find((entry) => entry.id === id),
            join(stampDir, id),
        ),
    );
    const lines = [
        ...summaryHeaderLines(run, stamp),
        `Results: ${stampDir}`,
        "",
        ...summaryTable(rows),
        "",
        ...summaryTallies(rows),
        "",
    ];
    const text = lines.join("\n");
    write(join(stampDir, "summary.md"), text);
    process.stdout.write(text);
}

/** Read a result artefact for the dossier; absent files get a visible marker. */
function readArtifact(resultDir, name) {
    const path = join(resultDir, name);
    return existsSync(path) ? readFileSync(path, "utf8").trim() : "(absent)";
}

/** One tool-trail line for the dossier, with the output trimmed for scanning. */
function trailLine(entry) {
    const input = JSON.stringify(entry.input ?? {});
    const output =
        typeof entry.output === "string"
            ? entry.output.slice(0, 160)
            : entry.output;
    return `- **${entry.tool}** input \`${input}\`${output ? ` -> \`${JSON.stringify(output)}\`` : ""}`;
}

const TRAIL_LIMIT = 15;

function trailFor(resultDir) {
    const trail = readTrail(resultDir);
    if (trail === null) return [];
    const entries = trail.entries.map(trailLine);
    if (entries.length <= TRAIL_LIMIT) return entries;
    return [
        ...entries.slice(0, TRAIL_LIMIT),
        `(${entries.length - TRAIL_LIMIT} more calls elided — this projection is truncated; tools.jsonl is the authoritative full trail)`,
    ];
}

function verdictFor(resultDir) {
    const verdict = readJson(join(resultDir, "verdict.json"));
    if (!verdict) return "not judged locally";
    const destination = verdict.destination
        ? ` — destination: ${verdict.destination}`
        : "";
    const reason = verdict.reason ? ` — ${verdict.reason}` : "";
    const attempt = verdict.attempt
        ? verdict.resumedFrom
            ? `, resumed ${verdict.resumedFrom}`
            : `, attempt ${verdict.attempt}`
        : "";
    return `${verdict.verdict}${destination}${reason} (judge model: ${verdict.judgeModel ?? "unknown"}${attempt})`;
}

/** One labelled fenced artefact block of the dossier, with a trailing blank line. */
function artifactSection(resultDir, heading, name) {
    return [heading, "", "````", readArtifact(resultDir, name), "````", ""];
}

/** The numbered tool-trail entries of one case, or a "(no tool calls)" placeholder. */
function caseTrailEntries(resultDir) {
    const trail = trailFor(resultDir);
    return [
        `### Tool trail (${trail.length} entr${trail.length === 1 ? "y" : "ies"})`,
        "",
        ...(trail.length > 0 ? trail : ["(no tool calls)"]),
        "",
    ];
}

/** The exposure and discovery observations drawn from one case's tool trail. */
function caseObservations(resultDir) {
    return [
        `Exposure: ${
            exposureFor(resultDir).join(" + ") || "none"
        } (classified from completed calls in the tool trail; guidance exposure is expected)`,
        "",
        `Discovery: ${discoveryLabel(discoveryFor(resultDir))} (docs-family calls; help lists the configured lakes)`,
        "",
    ];
}

/** The recorded run-meta line under one case's local judge verdict. */
function caseMetaLine(meta) {
    return (
        `Run meta: exit ${meta.exit ?? "?"}, ${meta.writes ?? "?"} write(s), ` +
        `answer ${meta.answerHash ?? "?"}, started ${meta.startedAt ?? "?"}` +
        `${meta.answerValid === false ? ", INVALID ANSWER" : ""}.`
    );
}

/** The dossier section for one case: rubric, prompt, answer, trail, verdict. */
function caseSection(caseInfo, resultDir) {
    const meta = readJson(join(resultDir, "meta.json")) ?? {};
    const id = caseInfo?.id ?? "?";
    const expected = caseInfo?.expected ?? "(unknown — legacy run)";
    return [
        "---",
        "",
        `## ${id} — Expected: ${expected}`,
        "",
        ...artifactSection(resultDir, "### Rubric", "rubric.md"),
        ...artifactSection(
            resultDir,
            "### Prompt given to the trial model",
            "prompt.md",
        ),
        ...artifactSection(resultDir, "### Trial answer", "final.md"),
        ...caseTrailEntries(resultDir),
        ...caseObservations(resultDir),
        ...artifactSection(resultDir, "### Files changed", "writes.txt"),
        "### Local judge",
        "",
        verdictFor(resultDir),
        "",
        caseMetaLine(meta),
        "",
    ];
}

/** The legacy provenance warning, or an empty placeholder on a current run. */
function dossierLegacyLine(run) {
    return run === null
        ? "- Provenance: UNKNOWN — legacy stamp without run.json. Model, variant and guidance identity below come from saved per-case artefacts where present; treat missing labels as unknown, never as defaults."
        : "";
}

/** The image bullet of the provenance block: the container, or an explicit host run. */
function dossierImageLine(run) {
    return `- Image: ${run.boundary?.image || "none (host run)"}`;
}

/** The provenance bullets, or the legacy warning when the stamp recorded none. */
function dossierProvenanceLines(run) {
    const provenanceInfo = run?.provenance;
    return provenanceInfo
        ? [
              `- Fixture: ${provenanceInfo.fixtureVersion ?? "unknown"} (${provenanceInfo.fixtureHash ?? "unknown"})`,
              `- Plugin: ${provenanceInfo.pluginCommit ?? "unknown"} (${provenanceInfo.pluginHash ?? "unknown"}${provenanceInfo.pluginDirty ? ", dirty tree" : ""})`,
              `- CLI: ${provenanceInfo.opencode ?? "unknown"}`,
              dossierImageLine(run),
          ]
        : [dossierLegacyLine(run)];
}

/** The sandbox-boundary sentence, or its legacy counterpart. */
function dossierBoundaryText(run) {
    const boundary = run?.boundary;
    return boundary?.containerised
        ? "each trial ran in its own container, whose mounts held only that case's sandbox, its prompt, an id-only case list and the result directory, plus a curated plugin package; the rubric reached the result only after the container exited"
        : boundary === undefined
          ? "unknown (legacy stamp — per-case meta.json records the boundary of each run)"
          : "trials ran directly on the host — the container boundary was NOT enforced for this stamp; treat sandbox guarantees as absent";
}

/** The run facts as bullets; "unknown (legacy)" when the stamp recorded none. */
function dossierRunLines(run) {
    const described = run ?? {};
    return [
        `- Run created: ${described.createdAt ?? "unknown (legacy)"}`,
        `- Reported: ${new Date().toISOString()} (rendering time, not run time)`,
        `- Trial model: ${described.model ?? "unknown (legacy)"}`,
        `- Variant: ${described.variant ?? "unknown (legacy)"}`,
    ];
}

/** The timeout and harness bullets of the dossier header. */
function dossierExecutionLines(run) {
    const described = run ?? {};
    return [
        `- Timeout: ${described.timeoutMs ?? "unknown"} ms per model call`,
        `- Harness: opencode-docs-plugin placement-harness v${described.harnessVersion ?? "?"}`,
    ];
}

function dossierHeader(options, stamp, run) {
    return [
        `# Placement-trial dossier ${stamp}`,
        "",
        ...dossierRunLines(run),
        ...dossierProvenanceLines(run),
        ...dossierExecutionLines(run),
        `- Boundary: ${dossierBoundaryText(run)}. Permission rules requesting no shell, edits or reads outside the workspace are defence in depth, not guarantees — read each case's tool trail and Exposure line. Trials state an intended action; they are not required to write.`,
        "",
        "You are an expert reviewer scoring a behavioural trial of",
        "documentation-placement guidance. For each case, read the rubric, the",
        "prompt, the trial's answer and its tool trail. Decide pass or fail",
        "against Expected and Accepts, flag any tempting wrong answer it fell",
        "for, and note whether the docs tool was used appropriately. Finish",
        "with a markdown summary table (Case | Verdict | Destination | Notes).",
        "",
    ];
}

/**
 * Bundle one stamp into a single Markdown dossier for deep review by a
 * stronger model (a local big-brother judge, or an external frontier model).
 * Rendered from the stamp's own evidence, never from current inputs.
 */
function exportDossier(options, stamp) {
    const stampDir = join(options.results, stamp);
    if (!existsSync(stampDir)) usage(`no results at ${stampDir}`);
    const run = loadRunDescription(options, stamp);
    const parts = dossierHeader(options, stamp, run);
    let cases = 0;
    const ids =
        run?.caseIds ??
        readdirSync(stampDir, { withFileTypes: true })
            .filter(
                (entry) =>
                    entry.isDirectory() &&
                    existsSync(join(stampDir, entry.name, "final.md")),
            )
            .map((entry) => entry.name)
            .sort();
    for (const id of ids) {
        const resultDir = join(stampDir, id);
        if (!existsSync(join(resultDir, "final.md"))) continue;
        cases += 1;
        parts.push(
            ...caseSection(
                run?.cases?.find((entry) => entry.id === id),
                resultDir,
            ),
        );
    }
    const dossier = parts.join("\n") + "\n";
    const outPath = join(stampDir, "dossier.md");
    write(outPath, dossier);
    console.log(
        `dossier: ${outPath} (${cases} cases, ${dossier.length} bytes)`,
    );
    return 0;
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

/**
 * Run items through a bounded worker pool. Each item's outcome is kept in
 * order; a rejecting worker fails that item without sinking the pool.
 */
async function runPool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    let index = 0;
    const width = Math.max(1, Math.min(limit, items.length));
    const runners = Array.from({ length: width }, async () => {
        while (true) {
            const current = index;
            index += 1;
            if (current >= items.length) break;
            try {
                results[current] = {
                    ok: true,
                    value: await worker(items[current], current),
                };
            } catch (error) {
                results[current] = { ok: false, error };
                console.error(`worker failed: ${error?.stack ?? error}`);
            }
            next = Math.max(next, current + 1);
        }
    });
    await Promise.all(runners);
    return results;
}

async function runSelected(options, stamp, selected) {
    // A run never generates: it validates the prepared generation and
    // refuses stale or missing shared inputs instead (F03 contract).
    const results = await runPool(selected, options.jobs, (testCase) =>
        runOne(testCase, options, stamp),
    );
    return results.reduce(
        (worst, outcome) => Math.max(worst, outcome.ok ? outcome.value : 1),
        0,
    );
}

async function judgeSelected(options, stamp, selected) {
    const results = await runPool(selected, options.judgeJobs, (testCase) =>
        judgeOne(testCase, options, stamp),
    );
    return results.reduce(
        (worst, outcome) => Math.max(worst, outcome.ok ? outcome.value : 1),
        0,
    );
}

/**
 * Resolve the stamp for a report/judge command: explicit --stamp must name an
 * existing run; without it the most recently CREATED run wins (run.json
 * createdAt, else directory mtime for legacy stamps) — never name order.
 */
function resolveExistingStamp(options) {
    if (options.stamp) {
        const stampDir = join(options.results, options.stamp);
        if (!existsSync(stampDir)) usage(`no results at ${stampDir}`);
        return options.stamp;
    }
    if (!existsSync(options.results))
        usage(`no results root at ${options.results}`);
    const candidates = readdirSync(options.results, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    if (candidates.length === 0)
        usage(`no result stamps under ${options.results}`);
    const createdAt = (name) => {
        const run = readJson(join(options.results, name, "run.json"));
        if (run?.createdAt) return Date.parse(run.createdAt);
        try {
            return lstatSync(join(options.results, name)).mtimeMs;
        } catch {
            return 0;
        }
    };
    return candidates.reduce((best, name) =>
        createdAt(name) > createdAt(best) ? name : best,
    );
}

/** What a sweep-style command should do, derived once. */
function planFor(command, noJudge) {
    return {
        generates: command === "all",
        runs: command === "run" || command === "all",
        judges: command === "judge" || (command === "all" && !noJudge),
        reports:
            command === "judge" ||
            command === "summary" ||
            command === "export" ||
            command === "all",
    };
}

async function executeAndReport(options, plan, stamp, selected) {
    let worst = 0;
    let infra = 0;
    if (plan.generates) infra = await generateAll(options);
    if (infra === 0 && plan.runs) {
        if (!ensureRunDescription(options, stamp, selected, "run")) return 1;
        worst = await runSelected(options, stamp, selected);
    }
    // Infrastructure failures abort the sweep; a semantic judge failure
    // (verdict fail) does not — the reports still render the evidence.
    if (infra !== 0) return infra;
    if (plan.judges)
        worst = Math.max(worst, await judgeSelected(options, stamp, selected));
    if (plan.reports) {
        renderSummary(options, stamp);
        exportDossier(options, stamp);
    }
    return worst;
}

async function main() {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === "generate") return generateAll(options);
    if (command === "summary") {
        renderSummary(options, resolveExistingStamp(options));
        return 0;
    }
    if (command === "export")
        return exportDossier(options, resolveExistingStamp(options));
    if (command === "describe") {
        if (!options.stamp) usage("describe requires --stamp NAME");
        const selected = select(options);
        return ensureRunDescription(
            options,
            options.stamp,
            selected,
            "describe",
        )
            ? 0
            : 1;
    }
    if (command === "judge") {
        const stamp = resolveExistingStamp(options);
        return judgeSelected(options, stamp, select(options));
    }
    return executeAndReport(
        options,
        planFor(command, options.noJudge),
        options.stamp || stampNow(),
        select(options),
    );
}

main().then(
    (code) => process.exit(code),
    (error) => {
        console.error(error?.stack ?? error);
        process.exit(1);
    },
);
