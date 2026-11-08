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
    renameSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    kind: "create" | "replace";
    target?: string;
    link?: string;
    retains?: string[];
    omits?: string[];
    preserve?: string[];
    singleDoc?: boolean;
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
    seeds?: SeedSpec[];
    mutationPolicy?: MutationPolicy | null;
    docsCriterion?: DocsCriterion | null;
    expectedDocs?: ExpectedDocs | null;
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
    discovery: boolean;
    help?: boolean;
    model: string;
    judgeModel: string;
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
    nativeDocsCompleted: number;
    twinDocsCompleted: number;
    codeModeAttempted: number;
    codeModeCompleted: number;
    executeCalls: number;
}

/** The reported docs telemetry for one trail. */
interface Telemetry {
    nativeDocs: number;
    twinDocs: number;
    nativeDocsCompleted: number;
    twinDocsCompleted: number;
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
    model?: string;
    judgeModel?: string | null;
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
const HARNESS_VERSION = 3;
/** Generation fingerprint version — bump when generation inputs/outputs change. */
const GENERATION_VERSION = 3;
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
    opencode:
        process.env.TRIAL_OPENCODE || process.env.OPENCODE_BIN || "opencode",
    fixture: DEFAULT_FIXTURE,
    plugin: DEFAULT_PLUGIN,
    timeoutMs: timeoutFromEnv(),
    jobs: jobsFromEnv("TRIAL_JOBS"),
    judgeJobs: jobsFromEnv("TRIAL_JUDGE_JOBS"),
};

/** Letters where a bare switch flag lands in `CliOptions`. */
type BooleanSwitch = "force" | "noJudge" | "allowWrites" | "discovery" | "help";

const SWITCHES: Record<string, BooleanSwitch> = {
    "--force": "force",
    "--no-judge": "noJudge",
    "--allow-writes": "allowWrites",
    "--discovery": "discovery",
    "--help": "help",
    "-h": "help",
};
/** Keys of `CliOptions` that hold strings (models, paths, names). */
type StringOptionKey =
    | "model"
    | "judgeModel"
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
function applyFlag(options: CliOptions, arg: string, argv: string[]) {
    const flag = SWITCHES[arg];
    if (flag === "help") usage();
    if (flag) {
        const flagKey: keyof CliOptions = flag;
        options[flagKey] = true;
        return true;
    }
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
    options[key] = spec.path === true ? resolve(raw) : raw;
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
        discovery: false,
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
 *   (generation and default judging flows): each entry then needs the
 *   claim/evidence/destinations a prompt is rendered from.
 * @returns The validated case entries.
 */
function loadCases(fixturePath: string, requireFull: boolean): TrialCase[] {
    const parsed: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
    if (!Array.isArray(parsed)) {
        usage(`corpus ${fixturePath} must be a JSON array of case entries`);
    }
    const cases: TrialCase[] = [];
    for (const entry of parsed) {
        const validated = validatedCorpusEntry(entry, requireFull);
        if (validated === null) {
            usage(
                `corpus ${fixturePath}: an entry lacks the shape of a ` +
                    (requireFull ? "full case" : "usable id"),
            );
        }
        cases.push(validated);
    }
    return cases;
}

/**
 * One validated corpus entry: proven by inspection, narrowed once — the
 * widening is only what the inspection above proves.
 * @param entry An array element of a loaded corpus.
 * @param requireFull Whether claim/destinations must be present.
 * @returns The narrowed case entry, or null when the shape fails.
 */
function validatedCorpusEntry(entry: unknown, requireFull: boolean): TrialCase | null {
    if (entry === null || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || id === "") return null;
    if (requireFull) {
        const claim = record.claim;
        const destinations = record.destinations;
        if (typeof claim !== "string" || !Array.isArray(destinations)) {
            return null;
        }
    }
    return record as unknown as TrialCase;
}

function select(options: CliOptions) {
    const cases = loadCases(options.fixture, false);
    if (options.ids.length === 0) return cases;
    const unknown = options.ids.filter(
        (id: string) => !cases.some((entry: TrialCase) => entry.id === id),
    );
    if (unknown.length > 0) usage(`unknown case(s): ${unknown.join(", ")}`);
    return cases.filter((entry) => options.ids.includes(entry.id));
}

const write = (path: string, contents: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
};

const sha256 = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
const fileHash = (path: string) => sha256(readFileSync(path));

function readJson(path: string): unknown | undefined {
    if (!existsSync(path)) return undefined;
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

/**
 * Typed record readers: each validates the record-ish object shape at the
 * real IO boundary, stays access-typed downstream, and never asserts a
 * field it has not seen.
 */
function readJsonRecord<T>(path: string): T | undefined {
    const value = readJson(path);
    if (!isRecord(value)) return undefined;
    return value as T;
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

function readMetaRecord(path: string): MetaRecord | undefined {
    return readJsonRecord<MetaRecord>(path);
}

function readVerdictRecord(path: string): VerdictRecord | undefined {
    return readJsonRecord<VerdictRecord>(path);
}

function readGenerationRecord(path: string): GenerationRecord | undefined {
    return readJsonRecord<GenerationRecord>(path);
}

function readRunJson(path: string): RunDescription | undefined {
    return readJsonRecord<RunDescription>(path);
}

function readJudgeAttemptMeta(path: string): JudgeAttemptRecord | undefined {
    return readJsonRecord<JudgeAttemptRecord>(path);
}

function readFreezeReceipt(path: string): FreezeReceipt | undefined {
    return readJsonRecord<FreezeReceipt>(path);
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
        ...previous,
        id,
        tool: typeof part.tool === "string" ? part.tool : previous.tool,
        input: state?.input ?? previous.input,
        status:
            state !== undefined && typeof state.status === "string"
                ? state.status
                : previous.status,
        output: toolOutput(state?.output ?? previous.output),
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

function extract(stdout: string) {
    const texts: string[] = [];
    const calls = new Map<string, ToolCall>();
    const unkeyed = { count: 0 };
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

/** The docs family an entry belongs to: "code-mode", "native", "twin", or null. */
function docsEntryKind(
    entry: ToolCall,
): "code-mode" | "native" | "twin" | null {
    const native = entry.tool === "docs" || entry.tool === "docs_search";
    if (isCodeModeDocs(entry)) return "code-mode";
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
    const field = kind === "native" ? "nativeDocs" : "twinDocs";
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
    // native or twin call that completed). Code Mode attempts never prove
    // the nested operation ran, so they never raise a verified verb.
    if (
        (kind === "native" || kind === "twin") &&
        entry.status === "completed"
    ) {
        tallies.verbsCompleted[verb] = (tallies.verbsCompleted[verb] ?? 0) + 1;
    }
}

/**
 * Docs-usage telemetry for one trail. Native `docs` calls, the native-facing
 * twin registration name `docs_search`, and Code Mode `execute` calls whose
 * code attempts `tools.docs.docs_search(…)` are counted separately. Counts
 * are reported at two levels: attempted operations (any status, plus
 * Code Mode attempts by code text) and verified completions (observable
 * docs operations that actually completed). A code-mode attempt is NOT
 * proof the nested operation ran: the nested call happens inside the
 * execute runtime and emits no separate event, so it is reported as
 * attempted only and is excluded from verified counts and from every gate
 * that needs verified usage.
 * @param entries Deduplicated tool calls.
 * @param parseFailures Unparsable trail lines.
 * @returns Counts and per-verb detail (attempted and completed) for
 *   reporting and criteria.
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
        nativeDocsCompleted: 0,
        twinDocsCompleted: 0,
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
        nativeDocsCompleted: tallies.nativeDocsCompleted,
        twinDocsCompleted: tallies.twinDocsCompleted,
        codeModeAttempted: tallies.codeModeAttempted,
        codeModeCompleted: tallies.codeModeCompleted,
        executeCalls: tallies.executeCalls,
        verbs: tallies.verbs,
        verbsCompleted: tallies.verbsCompleted,
        statuses: tallies.statuses,
        unparsedLines: parseFailures,
        docsCalls:
            tallies.nativeDocs + tallies.twinDocs + tallies.codeModeAttempted,
        verifiedDocs: tallies.nativeDocsCompleted + tallies.twinDocsCompleted,
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
    const { nativeDocs, twinDocs, codeModeAttempted } = telemetry;
    if (nativeDocs + twinDocs + codeModeAttempted === 0) return "none";
    const parts = [];
    if (nativeDocs > 0) parts.push(`${nativeDocs} native`);
    if (twinDocs > 0) parts.push(`${twinDocs} twin`);
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
    return { entries, parseFailures };
}

/* ------------------------------------------------------------------ *
 * Provenance and identity
 * ------------------------------------------------------------------ */

function childEnv(configHome: string): NodeJS.ProcessEnv {
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
    const manifest = readJsonRecord<{ fixtureHash?: string }>(
        join(options.fixtures, "manifest.json"),
    );
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

const promptFor = (testCase: FullTrialCase, options: CliOptions) => {
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
            permissions: SANDBOX_PERMISSIONS,
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
                permissions: SANDBOX_PERMISSIONS,
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
    const stored = readGenerationRecord(fixture.generationPath);
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
    const selected = select(options);
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
    const stored = readGenerationRecord(join(caseFixture, "generation.json"));
    if (stored === undefined) {
        return {
            problems: ["no generation fingerprint; run generate first"],
            generation: undefined,
        };
    }
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
    if (before.kind !== kind || after.kind !== before.kind) return "";
    switch (before.kind) {
        case "file":
            if (after.kind === "file") return fileKindChangeLabel(before, after);
            return "";
        case "symlink":
            if (after.kind === "symlink" && before.target !== after.target) {
                return "target";
            }
            return "";
        case "dir":
            if (
                after.kind === "dir" &&
                before.mode !== undefined &&
                after.mode !== undefined &&
                before.mode !== after.mode
            ) {
                return "mode";
            }
            return "";
        default:
            return "";
    }
}

/** Content first, then the permission-mode change. */
function fileKindChangeLabel(
    before: { hash: string; mode?: string | undefined },
    after: { hash: string; mode?: string | undefined },
): string {
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
    const metaDigest = meta?.finalStateDigest;
    if (
        typeof metaDigest === "string" &&
        snapshotDigest(snapshot) !== metaDigest
    ) {
        return {
            problem:
                "recorded mutation evidence altered after the run " +
                "(final-state digest mismatch)",
        };
    }
    const diff = meta?.writeKinds;
    if (!diff || !Array.isArray(diff.added)) {
        return {
            problem:
                "recording case predates structured write evidence; " +
                "re-run with the current harness",
        };
    }
    const allowed = definition.mutationPolicy?.allowed ?? [];
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
        allowed.some((pattern) => globMatch(pattern, path));
    const surfaceTouched = touched.filter(([path]) => onSurface(path));
    return {
        problem: null,
        liveDir,
        snapshot,
        diff,
        onSurface,
        surfaceTouched,
    };
}

/**
 * The gate's content checks for one expectation-fulfilling document:
 * structural validity, required and absent content, link references.
 * @param path The document's surface-relative path.
 * @param text The recorded document bytes.
 * @param expectation The case's `expectedDocs` object.
 * @param what What the document did (created / replaced), for messages.
 */
function docContentProblem(
    path: string,
    text: string,
    expectation: ExpectedDocs,
    what: string,
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
        if (text.includes(stale)) {
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

/** Whether anything besides the expected paths changed inside the surface. */
function unrelatedSurfaceChangeProblem(
    evidence: MutationEvidence,
    expectedPaths: string[],
): string | null {
    const others = evidence.surfaceTouched.filter(
        ([path]) => !expectedPaths.includes(path),
    );
    if (others.length === 0) return null;
    return (
        "unrelated change(s) inside the documentation surface: " +
        others.map(([path, action]) => `${action} ${path}`).join(", ")
    );
}

/** Replace-verb expectations: target modified in place, content valid. */
function replaceDocVerdict(
    evidence: MutationEvidence,
    expectation: ExpectedDocs,
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
    const content = docContentProblem(target, text, expectation, "replaced");
    if (content !== null) return { problem: content };
    const others = unrelatedSurfaceChangeProblem(evidence, [target]);
    if (others !== null) return { problem: others };
    return {
        problem: null,
        artifacts: [{ path: target, excerpt: artefactExcerpt(target, text) }],
    };
}

/** Create-verb expectations: exactly one valid knowledge doc on the surface. */
function createDocVerdict(
    evidence: MutationEvidence,
    expectation: ExpectedDocs,
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
    const content = docContentProblem(path, text, expectation, "created");
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
        expectation.kind === "replace"
            ? replaceDocVerdict(evidence, expectation)
            : createDocVerdict(evidence, expectation);
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
        model: options.model,
        judgeModel: options.judgeModel || null,
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
function ensureRunDescription(
    options: CliOptions,
    stamp: string,
    selected: TrialCase[],
    command: string,
) {
    const path = join(options.results, stamp, "run.json");
    const existing = readRunJson(path);
    const containerFlow =
        !selectedAreFullDefinitions(selected) ||
        boundaryOf().containerised === true;
    const description = runDescription(options, stamp, selected, command);
    if (existing !== undefined) {
        const conflicts = runDescriptionConflicts(
            existing,
            description,
            containerFlow,
        );
        if (conflicts.length > 0) {
            console.error(
                `run.json at ${path} already describes a different ` +
                    `experiment (${conflicts.join("; ")}); use a new --stamp`,
            );
            return false;
        }
        return true;
    }
    if (boundaryOf().containerised === true) {
        // Inside a trial container this stamp's run description is neither
        // visible nor writable: the freeze must have happened host-side, and
        // this case must carry a receipt proving it (the wrapper stages one
        // after 'describe'). An unwritable root, or a missing/mismatched
        // receipt, is a refusal — never assumed evidence of a freeze.
        const unverified = selected.filter((testCase) => {
            const receipt = readFreezeReceipt(
                join(options.fixtures, testCase.id, "frozen.json"),
            );
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

/** The saved run description, or null for a legacy stamp. */
function loadRunDescription(options: CliOptions, stamp: string) {
    return readRunJson(join(options.results, stamp, "run.json")) ?? null;
}

/* ------------------------------------------------------------------ *
 * Running trials
 * ------------------------------------------------------------------ */

/** The default grace window between SIGTERM and SIGKILL, env-overridable for tests. */
function termGraceFromEnv() {
    const value = Number(process.env.TRIAL_TERM_GRACE_MS ?? 5_000);
    return Number.isFinite(value) && value > 0 ? value : 5_000;
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
    const { cwd, env, model, title, prompt, opencode, timeoutMs } = args;
    return new Promise((resolve: (value: SpawnResult) => void) => {
        let child: import("child_process").ChildProcessByStdio<
            null,
            import("stream").Readable,
            import("stream").Readable
        >;
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
        child.stdout.on("data", (chunk) => appendChunk("stdout", chunk));
        child.stderr.on("data", (chunk) => appendChunk("stderr", chunk));

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
                writeKinds: diff,
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
    const meta = readMetaRecord(join(resultDir, "meta.json"));
    if (meta?.answerValid === false) {
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
 * `minVerifiedCalls` (current): a gate on verified completions only —
 * observable docs operations (native or twin) that completed. A failed or
 * denied call, and a Code Mode attempt (whose nested operation is
 * unobservable), never satisfies a gate. Required verbs must have been
 * completed, and each `paths` fragment must be referenced by a completed
 * docs operation's input, so an unrelated read does not stand in for the
 * relevant document.
 *
 * `minDocsCalls` (legacy): the historical attempted-operations semantics,
 * applied to saved old definitions as they were recorded — labelled
 * `(legacy attempted-operations)` so the loosened floor is visible, never
 * silently applied.
 * @returns The gate problem, or null when the criterion is met or absent.
 */
function docsCriterionProblem(testCase: FullTrialCase, resultDir: string) {
    const criterion = testCase?.docsCriterion;
    if (!criterion) return null;
    return "minVerifiedCalls" in criterion
        ? verifiedDocsCriterionProblem(criterion, resultDir)
        : legacyDocsCriterionProblem(criterion, resultDir);
}

/** Required document references a completed docs operation must include. */
function missingRequiredPaths(trail: ToolTrail, paths: string[]): string[] {
    return paths.filter(
        (path) =>
            !trail.entries.some(
                (entry) =>
                    docsEntryKind(entry) !== null &&
                    entry.status === "completed" &&
                    JSON.stringify(entry.input ?? "").includes(path),
            ),
    );
}

/** The `minVerifiedCalls` criterion: verified completions only. */
function verifiedDocsCriterionProblem(
    criterion: VerifiedDocsCriterion,
    resultDir: string,
): string | null {
    const trail = readTrail(resultDir);
    if (trail === null) return "docs criterion unmet: no tool trail recorded";
    const telemetry = docsTelemetry(trail.entries, trail.parseFailures);
    const required = criterion.minVerifiedCalls ?? 1;
    if (telemetry.verifiedDocs < required) {
        return telemetry.codeModeAttempted > 0 && telemetry.verifiedDocs === 0
            ? `docs criterion unmet: ${telemetry.codeModeAttempted} code-mode attempt(s) are unobservable nested operations — inconclusive without a completed native or twin call ` +
                  `(0 verified docs op(s), required ${required})`
            : `docs criterion unmet: ${telemetry.verifiedDocs} verified docs op(s), required ${required}`;
    }
    if (
        criterion.verbs !== undefined &&
        !criterion.verbs.some(
            (verb) => (telemetry.verbsCompleted[verb] ?? 0) > 0,
        )
    ) {
        return `docs criterion unmet: no completed ${criterion.verbs.join("/")} operation (attempts are counted, never verified)`;
    }
    if (criterion.paths !== undefined) {
        const missing = missingRequiredPaths(trail, criterion.paths);
        if (missing.length > 0) {
            return `docs criterion unmet: no completed docs operation references ${missing.join(", ")}`;
        }
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
        textParts,
        lastPartKind,
    } = extract(result.stdout ?? "");
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
        textParts,
        lastPartKind,
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
        afterSnapshot,
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

function judgePrompt(resultDir: string, artifactLines: string[]) {
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
${writes}${artifactLines.length > 0 ? `\n\nVerified recorded artefacts (the deterministic structural gate already passed on these; excerpts may be truncated — the recorded live tree is authoritative):\n${artifactLines.join("\n")}` : ""}`;
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
    const meta = readMetaRecord(join(resultDir, "meta.json"));
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
        const prior = readJudgeAttemptMeta(
            join(judgeRoot, entry.name, "meta.json"),
        );
        if (prior?.judgeKey === key && prior?.judgeStatus === "judged") {
            const verdict = readVerdictRecord(
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
function judgeSelection(options: CliOptions, stamp: string): FullTrialCase[] {
    const run = loadRunDescription(options, stamp);
    if (run === null) {
        console.error(
            "judging a legacy stamp: no frozen run description exists, so " +
                "criteria come from the current corpus (limitation, not a pass)",
        );
        const legacyCases = select(options).filter(isFullCase);
        if (legacyCases.length === 0) {
            usage(
                "the current corpus carries no full definitions to judge a " +
                    "legacy stamp with",
            );
        }
        return legacyCases;
    }
    const full: FullTrialCase[] =
        (run.cases ?? [])
            .map((entry: RunCase) => entry.definition ?? entry)
            .filter((definition: unknown) => isRecord(definition))
            ?.filter(isFullCase) ?? [];
    if (full.length === 0) {
        usage(
            `run.json at ${join(options.results, stamp)} records no usable full case definitions`,
        );
    }
    if (full.length === 0) {
        usage(
            `run.json at ${join(options.results, stamp)} records no usable case definitions`,
        );
    }
    if (options.ids.length === 0) return full;
    const unknown = options.ids.filter(
        (id: string) => !full.some((entry) => entry.id === id),
    );
    if (unknown.length > 0) {
        usage(
            `case(s) ${unknown.join(", ")} are not part of experiment ${stamp}`,
        );
    }
    return full.filter((entry) => options.ids.includes(entry.id));
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
    const meta = readMetaRecord(join(resultDir, "meta.json")) ?? {};
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

function summaryRow(
    runDescription: RunDescription | null,
    caseInfo: RunCase | undefined,
    resultDir: string,
) {
    const verdict = readVerdictRecord(join(resultDir, "verdict.json"));
    const report = existsSync(join(resultDir, "writes.txt"))
        ? readFileSync(join(resultDir, "writes.txt"), "utf8").trim()
        : "";
    const trail = readTrail(resultDir);
    const telemetry =
        trail === null
            ? null
            : docsTelemetry(trail.entries, trail.parseFailures);
    const meta = readMetaRecord(join(resultDir, "meta.json")) ?? {};
    return {
        id: caseInfo?.id ?? "?",
        expected: summaryExpected(caseInfo, runDescription),
        verdict: summaryVerdict(verdict, resultDir),
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
        "| Case | Expected | Verdict | Destination | Writes | Docs | Discovery | Exposure |",
        "| ---- | -------- | ------- | ----------- | ------ | ---- | --------- | -------- |",
        ...rows.map(
            (row) =>
                `| ${row.id} | ${row.expected} | ${row.verdict}${row.modelMismatch} | ${row.destination || "-"} | ${row.writes} | ${row.docs} | ${row.discovery} | ${row.exposure} |`,
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
    const run = loadRunDescription(options, stamp);
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
    const verdict = readVerdictRecord(join(resultDir, "verdict.json"));
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
function caseSection(caseInfo: RunCase | undefined, resultDir: string) {
    const meta = readMetaRecord(join(resultDir, "meta.json")) ?? {};
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
                run?.cases?.find((entry: RunCase) => entry.id === id),
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
        const run = readRunJson(join(options.results, name, "run.json"));
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
