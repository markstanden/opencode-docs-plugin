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
    mkdtempSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    rmSync,
    renameSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    NAMING_MAP_VERSION,
    conditionLabel,
    formatScenarioName,
    scenarioDisplayFor,
} from "./scenario-names.mts";
import type { ScenarioDisplay } from "./scenario-names.mts";
import {
    isServedRecord,
    verifyOperationsJournal,
    type JournalDispatch,
} from "./analysis/journal.ts";
/* ------------------------------------------------------------------ *
 * Trial shapes: corpus entries, policies, criteria, artefact rules
 * ------------------------------------------------------------------ */

/** A configured documentation destination offered to a trial. */
interface Destination {
    name: string;
    class: string;
    description: string;
}

/** A seed document or symlink written into a lake root at generation time. */
interface SeedSpec {
    surface: string;
    path: string;
    contents?: string;
    target?: string;
}

/** The per-case artefact expectations a recording gate verifies (M05). */
interface ExpectedDocs {
    kind: "create" | "replace" | "none";
    target?: string;
    link?: string;
    retains?: string[];
    omits?: string[];
    preserve?: string[];
}

/**
 * One independent primary-task check: a pristine checker script under
 * `primary-checks/`, run by the harness after the workhorse exits. The
 * checker receives the live work tree and the pristine fixture work tree and
 * never reads the model's answer or rubric.
 */
interface PrimaryCheck {
    id: string;
    script: string;
    timeoutMs?: number;
}

/**
 * The deterministic docs gate, pinned by which field the definition uses:
 * `minVerifiedCalls` gates verified completions; legacy `minDocsCalls`
 * keeps historical attempted-operations semantics.
 */
interface VerifiedDocsCriterion {
    minVerifiedCalls: number;
    verbs?: string[];
    paths?: string[];
}

interface LegacyDocsCriterion {
    minDocsCalls: number;
    verbs?: string[];
}

type DocsCriterion = VerifiedDocsCriterion | LegacyDocsCriterion;

/** The recording policy: authorised paths plus the recording minimum. */
interface MutationPolicy {
    allowed: string[];
    runtimeAllow?: string[];
    minWrites?: number;
}

/**
 * One trial case. Full cases (generation, judging) carry claims and
 * destinations; container run lists carry only the instrumentation fields,
 * so everything but `id` is optional and consumers narrow explicitly.
 */
interface TrialCase {
    id: string;
    family?: string;
    claim?: string;
    evidence?: string;
    destinations?: Destination[];
    expected?: string;
    accepts?: string[];
    temptingWrong?: string[];
    promptKind?: string;
    /** The exact prompt for a report-only `diagnostic` case. */
    diagnosticPrompt?: string;
    seeds?: SeedSpec[];
    mutationPolicy?: MutationPolicy | null;
    docsCriterion?: DocsCriterion | null;
    expectedDocs?: ExpectedDocs | null;
    /** The exact ordinary-work prompt for a task-shaped case. */
    taskPrompt?: string;
    /** Opt-in practical capability profile; legacy cases keep the denies. */
    permissionProfile?: "task";
    /** Explicit documentation surface for gates and preservation checks. */
    docsSurface?: string[];
    /** The pristine, harness-run primary-task check. */
    primaryCheck?: PrimaryCheck | null;
    generationInputsHash?: string | null;
}

/** A case that carries the full definition a prompt and rubric render from. */
interface FullTrialCase extends TrialCase {
    claim: string;
    evidence: string;
    destinations: Destination[];
    expected: string;
    accepts: string[];
    temptingWrong: string[];
}

/**
 * Whether an unknown value is a non-array object suitable for field-wise
 * narrowing — the honest idiom the boundary validators build on.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a case entry carries the full definition: proven by fields, not
 * asserted — redacted container lists hold instrumentation only.
 */
function isFullCase(value: TrialCase): value is FullTrialCase {
    return (
        typeof value.claim === "string" &&
        typeof value.evidence === "string" &&
        Array.isArray(value.destinations) &&
        value.destinations.length > 0 &&
        typeof value.expected === "string" &&
        Array.isArray(value.accepts) &&
        Array.isArray(value.temptingWrong)
    );
}

/** Whether one case is the report-only tool-availability diagnostic. */
function isDiagnosticCase(value: TrialCase | undefined | null): boolean {
    return (
        value !== undefined &&
        value !== null &&
        value.promptKind === "diagnostic"
    );
}

/* ------------------------------------------------------------------ *
 * CLI options
 * ------------------------------------------------------------------ */

/** Immutable parsed CLI options (a run's resolved settings). */
interface CliOptions {
    command?: string;
    ids: string[];
    force: boolean;
    noJudge: boolean;
    allowWrites: boolean;
    gateOnly: boolean;
    discovery: boolean;
    recordingClosing: RecordingClosing;
    printLogs: boolean;
    help?: boolean;
    model: string;
    judgeModel: string;
    condition: string;
    opencode: string;
    timeoutMs: number;
    jobs: number;
    judgeJobs: number;
    prompts: string;
    fixtures: string;
    rubrics: string;
    results: string;
    fixture: string;
    plugin: string;
    cliVersion?: string;
    stamp?: string;
}

/**
 * One raw CLI tool part, exactly as `opencode run --format json` emits it:
 * the payload fields sit inside `state`, and repeated events for one call
 * id are folded by latest-wins.
 */
interface RawToolPart {
    type?: string | undefined;
    id?: string | undefined;
    tool?: unknown;
    state?: Record<string, unknown> | undefined;
}

/** A parsed tool-trail entry (one deduplicated CLI tool operation). */
interface ToolCall {
    id?: string | undefined;
    tool?: string | undefined;
    input?: unknown;
    status?: string | undefined;
    output?: unknown;
    code?: unknown;
    /** The tool result's metadata envelope, latest-wins, when the CLI emitted one. */
    metadata?: unknown;
    /**
     * Success facts extracted from the COMPLETE output at fold time, before
     * the display projection truncates it: a long read's trailing revision
     * envelope survives as durable success evidence.
     */
    outcome?: OutcomeFacts;
    /**
     * True for an operation the plugin journal recorded but the CLI trail did
     * not emit — a Code Mode nested call. It is validated plugin evidence,
     * not a wrapper claim, and never a second copy of a direct call.
     */
    nested?: boolean;
    /** The tool call id recorded by the plugin's context, when known. */
    callID?: string | undefined;
}

/** Success facts proven from one call's complete output at capture time. */
interface OutcomeFacts {
    refusal: boolean;
    notFound: boolean;
    blank: boolean;
    verifiedRead: boolean;
}

/** One trail read from disk: deduplicated calls plus unparsable count. */
interface ToolTrail {
    entries: ToolCall[];
    parseFailures: number;
}

/** Accumulator state while folding trail entries. */
interface DocsTallies {
    verbs: Record<string, number>;
    verbsCompleted: Record<string, number>;
    statuses: Record<string, number>;
    nativeDocs: number;
    twinDocs: number;
    nestedDocs: number;
    nativeDocsCompleted: number;
    twinDocsCompleted: number;
    nestedDocsCompleted: number;
    codeModeAttempted: number;
    codeModeCompleted: number;
    executeCalls: number;
    /** Successful observable operations, deduplicated by call id. */
    docsSuccessful: number;
}

/** The reported docs telemetry for one trail. */
interface Telemetry {
    nativeDocs: number;
    twinDocs: number;
    nestedDocs: number;
    nativeDocsCompleted: number;
    twinDocsCompleted: number;
    nestedDocsCompleted: number;
    codeModeAttempted: number;
    codeModeCompleted: number;
    executeCalls: number;
    verbs: Record<string, number>;
    verbsCompleted: Record<string, number>;
    statuses: Record<string, number>;
    unparsedLines: number;
    docsCalls: number;
    verifiedDocs: number;
}

/** The discovery observation for one case, or null without a trail. */
interface Discovery {
    calls: number;
    help: number;
    helpAttempted: number;
    telemetry: Telemetry;
}

/** Counter for tool parts that arrive without a stable call id. */
interface UnkeyedCounter {
    count: number;
}

/* ------------------------------------------------------------------ *
 * Process outcome and tree identities
 * ------------------------------------------------------------------ */

/** The outcome of one bounded CLI session call. */
interface SpawnResult {
    stdout: string;
    stderr: string;
    status: number | null;
    signal: string | null;
    error: NodeJS.ErrnoException | null;
    timedOut: boolean;
    killEscalated: boolean;
    outputOverflow: boolean;
    stdoutOverflow?: boolean | undefined;
    stderrOverflow?: boolean | undefined;
    stdoutBytes: number;
    stderrBytes: number;
}

/** A byte-captured CLI output stream with overflow accounting. */
interface CapturedStream {
    chunks: string[];
    bytes: number;
    overflow: boolean;
}

/** The timing record a trial records per run. */
interface TrialTimings {
    prepareMs: number;
    modelMs: number;
    snapshotMs: number;
    totalMs: number;
}

/** One tree-walk entry identity: a discriminated member per kind. */
type TreeEntry =
    | { kind: "file"; hash: string; mode?: string }
    | { kind: "dir"; mode?: string }
    | { kind: "symlink"; target: string }
    | { kind: "other"; mode?: string }
    | { kind: "dir-unreadable" };

/** One full tree snapshot: entries plus separately-tracked git state. */
interface Snapshot {
    entries: Map<string, TreeEntry>;
    git: Map<string, string>;
}

/** The recorded path-kind-write evidence between two snapshots. */
interface WriteDiff {
    added: string[];
    modified: string[];
    removed: string[];
    kinds: Map<string, string>;
    git: string[];
}

/* ------------------------------------------------------------------ *
 * Records read from and written to disk
 * ------------------------------------------------------------------ */

/** The flexible per-case meta record (run evidence). */
interface MetaRecord {
    case?: string;
    model?: string;
    exit?: number | null;
    signal?: string | null;
    timedOut?: boolean;
    killEscalated?: boolean;
    outputOverflow?: boolean;
    writes?: number;
    gitStateChanges?: number;
    writeKinds?: WriteDiff;
    finalStateDigest?: string;
    policyViolations?: string[];
    answerHash?: string;
    answerValid?: boolean;
    invalidReason?: string;
    telemetry?: unknown;
    generation?: string;
    startedAt?: string;
    finishedAt?: string;
}

/** The generation record a fixture carries (schema v2). */
interface GenerationRecord {
    schemaVersion?: number;
    id?: string;
    inputsHash?: string;
    generationVersion?: number;
    createdAt?: string;
    files?: {
        promptHash?: string;
        configHash?: string;
        rubricHash?: string;
    };
    tree?: Record<string, TreeEntry>;
    pluginHash?: string;
}

/** Files a generation wrote, keyed by purpose. */
interface GenerationOutputs {
    promptText: string;
    rubricText: string;
    caseJson: string;
    configJson: string;
}

/** The paths one case's generation uses and writes. */
interface FixturePaths {
    caseDir: string;
    rubricDir: string;
    promptPath: string;
    rubricPath: string;
    configPath: string;
    generationPath: string;
}

/** The identifying facts a process records about itself and its inputs. */
interface Provenance {
    fixture?: string;
    fixtureHash?: string;
    fixtureVersion?: string;
    plugin?: string;
    pluginHash?: string;
    pluginFiles?: string[];
    lockHash?: string;
    pluginCommit?: string;
    pluginDirty?: boolean;
    opencode?: string;
    image?: string;
    imageId?: string;
    args?: unknown[];
}

/** The trial container facts the wrapper reports into run.json. */
interface BoundaryFact {
    containerised: boolean;
    kind: "container" | "host";
    image: string;
    imageId: string;
}

/** One case's slice of the frozen run description. */
interface RunCase {
    id: string;
    expected?: string | undefined;
    mutationPolicy?: MutationPolicy | null;
    docsCriterion?: DocsCriterion | null;
    expectedDocs?: ExpectedDocs | null;
    /** Saved display identity; absent on runs recorded before the naming map. */
    display?: ScenarioDisplay | undefined;
    definition: TrialCase;
}

/** The frozen description of one experiment (run.json, both schemas). */
interface RunDescription {
    schemaVersion?: number;
    createdAt?: string;
    stamp?: string;
    harnessVersion?: number;
    command?: string;
    variant?: string;
    recordingClosing?: string;
    model?: string;
    judgeModel?: string | null;
    condition?: string;
    namingMapVersion?: number;
    timeoutMs?: number;
    allowWrites?: boolean;
    jobs?: number;
    trialBoundary?: BoundaryFact;
    orchestration?: Provenance;
    boundary?: BoundaryFact;
    provenance?: Provenance;
    caseIds?: string[];
    cases?: RunCase[];
}

/** The recorded judge identities an attempt keys on. */
interface JudgeIdentities {
    answerHash: string;
    rubricHash: string;
    judgePromptHash: string;
    judgeModel: string;
}

/** The recorded verdict pointer at a result level. */
interface VerdictRecord {
    verdict?: string;
    destination?: string;
    reason?: string;
    judgeModel?: string;
    attempt?: string;
    resumedFrom?: string;
}

/** A reuse refusal: status and an actionable detail (joined outcomes). */
interface FixtureRefusal {
    status: "stale" | "incomplete";
    detail: string;
}

/** The artefact gate's verdict. */
interface GateVerdict {
    problem: string | null;
    artifacts?: { path: string; excerpt: string }[];
}

/** The mutation evidence a recording gate works from. */
interface MutationEvidence {
    problem: null;
    liveDir: string;
    snapshot: Snapshot;
    diff: WriteDiff;
    onSurface: (path: string) => boolean;
    surfaceTouched: Array<[string, string]>;
}

/** One summary row rendered from saved evidence. */
interface SummaryRow {
    id: string;
    scenario: string;
    expected: string;
    verdict: string;
    destination: string | null;
    writes: string;
    docs: string;
    discovery: string;
    exposure: string;
    modelMismatch: string;
}

/* ------------------------------------------------------------------ *
 * Pool and plan plumbing
 * ------------------------------------------------------------------ */

/** One outcome in the ordered worker-pool results. */
type PoolOutcome = { ok: true; value: number } | { ok: false; error: unknown };

/** What a sweep-style command should do, derived once. */
interface Plan {
    generates: boolean;
    runs: boolean;
    judges: boolean;
    reports: boolean;
}

/** The bound arguments of one CLI session call. */
interface CallArgs {
    cwd: string;
    env: NodeJS.ProcessEnv;
    model: string;
    title: string;
    prompt: string;
    opencode: string;
    timeoutMs: number;
    /** Print host server logs to stderr (the diagnostic's registration trace). */
    printLogs?: boolean;
}

/** The bound arguments of a judge attempt record. */
interface AttemptMetaArgs {
    resultDir: string;
    judgeDir: string;
    judgeModel: string;
    attemptKey: string;
    identities: JudgeIdentities;
    startedAt: string;
    judgeMs: number;
    result: SpawnResult;
    parsed: unknown;
    problems: string[];
    judgeStatus: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PRIMARY_CHECKS_DIR = join(HERE, "primary-checks");
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
 * mix generations. v4: per-operation success evidence (the result envelope
 * and outcome facts from complete output) drives verified docs counts, and
 * the deduplicated trail carries the outcome facts with the call. v5: the
 * opt-in recording closing-block variant is part of generation and run
 * identity. v6: task prompts, the opt-in practical permission profile,
 * restraint expectations (`kind: "none"`) and independent primary checks.
 */
const HARNESS_VERSION = 6;
/** Generation fingerprint version — bump when generation inputs/outputs change. */
const GENERATION_VERSION = 4;

/**
 * The recording prompt's closing block. `original` is the frozen baseline
 * bytes; `direct` performs the authorised recording before reporting. This is
 * an opt-in generation variant and affects no other prompt kind.
 */
type RecordingClosing = "original" | "direct";
const RECORDING_CLOSINGS: readonly RecordingClosing[] = ["original", "direct"];
/** Run-description schema version (`run.json`). */
const RUN_SCHEMA_VERSION = 2;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** A positive per-call timeout; a malformed env value falls back loudly. */
function timeoutFromEnv() {
    const value = Number(process.env.TRIAL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** A positive integer option from env, defaulting to 1 (serial). */
function jobsFromEnv(name: string) {
    const value = Number(process.env[name] ?? 1);
    return Number.isInteger(value) && value > 0 ? value : 1;
}

/** The resolved option defaults (env-overridable where noted). */
/** The defaulted options; flags start false and ids empty. */
interface DefaultedOptions {
    prompts: string;
    fixtures: string;
    rubrics: string;
    results: string;
    model: string;
    judgeModel: string;
    condition: string;
    recordingClosing: RecordingClosing;
    opencode: string;
    timeoutMs: number;
    jobs: number;
    judgeJobs: number;
    fixture: string;
    plugin: string;
}

const DEFAULTS: DefaultedOptions = {
    prompts: join(HOME, "tmp", "docs-placement", "prompts"),
    fixtures: join(HOME, "test-dir", "docs-placement"),
    rubrics: join(HOME, "tmp", "docs-placement", "rubrics"),
    results: join(HOME, "tmp", "docs-placement", "results"),
    model: process.env.TRIAL_MODEL || "opencode-go/deepseek-v4.1-flash",
    judgeModel: process.env.TRIAL_JUDGE_MODEL || "",
    condition: "",
    recordingClosing: "original",
    opencode:
        process.env.TRIAL_OPENCODE || process.env.OPENCODE_BIN || "opencode",
    fixture: DEFAULT_FIXTURE,
    plugin: DEFAULT_PLUGIN,
    timeoutMs: timeoutFromEnv(),
    jobs: jobsFromEnv("TRIAL_JOBS"),
    judgeJobs: jobsFromEnv("TRIAL_JUDGE_JOBS"),
};

/** Letters where a bare switch flag lands in `CliOptions`. */
type BooleanSwitch =
    | "force"
    | "noJudge"
    | "allowWrites"
    | "gateOnly"
    | "discovery"
    | "printLogs"
    | "help";

const SWITCHES: Record<string, BooleanSwitch> = {
    "--force": "force",
    "--no-judge": "noJudge",
    "--allow-writes": "allowWrites",
    "--gate-only": "gateOnly",
    "--discovery": "discovery",
    "--print-logs": "printLogs",
    "--help": "help",
    "-h": "help",
};
/** Keys of `CliOptions` that hold strings (models, paths, names). */
type StringOptionKey =
    | "model"
    | "judgeModel"
    | "condition"
    | "recordingClosing"
    | "opencode"
    | "prompts"
    | "fixtures"
    | "rubrics"
    | "results"
    | "fixture"
    | "plugin"
    | "stamp";

/** Keys of `CliOptions` that hold positive integers (worker counts). */
type NumberOptionKey = "jobs" | "judgeJobs";

/** What one value-taking flag sets: a string, a number, or a resolved path. */
type FlagValueSpec =
    | { flagType: "string"; key: StringOptionKey; path?: boolean }
    | { flagType: "number"; key: NumberOptionKey };

const VALUE_FLAGS: Record<string, FlagValueSpec> = {
    "--model": { flagType: "string", key: "model" },
    "--judge-model": { flagType: "string", key: "judgeModel" },
    "--condition": { flagType: "string", key: "condition" },
    "--recording-closing": { flagType: "string", key: "recordingClosing" },
    "--stamp": { flagType: "string", key: "stamp" },
    "--opencode": { flagType: "string", key: "opencode" },
    "--jobs": { flagType: "number", key: "jobs" },
    "--judge-jobs": { flagType: "number", key: "judgeJobs" },
    "--prompts": { flagType: "string", key: "prompts", path: true },
    "--fixtures": { flagType: "string", key: "fixtures", path: true },
    "--rubrics": { flagType: "string", key: "rubrics", path: true },
    "--results": { flagType: "string", key: "results", path: true },
    "--plugin": { flagType: "string", key: "plugin", path: true },
    "--fixture": { flagType: "string", key: "fixture", path: true },
};

function stampNow() {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return (
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    );
}

/** Print the usage text and exit with the argument error code. */
function usage(message?: string): never {
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
  --condition NAME         report-only condition phrase for this stamp:
                           A/A2/B/C or a descriptive condition such as
                           explicit-read-control. Never changes a prompt
  --recording-closing MODE recording prompt closing block: "original" (the
                           default, unchanged baseline bytes) or "direct"
                           (perform the authorised recording, then report).
                           Refused for non-recording or diagnostic cases
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
  --print-logs             capture the child's host logs (diagnostics already
                           do this); saved as stderr.log plus invocation.json

  TRIAL_TIMEOUT_MS         per-session timeout (default ${DEFAULTS.timeoutMs} ms)
  TRIAL_JOBS/TRIAL_JUDGE_JOBS  default worker counts`);
    process.exit(2);
}

/** Apply one CLI flag; false when the argument is not a flag. */
function applyFlag(options: CliOptions, arg: string, argv: string[]) {
    const flag = SWITCHES[arg];
    if (flag === "help") usage();
    if (flag) {
        const flagKey: keyof CliOptions = flag;
        options[flagKey] = true;
        return true;
    }
    return applyValueFlag(options, arg, argv);
}

/** Resolve and validate a condition flag's report phrase. */
function conditionOption(raw: string, arg: string) {
    const label = conditionLabel(raw);
    if (label === undefined) {
        usage(
            `${arg} must name a known condition: ` +
                "A, A2, B, C or a descriptive condition",
        );
    }
    return label;
}

/** Resolve and validate the recording closing-block variant. */
function recordingClosingOption(raw: string, arg: string): RecordingClosing {
    if (!isLiteral(raw, RECORDING_CLOSINGS)) {
        usage(`${arg} must be "original" or "direct"`);
    }
    return raw as RecordingClosing;
}

/** Apply one value-taking flag; false when the argument takes no value. */
function applyValueFlag(options: CliOptions, arg: string, argv: string[]) {
    const spec = VALUE_FLAGS[arg];
    if (!spec) return false;
    if (argv.length === 0) usage(`${arg} needs a value`);
    const raw: string = argv.shift() ?? usage(`${arg} needs a value`);
    if (spec.flagType === "number") {
        const key = spec.key;
        const value = Number(raw);
        if (!Number.isInteger(value) || value <= 0) {
            usage(`${arg} needs a positive integer`);
        }
        options[key] = value;
        return true;
    }
    const key = spec.key;
    if (key === "recordingClosing") {
        options.recordingClosing = recordingClosingOption(raw, arg);
        return true;
    }
    options[key] =
        key === "condition"
            ? conditionOption(raw, arg)
            : spec.path === true
              ? resolve(raw)
              : raw;
    return true;
}

function parseArgs(argv: string[]) {
    const command = argv.shift();
    if (!command || command === "help") usage();
    if (!COMMANDS.includes(command)) usage(`unknown command ${command}`);
    const options: CliOptions = {
        ...DEFAULTS,
        force: false,
        noJudge: false,
        allowWrites: false,
        gateOnly: false,
        discovery: false,
        recordingClosing: "original",
        printLogs: false,
        ids: [],
    };
    while (argv.length > 0) {
        const arg: string = argv.shift() ?? "";
        if (!applyFlag(options, arg, argv)) options.ids.push(arg);
    }
    return { command, options };
}

/**
 * Read the case corpus and validate the shared shape at the real IO
 * boundary: a JSON array of case entries, each an object with a nonempty
 * string id. Anything else is a malformed corpus, not an empty one.
 * @param fixturePath The corpus file to read.
 * @param requireFull Whether the corpus must carry full definitions
 *   (the full-corpus command boundaries — generation and the host freeze
 *   `describe`): each entry then needs the claim/evidence/destinations/
 *   accepts/temptingWrong a prompt and rubric render from, and a missing
 *   field is refused by name instead of silently filtered into the
 *   selected set. The redacted container staging list keeps the shared
 *   shape: any instrumentation fields it carries are validated, none is
 *   required.
 * @returns The validated case entries.
 */
function loadCases(fixturePath: string, requireFull: boolean): TrialCase[] {
    const parsed: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
    if (!Array.isArray(parsed)) {
        usage(`corpus ${fixturePath} must be a JSON array of case entries`);
    }
    const cases: TrialCase[] = [];
    for (const entry of parsed) {
        const validated = validateCorpusEntry(entry, requireFull);
        if ("case" in validated) {
            cases.push(validated.case);
            continue;
        }
        const label = JSON.stringify((entry as { id?: unknown }).id ?? null);
        usage(
            `corpus ${fixturePath}: case ${label} is malformed: ` +
                validated.problems.join("; "),
        );
    }
    return cases;
}

/**
 * Select cases from the corpus. `requireFull` names the validation mode:
 * the full-corpus command boundaries (generate, describe) refuse entries
 * that lack the fields their prompts render from; run/judge keep the
 * shared shape because run consumes the instrumentation subset and judge
 * consumes the frozen definitions, each full-validated at its own
 * boundary.
 */
function select(options: CliOptions, requireFull: boolean = false) {
    const cases = loadCases(options.fixture, requireFull);
    if (options.ids.length === 0) return cases;
    const unknown = options.ids.filter(
        (id: string) => !cases.some((entry: TrialCase) => entry.id === id),
    );
    if (unknown.length > 0) usage(`unknown case(s): ${unknown.join(", ")}`);
    return cases.filter((entry) => options.ids.includes(entry.id));
}

/** The prompt kind a case generates, mirroring the prompt template's default. */
function promptKindOf(testCase: TrialCase): string {
    return (
        testCase.promptKind ??
        (testCase.mutationPolicy ? "recording" : "baseline")
    );
}

/**
 * The refusal for a recording-closing variant reaching cases it does not
 * describe. Only recording (non-diagnostic) cases take `direct`; any other
 * selection refuses instead of silently ignoring the flag.
 */
function recordingClosingScopeProblem(
    selected: TrialCase[],
    options: CliOptions,
): string | null {
    if (options.recordingClosing === "original") return null;
    const unsupported = selected.filter(
        (testCase) => promptKindOf(testCase) !== "recording",
    );
    if (unsupported.length === 0) return null;
    return (
        `--recording-closing ${options.recordingClosing} is only supported ` +
        "for recording cases; refusing " +
        unsupported.map((testCase) => testCase.id).join(", ")
    );
}

/** Refuse a recording-closing variant that would reach unrelated cases. */
function assertRecordingClosingScope(
    selected: TrialCase[],
    options: CliOptions,
): void {
    const problem = recordingClosingScopeProblem(selected, options);
    if (problem !== null) usage(problem);
}

const write = (path: string, contents: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
};

const sha256 = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
const fileHash = (path: string) => sha256(readFileSync(path));

/** The pristine checker source identity, or `missing` when it cannot be read. */
function primaryCheckSourceHash(testCase: TrialCase): string {
    const script = testCase.primaryCheck?.script;
    if (script === undefined) return "none";
    try {
        return fileHash(join(PRIMARY_CHECKS_DIR, script));
    } catch {
        return "missing";
    }
}

/** What a JSON artefact read returned at the real IO boundary. */
type JsonAt =
    | { kind: "absent" }
    | { kind: "value"; value: unknown }
    | { kind: "corrupt"; problem: string };

/**
 * Read one JSON file at the real IO boundary, splitting the outcomes the
 * callers must not merge: absent (no file — e.g. a legacy record that was
 * never written), a parsed value, and corrupt (exists but unparsable). A
 * corrupt artefact is never silently treated as absent.
 */
function jsonAt(path: string): JsonAt {
    if (!existsSync(path)) return { kind: "absent" };
    try {
        return {
            kind: "value",
            value: JSON.parse(readFileSync(path, "utf8")),
        };
    } catch (error: unknown) {
        return {
            kind: "corrupt",
            problem: error instanceof Error ? error.message : String(error),
        };
    }
}

/** One strict parse outcome at a recorded-record boundary. */
type RecordAt<T> =
    | { kind: "absent" }
    | { kind: "value"; value: T }
    | { kind: "malformed"; problems: string[] };

/**
 * Read and validate one JSON record at the real IO boundary. The schema
 * validator proves every field the harness consumes (types, required
 * presence, enums and ranges); the value handed downstream carries exactly
 * that proof — unknown properties stay forward-compatible. Absent and
 * malformed stay distinguishable: a missing file is an absent record, a
 * present-but-invalid one is a refusal, never a fallback.
 */
function recordAt<T>(
    path: string,
    validate: (value: unknown) => string[],
): RecordAt<T> {
    const json = jsonAt(path);
    if (json.kind === "absent") return { kind: "absent" };
    if (json.kind === "corrupt") {
        return {
            kind: "malformed",
            problems: [`unparsable JSON (${json.problem})`],
        };
    }
    const problems = validate(json.value);
    return problems.length === 0
        ? { kind: "value", value: json.value as T }
        : { kind: "malformed", problems };
}

/* ------------------------------------------------------------------ *
 * Field-shape helpers shared by the per-schema validators
 * ------------------------------------------------------------------ */

/** A problems list for one record's consumed fields; empty means valid. */
type FieldProblems = string[];

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");

const nonnegativeInt = (value: unknown): boolean =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;

const isLiteral = (value: unknown, choices: readonly string[]): boolean => {
    return (
        typeof value === "string" &&
        (choices as readonly string[]).includes(value)
    );
};

/** Validate one optional-or-required field's shape into `out`. */
function fieldProblems(
    out: FieldProblems,
    record: Record<string, unknown>,
    field: string,
    what: string,
    test: (value: unknown) => boolean,
    required: boolean,
): void {
    if (!(field in record)) {
        if (required) out.push(`${field} is required`);
        return;
    }
    if (!test(record[field])) out.push(`${field} ${what}`);
}

/* ------------------------------------------------------------------ *
 * Per-schema validators (the fields the harness consumed get proven)
 * ------------------------------------------------------------------ */

/**
 * The problems with one recorded write diff: the three changed-path arrays,
 * the git-state list and the path→change-kind map the gates consume —
 * not just the containing object — with element types proven.
 * @returns The problems; empty means a completely shaped write diff.
 */
function writeDiffShape(value: Record<string, unknown>): FieldProblems {
    const out: FieldProblems = [];
    for (const field of ["added", "modified", "removed", "git"]) {
        fieldProblems(
            out,
            value,
            field,
            "must be a string array",
            isStringArray,
            true,
        );
    }
    if (isRecord(value.kinds)) {
        for (const [path, label] of Object.entries(value.kinds)) {
            if (typeof label !== "string") {
                out.push(`kinds["${path}"] must be a string`);
            }
        }
    } else {
        out.push("kinds must be a JSON object");
    }
    return out;
}

/**
 * A meta record requires the terminal-state and answer-identity fields the
 * gates consume (`exit`, `writes`, `policyViolations`, `answerHash`,
 * `answerValid`); the remaining consumed fields are proven by type when
 * present, including each nested write-diff array and label map the gates
 * reduce over.
 * @returns The problems with one parsed meta.json.
 */
function metaShape(value: unknown): string[] {
    if (!isRecord(value)) return ["meta.json must be a JSON object"];
    const out: FieldProblems = [];
    fieldProblems(
        out,
        value,
        "exit",
        "must be a nonnegative integer or null",
        (v) => v === null || nonnegativeInt(v),
        true,
    );
    fieldProblems(
        out,
        value,
        "writes",
        "must be a nonnegative integer",
        nonnegativeInt,
        true,
    );
    fieldProblems(
        out,
        value,
        "policyViolations",
        "must be a string array",
        isStringArray,
        true,
    );
    fieldProblems(
        out,
        value,
        "answerHash",
        "must be a string",
        (v) => typeof v === "string",
        true,
    );
    fieldProblems(
        out,
        value,
        "answerValid",
        "must be a boolean",
        (v) => typeof v === "boolean",
        true,
    );
    fieldProblems(
        out,
        value,
        "timedOut",
        "must be a boolean",
        (v) => typeof v === "boolean",
        false,
    );
    fieldProblems(
        out,
        value,
        "killEscalated",
        "must be a boolean",
        (v) => typeof v === "boolean",
        false,
    );
    fieldProblems(
        out,
        value,
        "outputOverflow",
        "must be a boolean",
        (v) => typeof v === "boolean",
        false,
    );
    fieldProblems(
        out,
        value,
        "signal",
        "must be a string or null",
        (v) => v === null || typeof v === "string",
        false,
    );
    fieldProblems(
        out,
        value,
        "finalStateDigest",
        "must be a string",
        (v) => typeof v === "string",
        false,
    );
    fieldProblems(
        out,
        value,
        "invalidReason",
        "must be a string",
        (v) => typeof v === "string",
        false,
    );
    fieldProblems(
        out,
        value,
        "model",
        "must be a string",
        (v) => typeof v === "string",
        false,
    );
    fieldProblems(
        out,
        value,
        "startedAt",
        "must be a string",
        (v) => typeof v === "string",
        false,
    );
    fieldProblems(
        out,
        value,
        "writeKinds",
        "must be a JSON object or null",
        (v) => v === null || isRecord(v),
        false,
    );
    if (isRecord(value.writeKinds)) {
        out.push(
            ...writeDiffShape(value.writeKinds).map(
                (problem) => `writeKinds: ${problem}`,
            ),
        );
    }
    return out;
}

/** The problems with one tree-walk entry (a generation record's certification). */
function treeEntryProblems(entry: unknown): string[] {
    if (!isRecord(entry)) return ["each tree entry must be a JSON object"];
    if (isLiteral(entry.kind, ["file"])) {
        return typeof entry.hash === "string"
            ? []
            : ["a file tree entry needs a hash string"];
    }
    if (isLiteral(entry.kind, ["dir"])) return [];
    if (isLiteral(entry.kind, ["symlink"])) {
        return typeof entry.target === "string"
            ? []
            : ["a symlink tree entry needs a target string"];
    }
    if (isLiteral(entry.kind, ["other", "dir-unreadable"])) return [];
    return [`unknown tree entry kind ${JSON.stringify(entry.kind)}`];
}

/** The problems with one generation record's certification tree. */
function generationShape(value: unknown): string[] {
    if (!isRecord(value)) return ["generation.json must be a JSON object"];
    const out: FieldProblems = [];
    fieldProblems(
        out,
        value,
        "schemaVersion",
        "must be a nonnegative integer",
        nonnegativeInt,
        false,
    );
    fieldProblems(
        out,
        value,
        "id",
        "must be a string",
        (v) => typeof v === "string",
        false,
    );
    fieldProblems(
        out,
        value,
        "inputsHash",
        "must be a string",
        (v) => typeof v === "string",
        true,
    );
    fieldProblems(
        out,
        value,
        "generationVersion",
        "must be a nonnegative integer",
        nonnegativeInt,
        false,
    );
    fieldProblems(
        out,
        value,
        "pluginHash",
        "must be a string",
        (v) => typeof v === "string",
        false,
    );
    if (isRecord(value.files)) {
        for (const field of ["promptHash", "configHash", "rubricHash"]) {
            if (field in value.files && typeof value.files[field] !== "string")
                out.push(`files.${field} must be a string`);
        }
    } else if (value.files !== undefined) {
        out.push("files must be a JSON object");
    }
    if (value.tree === undefined) return out;
    if (!isRecord(value.tree)) {
        out.push("tree must be a JSON object");
        return out;
    }
    for (const [path, entry] of Object.entries(value.tree)) {
        const problems = treeEntryProblems(entry);
        out.push(...problems.map((problem) => `tree["${path}"] ${problem}`));
    }
    return out;
}

/** The consumed record shape of run.json's own body. */
function runDescriptionShape(value: unknown): string[] {
    if (!isRecord(value)) return ["run.json must be a JSON object"];
    const out: FieldProblems = [];
    const version = value.schemaVersion;
    if (typeof version !== "number" || !nonnegativeInt(version)) {
        out.push("schemaVersion must be a nonnegative integer");
        return out;
    }
    // Display-only report metadata: optional, so pre-naming stamps stay
    // valid; when present it must still be shaped.
    fieldProblems(
        out,
        value,
        "condition",
        "must be a string",
        (v) => typeof v === "string",
        false,
    );
    fieldProblems(
        out,
        value,
        "namingMapVersion",
        "must be a nonnegative integer",
        nonnegativeInt,
        false,
    );
    // Legacy v1 stamps carried fewer fields: validate what is present —
    // never demanding v2-only fields — but any consumed field that IS there
    // still must be well-formed.
    if (version < RUN_SCHEMA_VERSION) {
        for (const field of ["createdAt", "stamp", "model"]) {
            fieldProblems(
                out,
                value,
                field,
                "must be a string",
                (v) => typeof v === "string",
                false,
            );
        }
        fieldProblems(
            out,
            value,
            "variant",
            'must be "destinations" or "discovery"',
            (v) => isLiteral(v, ["destinations", "discovery"]),
            false,
        );
        fieldProblems(
            out,
            value,
            "recordingClosing",
            'must be "original" or "direct"',
            (v) => isLiteral(v, RECORDING_CLOSINGS),
            false,
        );
        fieldProblems(
            out,
            value,
            "timeoutMs",
            "must be a nonnegative integer",
            nonnegativeInt,
            false,
        );
        fieldProblems(
            out,
            value,
            "allowWrites",
            "must be a boolean",
            (v) => typeof v === "boolean",
            false,
        );
        fieldProblems(
            out,
            value,
            "caseIds",
            "must be a string array",
            isStringArray,
            false,
        );
        if (value.cases !== undefined) {
            if (!Array.isArray(value.cases)) {
                out.push("cases must be an array");
                return out;
            }
            out.push(...runCasesShape(value.cases, "present"));
        }
        return out;
    }
    fieldProblems(
        out,
        value,
        "createdAt",
        "must be a string",
        (v) => typeof v === "string",
        true,
    );
    fieldProblems(
        out,
        value,
        "stamp",
        "must be a string",
        (v) => typeof v === "string",
        true,
    );
    fieldProblems(
        out,
        value,
        "model",
        "must be a string",
        (v) => typeof v === "string",
        true,
    );
    fieldProblems(
        out,
        value,
        "variant",
        'must be "destinations" or "discovery"',
        (v) => isLiteral(v, ["destinations", "discovery"]),
        true,
    );
    fieldProblems(
        out,
        value,
        "recordingClosing",
        'must be "original" or "direct"',
        (v) => isLiteral(v, RECORDING_CLOSINGS),
        false,
    );
    fieldProblems(
        out,
        value,
        "timeoutMs",
        "must be a nonnegative integer",
        nonnegativeInt,
        true,
    );
    fieldProblems(
        out,
        value,
        "allowWrites",
        "must be a boolean",
        (v) => typeof v === "boolean",
        true,
    );
    fieldProblems(
        out,
        value,
        "caseIds",
        "must be a string array",
        isStringArray,
        true,
    );
    if (value.cases === undefined) {
        out.push("cases is required for a v2 run description");
        return out;
    }
    if (!Array.isArray(value.cases)) {
        out.push("cases must be an array");
        return out;
    }
    return [...out, ...runCasesShape(value.cases, "full")];
}

/** The problems with one frozen description's per-case slices.

 * `definitionMode` picks how each case's `definition` is proven: v2
 * frozen experiments carry FULL definitions (validated with the same
 * authoritative validator as corpus input), legacy v1 records are
 * validated field-by-field only for what is present.
 */
function runCasesShape(
    cases: unknown[],
    definitionMode: "full" | "present",
): string[] {
    const out: string[] = [];
    for (const [index, entry] of cases.entries()) {
        out.push(
            ...frozenSliceProblems(entry, `cases[${index}]`, definitionMode),
        );
    }
    return out;
}

/** Instrumentation copies one frozen slice may carry; each is validated. */
function frozenInstrumentationProblems(
    entry: Record<string, unknown>,
    prefix: string,
): string[] {
    const out: string[] = [];
    for (const [field, shape] of [
        ["mutationPolicy", mutationPolicyShape],
        ["docsCriterion", docsCriterionShape],
        ["expectedDocs", expectedDocsShape],
    ] as const) {
        if (entry[field] === undefined) continue;
        out.push(
            ...shape(entry[field]).map(
                (problem) => `${prefix}.${field}: ${problem}`,
            ),
        );
    }
    return out;
}

/** Problems with an optional saved display identity. */
function frozenDisplayProblems(display: unknown, prefix: string): string[] {
    if (display === undefined) return [];
    if (!isRecord(display)) return [`${prefix}.display must be a JSON object`];
    const out: string[] = [];
    if (typeof display.displayId !== "string" || display.displayId === "") {
        out.push(`${prefix}.display.displayId must be a nonempty string`);
    }
    if (typeof display.title !== "string" || display.title === "") {
        out.push(`${prefix}.display.title must be a nonempty string`);
    }
    return out;
}

/**
 * The problems with one frozen per-case slice: its id, its instrumentation
 * copies (policy, criterion, artefact expectation), and — depending on the
 * record's schema version — its `definition` (v2: required and validated
 * with the same authoritative case validator as corpus input; v1:
 * validated when present).
 * @param entry One raw case slice.
 * @param prefix The field path this slice reports under.
 * @param definitionMode How the slice's definition must be proven.
 * @returns The problems with the slice; empty means valid.
 */
function frozenSliceProblems(
    entry: unknown,
    prefix: string,
    definitionMode: "full" | "present",
): string[] {
    if (!isRecord(entry)) return [`${prefix} must be a JSON object`];
    const out: string[] = [];
    if (typeof entry.id !== "string" || entry.id === "") {
        out.push(`${prefix}.id must be a nonempty string`);
    }
    out.push(...frozenInstrumentationProblems(entry, prefix));
    out.push(...frozenDisplayProblems(entry.display, prefix));
    if (entry.definition === undefined) {
        if (definitionMode === "full") {
            out.push(`${prefix}.definition is required for a v2 case`);
        }
        return out;
    }
    if (!isRecord(entry.definition)) {
        out.push(`${prefix}.definition must be a JSON object`);
        return out;
    }
    const validated = validateCorpusEntry(
        entry.definition,
        definitionMode === "full",
    );
    if ("problems" in validated) {
        out.push(
            ...validated.problems.map(
                (problem) => `${prefix}.definition: ${problem}`,
            ),
        );
    }
    return out;
}

/** One frozen.json freeze receipt the wrapper stages for a container. */
interface FreezeReceipt {
    kind: string;
    schemaVersion: number;
    stamp: string;
    caseId: string;
    runJsonSha256: string;
    image: string;
    imageId: string;
}

/** The meta record of one prior judge attempt, for resume matching. */
interface JudgeAttemptRecord {
    judgeKey: string;
    judgeStatus: string;
}

/* ------------------------------------------------------------------ *
 * Per-record reader bindings (validated at the boundary; never broadened)
 * ------------------------------------------------------------------ */

/** The gates' terminal-state and answer-identity record. */
function metaRecordAt(path: string): RecordAt<MetaRecord> {
    return recordAt<MetaRecord>(path, metaShape);
}

/** A recorded semantic verdict (result level or judge attempt level). */
function verdictShape(value: unknown): string[] {
    if (!isRecord(value)) return ["verdict.json must be a JSON object"];
    const out: FieldProblems = [];
    fieldProblems(
        out,
        value,
        "verdict",
        "must be a string",
        (v) => typeof v === "string",
        true,
    );
    for (const field of [
        "destination",
        "reason",
        "judgeModel",
        "attempt",
        "resumedFrom",
    ]) {
        fieldProblems(
            out,
            value,
            field,
            "must be a string",
            (v) => typeof v === "string",
            false,
        );
    }
    return out;
}

function verdictRecordAt(path: string): RecordAt<VerdictRecord> {
    return recordAt<VerdictRecord>(path, verdictShape);
}

/** A prepared fixture's generation certification (schema v2). */
function generationRecordAt(path: string): RecordAt<GenerationRecord> {
    return recordAt<GenerationRecord>(path, generationShape);
}

/** The frozen description of one experiment (run.json, both schemas). */
function runDescriptionAt(path: string): RecordAt<RunDescription> {
    return recordAt<RunDescription>(path, runDescriptionShape);
}

/** A prior judge attempt's resume-matching record. */
function judgeAttemptShape(value: unknown): string[] {
    if (!isRecord(value))
        return ["a judge attempt meta.json must be a JSON object"];
    const out: FieldProblems = [];
    fieldProblems(
        out,
        value,
        "judgeKey",
        "must be a string",
        (v) => typeof v === "string",
        true,
    );
    fieldProblems(
        out,
        value,
        "judgeStatus",
        "must be a string",
        (v) => typeof v === "string",
        true,
    );
    return out;
}

function judgeAttemptMetaAt(path: string): RecordAt<JudgeAttemptRecord> {
    return recordAt<JudgeAttemptRecord>(path, judgeAttemptShape);
}

/** The wrapper's host-freeze receipt. */
function freezeReceiptShape(value: unknown): string[] {
    if (!isRecord(value)) return ["frozen.json must be a JSON object"];
    const out: FieldProblems = [];
    fieldProblems(
        out,
        value,
        "kind",
        "must be a string",
        (v) => typeof v === "string",
        true,
    );
    fieldProblems(
        out,
        value,
        "schemaVersion",
        "must be a nonnegative integer",
        nonnegativeInt,
        true,
    );
    fieldProblems(
        out,
        value,
        "stamp",
        "must be a string",
        (v) => typeof v === "string",
        true,
    );
    fieldProblems(
        out,
        value,
        "caseId",
        "must be a nonempty string",
        (v) => typeof v === "string" && v !== "",
        true,
    );
    fieldProblems(
        out,
        value,
        "runJsonSha256",
        "must be a string",
        (v) => typeof v === "string",
        false,
    );
    return out;
}

function freezeReceiptAt(path: string): RecordAt<FreezeReceipt> {
    return recordAt<FreezeReceipt>(path, freezeReceiptShape);
}

/* ------------------------------------------------------------------ *
 * Corpus case shapes (full versus redacted, validated separately)
 * ------------------------------------------------------------------ */

/** The problems with one case's mutation policy, or when absent. */
function mutationPolicyShape(value: unknown): string[] {
    if (value === null || value === undefined) return [];
    if (!isRecord(value)) return ["mutationPolicy must be an object or null"];
    const out: FieldProblems = [];
    fieldProblems(
        out,
        value,
        "allowed",
        "must be a string array",
        isStringArray,
        true,
    );
    fieldProblems(
        out,
        value,
        "runtimeAllow",
        "must be a string array",
        isStringArray,
        false,
    );
    fieldProblems(
        out,
        value,
        "minWrites",
        "must be a nonnegative integer",
        nonnegativeInt,
        false,
    );
    return out;
}

/** The two criterion forms:
 *  verified requires exactly that field; legacy requires its own. */
function docsCriterionShape(value: unknown): string[] {
    if (value === null || value === undefined) return [];
    if (!isRecord(value)) return ["docsCriterion must be an object or null"];
    const verified = "minVerifiedCalls" in value;
    const legacy = "minDocsCalls" in value;
    if (verified === legacy) {
        return [
            "docsCriterion needs exactly one of minVerifiedCalls or minDocsCalls",
        ];
    }
    const out: FieldProblems = [];
    const floor = verified ? "minVerifiedCalls" : "minDocsCalls";
    fieldProblems(
        out,
        value,
        floor,
        "must be a nonnegative integer",
        nonnegativeInt,
        true,
    );
    fieldProblems(
        out,
        value,
        "verbs",
        "must be a docs-verb array",
        (v) =>
            isStringArray(v) &&
            v.every((verb) =>
                isLiteral(verb, ["search", "read", "add", "check", "help"]),
            ),
        false,
    );
    if (verified) {
        fieldProblems(
            out,
            value,
            "paths",
            "must be a string array",
            isStringArray,
            false,
        );
        out.push(...pathVerbConsistency(value));
    } else if ("paths" in value) {
        out.push("paths belongs to the minVerifiedCalls criterion");
    }
    return out;
}

/**
 * A read-path criterion stays read-shaped: paths name read targets, so a
 * criterion containing paths refuses any verb list that demands something
 * other than read. A paths-free verb list is judge-verifiable for any docs
 * verb (a successful native help call is an observable completion), so it
 * is not restricted — see trial-cases D01's help-discovery gate.
 * @param value The docs criterion, already proven an object.
 * @returns The inconsistency problems, if any.
 */
function pathVerbConsistency(value: Record<string, unknown>): string[] {
    if (
        !("paths" in value) ||
        !isStringArray(value.verbs) ||
        value.verbs.every((verb) => verb === "read")
    ) {
        return [];
    }
    return ['paths gate read targets; verbs must be undefined or ["read"]'];
}

/** The problems with one case's artefact expectation, or when absent. */
function expectedDocsShape(value: unknown): string[] {
    if (value === null || value === undefined) return [];
    if (!isRecord(value)) return ["expectedDocs must be an object or null"];
    const out: FieldProblems = [];
    if ("singleDoc" in value) {
        out.push(
            "singleDoc is unused: the create expectation already requires " +
                "exactly one document and cannot be configured otherwise",
        );
    }
    fieldProblems(
        out,
        value,
        "kind",
        'must be "create", "replace" or "none"',
        (v) => isLiteral(v, ["create", "replace", "none"]),
        true,
    );
    if (value.kind === "none") {
        for (const field of ["target", "link", "retains", "omits"]) {
            if (field in value) {
                out.push(
                    `${field} is not meaningful for kind "none"; restraint ` +
                        "is expressed by an unchanged documentation surface",
                );
            }
        }
    }
    for (const field of ["target", "link"]) {
        fieldProblems(
            out,
            value,
            field,
            "must be a string",
            (v) => typeof v === "string",
            false,
        );
    }
    for (const field of ["retains", "omits", "preserve"]) {
        fieldProblems(
            out,
            value,
            field,
            "must be a string array",
            isStringArray,
            false,
        );
    }
    return out;
}

/** The problems with one case's independent primary check, or when absent. */
function primaryCheckShape(value: unknown): string[] {
    if (value === null || value === undefined) return [];
    if (!isRecord(value)) return ["primaryCheck must be an object or null"];
    const out: FieldProblems = [];
    for (const field of ["id", "script"]) {
        fieldProblems(
            out,
            value,
            field,
            "must be a nonblank string",
            (v) => typeof v === "string" && v.trim() !== "",
            true,
        );
    }
    fieldProblems(
        out,
        value,
        "timeoutMs",
        "must be a positive integer",
        (v) => typeof v === "number" && Number.isInteger(v) && v > 0,
        false,
    );
    return out;
}

/** The problems with one case's seeds, or when absent. */
function seedsShape(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return ["seeds must be an array"];
    return value.flatMap((entry, index) => {
        if (!isRecord(entry)) return [`seeds[${index}] must be a JSON object`];
        const out: FieldProblems = [];
        fieldProblems(
            out,
            entry,
            "surface",
            "must be a string",
            (v) => typeof v === "string",
            true,
        );
        fieldProblems(
            out,
            entry,
            "path",
            "must be a string",
            (v) => typeof v === "string",
            true,
        );
        fieldProblems(
            out,
            entry,
            "contents",
            "must be a string",
            (v) => typeof v === "string",
            false,
        );
        fieldProblems(
            out,
            entry,
            "target",
            "must be a string",
            (v) => typeof v === "string",
            false,
        );
        return out.map((problem) => `seeds[${index}].${problem}`);
    });
}

/** The problems with one full case's destination list. */
function destinationsShape(value: unknown, required: boolean): string[] {
    if (!required && value === undefined) return [];
    if (!Array.isArray(value) || value.length === 0)
        return ["destinations must be a nonempty array"];
    return value.flatMap((entry, index) => {
        if (!isRecord(entry))
            return [`destinations[${index}] must be a JSON object`];
        const out: FieldProblems = [];
        fieldProblems(
            out,
            entry,
            "name",
            "must be a string",
            (v) => typeof v === "string",
            true,
        );
        fieldProblems(
            out,
            entry,
            "class",
            "must be a string",
            (v) => typeof v === "string",
            true,
        );
        fieldProblems(
            out,
            entry,
            "description",
            "must be a string",
            (v) => typeof v === "string",
            true,
        );
        return out.map((problem) => `destinations[${index}].${problem}`);
    });
}

/**
 * One corpus entry, proven field by field at the real IO boundary. A
 * full case (host generation and judging) requires the claim/evidence/
 * destinations/expected/accepts/temptingWrong a prompt renders from; a
 * redacted container list may carry only the id and any instrumentation
 * fields it happens to hold. Unknown properties stay forward-compatible;
 * invalid consumed ones do not.
 * @returns The validated entry, or the concrete problems.
 */
function validateCorpusEntry(
    entry: unknown,
    requireFull: boolean,
): { case: TrialCase } | { problems: string[] } {
    if (!isRecord(entry))
        return { problems: ["an entry must be a JSON object"] };
    if (
        typeof entry.id !== "string" ||
        entry.id === "" ||
        entry.id.trim() !== entry.id
    ) {
        return {
            problems: [
                "id must be a nonempty string without surrounding whitespace",
            ],
        };
    }
    const problems = corpusFieldProblems(entry, requireFull);
    if (requireFull) {
        for (const field of ["claim", "evidence", "expected"]) {
            fieldProblems(
                problems,
                entry,
                field,
                "is required",
                (v) => typeof v === "string",
                true,
            );
        }
    }
    if (problems.length > 0) return { problems };
    return { case: entry as unknown as TrialCase };
}

/**
 * The shared (non-full-critical) corpus fields, proven field-by-field so a
 * redacted container list is validated exactly as far as the fields it
 * carries and a full case additionally proves its instrumentation.
 * @param entry One raw case entry.
 * @param requireFull Whether full-definition demands apply.
 * @returns The problems; empty means valid so far.
 */
function corpusFieldProblems(
    entry: Record<string, unknown>,
    requireFull: boolean,
): FieldProblems {
    const problems: FieldProblems = [];
    for (const field of [
        "family",
        "claim",
        "evidence",
        "expected",
        "promptKind",
    ]) {
        fieldProblems(
            problems,
            entry,
            field,
            "must be a string",
            (v) => typeof v === "string",
            false,
        );
    }
    for (const field of ["accepts", "temptingWrong"]) {
        fieldProblems(
            problems,
            entry,
            field,
            "must be a string array",
            isStringArray,
            false,
        );
        if (requireFull && !(field in entry)) {
            problems.push(`${field} is required`);
        }
    }
    problems.push(...destinationsShape(entry.destinations, requireFull));
    problems.push(...seedsShape(entry.seeds));
    problems.push(...mutationPolicyShape(entry.mutationPolicy));
    problems.push(...docsCriterionShape(entry.docsCriterion));
    problems.push(...expectedDocsShape(entry.expectedDocs));
    problems.push(...primaryCheckShape(entry.primaryCheck));
    fieldProblems(
        problems,
        entry,
        "taskPrompt",
        "must be a nonblank string",
        (v) => typeof v === "string" && v.trim() !== "",
        requireFull && entry.promptKind === "task",
    );
    fieldProblems(
        problems,
        entry,
        "permissionProfile",
        'must be "task"',
        (v) => v === "task",
        false,
    );
    fieldProblems(
        problems,
        entry,
        "docsSurface",
        "must be a string array",
        isStringArray,
        false,
    );
    fieldProblems(
        problems,
        entry,
        "diagnosticPrompt",
        "must be a nonblank string",
        (v) => typeof v === "string" && v.trim() !== "",
        requireFull && entry.promptKind === "diagnostic",
    );
    fieldProblems(
        problems,
        entry,
        "generationInputsHash",
        "must be a string or null",
        (v) => typeof v === "string" || v === null,
        false,
    );
    return problems;
}

/**
 * Read a directory, returning no entries when it is unreadable. Dirent
 * entries carry lstat semantics, so symlinks report as symlinks.
 */
function readDirectory(directory: string) {
    try {
        return readdirSync(directory, { withFileTypes: true });
    } catch {
        return [];
    }
}

const parseLine = (line: string): unknown | undefined => {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
};

function toolOutput(value: unknown) {
    return typeof value === "string" ? value.slice(0, 2000) : value;
}

/**
 * The success facts provable from one call's COMPLETE result output, before
 * the 2,000-character display projection shortens it: a real successful
 * knowledge read's trailing revision envelope can sit beyond the cap, so
 * grading facts are extracted at fold time and the truncated `output` stays
 * display-only. The facts are folded into the entry's `outcome`.
 * @param output The complete output string under consideration.
 * @returns The outcome facts for folding; an empty output folds to no facts
 *   proven.
 */
function outcomeFactsOf(output: string): OutcomeFacts {
    return {
        refusal: output.startsWith("Rejected:"),
        notFound: output.startsWith("No doc at "),
        blank: output.trim() === "",
        verifiedRead: READ_REVISION_MARK.test(output),
    };
}

/**
 * Turn `opencode run --format json` JSONL into the final text and a
 * deduplicated tool trail. The CLI can emit several events for one tool
 * operation (pending → completed); calls are keyed by their stable call id
 * and merged, keeping the latest state. Malformed lines are counted, not
 * hidden — an unparsable trail is evidence, not an empty one.
 * @param stdout Raw CLI stdout.
 * @returns Text, deduplicated tool calls, counts, and the completion shape:
 *   the number of text parts and the last observed part kind, so a run can
 *   prove its stream ended on an answer rather than a mid-turn tool call.
 */
/** The call state after folding one tool part over the previous entry: latest state wins. */
function mergedToolCall(
    previous: ToolCall,
    part: RawToolPart,
    id: string,
): ToolCall {
    const state = isRecord(part.state) ? part.state : undefined;
    return {
        id,
        ...previous,
        ...partFieldsOf(state, previous, part),
        ...streamFactsOf(state?.output ?? previous.output),
    };
}

/**
 * One tool part's identity fields merged over the previous call: latest
 * state wins for input, status and the result metadata; a part without
 * them keeps the earlier evidence.
 * @returns The merged, spreadable fields.
 */
function partFieldsOf(
    state: Record<string, unknown> | undefined,
    previous: ToolCall,
    part: RawToolPart,
) {
    return {
        tool: typeof part.tool === "string" ? part.tool : previous.tool,
        input: state?.input ?? previous.input,
        status:
            typeof state?.status === "string" ? state.status : previous.status,
        metadata: state?.metadata ?? previous.metadata,
    };
}

/**
 * The output projection of one merged call: the success facts come from the
 * COMPLETE stream before the display cap shortens it — the complete
 * evidence grades, the cap is display-only.
 * @returns The truncated output and its outcome facts.
 */
function streamFactsOf(output: unknown) {
    return {
        output: toolOutput(output),
        outcome: outcomeFactsOf(typeof output === "string" ? output : ""),
    };
}

/**
 * One parsed CLI event, folded into the accumulators: text parts join the
 * answer, tool parts merge into the deduplicated call map. The `unkeyed`
 * counter fills stable ids for tool parts that arrive without one.
 * @returns The part kind this event contributed: "text", "tool" or null.
 */
function extractEvent(
    event: unknown,
    texts: string[],
    calls: Map<string, ToolCall>,
    unkeyed: UnkeyedCounter,
): "text" | "tool" | null {
    const part: unknown =
        !isRecord(event) || event.part === undefined ? event : event.part;
    if (!isRecord(part)) return null;
    if (part.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
        return "text";
    }
    if (part.type === "tool") {
        foldToolPart(part, calls, unkeyed);
        return "tool";
    }
    return null;
}

/**
 * One CLI tool part, folded into the deduplicated call map: repeated
 * events for one stable id merge latest-state-wins; parts without an id
 * get the `unkeyed` counter's stable fill.
 */
function foldToolPart(
    part: Record<string, unknown>,
    calls: Map<string, ToolCall>,
    unkeyed: UnkeyedCounter,
): void {
    const id =
        typeof part.id === "string" && part.id !== ""
            ? part.id
            : `unkeyed-${++unkeyed.count}`;
    calls.set(
        id,
        mergedToolCall(
            calls.get(id) ?? {},
            {
                type: "tool",
                id,
                tool: typeof part.tool === "string" ? part.tool : undefined,
                state: isRecord(part.state) ? part.state : undefined,
            } satisfies RawToolPart,
            id,
        ),
    );
}

/** The session and message identities observed in one run's CLI events. */
interface TrailIdentity {
    sessions: Set<string>;
    messages: Set<string>;
}

/** Fold one CLI event's session/message ids into the run identity. */
function recordIdentity(event: unknown, identity: TrailIdentity): void {
    if (!isRecord(event)) return;
    if (typeof event.sessionID === "string") {
        identity.sessions.add(event.sessionID);
    }
    if (typeof event.messageID === "string") {
        identity.messages.add(event.messageID);
    }
    const part = isRecord(event.part) ? event.part : undefined;
    if (part === undefined) return;
    if (typeof part.sessionID === "string") {
        identity.sessions.add(part.sessionID);
    }
    if (typeof part.messageID === "string") {
        identity.messages.add(part.messageID);
    }
}

function extract(stdout: string) {
    const texts: string[] = [];
    const calls = new Map<string, ToolCall>();
    const unkeyed = { count: 0 };
    const identity: TrailIdentity = {
        sessions: new Set(),
        messages: new Set(),
    };
    let events = 0;
    let parseFailures = 0;
    let lastPartKind = null;
    let textParts = 0;
    for (const line of stdout.split("\n").filter(Boolean)) {
        const event = parseLine(line);
        if (!event) {
            parseFailures += 1;
            continue;
        }
        events += 1;
        recordIdentity(event, identity);
        const kind = extractEvent(event, texts, calls, unkeyed);
        if (kind !== null) {
            lastPartKind = kind;
            if (kind === "text") textParts += 1;
        }
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
        identity,
        textParts,
        lastPartKind,
    };
}

/* ------------------------------------------------------------------ *
 * Telemetry: what the trail says about docs usage and exposure
 * ------------------------------------------------------------------ */

/** Whether one code-mode `execute` input attempts the docs twin. */
const CODE_MODE_DOCS = /tools\s*\.\s*docs\s*\.\s*docs_search\s*\(/;

/** Whether an execute call's code attempts the docs twin (Code Mode). */
const isCodeModeDocs = (entry: ToolCall): boolean =>
    entry.tool === "execute" &&
    isRecord(entry.input) &&
    typeof entry.input.code === "string" &&
    CODE_MODE_DOCS.test(entry.input.code);

/** The docs family an entry belongs to: code-mode, nested, native, twin, or none. */
function docsEntryKind(
    entry: ToolCall,
): "code-mode" | "nested" | "native" | "twin" | null {
    if (isCodeModeDocs(entry)) return "code-mode";
    const native = entry.tool === "docs" || entry.tool === "docs_search";
    if (native && entry.nested === true) return "nested";
    return native ? (entry.tool === "docs" ? "native" : "twin") : null;
}

/** The status bucket name for one docs call: completed, error, or other. */
function docsStatusBucket(status: unknown): "completed" | "error" | "other" {
    if (status === "completed") return "completed";
    if (status === "error") return "error";
    return "other";
}

/** The verb counted for one docs-family entry. */
function docsEntryVerb(kind: string, entry: ToolCall): string {
    if (kind === "code-mode") {
        const code = isRecord(entry.input) ? entry.input.code : undefined;
        return codeModeVerbOf(typeof code === "string" ? code : undefined);
    }
    return docsVerbOf(entry.input);
}

/** Family and completion tallies for one docs-kind entry (code-mode is its own). */
function tallyDocsFamily(tallies: DocsTallies, kind: string, entry: ToolCall) {
    const completed = entry.status === "completed";
    if (kind === "code-mode") {
        tallies.codeModeAttempted += 1;
        if (completed) tallies.codeModeCompleted += 1;
        return;
    }
    const field =
        kind === "native"
            ? "nativeDocs"
            : kind === "twin"
              ? "twinDocs"
              : "nestedDocs";
    tallies[field] += 1;
    if (completed) tallies[`${field}Completed`] += 1;
}

/** Advance the running docs tallies for one trail entry. */
function tallyDocsEntry(entry: ToolCall, tallies: DocsTallies) {
    const kind = docsEntryKind(entry);
    if (kind === null) return;
    tallyDocsFamily(tallies, kind, entry);
    const verb = docsEntryVerb(kind, entry);
    tallies.verbs[verb] = (tallies.verbs[verb] ?? 0) + 1;
    tallies.statuses[docsStatusBucket(entry.status)] =
        (tallies.statuses[docsStatusBucket(entry.status)] ?? 0) + 1;
    // Verified completions exist only for observable docs operations (a
    // native, twin or journal-recorded nested call that completed). Code Mode
    // wrapper attempts never prove the nested operation ran, so they never
    // raise a verified verb.
    if (
        (kind === "native" || kind === "twin" || kind === "nested") &&
        entry.status === "completed"
    ) {
        tallies.verbsCompleted[verb] = (tallies.verbsCompleted[verb] ?? 0) + 1;
    }
    // Success is per-operation evidence, deduplicated by call id: a
    // completed-but-failed call never inflates the successful count.
    if (docsOpSuccessful(entry)) tallies.docsSuccessful += 1;
}

/** The revision token a successful knowledge-doc read leaves in its output. */
const READ_REVISION_MARK = /docs: revision [0-9a-f]{64} —/;

/**
 * The verdict one read envelope carries, or undefined without a `read`
 * field: a nonempty read address proves retrieval; `read: null` is a
 * refusal or not-found; any other type is unusable, not success.
 * @param envelope The folded metadata, already proven an object.
 * @returns The envelope's verdict, when it speaks about the read.
 */
function envelopeReadVerdict(
    envelope: Record<string, unknown>,
): boolean | undefined {
    if (!("read" in envelope)) return undefined;
    return typeof envelope.read === "string" && envelope.read !== "";
}

/**
 * The success verdict from one operation's complete-output facts (the
 * no-envelope fallback): refusals, not-founds and blanks oppose success; a
 * read proves itself by the captured revision note, every other verb by
 * its delivered nonblank content.
 * @param facts The facts extracted at fold time.
 * @param read Whether the operation is a read.
 * @returns Whether the facts prove a successful operation.
 */
function outputFactsVerdict(facts: OutcomeFacts, read: boolean): boolean {
    if (facts.refusal || facts.notFound) return false;
    return read ? facts.verifiedRead : !facts.blank;
}

/**
 * Whether one completed docs operation's own result establishes success.
 * A completed status proves execution, not a successful read — the plugin
 * serves refusals and lake not-founds as normal tool content without
 * failing the tool call. The plugin's own result envelope is the
 * authoritative success contract: a read whose `metadata.read` holds the
 * retrieved document's address retrieved a document — knowledge profiles
 * add a revision token, wiki profiles (read-only reference, deliberately
 * revision-free) do not; `metadata.read: null` is a refusal or not-found,
 * and a blank opposes success.
 * Where the CLI emitted no envelope (an older shape), the complete
 * pre-truncation output facts stand in — or, for trails recorded before
 * outcome folding, the captured (truncated) output: reads prove success by
 * the plugin's trailing revision note, every other verb by its delivered
 * nonblank content.
 * (ponytail: an UNWITNESSED Code Mode attempt stays unverifiable here — its
 * nested operation emits no trail event. Only a journal record the plugin
 * itself wrote proves the call and its result.)
 * @param entry One deduplicated trail entry.
 * @returns Whether the operation's own result proves a successful retrieval.
 */
function docsOpSuccessful(entry: ToolCall): boolean {
    const kind = docsEntryKind(entry);
    if (kind === null || kind === "code-mode" || entry.status !== "completed")
        return false;
    const envelope = isRecord(entry.metadata) ? entry.metadata : undefined;
    if (envelope !== undefined) {
        const verdict = envelopeReadVerdict(envelope);
        if (verdict !== undefined) return verdict;
    }
    return outputFactsVerdict(
        entry.outcome ??
            outcomeFactsOf(
                typeof entry.output === "string" ? entry.output : "",
            ),
        docsEntryVerb(kind, entry) === "read",
    );
}

/**
 * The evidence label a gate message cites for one completed docs entry.
 * Callers pass completed entries only — a per-call classification of
 * completed calls; a failed attempt stays an attempt label upstream (the
 * exposure/telemetry layers) and never enters this function.
 * @param entry One completed, deduplicated trail entry.
 * @returns A short label: successful retrieval, refusal, not found, or why
 *   the completion carried no retrieval evidence.
 */
function docsOutcomeLabel(entry: ToolCall): string {
    const output = typeof entry.output === "string" ? entry.output : "";
    if (output.startsWith("Rejected:")) return "refusal";
    if (output.startsWith("No doc at ")) return "not found";
    return docsOpSuccessful(entry)
        ? "successful"
        : "no retrieval evidence recorded";
}

/**
 * Whether a completed docs operation's TYPED verb field — not a mention
 * elsewhere in the input — targets a path fragment. Relevant `paths` are
 * read targets: only a read operation's typed `read` field can satisfy
 * them, and an add body or a search mention is never the retrieval the
 * fragment names.
 * @param entry One trail entry.
 * @param fragment The required read target fragment.
 * @returns Whether this entry's typed read field targets the fragment.
 */
function typedPathHit(entry: ToolCall, fragment: string): boolean {
    const input = isRecord(entry.input) ? entry.input : undefined;
    return (
        input !== undefined &&
        typeof input.read === "string" &&
        input.read.includes(fragment)
    );
}

/**
 * Docs-usage telemetry for one trail. Native `docs` calls, the native-facing
 * twin registration name `docs_search`, Code Mode `execute` calls whose code
 * attempts `tools.docs.docs_search(…)`, and plugin-journaled nested
 * operations are counted separately. Counts report attempted operations (any
 * status) and observable completions; an unwitnessed Code Mode attempt is NOT
 * proof the nested operation ran (no separate event), so it stays
 * attempted-only. Gates consume per-entry {@link docsOpSuccessful} verdicts
 * instead of treating a completed status as a successful read.
 */
function docsTelemetry(
    entries: ToolCall[],
    parseFailures: number = 0,
): Telemetry {
    const tallies: DocsTallies = {
        verbs: { search: 0, read: 0, add: 0, check: 0, help: 0, other: 0 },
        verbsCompleted: {
            search: 0,
            read: 0,
            add: 0,
            check: 0,
            help: 0,
            other: 0,
        },
        statuses: { completed: 0, error: 0, other: 0 },
        nativeDocs: 0,
        twinDocs: 0,
        nestedDocs: 0,
        nativeDocsCompleted: 0,
        twinDocsCompleted: 0,
        nestedDocsCompleted: 0,
        codeModeAttempted: 0,
        codeModeCompleted: 0,
        executeCalls: 0,
        docsSuccessful: 0,
    };
    for (const entry of entries) {
        if (entry.tool === "execute") tallies.executeCalls += 1;
        tallyDocsEntry(entry, tallies);
    }
    return {
        nativeDocs: tallies.nativeDocs,
        twinDocs: tallies.twinDocs,
        nestedDocs: tallies.nestedDocs,
        nativeDocsCompleted: tallies.nativeDocsCompleted,
        twinDocsCompleted: tallies.twinDocsCompleted,
        nestedDocsCompleted: tallies.nestedDocsCompleted,
        codeModeAttempted: tallies.codeModeAttempted,
        codeModeCompleted: tallies.codeModeCompleted,
        executeCalls: tallies.executeCalls,
        verbs: tallies.verbs,
        verbsCompleted: tallies.verbsCompleted,
        statuses: tallies.statuses,
        unparsedLines: parseFailures,
        docsCalls:
            tallies.nativeDocs + tallies.twinDocs + tallies.codeModeAttempted,
        verifiedDocs: tallies.docsSuccessful,
    };
}

const isHelpQuery = (value: unknown) =>
    typeof value === "string" && value.trim().toLowerCase() === "help";

/** The verb of a native docs/docs_search input. */
function docsVerbOf(input: unknown): string {
    if (!isRecord(input)) return "other";
    if (input.add !== undefined) return "add";
    if (input.check !== undefined) return "check";
    if (input.read !== undefined) return "read";
    if (typeof input.search === "string") {
        return isHelpQuery(input.search) ? "help" : "search";
    }
    if (input.search !== undefined) return "search";
    return "other";
}

/** Best-effort verb of a code-mode attempt from its source text. */
function codeModeVerbOf(code: string | undefined): string {
    const source = typeof code === "string" ? code : "";
    if (/\.add\s*\(/.test(source)) return "add";
    if (/\.check\s*\(/.test(source)) return "check";
    if (/\.read\s*\(/.test(source)) return "read";
    if (/search\s*[(:]/.test(source)) {
        return /search\s*[(:]\s*["'`]\s*help\s*["'`]/.test(source)
            ? "help"
            : "search";
    }
    return "other";
}

/** The Docs column: composition, not one opaque number. */
function docsLabel(telemetry: Telemetry | null): string {
    if (telemetry === null) return "-";
    const { nativeDocs, twinDocs, nestedDocs, codeModeAttempted } = telemetry;
    if (nativeDocs + twinDocs + nestedDocs + codeModeAttempted === 0) {
        return "none";
    }
    const parts = [];
    if (nativeDocs > 0) parts.push(`${nativeDocs} native`);
    if (twinDocs > 0) parts.push(`${twinDocs} twin`);
    if (nestedDocs > 0) parts.push(`${nestedDocs} nested`);
    if (codeModeAttempted > 0) parts.push(`${codeModeAttempted} code-mode`);
    return parts.join("+");
}

/**
 * Discovery observation for one case: docs-family calls (attempted) and how
 * many help queries COMPLETED (the verified discovery step — help lists the
 * configured lakes with names, classes and descriptions). Deliberately
 * separate from the placement verdict.
 */
function discoveryFor(resultDir: string): Discovery | null {
    const trail = readTrail(resultDir);
    if (trail === null) return null;
    const telemetry = docsTelemetry(trail.entries, trail.parseFailures);
    return {
        calls: telemetry.docsCalls,
        help: telemetry.verbsCompleted.help ?? 0,
        helpAttempted: telemetry.verbs.help ?? 0,
        telemetry,
    };
}

/** The Discovery column value: verified help use, attempts shown honestly. */
function discoveryLabel(discovery: Discovery | null): string {
    if (discovery === null) return "-";
    if (discovery.calls === 0) return "none";
    if (discovery.help === 0) {
        return discovery.helpAttempted > 0
            ? `no help (${discovery.helpAttempted} attempted)`
            : `no help (${discovery.calls})`;
    }
    return `help×${discovery.help}`;
}

/**
 * What a completed tool call exposes beyond the prompt, most specific first.
 * Overlapping paths stay labelled: a rubric read is never mistaken for the
 * redacted case list. A `glob` naming a guidance file is discovery, not a
 * read. Only completed calls count as exposure; attempts are labelled
 * separately so a failed probe is never reported as a successful leak.
 */
/** One exposure rule: a label and the trail-input pattern that names it. */
type ExposureRule = [label: string, pattern: RegExp];

const EXPOSURE_RULES: ExposureRule[] = [
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
function recordExposure(entry: ToolCall, found: Map<string, boolean>): void {
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
function exposureFor(resultDir: string): string[] {
    const trail = readTrail(resultDir);
    if (trail === null) return [];
    const found = new Map();
    for (const entry of trail.entries) recordExposure(entry, found);
    return [...found.entries()].map(([label, completed]) =>
        completed ? label : `${label} (attempt)`,
    );
}

/**
 * The opt-in operation journal, copied into evidence after the run. The
 * plugin writes a per-run temp path; this file is harness output, never the
 * capture path a trial could pre-seed during the run.
 */
const OPERATION_JOURNAL_FILE = "docs-operations.jsonl";
/** The per-run signing key saved beside the journal after the run. */
const OPERATION_JOURNAL_KEY_FILE = "docs-operations.key";

/** The text of a plugin result's content, flattened for the shared verifier. */
function journalContentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) =>
                isRecord(part) && typeof part.text === "string"
                    ? part.text
                    : "",
            )
            .join("");
    }
    return "";
}

/** Whether a journal record names a served Code Mode twin call. */
function isServedTwinRecord(record: Record<string, unknown>): boolean {
    return isServedRecord(record) && record.surface === "codemode-twin";
}

/** A journal record's verdict and output, or null when it is unusable. */
function nestedResultOf(record: Record<string, unknown>): {
    status: "completed" | "error";
    output: string;
    metadata: unknown;
} | null {
    const status = record.status;
    if (status !== "completed" && status !== "error") return null;
    if (status === "error") {
        return typeof record.error === "string"
            ? { status, output: record.error, metadata: undefined }
            : null;
    }
    if (!isRecord(record.result)) return null;
    return {
        status,
        output: journalContentText(record.result.content),
        metadata: record.result.metadata,
    };
}

/** One nested dispatch the host recorded in an execute result's metadata. */
interface NestedDispatch {
    tool: string;
    status: string;
    input: unknown;
}

/** The journal's registered tool name for one host dispatch name. */
function docsDispatchTool(name: unknown): string | null {
    if (name === "docs.docs_search") return "docs_search";
    if (name === "docs") return "docs";
    return null;
}

/** The docs dispatches one execute entry's result metadata recorded. */
function recordedDispatches(entry: ToolCall): NestedDispatch[] {
    if (entry.tool !== "execute" || !isRecord(entry.metadata)) return [];
    const envelope = isRecord(entry.metadata.metadata)
        ? entry.metadata.metadata
        : entry.metadata;
    const calls = Array.isArray(envelope.toolCalls) ? envelope.toolCalls : [];
    const dispatches: NestedDispatch[] = [];
    for (const call of calls) {
        if (!isRecord(call)) continue;
        const tool = docsDispatchTool(call.tool);
        if (tool === null) continue;
        dispatches.push({
            tool,
            status: typeof call.status === "string" ? call.status : "unknown",
            input: call.input,
        });
    }
    return dispatches;
}

/**
 * The nested docs dispatches the host recorded inside execute results. This
 * is the independent half of journal attribution: a record must correspond
 * to a dispatch the runtime actually made, not merely to a plausible shape.
 * @param entries The raw CLI trail entries.
 * @returns The docs dispatches, in execution order.
 */
function nestedDispatches(entries: ToolCall[]): NestedDispatch[] {
    return entries.flatMap(recordedDispatches);
}

/** The session/message identities observed in a saved stdout trail. */
function journalIdentityFromStdout(resultDir: string): TrailIdentity {
    const identity: TrailIdentity = {
        sessions: new Set(),
        messages: new Set(),
    };
    const path = join(resultDir, "stdout.jsonl");
    if (!existsSync(path)) return identity;
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return identity;
    }
    for (const line of text.split("\n").filter(Boolean)) {
        recordIdentity(parseLine(line), identity);
    }
    return identity;
}

/** One validated journal record as a trail-shaped nested operation. */
function nestedOperationOf(
    record: unknown,
    index: number,
    callID: string,
): ToolCall | null {
    if (!isRecord(record)) return null;
    if (!isServedTwinRecord(record)) return null;
    const result = nestedResultOf(record);
    if (result === null) return null;
    return {
        id: `nested-${index}`,
        tool: record.tool as string,
        input: record.input,
        status: result.status,
        output: result.output,
        metadata: result.metadata,
        outcome: outcomeFactsOf(result.output),
        nested: true,
        callID,
    };
}

/** The saved journal lines and signing key, or null when unusable. */
function journalEvidenceOf(
    resultDir: string,
): { lines?: string[]; key: string | null } | null {
    const path = join(resultDir, OPERATION_JOURNAL_FILE);
    if (!existsSync(path)) return null;
    let key: string | null = null;
    try {
        const text = readFileSync(
            join(resultDir, OPERATION_JOURNAL_KEY_FILE),
            "utf8",
        ).trim();
        if (text !== "") key = text;
    } catch {
        key = null;
    }
    try {
        return {
            lines: readFileSync(path, "utf8").split("\n").filter(Boolean),
            key,
        };
    } catch {
        return null;
    }
}

/**
 * Read the harness-written plugin journal and keep only records this run can
 * account for. A record must carry a valid signature under this run's saved
 * key, name a session and message observed in the run's CLI events, name an
 * execute call present in its trail, and match one not-yet-matched nested
 * docs dispatch that the host recorded in that execute result. Correct shape
 * alone is never enough; a record written by a trial tool cannot acquire the
 * signature or those identities. Unmatched or malformed records are dropped
 * (an absent journal is the pre-instrumentation status quo).
 * @param resultDir The case's result directory.
 * @param entries The raw CLI trail entries.
 * @param identity The run's observed session/message identity.
 * @returns The validated nested operations, oldest first.
 */
function readOperationJournal(
    resultDir: string,
    entries: ToolCall[],
    identity: TrailIdentity,
): ToolCall[] {
    const evidence = journalEvidenceOf(resultDir);
    const executeIds = new Set(
        entries
            .filter((entry) => entry.tool === "execute")
            .map((entry) => entry.id)
            .filter((id): id is string => typeof id === "string"),
    );
    const verification = verifyOperationsJournal({
        lines: evidence?.lines,
        key: evidence?.key ?? null,
        identity,
        callIds: executeIds,
        dispatches: nestedDispatches(entries).map(
            (dispatch): JournalDispatch => ({
                tool: dispatch.tool,
                status: dispatch.status,
                input: dispatch.input,
            }),
        ),
    });
    const nested: ToolCall[] = [];
    for (const credited of verification.credited) {
        const entry = nestedOperationOf(
            credited.record,
            credited.index,
            credited.record.callID as string,
        );
        if (entry !== null) nested.push(entry);
    }
    return nested;
}

/**
 * Fold journaled nested operations into the CLI trail. Deduplication is by
 * call identity, never by arguments: two distinct reads with identical input
 * are two calls, and a later successful nested read survives beside an
 * earlier observable refusal. Only a direct twin call the trail already
 * carries under the same call id is dropped. The execute wrapper stays an
 * attempt and is never a docs operation.
 * @param entries The deduplicated CLI trail.
 * @param nested The validated journal operations.
 * @returns The trail plus every nested operation not already observable.
 */
function mergeNestedOperations(
    entries: ToolCall[],
    nested: ToolCall[],
): ToolCall[] {
    const directIds = new Set(
        entries
            .filter(
                (entry) =>
                    typeof entry.id === "string" &&
                    (entry.tool === "docs" || entry.tool === "docs_search"),
            )
            .map((entry) => `${entry.tool}|${entry.id}`),
    );
    const extra = nested.filter(
        (entry) =>
            typeof entry.callID !== "string" ||
            !directIds.has(`${entry.tool}|${entry.callID}`),
    );
    return [...entries, ...extra];
}

/** Write the captured journal and its key as evidence, after the run. */
function copyCapturedJournal(
    resultDir: string,
    journalPath: string,
    key: string,
): void {
    let text = "";
    try {
        text = readFileSync(journalPath, "utf8");
    } catch {
        // No write is a real empty capture, not an error.
    }
    write(join(resultDir, OPERATION_JOURNAL_FILE), text);
    writeFileSync(join(resultDir, OPERATION_JOURNAL_KEY_FILE), `${key}\n`, {
        mode: 0o600,
    });
}

/** The docs telemetry for one run, with attributed nested calls folded in. */
function capturedDocsTelemetry(
    resultDir: string,
    toolCalls: ToolCall[],
    identity: TrailIdentity,
    parseFailures: number,
): Telemetry {
    return docsTelemetry(
        mergeNestedOperations(
            toolCalls,
            readOperationJournal(resultDir, toolCalls, identity),
        ),
        parseFailures,
    );
}

/** Read one result's deduplicated trail, or null when absent/unreadable. */
function readTrail(resultDir: string): ToolTrail | null {
    const path = join(resultDir, "tools.jsonl");
    if (!existsSync(path)) return null;
    let parseFailures = 0;
    const entries = [];
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        const entry = parseLine(line);
        if (!entry) parseFailures += 1;
        else entries.push(entry);
    }
    return {
        entries: mergeNestedOperations(
            entries,
            readOperationJournal(
                resultDir,
                entries,
                journalIdentityFromStdout(resultDir),
            ),
        ),
        parseFailures,
    };
}

/* ------------------------------------------------------------------ *
 * Tool-availability diagnostic (report-only)
 * ------------------------------------------------------------------ */

type DiagnosticPresence = "present" | "absent" | "unknown";
type DiagnosticCatalogueStatus = "present" | "missing" | "unknown";
type DiagnosticDispatchStatus = "succeeded" | "failed" | "not attempted";
type DiagnosticHelpStatus =
    "inventory returned" | "refusal or blank" | "unknown";
type DiagnosticObservability = "operation-level" | "wrapper-only" | "no event";
type DiagnosticCriterionStatus = "met" | "unmet" | "not declared";

interface DiagnosticSurface {
    status: DiagnosticPresence;
    source: string;
    detail: string;
}

interface DiagnosticDispatch {
    status: DiagnosticDispatchStatus;
    source: string;
    detail: string;
    error: string | null;
}

interface DiagnosticRecord {
    invocation: {
        command: string;
        args: string[];
        cwd: string;
        pwd?: string | null;
        promptSha256: string;
        startedAt: string;
        config: unknown;
    } | null;
    timestamps: {
        runStartedAt: string;
        pluginLoadAt: string | null;
        serverStartAt: string | null;
        firstRequestAt: string | null;
        finishedAt: string;
        pluginLoadToFirstRequestMs: number | null;
    };
    registration: {
        status: "observed" | "absent" | "unknown";
        source: string;
        detail: string;
    };
    environment: {
        invokedCwd: string | null;
        childPwd: string | null;
        pwdMatches: boolean | null;
        hostDirectory: string | null;
        cwdMatches: boolean | null;
    };
    advertisement: {
        nativeDocs: DiagnosticSurface;
        codeModeDocs: DiagnosticSurface;
    };
    catalogue: {
        status: DiagnosticCatalogueStatus;
        source: string;
        detail: string;
    };
    dispatch: {
        nativeDocs: DiagnosticDispatch;
        codeModeDocs: DiagnosticDispatch;
    };
    help: {
        status: DiagnosticHelpStatus;
        source: string;
        detail: string;
    };
    observability: {
        status: DiagnosticObservability;
        source: string;
        detail: string;
    };
    criterion: {
        status: DiagnosticCriterionStatus;
        source: string;
        detail: string;
    };
    positive: {
        status: "yes" | "no";
        reason: string;
    };
    supporting: { modelReported: string };
}

const LOG_TIMESTAMP = /^timestamp=(\S+)/;

/** The host location directory reported in the log, or null. */
function hostDirectoryFromLog(text: string): string | null {
    const line = text
        .split("\n")
        .find((entry) =>
            /(?:msg|message)="location services booted"/.test(entry),
        );
    return line?.match(/directory=(\S+)/)?.[1] ?? null;
}

/** The plugin-registration verdict from the captured host log. */
function registrationFromLog(
    text: string,
    invokedCwd: string | null,
    hostDirectory: string | null,
): DiagnosticRecord["registration"] {
    const lines = text.split("\n").filter(Boolean);
    const load = lines.find((line) =>
        /(?:msg|message)="loading plugin"/.test(line),
    );
    if (load !== undefined) {
        return {
            status: "observed",
            source: "stderr.log",
            detail: load.trim(),
        };
    }
    const started = lines.some((line) =>
        /(?:msg|message)="cli starting"/.test(line),
    );
    const stopped = lines.some((line) =>
        /(?:msg|message)="shutdown started"/.test(line),
    );
    if (started && stopped) {
        const mismatch =
            invokedCwd !== null &&
            hostDirectory !== null &&
            invokedCwd !== hostDirectory
                ? `; host location ${hostDirectory} differs from invoked cwd ` +
                  `${invokedCwd}, so the fixture config was not loaded`
                : "";
        return {
            status: "absent",
            source: "stderr.log",
            detail:
                "complete startup/shutdown trace with no plugin-load " +
                `record${mismatch}`,
        };
    }
    return {
        status: "unknown",
        source: "stderr.log",
        detail: "no complete plugin-load trace was captured",
    };
}

/** The invoked cwd, child PWD and host's own location report. */
function diagnosticEnvironment(
    invocation: DiagnosticRecord["invocation"],
    hostDirectory: string | null,
): DiagnosticRecord["environment"] {
    const invokedCwd = invocation?.cwd ?? null;
    const childPwd = invocation?.pwd ?? null;
    return {
        invokedCwd,
        childPwd,
        pwdMatches:
            invokedCwd === null || childPwd === null
                ? null
                : invokedCwd === childPwd,
        hostDirectory,
        cwdMatches:
            invokedCwd === null || hostDirectory === null
                ? null
                : invokedCwd === hostDirectory,
    };
}

/** One tool name from a definitions capture, for presence classification. */
interface CapturedToolName {
    name: string;
    namespace?: string | undefined;
}

/** Normalise one captured tool entry (string or object), or null. */
function capturedToolName(entry: unknown): CapturedToolName | null {
    if (typeof entry === "string") return { name: entry };
    if (!isRecord(entry)) return null;
    const name = entry.name ?? entry.tool;
    if (typeof name !== "string" || name === "") return null;
    const namespace =
        typeof entry.namespace === "string" ? entry.namespace : undefined;
    return { name, namespace };
}

/** The names a definitions capture proves, or null when malformed. */
function capturedDefinitions(value: unknown): CapturedToolName[] | null {
    if (Array.isArray(value)) {
        return value.map(capturedToolName).filter((entry) => entry !== null);
    }
    if (!isRecord(value)) return null;
    const generic = value.tools ?? value.definitions;
    if (Array.isArray(generic)) {
        return generic.map(capturedToolName).filter((entry) => entry !== null);
    }
    const names: CapturedToolName[] = [];
    for (const field of [
        "nativeTools",
        "codeModeTools",
        "native",
        "codeMode",
    ]) {
        const list = value[field];
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            const captured = capturedToolName(entry);
            if (captured !== null) names.push(captured);
        }
    }
    return names.length > 0 ? names : null;
}

/** Whether one captured name is the native docs surface. */
function isCapturedNativeDocs(entry: CapturedToolName): boolean {
    return (
        entry.namespace === undefined &&
        (entry.name === "docs" || entry.name === "docs_search")
    );
}

/** Whether one captured name is the Code Mode docs method. */
function isCapturedCodeModeDocs(entry: CapturedToolName): boolean {
    return (
        entry.name === "docs.docs_search" ||
        (entry.namespace === "docs" && entry.name === "docs_search")
    );
}

/** One definitions capture read from the result directory. */
type DefinitionsCapture =
    | { kind: "absent" }
    | { kind: "malformed"; detail: string }
    | { kind: "present"; native: boolean; codeMode: boolean };

/** Read the optional first-request tool-definitions capture, when a host saved one. */
function readDefinitionsCapture(resultDir: string): DefinitionsCapture {
    const at = jsonAt(join(resultDir, "tool-definitions.json"));
    if (at.kind === "absent") return { kind: "absent" };
    if (at.kind === "corrupt") {
        return {
            kind: "malformed",
            detail: `tool-definitions.json is malformed (${at.problem})`,
        };
    }
    const names = capturedDefinitions(at.value);
    if (names === null) {
        return {
            kind: "malformed",
            detail: "tool-definitions.json carries no recognised tool list",
        };
    }
    return {
        kind: "present",
        native: names.some(isCapturedNativeDocs),
        codeMode: names.some(isCapturedCodeModeDocs),
    };
}

/** The string form of a tool call's captured output, or its JSON rendering. */
function diagnosticOutput(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

/** The first nonblank error output among calls, or null. */
function firstCallError(calls: ToolCall[]): string | null {
    const failed = calls.find((entry) => entry.status === "error");
    if (failed === undefined) return null;
    const output = diagnosticOutput(failed.output).trim();
    return output === "" ? null : output;
}

/** The dispatch verdict for one surface's calls. */
function diagnosticDispatch(
    calls: ToolCall[],
    label: string,
): DiagnosticDispatch {
    if (calls.length === 0) {
        return {
            status: "not attempted",
            source: "tools.jsonl",
            detail: `no ${label} call observed`,
            error: null,
        };
    }
    const completed = calls.filter((entry) => entry.status === "completed");
    if (completed.length > 0) {
        return {
            status: "succeeded",
            source: "tools.jsonl",
            detail: `${completed.length} completed call(s)`,
            error: firstCallError(calls),
        };
    }
    return {
        status: "failed",
        source: "tools.jsonl",
        detail: `${calls.length} call(s) ended without completion`,
        error: firstCallError(calls),
    };
}

/** The advertisement verdict for one surface, from capture then dispatch. */
function diagnosticAdvertisement(
    surface: "native" | "codeMode",
    capture: DefinitionsCapture,
    calls: ToolCall[],
): DiagnosticSurface {
    const label =
        surface === "native" ? "native docs" : "Code Mode docs method";
    if (capture.kind === "present") {
        const found = surface === "native" ? capture.native : capture.codeMode;
        return {
            status: found ? "present" : "absent",
            source: "tool-definitions.json",
            detail: found
                ? `the capture lists the ${label}`
                : `the complete capture does not list the ${label}`,
        };
    }
    const inferred = calls.some((entry) => entry.status === "completed");
    if (inferred) {
        return {
            status: "present",
            source: "tools.jsonl",
            detail:
                `a completed ${label} call proves exposure; it is not a ` +
                "registry dump",
        };
    }
    return {
        status: "unknown",
        source: "artefacts",
        detail:
            capture.kind === "malformed"
                ? capture.detail
                : `no tool-definitions capture and no completed ${label} call`,
    };
}

/** The catalogue verdict for the Code Mode docs method. */
function diagnosticCatalogue(
    capture: DefinitionsCapture,
    codeCalls: ToolCall[],
): DiagnosticRecord["catalogue"] {
    if (capture.kind === "present") {
        return {
            status: capture.codeMode ? "present" : "missing",
            source: "tool-definitions.json",
            detail: capture.codeMode
                ? "the capture lists the Code Mode docs method"
                : "the complete capture omits the Code Mode docs method",
        };
    }
    const completed = codeCalls.some((entry) => entry.status === "completed");
    if (completed) {
        return {
            status: "present",
            source: "tools.jsonl",
            detail: "a Code Mode docs dispatch completed",
        };
    }
    const error = firstCallError(codeCalls);
    if (error !== null) {
        return {
            status: "missing",
            source: "tools.jsonl",
            detail: `exact dispatch error: \`${error}\``,
        };
    }
    return {
        status: "unknown",
        source: "artefacts",
        detail:
            capture.kind === "malformed"
                ? capture.detail
                : "no tool-definitions capture and no Code Mode docs dispatch",
    };
}

/** The first stdout event timestamp, the first model-request mark. */
function firstRequestTimestamp(resultDir: string): string | null {
    const path = join(resultDir, "stdout.jsonl");
    if (!existsSync(path)) return null;
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        const event = parseLine(line);
        if (!isRecord(event) || typeof event.timestamp !== "number") continue;
        return new Date(event.timestamp).toISOString();
    }
    return null;
}

/** The help-result verdict, preferring observable native/twin/nested operations. */
function diagnosticHelp(entries: ToolCall[]): DiagnosticRecord["help"] {
    const operationHelp = entries.filter((entry) => {
        const kind = docsEntryKind(entry);
        return (
            (kind === "native" || kind === "twin" || kind === "nested") &&
            docsEntryVerb(kind, entry) === "help"
        );
    });
    if (operationHelp.length > 0) {
        const successful = operationHelp.find(docsOpSuccessful);
        if (successful !== undefined) {
            const kind = docsEntryKind(successful);
            return {
                status: "inventory returned",
                source:
                    kind === "nested"
                        ? "operation-level nested `docs_search` help call " +
                          "(plugin journal)"
                        : `operation-level \`${successful.tool}\` help call`,
                detail: diagnosticOutput(successful.output).trim(),
            };
        }
        const completed = operationHelp.find(
            (entry) => entry.status === "completed",
        );
        if (completed !== undefined) {
            return {
                status: "refusal or blank",
                source: "tools.jsonl",
                detail:
                    "the help call completed without a nonblank inventory; " +
                    `output: \`${diagnosticOutput(completed.output).trim()}\``,
            };
        }
        return {
            status: "unknown",
            source: "tools.jsonl",
            detail: "the help dispatch failed before a result was returned",
        };
    }
    const codeHelp = entries.filter(
        (entry) =>
            isCodeModeDocs(entry) &&
            codeModeVerbOf(
                isRecord(entry.input) && typeof entry.input.code === "string"
                    ? entry.input.code
                    : undefined,
            ) === "help",
    );
    if (codeHelp.length > 0) {
        const completed = codeHelp.find(
            (entry) =>
                entry.status === "completed" &&
                diagnosticOutput(entry.output).trim() !== "",
        );
        if (completed !== undefined) {
            return {
                status: "inventory returned",
                source:
                    "Code Mode execute wrapper result; nested operation " +
                    "unobservable",
                detail: diagnosticOutput(completed.output).trim(),
            };
        }
        const blank = codeHelp.find((entry) => entry.status === "completed");
        if (blank !== undefined) {
            return {
                status: "refusal or blank",
                source: "tools.jsonl",
                detail: "the Code Mode help wrapper completed without output",
            };
        }
        return {
            status: "unknown",
            source: "tools.jsonl",
            detail: "the Code Mode help dispatch failed before a result",
        };
    }
    return {
        status: "unknown",
        source: "artefacts",
        detail: "no help request observed",
    };
}

/** The observability verdict: an operation event, a wrapper, or nothing. */
function diagnosticObservability(
    entries: ToolCall[],
): DiagnosticRecord["observability"] {
    const nested = entries.filter((entry) => docsEntryKind(entry) === "nested");
    const observable = entries.filter((entry) => {
        const kind = docsEntryKind(entry);
        return kind === "native" || kind === "twin";
    });
    if (observable.length + nested.length > 0) {
        const parts: string[] = [];
        if (observable.length > 0) {
            parts.push(`${observable.length} native/twin docs event(s)`);
        }
        if (nested.length > 0) {
            parts.push(`${nested.length} plugin-journaled nested operation(s)`);
        }
        return {
            status: "operation-level",
            source:
                nested.length > 0
                    ? "tools.jsonl + docs-operations.jsonl"
                    : "tools.jsonl",
            detail: parts.join(", "),
        };
    }
    const wrappers = entries.filter(isCodeModeDocs);
    if (wrappers.length > 0) {
        return {
            status: "wrapper-only",
            source: "tools.jsonl",
            detail:
                `${wrappers.length} Code Mode docs attempt(s); no ` +
                "operation-level docs event",
        };
    }
    return {
        status: "no event",
        source: "tools.jsonl",
        detail: "no docs-family event observed",
    };
}

/** The captured host log text, or empty when none was saved. */
function diagnosticLogText(resultDir: string): string {
    const path = join(resultDir, "stderr.log");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The plugin-load and server-start marks from the captured host log. */
function diagnosticLogTiming(log: string) {
    const lines = log.split("\n");
    const mark = (pattern: RegExp): string | null =>
        lines.find((line) => pattern.test(line))?.match(LOG_TIMESTAMP)?.[1] ??
        null;
    return {
        pluginLoadAt: mark(/(?:msg|message)="loading plugin"/),
        serverStartAt: mark(/(?:msg|message)="cli starting"/),
    };
}

/** The exact invocation record saved by a diagnostic run. */
function diagnosticInvocation(
    resultDir: string,
): DiagnosticRecord["invocation"] {
    const at = jsonAt(join(resultDir, "invocation.json"));
    return at.kind === "value" && isRecord(at.value)
        ? (at.value as DiagnosticRecord["invocation"])
        : null;
}

/** Whether the help/inventory evidence is a positive, observable diagnostic. */
function diagnosticPositive(
    help: DiagnosticRecord["help"],
    observability: DiagnosticRecord["observability"],
    criterion: DiagnosticRecord["criterion"],
): DiagnosticRecord["positive"] {
    // A declared criterion is evaluated on its own evidence: a read-only
    // control must not be labelled unsuccessful merely because it made no
    // help call, and a help/inventory response does not satisfy a read.
    if (criterion.status === "met") {
        return {
            status: "yes",
            reason: "the declared docs criterion is met by a verified operation",
        };
    }
    if (criterion.status === "unmet") {
        return {
            status: "no",
            reason:
                `the declared docs criterion is unmet: ${criterion.detail}; ` +
                "help/inventory evidence is separate and does not satisfy it",
        };
    }
    if (
        help.status === "inventory returned" &&
        observability.status === "operation-level"
    ) {
        return {
            status: "yes",
            reason: "operation-level help/inventory response",
        };
    }
    if (
        help.status === "inventory returned" &&
        observability.status === "wrapper-only"
    ) {
        return {
            status: "no",
            reason:
                "help/inventory was wrapper-only; it is not verified docs " +
                "use",
        };
    }
    return {
        status: "no",
        reason: "no operation-level help/inventory response",
    };
}

/**
 * The declared docs criterion of a report-only diagnostic, evaluated through
 * the same deterministic operation verifier used before semantic judging. A
 * diagnostic without a criterion keeps the legacy help/inventory behaviour.
 * The verifier proves an observable successful operation against the typed
 * target path; it does not compare the retrieved bytes with the seed, so the
 * exact content and revision are checked in the live control evidence.
 */
function diagnosticCriterion(resultDir: string): DiagnosticRecord["criterion"] {
    const caseAt = jsonAt(join(resultDir, "case.json"));
    const recorded =
        caseAt.kind === "value" && isRecord(caseAt.value) ? caseAt.value : null;
    const caseDef: TrialCase | null =
        recorded !== null && typeof recorded.id === "string"
            ? (recorded as unknown as TrialCase)
            : null;
    if (caseDef === null || caseDef.docsCriterion == null) {
        return {
            status: "not declared",
            source: "case.json",
            detail:
                "the diagnostic case declares no docs criterion; " +
                "help/inventory evidence applies",
        };
    }
    const problem = docsCriterionProblem(caseDef, resultDir);
    if (problem !== null) {
        return { status: "unmet", source: "tools.jsonl", detail: problem };
    }
    return {
        status: "met",
        source: "tools.jsonl",
        detail:
            "an observable successful docs operation met the declared " +
            "criterion; the verifier checks operation success and the typed " +
            "target path, not exact seeded content",
    };
}

/** The model's own report, recorded only as supporting evidence. */
function diagnosticModelReport(resultDir: string): string {
    const path = join(resultDir, "final.md");
    return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

/** The recorded run meta, or null when the case never ran. */
function diagnosticMeta(resultDir: string): MetaRecord | null {
    const at = metaRecordAt(join(resultDir, "meta.json"));
    if (at.kind === "absent") return null;
    return at.kind === "value" ? at.value : {};
}

/** One run's tool entries and the two docs-surface call sets. */
function diagnosticToolCalls(resultDir: string) {
    const trail = readTrail(resultDir);
    if (trail === null && !existsSync(join(resultDir, "stdout.jsonl")))
        return null;
    const entries = trail?.entries ?? [];
    return {
        entries,
        nativeCalls: entries.filter(
            (entry) =>
                (entry.tool === "docs" || entry.tool === "docs_search") &&
                docsEntryKind(entry) !== "nested",
        ),
        codeCalls: entries.filter(
            (entry) =>
                isCodeModeDocs(entry) || docsEntryKind(entry) === "nested",
        ),
    };
}

/** The run's timing marks, including the registration-to-request delta. */
function diagnosticTimestamps(
    meta: MetaRecord,
    invocation: DiagnosticRecord["invocation"],
    logTiming: ReturnType<typeof diagnosticLogTiming>,
    firstRequestAt: string | null,
): DiagnosticRecord["timestamps"] {
    const runStartedAt =
        invocation?.startedAt ??
        (typeof meta.startedAt === "string" ? meta.startedAt : "?");
    const finishedAt =
        typeof meta.finishedAt === "string" ? meta.finishedAt : "?";
    const delta =
        logTiming.pluginLoadAt !== null && firstRequestAt !== null
            ? Date.parse(firstRequestAt) - Date.parse(logTiming.pluginLoadAt)
            : null;
    return {
        runStartedAt,
        pluginLoadAt: logTiming.pluginLoadAt,
        serverStartAt: logTiming.serverStartAt,
        firstRequestAt,
        finishedAt,
        pluginLoadToFirstRequestMs: delta,
    };
}

/** Build the report-only diagnostic record from one result directory's artefacts. */
function diagnosticFor(resultDir: string): DiagnosticRecord | null {
    const meta = diagnosticMeta(resultDir);
    if (meta === null) return null;
    const calls = diagnosticToolCalls(resultDir);
    if (calls === null) return null;
    const { entries, nativeCalls, codeCalls } = calls;
    const capture = readDefinitionsCapture(resultDir);
    const log = diagnosticLogText(resultDir);
    const hostDirectory = hostDirectoryFromLog(log);
    const invocation = diagnosticInvocation(resultDir);
    const registration = registrationFromLog(
        log,
        invocation?.cwd ?? null,
        hostDirectory,
    );
    const logTiming = diagnosticLogTiming(log);
    const firstRequestAt = firstRequestTimestamp(resultDir);
    const help = diagnosticHelp(entries);
    const observability = diagnosticObservability(entries);
    const criterion = diagnosticCriterion(resultDir);
    return {
        invocation,
        timestamps: diagnosticTimestamps(
            meta,
            invocation,
            logTiming,
            firstRequestAt,
        ),
        registration,
        environment: diagnosticEnvironment(invocation, hostDirectory),
        advertisement: {
            nativeDocs: diagnosticAdvertisement("native", capture, nativeCalls),
            codeModeDocs: diagnosticAdvertisement(
                "codeMode",
                capture,
                codeCalls,
            ),
        },
        catalogue: diagnosticCatalogue(capture, codeCalls),
        dispatch: {
            nativeDocs: diagnosticDispatch(nativeCalls, "native docs"),
            codeModeDocs: diagnosticDispatch(codeCalls, "Code Mode docs"),
        },
        help,
        observability,
        criterion,
        positive: diagnosticPositive(help, observability, criterion),
        supporting: { modelReported: diagnosticModelReport(resultDir) },
    };
}

/** The invoked-cwd, child-PWD and host-location lines, exposing a launch mismatch. */
function diagnosticEnvironmentLine(record: DiagnosticRecord): string {
    const environment = record.environment;
    const match =
        environment.cwdMatches === null
            ? "unknown"
            : environment.cwdMatches
              ? "match"
              : "MISMATCH — the fixture config was not loaded";
    const pwdMatch =
        environment.pwdMatches === null
            ? "unknown"
            : environment.pwdMatches
              ? "match"
              : "MISMATCH — the child inherited a different directory";
    return [
        `- Host location: ${environment.hostDirectory ?? "unknown"}; invoked cwd ${environment.invokedCwd ?? "unknown"}; ${match}`,
        `- Child PWD: ${environment.childPwd ?? "unknown"}; ${pwdMatch}`,
    ].join("\n");
}

/** The invocation line, with the prompt argument abbreviated. */
function diagnosticInvocationLabel(
    invocation: DiagnosticRecord["invocation"],
): string {
    if (invocation === null) return "unknown";
    return (
        `${invocation.command} ` +
        `${invocation.args.slice(0, -1).join(" ")} <prompt>`
    );
}

/** One dispatch line, preserving an exact error when the call captured one. */
function diagnosticDispatchLine(
    label: string,
    dispatch: DiagnosticDispatch,
): string {
    const error =
        dispatch.error === null ? "" : `; exact error: \`${dispatch.error}\``;
    return `- Dispatch (${label}): **${dispatch.status}** — ${dispatch.detail}${error}`;
}

/** The model-report line, flattened and bounded for the report. */
function diagnosticModelReportLine(record: DiagnosticRecord): string {
    const reported = record.supporting.modelReported;
    const text =
        reported === "" ? "none" : reported.split("\n").join(" ").slice(0, 600);
    return `- Supporting model report (not authoritative): ${text}`;
}

/** The diagnostic sections rendered into summary and dossier reports. */
function diagnosticLines(record: DiagnosticRecord): string[] {
    const at = record.timestamps;
    const delta =
        at.pluginLoadToFirstRequestMs === null
            ? "unknown"
            : `${at.pluginLoadToFirstRequestMs} ms`;
    const invocation = record.invocation;
    return [
        "### Tool-availability diagnostic",
        "",
        `- Invocation: \`${diagnosticInvocationLabel(invocation)}\``,
        `- Cwd: \`${invocation?.cwd ?? "unknown"}\``,
        diagnosticEnvironmentLine(record),
        `- Prompt sha256: \`${invocation?.promptSha256 ?? "unknown"}\``,
        `- Timestamps: run started ${at.runStartedAt}; plugin load ${at.pluginLoadAt ?? "unknown"}; server start ${at.serverStartAt ?? "unknown"}; first request ${at.firstRequestAt ?? "unknown"}; finished ${at.finishedAt}; plugin-load→first-request ${delta}`,
        `- Plugin registration: **${record.registration.status}** — ${record.registration.source}: ${record.registration.detail}`,
        `- Advertisement (native docs): **${record.advertisement.nativeDocs.status}** — ${record.advertisement.nativeDocs.source}: ${record.advertisement.nativeDocs.detail}`,
        `- Advertisement (Code Mode docs method): **${record.advertisement.codeModeDocs.status}** — ${record.advertisement.codeModeDocs.source}: ${record.advertisement.codeModeDocs.detail}`,
        `- Catalogue: **${record.catalogue.status}** — ${record.catalogue.source}: ${record.catalogue.detail}`,
        diagnosticDispatchLine("native docs", record.dispatch.nativeDocs),
        diagnosticDispatchLine("Code Mode docs", record.dispatch.codeModeDocs),
        `- Help: **${record.help.status}** — ${record.help.source}: ${record.help.detail}`,
        `- Observability: **${record.observability.status}** — ${record.observability.source}: ${record.observability.detail}`,
        `- Declared docs criterion: **${record.criterion.status}** — ${record.criterion.source}: ${record.criterion.detail}`,
        `- Positive: **${record.positive.status}** — ${record.positive.reason}`,
        diagnosticModelReportLine(record),
        "",
    ];
}

/** Whether one result directory belongs to the report-only diagnostic. */
function resultIsDiagnostic(resultDir: string): boolean {
    const caseAt = jsonAt(join(resultDir, "case.json"));
    return (
        caseAt.kind === "value" &&
        isRecord(caseAt.value) &&
        caseAt.value.promptKind === "diagnostic"
    );
}

/**
 * The child environment. `spawn`'s cwd changes the process directory but
 * leaves an inherited PWD untouched; OpenCode resolves its config path from
 * PWD, so an inherited host value sends the child to the wrong directory and
 * skips the fixture config. Set PWD after every other overlay, to the exact
 * cwd this spawn uses.
 * @param configHome The isolated XDG config directory.
 * @param cwd The absolute working directory passed to `spawn`.
 * @param journalPath The per-run journal path, inside the container temp fs.
 * @param journalKey The per-run signing key for that journal.
 */
function childEnv(
    configHome: string,
    cwd: string,
    journalPath?: string,
    journalKey?: string,
): NodeJS.ProcessEnv {
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
    env.PWD = cwd;
    // Opt-in docs instrumentation: a per-run temp path and signing key. The
    // harness copies the journal into evidence after the run and saves the
    // key then, so a trial-time file write cannot pass as capture.
    if (journalPath !== undefined && journalKey !== undefined) {
        env.DOCS_OPERATION_JOURNAL = journalPath;
        env.DOCS_OPERATION_JOURNAL_KEY = journalKey;
    } else {
        delete env.DOCS_OPERATION_JOURNAL;
        delete env.DOCS_OPERATION_JOURNAL_KEY;
    }
    delete env.DOCS_OPERATION_JOURNAL_FD;
    return env;
}

/** Environment-key names whose values are never recorded as evidence. */
const SECRET_KEY = /key|token|secret|password|credential/i;

/** A redacted copy of one configuration value, recursively. */
function redactedConfig(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactedConfig);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) =>
            SECRET_KEY.test(key)
                ? [key, "<redacted>"]
                : [key, redactedConfig(entry)],
        ),
    );
}

function opencodeVersion(options: CliOptions): string {
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
function gitFact(directory: string, args: string[]): string {
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
function gitInitQuiet(work: string) {
    try {
        spawnSync("git", ["init", "-q"], { cwd: work, stdio: "ignore" });
    } catch {
        /* fixture scaffolding only */
    }
}

/** The real fixture hash, even when a run container sees only a redacted list. */
function fixtureHashOf(options: CliOptions): string {
    if (process.env.PLACEMENT_FIXTURE_HASH) {
        return process.env.PLACEMENT_FIXTURE_HASH;
    }
    if (existsSync(options.fixture)) return fileHash(options.fixture);
    const manifestAt = recordAt<{ fixtureHash?: string }>(
        join(options.fixtures, "manifest.json"),
        (value) => {
            if (!isRecord(value))
                return ["manifest.json must be a JSON object"];
            return typeof value.fixtureHash === "string" ||
                value.fixtureHash === undefined
                ? []
                : ["fixtureHash must be a string"];
        },
    );
    return manifestAt.kind === "value"
        ? (manifestAt.value.fixtureHash ?? "unknown")
        : "unknown";
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
function pluginIdentity(options: CliOptions): ProvenancePick {
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

function pluginCommitOf(options: CliOptions): string {
    const commit = gitFact(options.plugin, ["rev-parse", "HEAD"]);
    if (commit !== "unknown") return commit;
    return process.env.PLACEMENT_PLUGIN_COMMIT || "unknown";
}

function pluginDirtyOf(options: CliOptions): boolean {
    const status = gitFact(options.plugin, ["status", "--porcelain"]);
    if (status === "unknown") return process.env.PLACEMENT_PLUGIN_DIRTY === "1";
    return status !== "";
}

/** The plugin's content identity pieces a trial certifies. */
interface ProvenancePick {
    contentHash: string;
    lockHash: string;
    files: string[];
}

/** Content hashes and versions that make a result reproducible. */
function provenance(options: CliOptions): Provenance {
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
function boundaryOf(): BoundaryFact {
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

/**
 * The authored prompt bytes for kinds that add no destinations or framing,
 * or null when the case uses a generated template.
 */
function authoredPrompt(testCase: FullTrialCase, kind: string): string | null {
    if (kind === "diagnostic") return testCase.diagnosticPrompt ?? "";
    if (kind === "task") return testCase.taskPrompt ?? "";
    return null;
}

const promptFor = (testCase: FullTrialCase, options: CliOptions) => {
    // Discovery variant: the prompt names no destination and no tool — the
    // lakes are reachable only through the session's normal tool inventory
    // (the docs tool's own description points at `help`).
    const kind = promptKindOf(testCase);
    const authored = authoredPrompt(testCase, kind);
    if (authored !== null) return authored;
    const destinations =
        kind === "natural" || options.discovery
            ? ""
            : `Available documentation destinations:
${testCase.destinations
    .map(
        (destination: Destination) =>
            `- ${destination.name} (\`${destination.class}\`): ${destination.description}`,
    )
    .join("\n")}`;
    // Baseline decisions suppress writes; recording authorises them inside
    // the trial's own surfaces. Natural prompts are wholly undirected: no
    // destinations, no documentation framing, no required answer shape —
    // they measure whether the trigger happens unprompted.
    if (kind === "natural") {
        return `We have established the following finding.

Finding:
${testCase.claim}

Evidence:
${testCase.evidence}

What do you recommend we do, if anything?

Treat the evidence descriptions as supplied facts for this synthetic trial.
`;
    }
    const closing =
        kind === "recording"
            ? "Use your normal documentation guidance for this finding. For this trial, you are authorised to record documentation; changes are permitted only inside the trial's own documentation surfaces."
            : "Use your normal documentation guidance to decide how to preserve this finding. For this trial, do not change files.";
    const answerBlock =
        kind === "recording" && options.recordingClosing === "direct"
            ? `Perform the authorised recording now within the permitted documentation surfaces.
Then state:
- The action taken.
- The exact destination lake, or other documentation workflow.
- Whether you created or updated one document or several.
- A brief reason.
- Any unresolved issue.`
            : `State:
- Your intended action.
- The exact destination lake, or other documentation workflow.
- Whether this needs one document or several.
- A brief reason.
- Any clarification needed before proceeding.`;
    return `We have established the following finding.

Finding:
${testCase.claim}

Evidence:
${testCase.evidence}

${destinations ? `${destinations}\n\n` : ""}${closing}

${answerBlock}

Treat the evidence descriptions as supplied facts for this synthetic trial.
`;
};

const rubricFor = (testCase: FullTrialCase) => `# ${testCase.id} rubric

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

/**
 * The opt-in practical profile for ordinary-work task cases. The trial
 * container remains the physical boundary; the mutation policy, not this
 * tool-capability profile, owns path authority. The allow rules follow the
 * broad denies because OpenCode uses the last matching rule.
 */
const TASK_PERMISSIONS = [
    ...SANDBOX_PERMISSIONS,
    { action: "shell", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "allow" },
];

/** The permission rules a case's preparation and session carry. */
function permissionsFor(testCase: TrialCase) {
    return testCase.permissionProfile === "task"
        ? TASK_PERMISSIONS
        : SANDBOX_PERMISSIONS;
}

/**
 * The documentation surface a case's gates compare. Legacy recording cases
 * declared it implicitly through their whole mutation policy; task cases
 * separate task paths from the documentation lake explicitly.
 */
function docsSurfaceFor(testCase: TrialCase): string[] {
    return testCase.docsSurface ?? testCase.mutationPolicy?.allowed ?? [];
}

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

function writeWorkFiles(work: string, files: Record<string, string>) {
    for (const [name, contents] of Object.entries(files))
        write(join(work, name), contents);
}

/** Lake specs for the trial config; roots are relative to the work directory. */
function lakesFor(testCase: FullTrialCase) {
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
            (destination: Destination) => destination.class === "repo",
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

/**
 * The prepared-tree certification for one case fixture: a flat identity map
 * over the generator-written sandbox surfaces (`work`, `lakes`,
 * `config-home`, minus `.git`), keyed by surface-relative path. Files hash
 * their bytes, symlinks their target, directories their presence —
 * deterministic path/type/content/link identities with no transient
 * timestamps or permission bits, since modes can differ legitimately across
 * mount boundaries.
 */
function certifiedTreeSnapshot(caseFixture: string) {
    const entries = new Map();
    for (const surface of ["work", "lakes", "config-home"]) {
        const root = join(caseFixture, surface);
        if (!existsSync(root)) continue;
        const skip = surface === "work" ? [".git"] : undefined;
        for (const [name, entry] of walkTree(root, false, skip))
            entries.set(`${surface}/${name}`, entry);
    }
    return entries;
}

/** The certified map as a stable, sorted object (for the generation record). */
function certificationMap(entries: Map<string, TreeEntry>) {
    return Object.fromEntries(
        [...entries].sort(([a], [b]) => (a < b ? -1 : 1)),
    );
}

/**
 * Compare a recomputed prepared tree against the recorded certification.
 * Every recorded entry must exist with an identical identity, and the
 * prepared tree must contain nothing the record does not know.
 */
function certificationProblems(
    actual: Map<string, TreeEntry>,
    expected: Record<string, TreeEntry> | undefined,
) {
    if (!expected || typeof expected !== "object") {
        return [
            "the generation record certifies no prepared tree " +
                "(pre-v2 record); rerun generate --force",
        ];
    }
    const problems = [];
    for (const [path, entry] of Object.entries(expected)) {
        const now = actual.get(path);
        if (now === undefined) {
            problems.push(`prepared file ${path} is missing`);
        } else if (JSON.stringify(now) !== JSON.stringify(entry)) {
            problems.push(
                `prepared file ${path} does not match the recorded generation`,
            );
        }
    }
    for (const path of actual.keys()) {
        if (!(path in expected)) {
            problems.push(
                `prepared tree contains an unrecorded entry ${path}; rerun generate --force`,
            );
        }
    }
    return problems;
}

/** Create the case's work and lake directories, plus its code-shaped context. */
function buildFixtureTree(testCase: FullTrialCase, caseDir: string) {
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
            (destination: Destination) => destination.class === "repo",
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
function seedFixture(testCase: FullTrialCase, caseDir: string) {
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
function generationInputsHash(
    testCase: TrialCase,
    options: CliOptions,
): string {
    return sha256(
        JSON.stringify({
            generationVersion: GENERATION_VERSION,
            caseEntry: testCase,
            model: options.model,
            plugin: pluginIdentity(options).contentHash,
            lockHash: pluginIdentity(options).lockHash,
            discovery: options.discovery === true,
            recordingClosing: options.recordingClosing,
            permissions: permissionsFor(testCase),
            ...(testCase.primaryCheck
                ? { primaryCheckHash: primaryCheckSourceHash(testCase) }
                : {}),
        }),
    );
}

/** The file identities a generation record certifies. */
function generationOutputs(testCase: FullTrialCase, options: CliOptions) {
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
                permissions: permissionsFor(testCase),
            },
            null,
            2,
        ) + "\n";
    return { promptText, rubricText, caseJson, configJson };
}

/** Whether the recorded prompt, config and (when present) rubric are byte-intact. */
function fixtureOutputsIntact(
    options: CliOptions,
    fixture: FixturePaths,
    outputs: GenerationOutputs,
) {
    const matches = (path: string, text: string): boolean =>
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
function reusedFixtureRefusal(
    testCase: FullTrialCase,
    options: CliOptions,
    stored: GenerationRecord | undefined,
    fingerprint: string,
    fixture: FixturePaths,
): FixtureRefusal | null {
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
        const treeProblems = certificationProblems(
            certifiedTreeSnapshot(fixture.caseDir),
            stored.tree,
        );
        if (treeProblems.length > 0) {
            return {
                status: "incomplete",
                detail:
                    "prepared tree does not match the recorded generation " +
                    `(${treeProblems[0]}); rerun generate --force`,
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
function writeGeneratedFixture(
    testCase: FullTrialCase,
    options: CliOptions,
    fingerprint: string,
    fixture: FixturePaths,
) {
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
                schemaVersion: 2,
                id: testCase.id,
                inputsHash: fingerprint,
                generationVersion: GENERATION_VERSION,
                recordingClosing: options.recordingClosing,
                createdAt: new Date().toISOString(),
                files: {
                    promptHash: sha256(outputs.promptText),
                    configHash: sha256(outputs.configJson),
                    rubricHash: sha256(outputs.rubricText),
                },
                tree: certificationMap(certifiedTreeSnapshot(fixture.caseDir)),
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
function generateCase(
    testCase: FullTrialCase,
    options: CliOptions,
): GenerateOutcome {
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
    const storedAt = generationRecordAt(fixture.generationPath);
    const stored = storedAt.kind === "value" ? storedAt.value : undefined;
    if (storedAt.kind === "malformed") {
        return {
            status: "stale" as const,
            detail:
                `prepared generation record is malformed ` +
                `(${storedAt.problems.join("; ")}); rerun generate --force`,
        };
    }
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

/** One generate outcome: kept/created statuses or a refusal with detail. */
type GenerateOutcome =
    | { status: "kept" | "created" }
    | { status: "stale" | "incomplete"; detail: string };

function generateAll(options: CliOptions): number {
    const selected = select(options, true);
    assertRecordingClosingScope(selected, options);
    const rows: Array<[string, GenerateOutcome]> = [];
    let failures = 0;
    for (const testCase of selected) {
        if (!isFullCase(testCase)) {
            rows.push([
                testCase.id,
                {
                    status: "incomplete",
                    detail: "case entry lacks the claim/destinations a generation renders from",
                },
            ]);
            failures += 1;
            continue;
        }
        const outcome: GenerateOutcome = generateCase(testCase, options);
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
                : `${outcome.status} — ${"detail" in outcome ? outcome.detail : "?"}`;
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
 * Whether the selected entries carry full case definitions (a host flow,
 * where the run can recompute the frozen experiment identity) as opposed to
 * the stripped instrumentation-only run list a container receives.
 */
function selectedAreFullDefinitions(selected: TrialCase[]) {
    return (
        selected.length > 0 &&
        selected.every(
            (testCase) =>
                typeof testCase.claim === "string" &&
                Array.isArray(testCase.destinations) &&
                testCase.destinations.length > 0,
        )
    );
}

/** Output-hash problems for the rubric, when this host can see one. */
function rubricOutputProblems(
    stored: GenerationRecord,
    testCase: TrialCase,
    options: CliOptions,
) {
    if (!existsSync(options.rubrics)) return [];
    const rubricPath = join(options.rubrics, testCase.id, "rubric.md");
    if (!existsSync(rubricPath)) return ["no rubric generated"];
    if (stored.files?.rubricHash !== fileHash(rubricPath)) {
        return ["rubric does not match the recorded generation"];
    }
    return [];
}

/** Output-hash problems for one prepared generation (prompt/config/rubric). */
function generationOutputProblems(
    stored: GenerationRecord,
    testCase: TrialCase,
    options: CliOptions,
) {
    const problems = [];
    const promptPath = join(options.prompts, `${testCase.id}.md`);
    const configPath = join(
        options.fixtures,
        testCase.id,
        "work",
        "opencode.json",
    );
    if (!existsSync(promptPath)) problems.push("no prompt generated");
    else if (stored.files?.promptHash !== fileHash(promptPath))
        problems.push("prompt does not match the recorded generation");
    if (!existsSync(configPath)) problems.push("no fixture config generated");
    else if (stored.files?.configHash !== fileHash(configPath))
        problems.push("fixture config does not match the recorded generation");
    problems.push(...rubricOutputProblems(stored, testCase, options));
    return problems;
}

/** Input-fingerprint problems: recomputed on full flows; receipts in flows without one. */
function generationInputProblems(
    testCase: TrialCase,
    options: CliOptions,
    corpusComplete: boolean,
    stored: GenerationRecord,
) {
    if (corpusComplete) {
        const current = generationInputsHash(testCase, options);
        if (stored.inputsHash !== current) {
            return [
                "generation inputs changed since this fixture was generated " +
                    "(case, model, plugin or variant); rerun generate --force",
            ];
        }
        return [];
    }
    if (
        typeof testCase.generationInputsHash === "string" &&
        testCase.generationInputsHash !== stored.inputsHash
    ) {
        return [
            "the staged generation record does not match the frozen run corpus",
        ];
    }
    return [];
}

/** The prepared-tree identities to certify, rewalked against the record. */
function preparedTreeProblems(
    stored: GenerationRecord,
    testCase: TrialCase,
    options: CliOptions,
) {
    const caseFixture = join(options.fixtures, testCase.id);
    return certificationProblems(
        certifiedTreeSnapshot(caseFixture),
        stored.tree,
    );
}

/**
 * Validate that a run's prepared generation is current and unmutated.
 * Every run refuses missing/tampered prompt, config and (host-visible)
 * rubric outputs, and certifies the prepared tree — seeds, work files and
 * sandbox dirs hashed against the generation record, so a post-generation
 * edit to a seed (or any added or deleted file) cannot ride into a run.
 * Where the corpus carries full case definitions (host flow), the recorded
 * inputs hash is recomputed against the current case, model, plugin and
 * variant identities; the stripped container flow instead checks the
 * redacted list's embedded generation hash. A run never regenerates at all.
 */
function validateGeneration(
    testCase: TrialCase,
    options: CliOptions,
    corpusComplete: boolean,
) {
    const caseFixture = join(options.fixtures, testCase.id);
    const storedAt = generationRecordAt(join(caseFixture, "generation.json"));
    if (storedAt.kind === "malformed") {
        return {
            problems: [
                `prepared generation record is malformed ` +
                    `(${storedAt.problems.join("; ")}); rerun generate --force`,
            ],
            generation: undefined,
        };
    }
    if (storedAt.kind === "absent") {
        return {
            problems: ["no generation fingerprint; run generate first"],
            generation: undefined,
        };
    }
    const stored = storedAt.value;
    const problems = [
        ...generationOutputProblems(stored, testCase, options),
        ...generationInputProblems(testCase, options, corpusComplete, stored),
        ...preparedTreeProblems(stored, testCase, options),
    ];
    return { problems, generation: stored };
}

/* ------------------------------------------------------------------ *
 * Tree walking: mutation snapshot, prepared-tree certification, digests
 * ------------------------------------------------------------------ */

/**
 * Walk one directory tree, returning no entries when it is unreadable.
 * Dirent entries carry lstat semantics, so a symlinked directory shows as a
 * symlink and is never descended into. Unlike a snapshot walk, unreadable
 * directories surface to the caller for classification.
 */
function listDirents(directory: string) {
    return readdirSync(directory, { withFileTypes: true });
}

/**
 * One entry identity in a tree walk: kind plus whatever makes it finer —
 * file content hash, symlink target, and (when `withModes`) the permission
 * bits. Every kind's payload comes from its own equality-extracting helper;
 * everything is lstat-based, so links are never followed out of the tree.
 */
function walkEntry(path: string, item: Dirent, withModes: boolean): TreeEntry {
    if (item.isSymbolicLink()) return walkSymlinkEntry(path);
    if (item.isDirectory()) return walkDirectoryEntry(path, withModes);
    if (item.isFile()) return walkFileEntry(path, withModes);
    return walkOtherEntry(path, withModes);
}

/** A symlink entry records its target, never the content behind the link. */
function walkSymlinkEntry(path: string): TreeEntry {
    let target = "(unreadable)";
    try {
        target = readlinkSync(path);
    } catch {
        /* recorded as unreadable */
    }
    return { kind: "symlink", target };
}

/** A directory entry records its presence plus (optionally) its mode. */
function walkDirectoryEntry(path: string, withModes: boolean): TreeEntry {
    if (!withModes) return { kind: "dir" };
    try {
        return {
            kind: "dir",
            mode: `0${(lstatSync(path).mode & 0o7777).toString(8)}`,
        };
    } catch {
        return { kind: "dir", mode: "unreadable" };
    }
}

/** A file entry hashes its bytes, marked unreadable when it cannot be read. */
function walkFileEntry(path: string, withModes: boolean): TreeEntry {
    let hash = "unreadable";
    try {
        hash = fileHash(path);
    } catch {
        /* recorded as unreadable */
    }
    if (!withModes) return { kind: "file", hash };
    try {
        return {
            kind: "file",
            hash,
            mode: `0${(lstatSync(path).mode & 0o7777).toString(8)}`,
        };
    } catch {
        return { kind: "file", hash, mode: "unreadable" };
    }
}

/** Anything but a directory, file or symlink; kind plus mode when known. */
function walkOtherEntry(path: string, withModes: boolean): TreeEntry {
    if (!withModes) return { kind: "other" };
    try {
        return {
            kind: "other",
            mode: `0${(lstatSync(path).mode & 0o7777).toString(8)}`,
        };
    } catch {
        return { kind: "other", mode: "unreadable" };
    }
}

/**
 * Walk a root into a flat map of relative paths → {@link walkEntry} paths,
 * recursively. Unreadable directories are recorded as `unreachable:true`
 * entries with empty contents rather than swallowed: a silently empty
 * inventory would fake mutation evidence.
 * @param root Absolute root to walk.
 * @param withModes Whether entries carry permission bits.
 * @param skip Path-name segments (first component) to exclude, e.g. ".git".
 * @param prefix Optional path prefix applied to recorded relative names.
 * @returns A map of relative path to entry identity.
 */
function walkTree(
    root: string,
    withModes: boolean,
    skip: string[] | undefined,
    prefix: string = "",
): Map<string, TreeEntry> {
    const entries = new Map<string, TreeEntry>();
    const walk = (directory: string, prefixSeg: string): void => {
        let items;
        try {
            items = listDirents(directory);
        } catch {
            entries.set(`${prefixSeg}(unreadable)`, { kind: "dir-unreadable" });
            return;
        }
        for (const item of items) {
            const path = join(directory, item.name);
            const name = prefixSeg ? `${prefixSeg}${item.name}` : item.name;
            if (skip !== undefined && skip.includes(item.name)) continue;
            const entry = walkEntry(path, item, withModes);
            entries.set(name, entry);
            if (entry.kind === "dir" && item.isDirectory())
                walk(path, `${name}/`);
        }
    };
    walk(root, prefix);
    return entries;
}

/* ------------------------------------------------------------------ *
 * Mutation snapshot: final-state proof, symlink-aware
 * ------------------------------------------------------------------ */

/** Git files whose changes are reported as git state, not trial writes. */
function gitStateEntries(workRoot: string) {
    const git = join(workRoot, ".git");
    const entries = new Map();
    if (!existsSync(git)) return entries;
    const hashFile = (path: string): string => {
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
    const walk = (directory: string, prefix: string): void => {
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
 * their target, directories carry their permission mode. The snapshot
 * proves final-state changes: a transient write that reverts between two
 * snapshots is invisible without execution instrumentation (stated, not
 * hidden). An unreadable directory is recorded as an explicit
 * `dir-unreadable` entry rather than documented as an empty success: a
 * silently-empty inventory would fake mutation evidence. `.git` content is
 * tracked separately as git state, and never as a trial-visible snapshot
 * entry.
 */
function snapshotLive(live: string) {
    const entries = new Map();
    for (const surface of ["work", "lakes", "config-home"]) {
        const root = join(live, surface);
        if (!existsSync(root)) continue;
        const skip = surface === "work" ? [".git"] : undefined;
        for (const [name, entry] of walkTree(root, true, skip))
            entries.set(`${surface}/${name}`, entry);
    }
    return { entries, git: gitStateEntries(join(live, "work")) };
}

/** The change label between two entries of the same kind. */
function sameKindChangeLabel(
    kind: string,
    before: TreeEntry,
    after: TreeEntry,
): string {
    if (kind !== before.kind) return "";
    if (after.kind !== before.kind) return "";
    switch (before.kind) {
        case "file":
            return fileKindChangeLabel(before, after);
        case "symlink":
            return symlinkKindChangeLabel(before, after);
        case "dir":
            return dirKindChangeLabel(before, after);
        default:
            return "";
    }
}

/** Content first, then the permission-mode change between two files. */
function fileKindChangeLabel(before: TreeEntry, after: TreeEntry): string {
    if (before.kind !== "file" || after.kind !== "file") return "";
    if (before.hash !== after.hash) return "content";
    if (
        before.mode !== undefined &&
        after.mode !== undefined &&
        before.mode !== after.mode
    ) {
        return "mode";
    }
    return "";
}

/** The retarget change between two symlinks. */
function symlinkKindChangeLabel(before: TreeEntry, after: TreeEntry): string {
    if (before.kind !== "symlink" || after.kind !== "symlink") return "";
    return before.target !== after.target ? "target" : "";
}

/** The permission-only directory change between two dirs. */
function dirKindChangeLabel(before: TreeEntry, after: TreeEntry): string {
    if (before.kind !== "dir" || after.kind !== "dir") return "";
    if (before.mode === undefined) return "";
    if (after.mode === undefined) return "";
    return before.mode !== after.mode ? "mode" : "";
}

/**
 * One entry's change label for {@link snapshotDiff}: a kind change
 * (file→symlink replacement etc.) wins, then content/target, then — the
 * M08 gap — a permission-mode change that existed without any content or
 * target change at all.
 */
function entryChanged(before: TreeEntry, after: TreeEntry) {
    if (before.kind !== after.kind) return "kind";
    return sameKindChangeLabel(before.kind, before, after);
}

function snapshotDiff(before: Snapshot, after: Snapshot) {
    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    const kinds = new Map<string, string>();
    for (const [path, value] of after.entries) {
        const prior = before.entries.get(path);
        if (prior === undefined) {
            added.push(path);
            kinds.set(path, value.kind);
            continue;
        }
        const change = entryChanged(prior, value);
        if (change !== "") {
            modified.push(path);
            kinds.set(path, change);
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

const writeCount = (diff: WriteDiff) =>
    diff.added.length + diff.modified.length + diff.removed.length;

/** Glob match with `*` within a segment and `**` across segments. */
function globMatch(pattern: string, path: string) {
    const patternParts = pattern.split("/");
    const pathParts = path.split("/");
    const match = (p: string[], s: string[]): boolean => {
        if (p.length === 0) return s.length === 0;
        if (p[0] === "**") {
            for (let skip = 0; skip <= s.length; skip += 1) {
                if (match(p.slice(1), s.slice(skip))) return true;
            }
            return false;
        }
        if (s.length === 0) return false;
        const segment: string = p[0] ?? "";
        const test: string = s[0] ?? "";
        const part: string = segment
            .split("*")
            .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*");
        if (!new RegExp(`^${part}$`).test(test)) return false;
        return match(p.slice(1), s.slice(1));
    };
    return match(patternParts, pathParts);
}

/**
 * Whether a mutation is permitted by the case's explicit policy. Cases
 * without a policy are decision-only: no path is permitted. Git-state
 * changes are reported separately and never count as trial writes.
 */
function policyViolation(diff: WriteDiff, testCase: TrialCase) {
    const allowed = testCase.mutationPolicy?.allowed ?? [];
    const runtime = testCase.mutationPolicy?.runtimeAllow ?? [];
    const paths = [
        ...diff.added.map(
            (path: string) => [path, "added"] as [string, string],
        ),
        ...diff.modified.map(
            (path: string) => [path, "modified"] as [string, string],
        ),
        ...diff.removed.map(
            (path: string) => [path, "removed"] as [string, string],
        ),
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

function writesReport(diff: WriteDiff, violations: string[]) {
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
function writesLabel(report: string) {
    return report === ""
        ? "-"
        : report === "none"
          ? "none"
          : `${report.split("\n").filter(Boolean).length} file(s)`;
}

/**
 * The structured Writes column: mutation evidence from meta.json — path
 * counts and policy violations — with the report-line count kept only as
 * the legacy fallback when a stamp predates structured `writes`.
 * @param meta The result's meta.json, when present.
 * @param report The writes.txt text.
 */
function writesColumn(meta: MetaRecord, report: string) {
    if (meta === null || typeof meta.writes !== "number")
        return writesLabel(report);
    const violations = Array.isArray(meta.policyViolations)
        ? meta.policyViolations.length
        : 0;
    if (meta.writes === 0 && violations === 0) return "none";
    return `${meta.writes} file(s)${violations > 0 ? ` + ${violations} violation(s)` : ""}`;
}

/** Front-matter problems (Area / Keywords / Summary present and nonblank). */
function invalidFrontMatterReason(frontMatter: string[]) {
    for (const field of ["Area:", "Keywords:", "Summary:"]) {
        if (
            !frontMatter.some(
                (line) =>
                    line.startsWith(field) &&
                    line.slice(field.length).trim() !== "",
            )
        ) {
            return `front-matter ${field.slice(0, -1)} missing or blank`;
        }
    }
    return null;
}

/** Body problems: an H1, a claim section, and a nonempty claim body. */
function invalidClaimBodyReason(body: string[]) {
    if (!body.some((line) => line.startsWith("# "))) return "no H1 heading";
    const claimHeading =
        /^(#{2,3})\s*(Facts|Inferred|Tested|Failed approaches|Open questions)\s*$/;
    const headingIndex = body.findIndex((line) => claimHeading.test(line));
    if (headingIndex === -1) return "no claim section";
    if (!body.slice(headingIndex + 1).some((line) => line.trim() !== "")) {
        return "empty claim section";
    }
    return null;
}

/**
 * Deterministic structural validity of a recorded knowledge document,
 * mirroring the writing convention the plugin serves: front-matter with
 * nonblank Area, Keywords and Summary; an H1; and a claim section (Facts /
 * Inferred / Tested / Failed approaches / Open questions) with a nonempty
 * body. Returns the first structural problem, or null.
 * @param text The document body.
 */
function invalidKnowledgeDocReason(text: string) {
    const lines = text.split("\n");
    if (lines[0]?.trim() !== "---") return "no front-matter";
    let end = 1;
    while (end < lines.length && lines[end] !== "---") end += 1;
    if (end >= lines.length) return "unterminated front-matter";
    const problems = [
        invalidFrontMatterReason(lines.slice(1, end)),
        invalidClaimBodyReason(lines.slice(end + 1)),
    ];
    return problems.find((problem) => problem !== null) ?? null;
}

/** A bounded, visibly-truncated excerpt of a recorded artefact. */
function artefactExcerpt(path: string, text: string, limit: number = 1200) {
    return text.length > limit
        ? `${text.slice(0, limit)}\n<excerpt truncated at ${limit} bytes — the full recorded document lives at ${path}>`
        : text;
}

/**
 * The problems a recorded meta carries for its final-state digest, or null
 * when no digest is recorded or the re-snapshot matches.
 * @param meta The run's meta.json.
 * @param snapshot The re-walked live snapshot.
 * @returns The digest refusal, or null when evidence is intact.
 */
function digestMismatchProblem(
    meta: MetaRecord,
    snapshot: Snapshot,
): string | null {
    const metaDigest = meta?.finalStateDigest;
    if (
        typeof metaDigest === "string" &&
        snapshotDigest(snapshot) !== metaDigest
    ) {
        return (
            "recorded mutation evidence altered after the run " +
            "(final-state digest mismatch)"
        );
    }
    return null;
}

/**
 * The kinds labels of a recorded write diff in their Map contract: the
 * labels ride meta.json as an object form, so a Map is restored before
 * every consumer reduces over it. A non-object kinds (refused by the
 * validators upstream) degrades to no labels.
 * @param diff The recorded write diff.
 * @returns The change-kind labels per recorded path.
 */
function recordedKinds(diff: WriteDiff): Map<string, string> {
    if (diff.kinds instanceof Map) return diff.kinds;
    return isRecord(diff.kinds)
        ? new Map(Object.entries(diff.kinds))
        : new Map();
}

/**
 * The recorded mutation evidence a recording gate works from: the live
 * tree re-snapshotted and digest-verified against meta, the recorded
 * write diff, and the in-policy surface slice of it.
 * @param resultDir The case's result directory (its `live` tree is read).
 * @param meta The run's meta.json.
 * @param definition The case definition.
 * @returns The evidence fields, or the refusal problem.
 */
function recordedMutationEvidence(
    resultDir: string,
    meta: MetaRecord,
    definition: TrialCase,
) {
    const liveDir = join(resultDir, "live");
    const snapshot = snapshotLive(liveDir);
    const digestProblem = digestMismatchProblem(meta, snapshot);
    if (digestProblem !== null) return { problem: digestProblem };
    const diff = meta?.writeKinds;
    if (!diff || !Array.isArray(diff.added)) {
        return {
            problem:
                "recording case predates structured write evidence; " +
                "re-run with the current harness",
        };
    }
    const kinds = recordedKinds(diff);
    const surface = docsSurfaceFor(definition);
    const touched = [
        ...diff.added.map(
            (path: string) => [path, "added"] as [string, string],
        ),
        ...diff.modified.map(
            (path: string) => [path, "modified"] as [string, string],
        ),
        ...diff.removed.map(
            (path: string) => [path, "removed"] as [string, string],
        ),
    ];
    const onSurface = (path: string): boolean =>
        surface.some((pattern) => globMatch(pattern, path));
    const surfaceTouched = touched.filter(([path]) => onSurface(path));
    return {
        problem: null,
        liveDir,
        snapshot,
        diff: { ...diff, kinds },
        onSurface,
        surfaceTouched,
    };
}

/**
 * Whether a stale marker survives as the seeded claim it superseded. A
 * replacement may legitimately discuss the old value (for example "setup
 * rejects Node 22"), so literal presence alone is not evidence that the
 * stale assertion remains. The seed defines the claim: the gate fails only
 * when a non-empty seed line containing the marker survives verbatim. A
 * seed without such a line keeps the literal-absence rule; semantic
 * correctness stays with the judge.
 * @param text The replaced document bytes.
 * @param seedText The seeded predecessor bytes, or null when there is none.
 * @param stale The `omits` marker.
 */
function staleMarkerSurvives(
    text: string,
    seedText: string | null,
    stale: string,
): boolean {
    if (seedText === null) return text.includes(stale);
    const claimLines = seedText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && line.includes(stale));
    if (claimLines.length === 0) return text.includes(stale);
    const present = new Set(text.split("\n").map((line) => line.trim()));
    return claimLines.some((line) => present.has(line));
}

/**
 * The seeded predecessor bytes for a replace target, or null when the case
 * carries none (for example a created document).
 * @param definition The case definition holding the seeds.
 * @param target The surface-qualified replace target.
 */
function seededPredecessor(
    definition: TrialCase,
    target: string,
): string | null {
    for (const seed of definition.seeds ?? []) {
        if (`${seed.surface}/${seed.path}` !== target) continue;
        return typeof seed.contents === "string" ? seed.contents : null;
    }
    return null;
}

/**
 * The gate's content checks for one expectation-fulfilling document:
 * structural validity, required content, superseded seeded claims and link
 * references.
 * @param path The document's surface-relative path.
 * @param text The recorded document bytes.
 * @param expectation The case's `expectedDocs` object.
 * @param what What the document did (created / replaced), for messages.
 * @param seedText The seeded predecessor bytes for a replace target, or null.
 */
function docContentProblem(
    path: string,
    text: string,
    expectation: ExpectedDocs,
    what: string,
    seedText: string | null,
): string | null {
    const structural = invalidKnowledgeDocReason(text);
    if (structural !== null) {
        return `${what} ${path} is not a structurally valid knowledge doc (${structural})`;
    }
    for (const keep of expectation.retains ?? []) {
        if (!text.includes(keep)) {
            return `${what} ${path} lost required content: ${JSON.stringify(keep)}`;
        }
    }
    for (const stale of expectation.omits ?? []) {
        if (staleMarkerSurvives(text, seedText, stale)) {
            return `${what} ${path} still carries superseded content: ${JSON.stringify(stale)}`;
        }
    }
    if (expectation.link !== undefined && !text.includes(expectation.link)) {
        return `${what} ${path} does not reference ${JSON.stringify(expectation.link)}`;
    }
    return null;
}

/** The recorded bytes of one expected artefact, or null when unreadable. */
function recordedDocBytes(liveDir: string, snapshot: Snapshot, path: string) {
    const entry = snapshot.entries.get(path);
    if (entry === undefined || entry.kind !== "file") return null;
    try {
        return readFileSync(join(liveDir, path), "utf8");
    } catch {
        return null;
    }
}

/** The plugin's collection rule skips these areas in a knowledge lake's root. */
const KNOWLEDGE_EXCLUDED_AREAS = ["plans", "requirements", "wiki"];

/**
 * The lake-root anchors the case's own mutation policy implies: a `x/**`
 * pattern authorises exactly the tree at `x`, so the collection rule can be
 * applied lake-relative without recomputing the trial's lake config.
 */
function policyLakeRoots(_evidence: MutationEvidence, definition: TrialCase) {
    return docsSurfaceFor(definition)
        .filter((pattern) => pattern.endsWith("/**"))
        .map((pattern) => pattern.slice(0, -3));
}

/**
 * The plugin's collection rule, mirrored from `uncollectedSegment`: the
 * first lake-relative segment that keeps a doc out of the index, or null
 * when collection reaches it. Dot directories and `node_modules` are
 * skipped at any depth; knowledge lakes skip the scratch/mirror areas at
 * the top only. (ponytail: every sandbox lake is knowledge-profiled, so the
 * wiki-profile exemption is not modelled — a wiki-lake recording criterion
 * would over-reject here.)
 * @returns The refusal detail, or null when the doc is collectable.
 */
function uncollectableDocReason(path: string, roots: string[]): string | null {
    for (const root of roots) {
        if (path !== root && !path.startsWith(`${root}/`)) continue;
        const segments = path.slice(root.length + 1).split("/");
        for (const [index, segment] of segments.entries()) {
            if (segment.startsWith(".") || segment === "node_modules") {
                return `hidden or ignored segment '${segment}' — the plugin's collector never indexes it`;
            }
            if (
                index === 0 &&
                (KNOWLEDGE_EXCLUDED_AREAS as string[]).includes(segment)
            ) {
                return `scratch or mirror area '${segment}' — knowledge lakes never collect it`;
            }
        }
        return null;
    }
    return null;
}

/**
 * Newly added directories that are plain ancestors of an expected path:
 * creating `a/b/c.md` must create `a` and `a/b`, so the parent-of chain of
 * an expected document is necessary mutation evidence, not an unrelated
 * surface change. Everything else — unrelated empty directories, symlinks,
 * mode changes, extra files — still counts.
 * @returns The added ancestor-directory paths of the expected docs.
 */
function necessaryAncestorDirs(
    evidence: MutationEvidence,
    expectedPaths: string[],
): string[] {
    return evidence.diff.added.filter(
        (path) =>
            evidence.snapshot.entries.get(path)?.kind === "dir" &&
            expectedPaths.some((expected) => expected.startsWith(`${path}/`)),
    );
}

/**
 * The plugin's own publication housekeeping: `.docs-lock` is created beside
 * the target's deepest existing ancestor while a write is in flight, and its
 * lock file is removed on release — the now-empty directory remains. Only
 * that exact shape is permitted: an added, empty, readable directory named
 * `.docs-lock`, inside the documentation surface, sited at an ancestor of an
 * expected document (beside the target or higher while its parents were
 * created). A symlink, a directory holding anything, a stale lock file, or one
 * anywhere else remains an unrelated change.
 * @param evidence The recorded mutation evidence.
 * @param expectedPaths The case's expected document paths.
 * @returns The permitted housekeeping directory paths.
 */
function pluginLockHousekeeping(
    evidence: MutationEvidence,
    expectedPaths: string[],
): string[] {
    return evidence.diff.added.filter((path) => {
        if (basename(path) !== ".docs-lock") return false;
        if (!evidence.onSurface(path)) return false;
        const entry = evidence.snapshot.entries.get(path);
        if (entry?.kind !== "dir" || entry.mode === "unreadable") return false;
        // Empty means the release removed its lock file. A remaining child is
        // a stale/foreign object and stays a finding.
        if (
            [...evidence.snapshot.entries.keys()].some((candidate) =>
                candidate.startsWith(`${path}/`),
            )
        ) {
            return false;
        }
        const parent = dirname(path);
        return expectedPaths.some((expected) =>
            expected.startsWith(`${parent}/`),
        );
    });
}

/** Whether anything besides the expected paths changed inside the surface. */
function unrelatedSurfaceChangeProblem(
    evidence: MutationEvidence,
    expectedPaths: string[],
): string | null {
    const permitted = [
        ...expectedPaths,
        ...necessaryAncestorDirs(evidence, expectedPaths),
        ...pluginLockHousekeeping(evidence, expectedPaths),
    ];
    const others = evidence.surfaceTouched.filter(
        ([path]) => !permitted.includes(path),
    );
    if (others.length === 0) return null;
    return (
        "unrelated change(s) inside the documentation surface: " +
        others
            .map(
                ([path, action]) =>
                    `${action} ${path} (${evidence.diff.kinds.get(path) ?? "file"})`,
            )
            .join(", ")
    );
}

/** Replace-verb expectations: target modified in place, content valid. */
function replaceDocVerdict(
    evidence: MutationEvidence,
    expectation: ExpectedDocs,
    definition: TrialCase,
): GateVerdict {
    const target = expectation.target;
    if (target === undefined) {
        return { problem: "replace expectation without a target path" };
    }
    if (evidence.diff.removed.includes(target)) {
        return { problem: `expected replacement target ${target} was deleted` };
    }
    if (!evidence.diff.modified.includes(target)) {
        return {
            problem:
                `expected replacement of ${target} did not happen ` +
                "(unchanged; a second doc or an unrelated change cannot satisfy this case)",
        };
    }
    const text = recordedDocBytes(evidence.liveDir, evidence.snapshot, target);
    if (text === null) {
        return {
            problem: `expected replacement target ${target} is not a readable regular file`,
        };
    }
    const content = docContentProblem(
        target,
        text,
        expectation,
        "replaced",
        seededPredecessor(definition, target),
    );
    if (content !== null) return { problem: content };
    const others = unrelatedSurfaceChangeProblem(evidence, [target]);
    if (others !== null) return { problem: others };
    return {
        problem: null,
        artifacts: [{ path: target, excerpt: artefactExcerpt(target, text) }],
    };
}

/**
 * Restraint expectations: the complete documentation surface must be
 * identical to its seed. Creations, substantive changes, deletions and
 * replacements all fail; plugin lock housekeeping is also a failure because
 * it is evidence a write was attempted. Preserved notes are returned as
 * judge evidence so the judge sees the actual unchanged state.
 */
function restraintVerdict(
    evidence: MutationEvidence,
    expectation: ExpectedDocs,
): GateVerdict {
    if (evidence.surfaceTouched.length > 0) {
        return {
            problem:
                "restraint failed: the documentation surface changed " +
                `(${evidence.surfaceTouched
                    .map(([path, action]) => `${action} ${path}`)
                    .join(", ")}); a permitted but unnecessary note is a ` +
                "behavioural restraint failure, not a policy violation",
        };
    }
    const artifacts = (expectation.preserve ?? []).flatMap((path) => {
        const text = recordedDocBytes(
            evidence.liveDir,
            evidence.snapshot,
            path,
        );
        return text === null
            ? []
            : [{ path, excerpt: artefactExcerpt(path, text) }];
    });
    return { problem: null, artifacts };
}

/** Create-verb expectations: exactly one valid, collectable knowledge doc. */
function createDocVerdict(
    evidence: MutationEvidence,
    expectation: ExpectedDocs,
    definition: TrialCase,
): GateVerdict {
    const candidates = evidence.diff.added
        .filter((path) => evidence.onSurface(path) && path.endsWith(".md"))
        .filter((path) => evidence.snapshot.entries.get(path)?.kind === "file");
    if (candidates.length === 0) {
        return {
            problem:
                "no created knowledge doc inside the documentation surface " +
                "(directory-only changes, junk files and non-Markdown files cannot satisfy a required knowledge write)",
        };
    }
    if (candidates.length > 1) {
        return {
            problem:
                `several docs created inside the documentation surface ` +
                `(${candidates.join(", ")})`,
        };
    }
    const path = candidates[0];
    if (path === undefined) {
        return { problem: "no documented candidate despite a non-empty list" };
    }
    const text = recordedDocBytes(evidence.liveDir, evidence.snapshot, path);
    if (text === null) {
        return {
            problem: `created doc ${path} is not a readable regular file`,
        };
    }
    const uncollectable = uncollectableDocReason(
        path,
        policyLakeRoots(evidence, definition),
    );
    if (uncollectable !== null) {
        return {
            problem:
                `created doc ${path} is not collectable knowledge ` +
                `(${uncollectable}): a recording case cannot be satisfied ` +
                "by a doc the plugin never indexes",
        };
    }
    const content = docContentProblem(path, text, expectation, "created", null);
    if (content !== null) return { problem: content };
    const others = unrelatedSurfaceChangeProblem(evidence, [path]);
    if (others !== null) return { problem: others };
    return {
        problem: null,
        artifacts: [{ path, excerpt: artefactExcerpt(path, text) }],
    };
}

/** Preserved paths may show up nowhere in the recorded diff. */
function preservedPathProblem(
    evidence: MutationEvidence,
    expectation: ExpectedDocs,
): string | null {
    for (const path of expectation.preserve ?? []) {
        const touchedPath = [
            ...evidence.diff.added.map((p) => [p, "added"]),
            ...evidence.diff.modified.map((p) => [p, "modified"]),
            ...evidence.diff.removed.map((p) => [p, "removed"]),
        ].find(([p]) => p === path);
        if (touchedPath) {
            return `preserved ${path} was ${touchedPath[1]} by the run; the expectation requires it untouched`;
        }
    }
    return null;
}

/**
 * The deterministic artefact gate of a recording case, from its SAVED
 * definition (`expectedDocs`, M01/M05): create/replace expectations,
 * structural validity, required/absent content, link references,
 * preserved untouched paths and the single-document surface rule. The
 * recorded live tree is first verified against the run's own final-state
 * digest, so post-run edits to mutation evidence are refused rather than
 * graded. An empty directory, a junk or non-Markdown file, a wrong target,
 * an unrelated in-policy edit, or a deletion of the target cannot satisfy
 * a required knowledge write. Legacy definitions without `expectedDocs`
 * skip the gate (a stated limitation of those runs, not a pass).
 * @param resultDir The case's result directory (its `live` tree is read).
 * @param meta The run's meta.json.
 * @param definition The case definition.
 * @returns The gate verdict: `problem` null when met, else the refusal and
 *   always-empty artefacts; on success the verified artefact list.
 */
function expectedDocsGate(
    resultDir: string,
    meta: MetaRecord,
    definition: TrialCase,
) {
    const expectation = definition?.expectedDocs;
    if (!expectation) return { problem: null, artifacts: [] };
    const evidence = recordedMutationEvidence(resultDir, meta, definition);
    if (evidence.problem !== null) {
        return { problem: evidence.problem, artifacts: [] };
    }
    const preserved = preservedPathProblem(evidence, expectation);
    if (preserved !== null) return { problem: preserved, artifacts: [] };
    const verdict =
        expectation.kind === "none"
            ? restraintVerdict(evidence, expectation)
            : expectation.kind === "replace"
              ? replaceDocVerdict(evidence, expectation, definition)
              : createDocVerdict(evidence, expectation, definition);
    return { ...verdict, artifacts: verdict.artifacts ?? [] };
}

/* ------------------------------------------------------------------ *
 * The immutable run description (run.json)
 * ------------------------------------------------------------------ */

/**
 * The execution boundary of the TRIALS this stamp describes, as passed by
 * the wrapper: `PLACEMENT_TRIAL_IMAGE(_ID)` name the container the cases
 * run in, set at describe time. Absent means the trials run on the host.
 * This is deliberately distinct from {@link provenance} (the orchestrating
 * process's own facts): host orchestration and the trial containers are
 * different processes with different identities.
 */
function trialBoundaryOf(): BoundaryFact {
    const image = process.env.PLACEMENT_TRIAL_IMAGE ?? "";
    const imageId = process.env.PLACEMENT_TRIAL_IMAGE_ID ?? "";
    const containerised = image !== "" || imageId !== "";
    return {
        containerised,
        kind: containerised ? "container" : "host",
        image,
        imageId,
    };
}

/**
 * The frozen description of one experiment: every input identity and
 * setting that labels its evidence, captured at run time and never
 * recomputed from reporting-time defaults. `trialBoundary` records the
 * trials' actual container/image; `orchestration` records the freezing
 * process's identity; each case's own per-run facts stay in meta.json.
 */
function runDescription(
    options: CliOptions,
    stamp: string,
    selected: TrialCase[],
    command: string,
) {
    return {
        schemaVersion: RUN_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        stamp,
        harnessVersion: HARNESS_VERSION,
        command,
        variant: options.discovery ? "discovery" : "destinations",
        recordingClosing: options.recordingClosing,
        model: options.model,
        judgeModel: options.judgeModel || null,
        ...(options.condition ? { condition: options.condition } : {}),
        namingMapVersion: NAMING_MAP_VERSION,
        timeoutMs: options.timeoutMs,
        allowWrites: options.allowWrites === true,
        jobs: options.jobs,
        trialBoundary: trialBoundaryOf(),
        orchestration: provenance(options),
        caseIds: selected.map((testCase) => testCase.id),
        cases: selected.map((testCase) => ({
            id: testCase.id,
            expected: testCase.expected,
            mutationPolicy: testCase.mutationPolicy ?? null,
            docsCriterion: testCase.docsCriterion ?? null,
            expectedDocs: testCase.expectedDocs ?? null,
            ...(scenarioDisplayFor(testCase.id) === undefined
                ? {}
                : { display: scenarioDisplayFor(testCase.id) }),
            definition: testCase,
        })),
    };
}

/**
 * An atomic, exclusively-replaced file write through a temporary file and a
 * rename, so a stamp's frozen description never appears half-written to a
 * concurrent reader.
 * @param path The destination path.
 * @param contents The file body.
 */
function writeJsonAtomic(path: string, contents: string) {
    const tmp = `${path}.tmp-${process.pid}`;
    write(tmp, contents);
    renameSync(tmp, path);
}

/**
 * The frozen facts two descriptions of a run must agree on — model, judge
 * model, variant, timeout, write authorisation and the case list, plus
 * (host flows) the fixture/plugin identities and each case's full
 * definition. Facts that legitimately differ between orchestrating
 * processes — creation time, command, job counts, per-process provenance
 * and boundary — are excluded.
 * @param existing The stored description.
 * @param description The description computed now.
 * @param containerFlow Whether this verification runs under a stripped
 *   corpus (staged container), which carries no definitional authority.
 * @returns Conflict strings of the form "field: stored vs current".
 */
/** Field-value conflicts between a stored and a computed description. */
function comparedFieldConflicts(
    existing: RunDescription,
    description: RunDescription,
    compared: Array<keyof RunDescription>,
): string[] {
    const conflicts: string[] = [];
    for (const field of compared) {
        if (
            JSON.stringify(existing[field]) !==
            JSON.stringify(description[field])
        ) {
            conflicts.push(
                `${field}: ${JSON.stringify(existing[field])} vs ` +
                    `${JSON.stringify(description[field])}`,
            );
        }
    }
    return conflicts;
}

/** Definition-level conflicts: counts and each case's frozen definition. */
function definitionConflicts(
    existingCases: RunCase[],
    currentCases: RunCase[],
) {
    if (existingCases.length !== currentCases.length) {
        return [
            "cases: " +
                `${existingCases.length} frozen vs ${currentCases.length} selected`,
        ];
    }
    for (const current of currentCases) {
        const prior = existingCases.find((entry) => entry.id === current.id);
        if (
            JSON.stringify(prior?.definition) !==
            JSON.stringify(current.definition)
        ) {
            return [
                `definition of ${current.id} differs from the frozen experiment`,
            ];
        }
    }
    return [];
}

/**
 * Conflicts in saved labels that a legacy description may legitimately omit.
 * A present saved value is part of the experiment identity; an absent one is
 * never relabelled by a new invocation.
 */
function optionalLabelConflicts(
    existing: RunDescription,
    description: RunDescription,
): string[] {
    const conflicts: string[] = [];
    for (const field of ["condition", "recordingClosing"] as const) {
        if (
            existing[field] !== undefined &&
            existing[field] !== description[field]
        ) {
            conflicts.push(
                `${field}: ${JSON.stringify(existing[field])} vs ` +
                    `${JSON.stringify(description[field])}`,
            );
        }
    }
    return conflicts;
}

function runDescriptionConflicts(
    existing: RunDescription,
    description: RunDescription,
    containerFlow: boolean,
): string[] {
    const legacy = (existing.schemaVersion ?? 1) < RUN_SCHEMA_VERSION;
    const compared: Array<keyof RunDescription> =
        containerFlow || legacy
            ? [
                  "variant",
                  "model",
                  "judgeModel",
                  "timeoutMs",
                  "allowWrites",
                  "caseIds",
              ]
            : [
                  "variant",
                  "model",
                  "judgeModel",
                  "timeoutMs",
                  "allowWrites",
                  "caseIds",
                  "orchestration",
              ];
    const conflicts = comparedFieldConflicts(existing, description, compared);
    conflicts.push(...optionalLabelConflicts(existing, description));
    // Full-corpus flows compare the authoritative definitions too, so a
    // corpus edit cannot relabel a frozen experiment.
    if (!containerFlow && !legacy) {
        conflicts.push(
            ...definitionConflicts(
                existing.cases ?? [],
                description.cases ?? [],
            ),
        );
    }
    return conflicts;
}

/**
 * Write the stamp's run description once. Re-verification is strict and
 * identity-aware: on a host the full description (definitions included)
 * must match, so a corpus edit, a different plugin or changed settings
 * cannot relabel a frozen experiment; a staged container verifies the
 * experiment's identity knobs against the stripped corpus it can see. An
 * absent freeze is refused everywhere: a filesystem permission error is
 * not evidence that another process recorded the description correctly.
 */

/**
 * Verify a container flow's per-case host-freeze receipts: every selected
 * case must hold a frozen.json naming this stamp and case. A missing or
 * malformed receipt stays unverified — never assumed evidence of a freeze.
 */
function containerFreezesVerified(
    options: CliOptions,
    stamp: string,
    selected: TrialCase[],
): boolean {
    const unverified = selected.filter((testCase) => {
        const receiptAt = freezeReceiptAt(
            join(options.fixtures, testCase.id, "frozen.json"),
        );
        const receipt =
            receiptAt.kind === "value" ? receiptAt.value : undefined;
        return (
            !receipt ||
            receipt.kind !== "placement-freeze-receipt" ||
            receipt.stamp !== stamp ||
            receipt.caseId !== testCase.id
        );
    });
    if (unverified.length > 0) {
        console.error(
            `no verified host freeze for ${unverified.map((testCase) => testCase.id).join(", ")} — ` +
                "the per-case 'frozen.json' receipt is absent or does not " +
                `name stamp ${stamp}; freeze host-side ('describe') before running`,
        );
        return false;
    }
    return true;
}

/** A new freeze must not label a prepared generation it does not own. */
function preparedGenerationRefusal(
    options: CliOptions,
    selected: TrialCase[],
): string | null {
    if (!selectedAreFullDefinitions(selected)) return null;
    const stale = selected
        .map((testCase) => ({
            id: testCase.id,
            problems: validateGeneration(testCase, options, true).problems,
        }))
        .filter((entry) => entry.problems.length > 0);
    if (stale.length === 0) return null;
    return (
        `prepared generation does not match the frozen experiment: ` +
        stale
            .map((entry) => `${entry.id} (${entry.problems.join("; ")})`)
            .join(", ")
    );
}

/** Re-verify an existing freeze without rewriting its saved metadata. */
function existingDescriptionVerified(
    existing: RunDescription,
    description: RunDescription,
    path: string,
    containerFlow: boolean,
) {
    const conflicts = runDescriptionConflicts(
        existing,
        description,
        containerFlow,
    );
    if (conflicts.length === 0) return true;
    console.error(
        `run.json at ${path} already describes a different ` +
            `experiment (${conflicts.join("; ")}); use a new --stamp`,
    );
    return false;
}

function ensureRunDescription(
    options: CliOptions,
    stamp: string,
    selected: TrialCase[],
    command: string,
) {
    const path = join(options.results, stamp, "run.json");
    const existingAt = runDescriptionAt(path);
    if (existingAt.kind === "malformed") {
        console.error(
            `run.json at ${path} exists but is malformed ` +
                `(${existingAt.problems.join("; ")}); a frozen experiment ` +
                "cannot be rewritten this way — use a new --stamp",
        );
        return false;
    }
    const existing = existingAt.kind === "value" ? existingAt.value : undefined;
    const containerFlow =
        !selectedAreFullDefinitions(selected) ||
        boundaryOf().containerised === true;
    const description = runDescription(options, stamp, selected, command);
    if (existing !== undefined) {
        return existingDescriptionVerified(
            existing,
            description,
            path,
            containerFlow,
        );
    }
    // A new freeze must not label a prepared generation it does not own.
    // The full corpus is authoritative here, so a changed model, plugin,
    // variant or case definition refuses before any container stages a
    // prompt whose config carries different inputs.
    const generationRefusal = preparedGenerationRefusal(options, selected);
    if (generationRefusal !== null) {
        console.error(generationRefusal);
        return false;
    }
    if (boundaryOf().containerised === true) {
        // Inside a trial container this stamp's run description is neither
        // visible nor writable: the freeze must have happened host-side, and
        // this case must carry a receipt proving it (the wrapper stages one
        // after 'describe')
        return containerFreezesVerified(options, stamp, selected);
    }
    try {
        writeJsonAtomic(path, JSON.stringify(description, null, 2) + "\n");
    } catch (error: unknown) {
        const code =
            error instanceof Error ? (error as { code?: string }).code : null;
        console.error(`cannot freeze ${path} (${code ?? String(error)})`);
        return false;
    }
    return true;
}

/** How a stamp's run.json reads: a value, an absent legacy record, or the
 * problems that make it unusable. */
function loadRunDescription(options: CliOptions, stamp: string) {
    const runPath = join(options.results, stamp, "run.json");
    return { path: runPath, ...runDescriptionAt(runPath) };
}

/* ------------------------------------------------------------------ *
 * Running trials
 * ------------------------------------------------------------------ */

/** The default grace window between SIGTERM and SIGKILL, env-overridable for tests. */
function termGraceFromEnv() {
    const value = Number(process.env.TRIAL_TERM_GRACE_MS ?? 5_000);
    return Number.isFinite(value) && value > 0 ? value : 5_000;
}

/** The exact argv of one session call, shared by the spawn and its evidence. */
function opencodeArgs(args: CallArgs): string[] {
    return [
        "run",
        "--standalone",
        "--auto",
        "--archived",
        "--title",
        args.title,
        "--model",
        args.model,
        "--format",
        "json",
        ...(args.printLogs === true ? ["--print-logs"] : []),
        args.prompt,
    ];
}

/**
 * Spawn one OpenCode session call and collect its output. Bounds: the
 * per-call timeout first sends SIGTERM, then SIGKILL after a short grace
 * — an ignoring child cannot hold the harness (a kill-terminated child
 * resolves at exit, not at stdio drain). Overflow is counted once per
 * stream: when the incoming bytes pass the capture limit, further chunks
 * are dropped and the overflow flag invalidates results that require a
 * complete trail. Returns completion metadata (status/signal/error/timeout/
 * escalation/overflow/byte counts) alongside the retained stdout/stderr.
 * @param args The bound options object.
 * @param args.cwd The session working directory.
 * @param args.env The child environment.
 * @param args.model The model route.
 * @param args.title The session title flag value.
 * @param args.prompt The prompt text.
 * @param args.opencode The CLI binary.
 * @param args.timeoutMs The per-call timeout.
 */
function opencodeCall(args: CallArgs): Promise<SpawnResult> {
    const { cwd, env, opencode, timeoutMs } = args;
    return new Promise((resolve: (value: SpawnResult) => void) => {
        let child: import("child_process").ChildProcess;
        try {
            child = spawn(opencode, opencodeArgs(args), {
                cwd,
                env,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error: unknown) {
            resolve({
                stdout: "",
                stderr: "",
                status: null,
                signal: null,
                error: error as NodeJS.ErrnoException,
                timedOut: false,
                killEscalated: false,
                outputOverflow: false,
                stdoutBytes: 0,
                stderrBytes: 0,
            });
            return;
        }
        /** Chunked retention: chunks are kept until the cap, counted always. */
        const freshStream = (): CapturedStream => ({
            chunks: [],
            bytes: 0,
            overflow: false,
        });
        const streams: Record<"stdout" | "stderr", CapturedStream> = {
            stdout: freshStream(),
            stderr: freshStream(),
        };
        const appendChunk = (
            name: "stdout" | "stderr",
            chunk: Buffer | string,
        ) => {
            const state = streams[name];
            state.bytes += chunk.length;
            if (state.overflow) return;
            if (state.bytes > MAX_BUFFER) {
                state.overflow = true;
                return;
            }
            state.chunks.push(String(chunk));
        };
        child.stdout?.on("data", (chunk) => appendChunk("stdout", chunk));
        child.stderr?.on("data", (chunk) => appendChunk("stderr", chunk));

        let killed = false;
        let escalated = false;
        let settled = false;
        let escalateTimer: NodeJS.Timeout | null = null;
        const timer = setTimeout(() => {
            killed = true;
            child.kill("SIGTERM");
            escalateTimer = setTimeout(() => {
                if (settled) return;
                if (child.exitCode === null && child.signalCode === null) {
                    escalated = true;
                    child.kill("SIGKILL");
                }
            }, termGraceFromEnv());
        }, timeoutMs);
        const finish = (result: {
            status: number | null;
            signal: string | null;
            error: NodeJS.ErrnoException | null;
        }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (escalateTimer !== null) clearTimeout(escalateTimer);
            resolve({
                ...result,
                timedOut: killed,
                killEscalated: escalated,
                outputOverflow:
                    streams.stdout.overflow || streams.stderr.overflow,
                stdoutBytes: streams.stdout.bytes,
                stderrBytes: streams.stderr.bytes,
                stdout: streams.stdout.chunks.join(""),
                stderr: streams.stderr.chunks.join(""),
            });
        };
        child.on("error", (error) =>
            finish({
                status: null,
                signal: null,
                error,
            }),
        );
        child.on("close", (status, signal) =>
            finish({ status, signal, error: null }),
        );
        // After escalation the child has been forcibly killed; remaining
        // output would only trickle once an orphaned pipe writer drains, so
        // settle at exit instead of at drain time.
        child.on("exit", (status, signal) => {
            if (escalated) finish({ status, signal, error: null });
        });
    });
}

/** Copy only the sandbox surfaces; rubric.md and case.json stay out of reach. */
function copySandbox(caseFixture: string, live: string) {
    for (const surface of ["work", "lakes", "config-home"]) {
        cpSync(join(caseFixture, surface), join(live, surface), {
            recursive: true,
        });
    }
}

/** Whether a recorded run already occupies this result directory. */
function resultExists(resultDir: string) {
    return (
        existsSync(join(resultDir, "meta.json")) ||
        existsSync(join(resultDir, "final.md"))
    );
}

/**
 * Reserve one case's result directory atomically: the create either wins or
 * reports a rival, so simultaneous workers can never share evidence paths.
 */
function reserveResultDir(resultDir: string) {
    // Parallel workers reserve the same path atomically: the parent exists,
    // the case directory is claimed exactly once — first with the directory
    // create, then with an exclusively-created marker file, so a pre-staged
    // empty mount point is claimable but a rival mid-run is not. Recorded
    // evidence always refuses: a stamp is immutable.
    mkdirSync(dirname(resultDir), { recursive: true });
    try {
        mkdirSync(resultDir, { recursive: false });
    } catch (error: unknown) {
        const code =
            error instanceof Error
                ? (error as { code?: string }).code
                : undefined;
        if (code !== "EEXIST") throw error;
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
    } catch (error: unknown) {
        const code =
            error instanceof Error
                ? (error as { code?: string }).code
                : undefined;
        if (code === "EEXIST") {
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

/** A stable digest over one tree snapshot's full identity (including git state). */
function snapshotDigest(snapshot: Snapshot): string {
    const encode = (
        map: Map<string, TreeEntry> | Map<string, string>,
    ): string => JSON.stringify([...map].sort(([a], [b]) => (a < b ? -1 : 1)));
    return sha256(`${encode(snapshot.entries)}\n${encode(snapshot.git)}`);
}

function metaFor(
    testCase: TrialCase,
    options: CliOptions,
    promptPath: string,
    caseFixture: string,
    startedAt: string,
    finishedAt: string,
    result: SpawnResult,
    diff: WriteDiff,
    violations: string[],
    answerHash: string,
    answerValid: boolean,
    telemetry: Telemetry,
    timings: TrialTimings,
    generation: GenerationRecord | undefined,
    invalidReason: string | null,
    afterSnapshot: Snapshot,
): string {
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
                killEscalated: result.killEscalated === true,
                outputOverflow: result.outputOverflow === true,
                stdoutBytes: result.stdoutBytes ?? 0,
                stderrBytes: result.stderrBytes ?? 0,
                writes: writeCount(diff),
                gitStateChanges: diff.git.length,
                // `kinds` rides its serialisable object form: a Map would
                // JSON.stringify to {}, losing every change label.
                writeKinds: { ...diff, kinds: Object.fromEntries(diff.kinds) },
                finalStateDigest: snapshotDigest(afterSnapshot),
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
function copyCaseEvidence(
    options: CliOptions,
    testCase: TrialCase,
    resultDir: string,
) {
    const sourceDir = join(options.rubrics, testCase.id);
    for (const name of ["rubric.md", "case.json"]) {
        const source = join(sourceDir, name);
        if (existsSync(source)) cpSync(source, join(resultDir, name));
    }
}

/**
 * Why a recorded answer is not valid evidence, or null. Validity is
 * deterministic and checked before any semantic judge: the process must
 * have completed (exit 0, no signal, no spawn error, no timeout), the
 * answer must be nonblank, and the trail must contain parsable events with
 * completion evidence. The recorded answer identity is also checked here:
 * judging hashes the recorded bytes and refuses an edited final.md rather
 * than adopting it.
 */
function answerInvalidReason(resultDir: string) {
    const finalPath = join(resultDir, "final.md");
    if (!existsSync(finalPath)) return "no final.md recorded";
    const metaAt = metaRecordAt(join(resultDir, "meta.json"));
    if (metaAt.kind === "malformed") {
        return (
            `recorded meta.json is malformed and unusable ` +
            `(${metaAt.problems.join("; ")}) — the answer's validity ` +
            "cannot be established"
        );
    }
    if (metaAt.kind === "absent") return null;
    const meta = metaAt.value;
    if (meta.answerValid === false) {
        return meta.invalidReason ?? "answer failed validity checks";
    }
    if (typeof meta?.answerHash === "string" && meta.answerHash !== "") {
        const actual = sha256(readFileSync(finalPath));
        if (actual !== meta.answerHash) {
            return "recorded answer altered after the run (final.md does not match the recorded answer hash)";
        }
    }
    return null;
}

/**
 * The deterministic docs gate of a case, driven by its criterion — which at
 * judge time is the SAVED definition's criterion, never the current corpus
 * (M01). Two semantics, pinned by which field the definition uses:
 *
 * `minVerifiedCalls` (current): a gate on successful operations only —
 * observable docs operations (native or twin) whose own output proves
 * success. A failed or denied call, a refusal, a lake not-found, and a
 * Code Mode attempt (whose nested operation is unobservable) never satisfy
 * a gate. Required verbs must have succeeded — a read carries the plugin's
 * revision token, other verbs their delivered content — and each `paths`
 * fragment must be the typed verb field's target of the SAME operation
 * that succeeded, so an unrelated read plus a stray mention of the target
 * cannot stand in for the relevant document.
 *
 * `minDocsCalls` (legacy): the historical attempted-operations semantics,
 * applied to saved old definitions as they were recorded — labelled
 * `(legacy attempted-operations)` so the loosened floor is visible, never
 * silently applied.
 * @returns The gate problem, or null when the criterion is met or absent.
 */
function docsCriterionProblem(testCase: TrialCase, resultDir: string) {
    const criterion = testCase?.docsCriterion;
    if (!criterion) return null;
    return "minVerifiedCalls" in criterion
        ? verifiedDocsCriterionProblem(criterion, resultDir)
        : legacyDocsCriterionProblem(criterion, resultDir);
}

/**
 * The documents `pathsCriterion` gates on: each required fragment must be
 * the typed `read` field's target of one completed docs operation, and that
 * same operation's own output must establish a successful retrieval. One
 * problem line per unmet fragment, so a successful read of one document
 * never conceals a missing or failed read of another.
 * @returns The per-fragment refusal lines, or null when all paths are met.
 */
function requiredPathProblems(
    trail: ToolTrail,
    fragments: string[],
): string[] | null {
    const unmet: string[] = [];
    for (const fragment of fragments) {
        const relevant = trail.entries.filter((entry) => {
            const kind = docsEntryKind(entry);
            return (
                (kind === "native" || kind === "twin" || kind === "nested") &&
                entry.status === "completed" &&
                docsEntryVerb(kind, entry) === "read" &&
                typedPathHit(entry, fragment)
            );
        });
        if (relevant.length === 0) {
            unmet.push(`no completed docs read references ${fragment}`);
            continue;
        }
        if (relevant.some(docsOpSuccessful)) continue;
        const labels = [
            ...new Set(relevant.map((entry) => docsOutcomeLabel(entry))),
        ];
        unmet.push(
            `no successful retrieval of ${fragment} — ` +
                `${labels.join(", ")}; a completed tool call is not a ` +
                "successful read",
        );
    }
    return unmet.length > 0 ? unmet : null;
}

/**
 * Why one criterion's required verbs are unmet, or null: every required
 * verb needs one of its operations' own result evidence to prove success —
 * attempts and completed-but-failed calls never count.
 * @param trail The read trail.
 * @param verbs The required verbs.
 * @returns The refusal line, or null.
 */
function requiredVerbProblems(
    trail: ToolTrail,
    verbs: string[],
): string | null {
    const satisfied = verbs.some((verb) =>
        trail.entries.some((entry) => {
            const kind = docsEntryKind(entry);
            return (
                kind !== null &&
                kind !== "code-mode" &&
                docsEntryVerb(kind, entry) === verb &&
                docsOpSuccessful(entry)
            );
        }),
    );
    if (satisfied) return null;
    return `docs criterion unmet: no successful ${verbs.join("/")} operation (attempts and completed-but-failed calls are never success)`;
}

/**
 * The unmet-floor message: the trail's success facts, with the
 * code-mode-only caveat when attempts were the only observed docs usage.
 * @param telemetry The trail's docs telemetry.
 * @param required The floor claimed.
 * @returns One refusal line.
 */
function floorUnmetMessage(telemetry: Telemetry, required: number): string {
    if (telemetry.codeModeAttempted > 0 && telemetry.verifiedDocs === 0) {
        return (
            `${telemetry.codeModeAttempted} code-mode attempt(s) are ` +
            "unobservable nested operations — inconclusive without a " +
            `completed native or twin call ` +
            `(0 successful docs op(s), required ${required})`
        );
    }
    return `${telemetry.verifiedDocs} successful docs op(s), required ${required}`;
}

/** The `minVerifiedCalls` criterion: a floor on successful operations. */
function verifiedDocsCriterionProblem(
    criterion: VerifiedDocsCriterion,
    resultDir: string,
): string | null {
    const trail = readTrail(resultDir);
    if (trail === null) return "docs criterion unmet: no tool trail recorded";
    const telemetry = docsTelemetry(trail.entries, trail.parseFailures);
    const required = criterion.minVerifiedCalls ?? 1;
    // Relevance and success come from the same operation: a required verb
    // counts only when one of its operations' own outputs proves success,
    // and each required path is the typed read field of the SAME operation
    // that successfully retrieved the document.
    const pathProblems =
        criterion.paths !== undefined
            ? requiredPathProblems(trail, criterion.paths)
            : null;
    // The floor counts successful operations only: completed refusals,
    // not-founds and failed reads are observations, never successes, so one
    // success plus one refusal cannot meet a floor of two. An unmet floor
    // does not swallow the per-path diagnostics — they aggregate alongside.
    if (telemetry.verifiedDocs < required) {
        const floor = floorUnmetMessage(telemetry, required);
        return pathProblems === null
            ? `docs criterion unmet: ${floor}`
            : `docs criterion unmet: ${floor}; ${pathProblems.join("; ")}`;
    }
    if (pathProblems !== null) {
        return `docs criterion unmet: ${pathProblems.join("; ")}`;
    }
    if (criterion.verbs !== undefined) {
        const verbProblem = requiredVerbProblems(trail, criterion.verbs);
        if (verbProblem !== null) return verbProblem;
    }
    return null;
}

/** The legacy `minDocsCalls` criterion: historical attempted-operations semantics. */
function legacyDocsCriterionProblem(
    criterion: LegacyDocsCriterion,
    resultDir: string,
): string | null {
    const trail = readTrail(resultDir);
    if (trail === null) return "docs criterion unmet: no tool trail recorded";
    const telemetry = docsTelemetry(trail.entries, trail.parseFailures);
    if (telemetry.docsCalls < (criterion.minDocsCalls ?? 1)) {
        return (
            `(legacy attempted-operations) docs criterion unmet: ` +
            `${telemetry.docsCalls} docs call(s), required ${criterion.minDocsCalls ?? 1}`
        );
    }
    if (criterion.verbs !== undefined) {
        const used = Object.entries(telemetry.verbs)
            .filter(([, count]) => count > 0)
            .map(([verb]) => verb);
        if (!criterion.verbs.some((verb) => used.includes(verb))) {
            return (
                "(legacy attempted-operations) docs criterion unmet: no " +
                criterion.verbs.join("/") +
                " call observed"
            );
        }
    }
    return null;
}

/** A blank answer: one unparsable trail is different evidence from an empty completion. */
function trialBlankAnswerReason(parseFailures: number, events: number) {
    return parseFailures > 0 && events === 0
        ? "trial produced no parsable completion events"
        : "trial produced a blank answer";
}

/**
 * Why the run's process outcome cannot be a completed trial: spawn
 * failure, a triggered timeout (regardless of the final exit code or
 * signal), any kill signal, or a nonzero exit.
 */
function runProcessFailure(result: SpawnResult, options: CliOptions) {
    if (result.error !== null && result.error !== undefined) {
        return `trial failed to start (${result.error.code ?? result.error})`;
    }
    if (result.timedOut === true) {
        return (
            `trial timed out after ${options.timeoutMs} ms` +
            (result.killEscalated === true ? " (SIGKILL after grace)" : "")
        );
    }
    if (result.signal !== null && result.signal !== undefined) {
        return `trial killed by signal ${result.signal}`;
    }
    if (result.status !== 0) {
        return `trial did not complete (exit ${result.status})`;
    }
    return null;
}

/** Capture, parsability, blankness and completion-shape evidence problems. */
function runTrailEvidenceProblem(
    result: SpawnResult,
    text: string,
    parseFailures: number,
    textParts: number,
    lastPartKind: string | null,
    events: number,
) {
    if (
        result.outputOverflow === true ||
        result.stdoutOverflow === true ||
        result.stderrOverflow === true
    ) {
        return (
            "trial output exceeded the capture limit " +
            "(the recorded evidence is incomplete by construction)"
        );
    }
    if (parseFailures > 0) {
        return events === 0
            ? "trial produced no parsable completion events"
            : `trial produced ${parseFailures} unparsable output line(s); trail completeness cannot be verified`;
    }
    if (text.trim() === "") {
        return trialBlankAnswerReason(parseFailures, events);
    }
    if (textParts === 0 || lastPartKind !== "text") {
        return "trial produced no final completion event";
    }
    return null;
}

/**
 * Why a completed run is not a valid trial answer, or null when it is:
 * process failure, capture-limit overflow (the retained evidence is
 * incomplete by construction), unparsable output lines (trail completeness
 * cannot be verified), a blank answer, or a stream that never ended on a
 * final answer text part.
 */
function trialInvalidReason(
    result: SpawnResult,
    text: string,
    parseFailures: number,
    events: number,
    options: CliOptions,
    textParts: number,
    lastPartKind: string | null,
) {
    const processProblem = runProcessFailure(result, options);
    if (processProblem !== null) return processProblem;
    return runTrailEvidenceProblem(
        result,
        text,
        parseFailures,
        textParts,
        lastPartKind,
        events,
    );
}

/** One independent primary-check outcome, kept distinct from task failure. */
interface PrimaryCheckRecord {
    id: string;
    script: string;
    sourceHash: string;
    command: string;
    args: string[];
    timeoutMs: number;
    startedAt: string;
    durationMs: number;
    status: "pass" | "fail" | "timeout" | "error";
    exit: number | null;
    signal: string | null;
    reason?: string;
    stdout: string;
    stderr: string;
}

/** Whether a spawned checker passed, failed, timed out or could not run. */
function primaryStatusOf(
    result: ReturnType<typeof spawnSync>,
): PrimaryCheckRecord["status"] {
    if (result.error !== undefined) {
        return (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
            ? "timeout"
            : "error";
    }
    return result.status === 0 ? "pass" : "fail";
}

/**
 * Run one case's pristine primary check against the completed live work tree.
 * The checker receives (`live/work`, pristine `fixture/work`) and the
 * harness never executes commands taken from the model's answer. A missing
 * checker, a spawn failure and a watchdog timeout are `error`/`timeout`, not
 * a task `fail`.
 */
function runPrimaryCheck(
    testCase: TrialCase,
    liveWork: string,
    pristineWork: string,
): PrimaryCheckRecord | null {
    const check = testCase.primaryCheck;
    if (!check) return null;
    const timeoutMs = check.timeoutMs ?? 30_000;
    const scriptPath = join(PRIMARY_CHECKS_DIR, check.script);
    const startedAt = new Date().toISOString();
    const start = Date.now();
    const base: Omit<PrimaryCheckRecord, "status" | "exit" | "signal"> = {
        id: check.id,
        script: check.script,
        sourceHash: primaryCheckSourceHash(testCase),
        command: process.execPath,
        args: [scriptPath, liveWork, pristineWork],
        timeoutMs,
        startedAt,
        durationMs: 0,
        stdout: "",
        stderr: "",
    };
    if (!existsSync(scriptPath)) {
        return {
            ...base,
            status: "error",
            exit: null,
            signal: null,
            reason: `primary checker ${check.script} is missing`,
        };
    }
    const result = spawnSync(
        process.execPath,
        [scriptPath, liveWork, pristineWork],
        {
            cwd: liveWork,
            encoding: "utf8",
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
        },
    );
    return {
        ...base,
        durationMs: Date.now() - start,
        status: primaryStatusOf(result),
        exit: result.status,
        signal: result.signal,
        ...(result.error === undefined ? {} : { reason: String(result.error) }),
        stdout: (result.stdout ?? "").slice(0, 16_000),
        stderr: (result.stderr ?? "").slice(0, 16_000),
    };
}

/** Run and persist a case's optional primary-check record. */
function recordPrimaryCheck(
    testCase: TrialCase,
    resultDir: string,
    liveWork: string,
    pristineWork: string,
) {
    const record = runPrimaryCheck(testCase, liveWork, pristineWork);
    if (record !== null) {
        write(
            join(resultDir, "primary-check.json"),
            JSON.stringify(record, null, 2) + "\n",
        );
    }
}

/**
 * Persist one run's evidence into its result directory: streams, exit
 * status, writes report, answer, tool trail and the run meta record.
 */
function writeRunEvidence(
    resultDir: string,
    promptPath: string,
    caseFixture: string,
    startedAt: string,
    testCase: TrialCase,
    options: CliOptions,
    result: SpawnResult,
    diff: WriteDiff,
    violations: string[],
    text: string,
    tools: string,
    answerHash: string,
    answerValid: boolean,
    telemetry: Telemetry,
    timings: TrialTimings,
    generation: GenerationRecord | undefined,
    invalidReason: string | null,
    afterSnapshot: Snapshot,
    invocation: unknown | null,
): void {
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
            afterSnapshot,
        ),
    );
    if (invocation !== null) {
        write(
            join(resultDir, "invocation.json"),
            JSON.stringify(invocation, null, 2) + "\n",
        );
    }
}

/** The one-line report printed after one trial completes. */
function runReportLine(
    testCase: TrialCase,
    resultDir: string,
    result: SpawnResult,
    diff: WriteDiff,
    violations: string[],
    answerValid: boolean,
    invalidReason: string | null | undefined,
): string {
    const writes = writeCount(diff);
    return (
        `${testCase.id}: exit ${result.status ?? "signal"}, writes ${writes}` +
        `${violations.length > 0 ? `, ${violations.length} out-of-policy` : ""}` +
        `${answerValid ? "" : `, INVALID (${invalidReason})`}` +
        ` -> ${resultDir}`
    );
}

async function runOne(
    testCase: TrialCase,
    options: CliOptions,
    stamp: string,
    corpusComplete: boolean,
): Promise<number> {
    const startedAt = new Date().toISOString();
    const timings = { prepareMs: 0, modelMs: 0, snapshotMs: 0, totalMs: 0 };
    const totalStart = Date.now();
    const prepareStart = Date.now();
    const promptPath = join(options.prompts, `${testCase.id}.md`);
    const { problems, generation } = validateGeneration(
        testCase,
        options,
        corpusComplete,
    );
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
    const diagnostic = isDiagnosticCase(testCase);
    // The plugin writes its journal to a per-run temp path; the harness
    // copies it into evidence (with the signing key) only after the child
    // exits, so a trial-time file cannot pre-seed that evidence.
    const journalDir = mkdtempSync(join(tmpdir(), "docs-journal-"));
    const journalPath = join(journalDir, "operations.jsonl");
    const journalKey = randomBytes(32).toString("hex");
    const callArgs: CallArgs = {
        cwd: join(live, "work"),
        env: childEnv(
            join(live, "config-home"),
            join(live, "work"),
            journalPath,
            journalKey,
        ),
        model: options.model,
        title: `placement-${testCase.id}`,
        prompt: readFileSync(promptPath, "utf8"),
        opencode: options.opencode,
        timeoutMs: options.timeoutMs,
        printLogs: diagnostic || options.printLogs,
    };
    const result = await opencodeCall(callArgs);
    timings.modelMs = Date.now() - modelStart;
    copyCapturedJournal(resultDir, journalPath, journalKey);
    rmSync(journalDir, { recursive: true, force: true });

    const snapshotStart = Date.now();
    const afterSnapshot = snapshotLive(live);
    const diff = snapshotDiff(before, afterSnapshot);
    const violations = policyViolation(diff, testCase);
    timings.snapshotMs = Date.now() - snapshotStart;

    const {
        text,
        tools,
        events,
        parseFailures,
        toolCalls,
        identity,
        textParts,
        lastPartKind,
    } = extract(result.stdout ?? "");
    // The journal is captured to a temp path and copied here, after the run:
    // a trial tool cannot pre-seed or edit this evidence.
    const telemetry = {
        ...capturedDocsTelemetry(resultDir, toolCalls, identity, parseFailures),
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
        textParts,
        lastPartKind,
    );
    const answerValid = invalidReason === null;
    timings.totalMs = Date.now() - totalStart;
    const configAt = jsonAt(join(callArgs.cwd, "opencode.json"));
    const invocation =
        diagnostic || options.printLogs
            ? {
                  command: options.opencode,
                  args: opencodeArgs(callArgs),
                  cwd: callArgs.cwd,
                  pwd: callArgs.env.PWD ?? null,
                  startedAt,
                  promptSha256: fileHash(promptPath),
                  config:
                      configAt.kind === "value"
                          ? redactedConfig(configAt.value)
                          : "unreadable",
              }
            : null;

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
        afterSnapshot,
        invocation,
    );
    // The independent primary check runs after the workhorse exits, against
    // the completed live tree and the pristine fixture copy. Its record is
    // campaign evidence and judge input, never a model-supplied command.
    recordPrimaryCheck(
        testCase,
        resultDir,
        join(live, "work"),
        join(caseFixture, "work"),
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

/** The independent primary result rendered for the judge, or empty. */
function primaryCheckEvidence(resultDir: string): string {
    const path = join(resultDir, "primary-check.json");
    if (!existsSync(path)) return "";
    const at = jsonAt(path);
    if (at.kind !== "value" || !isRecord(at.value)) {
        return "\n\nIndependent primary check: recorded but unreadable.";
    }
    const record = at.value;
    return (
        "\n\nIndependent primary check (run by the harness after the session " +
        "with pristine checker definitions, outside the workhorse's control):\n" +
        `- checker: ${String(record.id)} (${String(record.script)})\n` +
        `- sourceHash: ${String(record.sourceHash)}\n` +
        `- status: ${String(record.status)}\n` +
        `- exit: ${String(record.exit)}\n` +
        `- stdout:\n${String(record.stdout ?? "")}\n` +
        `- stderr:\n${String(record.stderr ?? "")}`
    );
}

function judgePrompt(
    resultDir: string,
    artifactLines: string[],
    testCase?: TrialCase,
) {
    const rubric = readFileSync(join(resultDir, "rubric.md"), "utf8");
    const answer = existsSync(join(resultDir, "final.md"))
        ? readFileSync(join(resultDir, "final.md"), "utf8")
        : "(no answer recorded)";
    const writes = existsSync(join(resultDir, "writes.txt"))
        ? readFileSync(join(resultDir, "writes.txt"), "utf8")
        : "(unknown)";
    const taskTrial = testCase?.promptKind === "task";
    const primary = primaryCheckEvidence(resultDir);
    const opening = taskTrial
        ? "Score one automatic-notetaking trial against its rubric. The workhorse " +
          "was doing ordinary practical work, not answering a documentation request. " +
          "Judge the completed documentation outcome: a useful required note or " +
          "correction, or appropriate restraint where no durable finding exists. " +
          "Primary-task success is measured separately by the independent check; " +
          "do not treat its failure as a documentation failure, but do not excuse a " +
          "broken practical task."
        : "Score one placement-guidance trial against its rubric. Judge only the stated intended action; a trial is not required to write a file.";
    const artifactLabel = taskTrial
        ? "Relevant resulting document state (verified; excerpts may be truncated — the recorded live tree is authoritative):"
        : "Verified recorded artefacts (the deterministic structural gate already passed on these; excerpts may be truncated — the recorded live tree is authoritative):";
    return `${opening}

Return ONE JSON object and nothing else:
{"verdict":"pass"|"fail","destination":"...","documents":"one"|"several"|"none","clarification":"yes"|"no","reason":"..."}

A pass means the destination or workflow matches Expected and Accepts, and does not rely on a tempting wrong answer. For Expected "clarify", a pass must ask a focused question and leave the destination explicitly deferred: naming a destination lake while ownership is unresolved is a guess and fails, unless the Accepts explicitly permit naming it (for example, with an independent ownership justification).

Rubric:
${rubric}

Trial answer:
${answer}

Files changed during the trial:
${writes}${primary}${artifactLines.length > 0 ? `\n\n${artifactLabel}\n${artifactLines.join("\n")}` : ""}`;
}

function copyRubric(options: CliOptions, resultDir: string, caseId: string) {
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

function prepareJudgeRoot(resultDir: string, judgeModel: string) {
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
function parseVerdict(text: string) {
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
function verdictEnumProblems(value: Record<string, unknown>) {
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
function verdictNonBlankProblems(value: Record<string, unknown>) {
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
function validateVerdict(value: unknown) {
    if (!isRecord(value)) {
        return ["not a JSON object"];
    }
    return [...verdictEnumProblems(value), ...verdictNonBlankProblems(value)];
}

/**
 * Whether the judge process itself succeeded: no spawn failure, no
 * triggered timeout (a timeout is failure regardless of the final exit
 * code or signal), no kill signal, no capture-limit overflow, and exit
 * zero.
 */
function judgeProcessOk(result: SpawnResult) {
    if (result.error !== null && result.error !== undefined) return false;
    if (result.timedOut === true) return false;
    if (result.signal !== null && result.signal !== undefined) return false;
    if (
        result.outputOverflow === true ||
        result.stdoutOverflow === true ||
        result.stderrOverflow === true
    ) {
        return false;
    }
    return result.status === 0;
}

function verdictLabel(verdict: unknown): string {
    if (!isRecord(verdict)) return "unparsed";
    const destination =
        typeof verdict.destination === "string" ? verdict.destination : "";
    const verdictText =
        typeof verdict.verdict === "string" ? verdict.verdict : "unparsed";
    return `${verdictText}${destination ? ` -> ${destination}` : ""}`;
}

/** The next judge attempt number, so rejudging never overwrites evidence. */
function nextAttempt(resultDir: string) {
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

function writeInvalidVerdict(
    caseId: string,
    resultDir: string,
    reason: string,
    answerHash: string,
) {
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
function policyReason(meta: MetaRecord, testCase: TrialCase) {
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
function runInvalidReason(
    resultDir: string,
    options: CliOptions,
    testCase: TrialCase,
) {
    const answer = answerInvalidReason(resultDir);
    if (answer !== null) return answer;
    const metaAt = metaRecordAt(join(resultDir, "meta.json"));
    if (metaAt.kind === "malformed") {
        return (
            `recorded meta.json is malformed and unusable ` +
            `(${metaAt.problems.join("; ")})`
        );
    }
    if (metaAt.kind === "absent") return "no meta.json recorded";
    const meta = metaAt.value;
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
function judgeStatusOf(result: SpawnResult, problems: string[]) {
    if (!judgeProcessOk(result)) return "process-failed";
    return problems.length > 0 ? "invalid-verdict" : "judged";
}

/**
 * The attempt-local meta.json body: identities, timings, terminal state and
 * the parsed verdict when one survived parsing.
 */
function judgeAttemptMeta(args: AttemptMetaArgs) {
    const {
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
    } = args;
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
        killEscalated: result.killEscalated === true,
        outputOverflow: result.outputOverflow === true,
        stdoutBytes: result.stdoutBytes ?? 0,
        stderrBytes: result.stderrBytes ?? 0,
        timings: { judgeMs },
        judgeStatus,
        ...(parsed === undefined ? {} : { parsedVerdict: parsed }),
        ...(problems.length > 0 ? { problems } : {}),
    };
}

/** Why an attempt was not judged: the judge process failure or the invalid output. */
function judgeFailureReason(result: SpawnResult, problems: string[]) {
    if (judgeProcessOk(result)) {
        return `judge output invalid (${problems.join("; ")})`;
    }
    const capture =
        result.outputOverflow === true ||
        result.stdoutOverflow === true ||
        result.stderrOverflow === true;
    return (
        `judge process failed (exit ${result.status ?? "?"}` +
        `${result.signal ? `, signal ${result.signal}` : ""}` +
        `${result.error ? `, error ${result.error.code ?? result.error}` : ""}` +
        `${result.timedOut ? ", timed out" : ""}` +
        `${capture ? ", exceeded the capture limit" : ""})`
    );
}

/** Record the result-level judge-error pointer and report it; always a failure. */
function writeJudgeErrorVerdict(
    caseId: string,
    resultDir: string,
    judgeModel: string,
    identities: JudgeIdentities,
    attempt: string,
    why: string,
) {
    write(
        join(resultDir, "verdict.json"),
        JSON.stringify(
            {
                verdict: "judge-error",
                reason: why,
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
    resultDir: string,
    parsed: unknown,
    judgeModel: string,
    identities: JudgeIdentities,
    attempt: string,
) {
    write(
        join(resultDir, "verdict.json"),
        JSON.stringify(
            {
                ...identities,
                ...(isRecord(parsed) ? parsed : {}),
                judgeModel,
                attempt,
            },
            null,
            2,
        ) + "\n",
    );
}

/** A judge attempt's output problems: verdict completeness + trail honesty. */
function judgeOutputProblems(
    parsed: unknown,
    judgeParseFailures: number,
    judgeTextParts: number,
) {
    return [
        ...(parsed === undefined
            ? ["no JSON object in output"]
            : validateVerdict(parsed)),
        ...(judgeTextParts === 0 ? ["no text part in judge output"] : []),
        ...(judgeParseFailures > 0
            ? [
                  `${judgeParseFailures} unparsable judge output line(s); output completeness cannot be verified`,
              ]
            : []),
    ];
}

/**
 * Record one judge attempt. The attempt directory preserves everything:
 * stdout, stderr, raw text, timings, completion metadata, the identities of
 * every input (answer, rubric, judge prompt) and the parsed or failed
 * verdict. The result-level pointer is written only for a real judged
 * verdict; a failed judge becomes `judge-error`, never a pass.
 */
async function judgeAttempt(
    caseId: string,
    resultDir: string,
    judgeDir: string,
    result: SpawnResult,
    judgeModel: string,
    identities: JudgeIdentities,
    judgeMs: number,
    attemptKey: string,
    startedAt: string,
): Promise<number> {
    write(join(judgeDir, "stdout.jsonl"), result.stdout ?? "");
    write(join(judgeDir, "stderr.log"), result.stderr ?? "");
    const {
        text,
        parseFailures: judgeParseFailures,
        textParts,
    } = extract(result.stdout ?? "");
    write(join(judgeDir, "raw.md"), text);

    const parsed = parseVerdict(text);
    const problems = judgeOutputProblems(parsed, judgeParseFailures, textParts);
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
                ...(isRecord(parsed) ? parsed : { raw: text.trim() }),
                judgeStatus,
                ...(problems.length > 0 ? { problems } : {}),
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
function judgeKey(identities: JudgeIdentities) {
    return sha256(JSON.stringify(identities));
}

/**
 * Resume an identical earlier judge attempt: rewrite the result-level pointer
 * with the resume provenance and return the prior verdict's exit code. Null
 * when no attempt with matching inputs and settings was judged.
 */
function resumePriorAttempt(
    caseId: string,
    resultDir: string,
    judgeRoot: string,
    key: string,
    identities: JudgeIdentities,
) {
    for (const entry of readdirSync(judgeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^attempt-\d+$/.test(entry.name)) continue;
        const priorAt = judgeAttemptMetaAt(
            join(judgeRoot, entry.name, "meta.json"),
        );
        // A broken attempt meta is evidence, not a resume source: it is
        // skipped and a fresh attempt records everything anew.
        if (priorAt.kind !== "value") continue;
        const prior = priorAt.value;
        if (prior.judgeKey === key && prior.judgeStatus === "judged") {
            const verdictAt = verdictRecordAt(
                join(judgeRoot, entry.name, "verdict.json"),
            );
            // Same for its verdict pointer: without a valid prior verdict
            // there is nothing to resume, so run a fresh attempt instead.
            if (verdictAt.kind !== "value") continue;
            const verdict = verdictAt.value;
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

/**
 * The case definitions a judge must answer: the saved experiment's own
 * frozen definitions (run.json's per-case records), never the current
 * corpus — a corpus edit, loosened policy or new criterion cannot relabel a
 * recorded experiment, and explicit case ids must belong to it. A legacy
 * stamp without run.json is judged against the current corpus with the
 * limitation called out; its definitions were never frozen.
 * @param options Parsed CLI options (ids, paths).
 * @param stamp The resolved stamp.
 * @returns The case definitions to judge.
 */
/**
 * A legacy stamp's judge definitions: the current corpus, full definitions
 * only, with the limitation stated in the report it feeds.
 */
function legacyJudgeSelection(options: CliOptions): FullTrialCase[] {
    console.error(
        "judging a legacy stamp: no frozen run description exists, so " +
            "criteria come from the current corpus (limitation, not a pass)",
    );
    const fullCases = select(options).filter(isFullCase);
    const legacyCases = fullCases.filter(
        (testCase) => !isDiagnosticCase(testCase),
    );
    if (legacyCases.length === 0) {
        if (fullCases.some(isDiagnosticCase)) {
            console.error(
                "diagnostic case(s) are report-only; no semantic judge",
            );
            return [];
        }
        usage(
            "the current corpus carries no full definitions to judge a " +
                "legacy stamp with",
        );
    }
    return legacyCases;
}

function judgeSelection(options: CliOptions, stamp: string): FullTrialCase[] {
    const runAt = loadRunDescription(options, stamp);
    if (runAt.kind === "malformed") {
        usage(
            `frozen run description at ${runAt.path} is malformed ` +
                `(${runAt.problems.join("; ")}); a corrupt experiment ` +
                "cannot be relabelled, re-frozen or judged",
        );
    }
    if (runAt.kind === "absent") return legacyJudgeSelection(options);
    const run = runAt.value as RunDescription;
    const full: FullTrialCase[] =
        (run.cases ?? [])
            .map((entry: RunCase) => entry.definition ?? entry)
            .filter((definition: unknown) => isRecord(definition))
            ?.filter(isFullCase) ?? [];
    const judgeable = full.filter((testCase) => !isDiagnosticCase(testCase));
    if (judgeable.length === 0) {
        if (full.length === 0) {
            usage(
                `run.json at ${join(options.results, stamp)} records no usable full case definitions ` +
                    "(a minimal legacy record alone does not supply a judgeable case)",
            );
        }
        console.error("diagnostic case(s) are report-only; no semantic judge");
        return [];
    }
    if (options.ids.length === 0) return judgeable;
    const unknown = options.ids.filter(
        (id: string) => !full.some((entry) => entry.id === id),
    );
    if (unknown.length > 0) {
        usage(
            `case(s) ${unknown.join(", ")} are not part of experiment ${stamp}`,
        );
    }
    return judgeable.filter((entry) => options.ids.includes(entry.id));
}

/**
 * The pre-judge gate sequence for one case: recorded-run validity, the
 * saved definition's docs criterion, the artefact expectations.
 * @returns The refusal reason, or null with the verified artefact list.
 */
function judgeGateReason(
    resultDir: string,
    options: CliOptions,
    testCase: FullTrialCase,
) {
    const invalid = runInvalidReason(resultDir, options, testCase);
    if (invalid !== null) return { reason: invalid, artifacts: [] };
    const criterionProblem = docsCriterionProblem(testCase, resultDir);
    if (criterionProblem !== null) {
        return { reason: criterionProblem, artifacts: [] };
    }
    // runInvalidReason just approved this run, so its meta reads as valid.
    const metaAt = metaRecordAt(join(resultDir, "meta.json"));
    const meta = metaAt.kind === "value" ? metaAt.value : {};
    const expectation = expectedDocsGate(resultDir, meta, testCase);
    if (expectation.problem !== null) {
        return { reason: expectation.problem, artifacts: [] };
    }
    return { reason: null, artifacts: expectation.artifacts };
}

/**
 * The recorded rubric must be the experiment's own: a saved full
 * definition renders the expected rubric deterministically, so a
 * replaced-upstream or edited copy is refused rather than adopted.
 * @returns The refusal reason, or null when matching or not checkable.
 */
function recordedRubricProblem(
    testCase: FullTrialCase,
    recordedRubric: string,
) {
    if (!selectedAreFullDefinitions([testCase])) return null;
    return recordedRubric === rubricFor(testCase)
        ? null
        : "recorded rubric does not match the experiment's saved definition";
}

/**
 * Record the deterministic pre-judge gate without calling a judge model.
 *
 * A campaign that scores documentation with its own structured judge still
 * needs the harness's own gate verdict preserved next to the run, so the
 * gate outcome and the semantic assessment stay separate evidence. Writes
 * `gate.json`; never a `verdict.json`, so a gate record cannot be mistaken
 * for a semantic verdict.
 * @param caseId The case being gated.
 * @param resultDir The case's result directory.
 * @param gate The gate outcome from {@link judgeGateReason}.
 * @param gate.reason The refusal reason, or null when the gate passed.
 * @param gate.artifacts The verified artefact list on a pass.
 * @param answerHash The recorded answer's identity.
 * @returns 0 when the gate passed, 1 when it blocked (an expected outcome,
 *   not a harness failure).
 */
function writeGateRecord(
    caseId: string,
    resultDir: string,
    gate: { reason: string | null; artifacts: Array<{ path: string }> },
    answerHash: string,
) {
    const status = gate.reason === null ? "pass" : "blocked";
    write(
        join(resultDir, "gate.json"),
        JSON.stringify(
            {
                caseId,
                status,
                reason: gate.reason,
                artifacts: gate.artifacts.map((artifact) => artifact.path),
                answerHash,
                checkedAt: new Date().toISOString(),
            },
            null,
            2,
        ) + "\n",
    );
    console.log(
        `${caseId}: gate ${status}${gate.reason === null ? "" : ` — ${gate.reason}`}`,
    );
    return gate.reason === null ? 0 : 1;
}

async function judgeOne(
    testCase: FullTrialCase,
    options: CliOptions,
    stamp: string,
) {
    const resultDir = join(options.results, stamp, testCase.id);
    if (!existsSync(resultDir)) {
        console.log(`${testCase.id}: no run recorded, skipping judge`);
        return 1;
    }
    const answerHash = existsSync(join(resultDir, "final.md"))
        ? fileHash(join(resultDir, "final.md"))
        : "unknown";
    const gate = judgeGateReason(resultDir, options, testCase);
    if (options.gateOnly === true) {
        return writeGateRecord(testCase.id, resultDir, gate, answerHash);
    }
    if (gate.reason !== null) {
        return writeInvalidVerdict(
            testCase.id,
            resultDir,
            gate.reason,
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
    const recordedRubric = readFileSync(join(resultDir, "rubric.md"), "utf8");
    const rubricProblem = recordedRubricProblem(testCase, recordedRubric);
    if (rubricProblem !== null) {
        return writeInvalidVerdict(
            testCase.id,
            resultDir,
            rubricProblem,
            answerHash,
        );
    }
    const rubricHash = fileHash(join(resultDir, "rubric.md"));
    const judgeModel = options.judgeModel || options.model;
    const prompt = judgePrompt(
        resultDir,
        gate.artifacts.map(
            (artifact) =>
                `- **${artifact.path}**\n\n\`\`\`\n${artifact.excerpt}\n\`\`\``,
        ),
        testCase,
    );
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
        env: childEnv(join(root, "config-home"), join(root, "work")),
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
function summaryExpected(
    caseInfo: RunCase | undefined,
    runDescription: RunDescription | null,
) {
    return (
        caseInfo?.expected ??
        (runDescription === null ? "(legacy run)" : "(missing from run.json)")
    );
}

/** The Verdict column: the recorded verdict, or why there is no verdict. */
function summaryVerdict(verdict: VerdictRecord | undefined, resultDir: string) {
    return verdict?.verdict ?? (existsSync(resultDir) ? "unjudged" : "not run");
}

/** The ` [model: …]` suffix for a result produced by a different model. */
function summaryModelMismatch(
    runDescription: RunDescription | null,
    meta: MetaRecord,
) {
    return runDescription !== null &&
        meta?.model !== undefined &&
        meta.model !== runDescription.model
        ? ` [model: ${meta.model}]`
        : "";
}

/** The Exposure column: no trail, the classified labels, or "none". */
function summaryExposure(resultDir: string, trail: ToolTrail | null) {
    return trail === null
        ? "no trail"
        : exposureFor(resultDir).join(" + ") || "none";
}

/** Whether a saved description predates the naming map. */
function isLegacyRun(runDescription: RunDescription | null) {
    return (
        runDescription === null || runDescription.namingMapVersion === undefined
    );
}

/** The Scenario cell: saved display, a legacy claim fallback, else the id. */
function reportedScenario(caseInfo: RunCase | undefined, legacy: boolean) {
    const id = caseInfo?.id ?? "?";
    return formatScenarioName(
        id,
        caseInfo?.display ?? null,
        legacy ? (caseInfo?.definition?.claim ?? null) : null,
    );
}

function summaryRow(
    runDescription: RunDescription | null,
    caseInfo: RunCase | undefined,
    resultDir: string,
) {
    const verdictAt = verdictRecordAt(join(resultDir, "verdict.json"));
    const verdict = verdictAt.kind === "value" ? verdictAt.value : undefined;
    const report = existsSync(join(resultDir, "writes.txt"))
        ? readFileSync(join(resultDir, "writes.txt"), "utf8").trim()
        : "";
    const trail = readTrail(resultDir);
    const telemetry =
        trail === null
            ? null
            : docsTelemetry(trail.entries, trail.parseFailures);
    const metaAt = metaRecordAt(join(resultDir, "meta.json"));
    const meta = metaAt.kind === "value" ? metaAt.value : {};
    const legacy = isLegacyRun(runDescription);
    return {
        id: caseInfo?.id ?? "?",
        scenario: reportedScenario(caseInfo, legacy),
        expected: summaryExpected(caseInfo, runDescription),
        verdict:
            verdictAt.kind === "malformed"
                ? "malformed verdict.json"
                : summaryVerdict(verdict, resultDir),
        destination: verdict?.destination ?? "",
        writes: writesColumn(meta, report),
        docs: docsLabel(telemetry),
        discovery: discoveryLabel(discoveryFor(resultDir)),
        exposure: summaryExposure(resultDir, trail),
        modelMismatch: summaryModelMismatch(runDescription, meta),
    };
}

/** The stamped case ids: the recorded list, else the sorted result directories. */
function stampedCaseIds(run: RunDescription | null, stampDir: string) {
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
function legacyStampNotice(run: RunDescription | null) {
    return run === null
        ? [
              "Provenance: unknown — legacy stamp without run.json; labels come from saved artefacts only.",
              "",
          ]
        : [];
}

/** The boundary sentence of the summary header, or its legacy counterpart. */
function summaryBoundary(run: RunDescription | null) {
    if (run === undefined || run === null) return "unknown (legacy)";
    const boundary = run.trialBoundary ?? legacySummaryBoundary(run);
    if (boundary === undefined) return "unknown (legacy)";
    return `${boundary.kind}${boundary.image ? ` (${boundary.image})` : ""}`;
}

/** A v1 stamp's boundary facts, lifted into the v2 field names. */
function legacySummaryBoundary(run: RunDescription) {
    const legacy = run.boundary;
    if (legacy === undefined || legacy === null) return undefined;
    const containerised = legacy.containerised === true;
    return {
        containerised,
        kind: containerised ? "container" : "host",
        image: legacy.image ?? "",
        imageId: legacy.imageId ?? "",
    };
}

/** The provenance identity lines, when the stamp recorded them. */
function summaryProvenanceLines(provenanceInfo: Provenance | undefined) {
    return provenanceInfo
        ? [
              `Fixture: ${provenanceInfo.fixtureVersion ?? "unknown"}`,
              `Plugin: ${provenanceInfo.pluginCommit ?? "unknown"} (${provenanceInfo.pluginHash ?? "unknown"})`,
              `CLI: ${provenanceInfo.opencode ?? "unknown"}`,
          ]
        : [];
}

/** The context lines between the title and the case table of summary.md. */
function summaryHeaderLines(run: RunDescription | null, stamp: string) {
    const described = run ?? {};
    return [
        `# Placement trial ${stamp}`,
        "",
        `Run created: ${described.createdAt ?? "unknown (legacy)"}`,
        `Reported: ${new Date().toISOString()} (rendering time, not run time)`,
        `Model: ${described.model ?? "unknown (legacy)"}`,
        ...(described.condition === undefined
            ? []
            : [`Condition: ${described.condition}`]),
        `Variant: ${described.variant ?? "unknown (legacy)"}`,
        `Boundary: ${summaryBoundary(run)}`,
        ...summaryProvenanceLines(
            described.orchestration ?? described.provenance,
        ),
        ...legacyStampNotice(run),
    ];
}

/** The markdown case table of the summary. */
function summaryTable(rows: SummaryRow[]) {
    return [
        "| Scenario | Expected | Verdict | Destination | Writes | Docs | Discovery | Exposure |",
        "| -------- | -------- | ------- | ----------- | ------ | ---- | --------- | -------- |",
        ...rows.map(
            (row) =>
                `| ${row.scenario} | ${row.expected} | ${row.verdict}${row.modelMismatch} | ${row.destination || "-"} | ${row.writes} | ${row.docs} | ${row.discovery} | ${row.exposure} |`,
        ),
    ];
}

/** The tally lines under the summary table. */
function summaryTallies(rows: SummaryRow[]) {
    return [
        `Passed: ${rows.filter((row) => row.verdict === "pass").length}/${rows.length}`,
        `Failed: ${rows.filter((row) => row.verdict === "fail").length}`,
        `Invalid: ${rows.filter((row) => row.verdict === "invalid").length}`,
        `Judge errors: ${rows.filter((row) => row.verdict === "judge-error").length}`,
        `Discovered: ${rows.filter((row) => row.discovery.startsWith("help")).length}/${rows.length}`,
        `Exposed: ${rows.filter((row) => row.exposure !== "none" && row.exposure !== "no trail").length}/${rows.length}`,
    ];
}

function renderSummary(options: CliOptions, stamp: string) {
    const stampDir = join(options.results, stamp);
    const runAt = loadRunDescription(options, stamp);
    if (runAt.kind === "malformed") {
        usage(
            `${stamp}: run.json at ${runAt.path} is malformed ` +
                `(${runAt.problems.join("; ")}); the run cannot be reported`,
        );
    }
    const run = runAt.kind === "absent" ? null : runAt.value;
    const caseList = run?.cases ?? [];
    const rows = stampedCaseIds(run, stampDir).map((id) =>
        summaryRow(
            run,
            caseList.find((entry: RunCase) => entry.id === id),
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
        ...rows.flatMap((row) => {
            const resultDir = join(stampDir, row.id);
            if (!resultIsDiagnostic(resultDir)) return [];
            const record = diagnosticFor(resultDir);
            return record === null ? [] : ["", ...diagnosticLines(record)];
        }),
    ];
    const text = lines.join("\n");
    write(join(stampDir, "summary.md"), text);
    process.stdout.write(text);
}

/** Read a result artefact for the dossier; absent files get a visible marker. */
function readArtifact(resultDir: string, name: string) {
    const path = join(resultDir, name);
    return existsSync(path) ? readFileSync(path, "utf8").trim() : "(absent)";
}

/** One tool-trail line for the dossier, with the output trimmed for scanning. */
function trailLine(entry: ToolCall) {
    const input = JSON.stringify(entry.input ?? {});
    const output =
        typeof entry.output === "string"
            ? entry.output.slice(0, 160)
            : entry.output;
    return `- **${entry.tool}** input \`${input}\`${output ? ` -> \`${JSON.stringify(output)}\`` : ""}`;
}

const TRAIL_LIMIT = 15;

function trailFor(resultDir: string) {
    const trail = readTrail(resultDir);
    if (trail === null) return [];
    const entries = trail.entries.map(trailLine);
    if (entries.length <= TRAIL_LIMIT) return entries;
    return [
        ...entries.slice(0, TRAIL_LIMIT),
        `(${entries.length - TRAIL_LIMIT} more calls elided — this projection is truncated; tools.jsonl is the authoritative full trail)`,
    ];
}

function verdictFor(resultDir: string) {
    const verdictAt = verdictRecordAt(join(resultDir, "verdict.json"));
    if (verdictAt.kind === "malformed")
        return `malformed verdict.json (${verdictAt.problems.join("; ")})`;
    const verdict = verdictAt.kind === "value" ? verdictAt.value : null;
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
function artifactSection(resultDir: string, heading: string, name: string) {
    return [heading, "", "````", readArtifact(resultDir, name), "````", ""];
}

/** The numbered tool-trail entries of one case, or a "(no tool calls)" placeholder. */
function caseTrailEntries(resultDir: string) {
    const trail = trailFor(resultDir);
    return [
        `### Tool trail (${trail.length} entr${trail.length === 1 ? "y" : "ies"})`,
        "",
        ...(trail.length > 0 ? trail : ["(no tool calls)"]),
        "",
    ];
}

/** The exposure and discovery observations drawn from one case's tool trail. */
function caseObservations(resultDir: string) {
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
function caseMetaLine(meta: MetaRecord) {
    return (
        `Run meta: exit ${meta.exit ?? "?"}, ${meta.writes ?? "?"} write(s), ` +
        `answer ${meta.answerHash ?? "?"}, started ${meta.startedAt ?? "?"}` +
        `${meta.answerValid === false ? ", INVALID ANSWER" : ""}.`
    );
}

/** The dossier section for one case: rubric, prompt, answer, trail, verdict. */
function caseSection(
    caseInfo: RunCase | undefined,
    resultDir: string,
    legacy: boolean = false,
) {
    const metaAt = metaRecordAt(join(resultDir, "meta.json"));
    const meta = metaAt.kind === "value" ? metaAt.value : {};
    const scenario = reportedScenario(caseInfo, legacy);
    const expected = caseInfo?.expected ?? "(unknown — legacy run)";
    const diagnostic = resultIsDiagnostic(resultDir)
        ? diagnosticFor(resultDir)
        : null;
    return [
        "---",
        "",
        `## ${scenario} — Expected: ${expected}`,
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
        ...(diagnostic === null ? [] : diagnosticLines(diagnostic)),
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
function dossierLegacyLine(run: RunDescription | null) {
    return run === null
        ? "- Provenance: UNKNOWN — legacy stamp without run.json. Model, variant and guidance identity below come from saved per-case artefacts where present; treat missing labels as unknown, never as defaults."
        : "";
}

/** The sandbox-boundary sentence, or its legacy counterpart. */
function dossierBoundaryText(run: RunDescription | null) {
    const boundary = run?.trialBoundary ?? run?.boundary;
    if (!boundary) {
        return "unknown (legacy stamp — per-case meta.json records the boundary of each run)";
    }
    return boundary.containerised
        ? "each trial ran in its own container, whose mounts held only that case's sandbox, its prompt, an id-only case list and the result directory, plus a curated plugin package; the rubric reached the result only after the container exited"
        : "trials ran directly on the host — the container boundary was NOT enforced for this stamp; treat sandbox guarantees as absent";
}

/** The provenance bullets, or the legacy warning when the stamp recorded none. */
/** The dossier's stamp-level provenance info, legacy names tolerated. */
function dossierProvenanceInfo(run: RunDescription | null) {
    return run?.orchestration ?? run?.provenance;
}

/** The dossier's stamp-level boundary facts, legacy names tolerated. */
function dossierProvenanceBoundary(run: RunDescription | null) {
    return run?.trialBoundary ?? run?.boundary;
}

/** The provenance bullets, or the legacy warning when the stamp recorded none. */
function dossierProvenanceLines(run: RunDescription | null) {
    const provenanceInfo = dossierProvenanceInfo(run);
    if (!provenanceInfo) return [dossierLegacyLine(run)];
    return [
        dossierFixtureBullet(provenanceInfo),
        dossierPluginBullet(provenanceInfo),
        `- CLI: ${provenanceInfo.opencode ?? "unknown"}`,
        `- Image: ${dossierProvenanceBoundary(run)?.image || "none (host run)"}`,
    ];
}

/** The fixture-identity bullet of the dossier provenance block. */
function dossierFixtureBullet(info: Provenance) {
    return `- Fixture: ${info.fixtureVersion ?? "unknown"} (${info.fixtureHash ?? "unknown"})`;
}

/** The plugin-identity bullet, including the dirty-tree flag. */
function dossierPluginBullet(info: Provenance) {
    return (
        `- Plugin: ${info.pluginCommit ?? "unknown"} ` +
        `(${info.pluginHash ?? "unknown"}${info.pluginDirty ? ", dirty tree" : ""})`
    );
}

/** The run facts as bullets; "unknown (legacy)" when the stamp recorded none. */
function dossierRunLines(run: RunDescription | null) {
    const described = run ?? {};
    return [
        `- Run created: ${described.createdAt ?? "unknown (legacy)"}`,
        `- Reported: ${new Date().toISOString()} (rendering time, not run time)`,
        `- Trial model: ${described.model ?? "unknown (legacy)"}`,
        ...(described.condition === undefined
            ? []
            : [`- Condition: ${described.condition}`]),
        `- Variant: ${described.variant ?? "unknown (legacy)"}`,
    ];
}

/** The timeout and harness bullets of the dossier header. */
function dossierExecutionLines(run: RunDescription | null) {
    const described = run ?? {};
    return [
        `- Timeout: ${described.timeoutMs ?? "unknown"} ms per model call`,
        `- Harness: opencode-docs-plugin placement-harness v${described.harnessVersion ?? "?"}`,
    ];
}

function dossierHeader(
    options: CliOptions,
    stamp: string,
    run: RunDescription | null,
) {
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
function exportDossier(options: CliOptions, stamp: string) {
    const stampDir = join(options.results, stamp);
    if (!existsSync(stampDir)) usage(`no results at ${stampDir}`);
    const runAt = loadRunDescription(options, stamp);
    if (runAt.kind === "malformed") {
        usage(
            `${stamp}: run.json at ${runAt.path} is malformed ` +
                `(${runAt.problems.join("; ")}); the run cannot be exported`,
        );
    }
    const run = runAt.kind === "absent" ? null : runAt.value;
    const parts = dossierHeader(options, stamp, run);
    let cases = 0;
    const legacy = isLegacyRun(run);
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
                run?.cases?.find((entry: RunCase) => entry.id === id),
                resultDir,
                legacy,
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
async function runPool<T>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<number>,
): Promise<Array<PoolOutcome>> {
    const results: PoolOutcome[] = [];
    let next = 0;
    let index = 0;
    const width = Math.max(1, Math.min(limit, items.length));
    const runners = Array.from({ length: width }, async (): Promise<void> => {
        while (true) {
            const current = index;
            index += 1;
            if (current >= items.length) break;
            try {
                const item = items[current];
                if (item === undefined) continue;
                results[current] = {
                    ok: true,
                    value: await worker(item, current),
                };
            } catch (error: unknown) {
                results[current] = { ok: false, error };
                console.error(
                    `worker failed: ${error instanceof Error ? (error.stack ?? String(error)) : String(error)}`,
                );
            }
            next = Math.max(next, current + 1);
        }
    });
    await Promise.all(runners);
    return results;
}

async function runSelected(
    options: CliOptions,
    stamp: string,
    selected: TrialCase[],
): Promise<number> {
    assertRecordingClosingScope(selected, options);
    // A run never generates: it validates the prepared generation and
    // refuses stale or missing shared inputs instead (F03 contract).
    const corpusComplete = selectedAreFullDefinitions(selected);
    const results = await runPool(selected, options.jobs, (testCase) =>
        runOne(testCase, options, stamp, corpusComplete),
    );
    return results.reduce(
        (worst, outcome) => Math.max(worst, outcome.ok ? outcome.value : 1),
        0,
    );
}

async function judgeSelected(
    options: CliOptions,
    stamp: string,
    selected: FullTrialCase[],
) {
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
function resolveExistingStamp(options: CliOptions) {
    if (options.stamp) {
        const stampDir = join(options.results, options.stamp);
        if (!existsSync(stampDir)) usage(`no results at ${stampDir}`);
        return options.stamp;
    }
    if (!existsSync(options.results))
        usage(`no results root at ${options.results}`);
    const candidates = readdirSync(options.results, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry: { name: string }) => entry.name);
    if (candidates.length === 0)
        usage(`no result stamps under ${options.results}`);
    const createdAt = (name: string): number => {
        const at = runDescriptionAt(join(options.results, name, "run.json"));
        const run = at.kind === "value" ? at.value : null;
        if (typeof run?.createdAt === "string")
            return Date.parse(run.createdAt);
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
function planFor(command: string, noJudge: boolean) {
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

async function executeAndReport(
    options: CliOptions,
    plan: Plan,
    stamp: string,
    selected: TrialCase[],
) {
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
    if (plan.judges) {
        const judgedCases = selected.filter(isFullCase);
        worst = Math.max(
            worst,
            await judgeSelected(options, stamp, judgedCases),
        );
    }
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
        const selected = select(options, true);
        assertRecordingClosingScope(selected, options);
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
        return judgeSelected(options, stamp, judgeSelection(options, stamp));
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
    (error: unknown) => {
        console.error(
            error instanceof Error
                ? (error.stack ?? String(error))
                : String(error),
        );
        process.exit(1);
    },
);
