#!/usr/bin/env node
/**
 * Campaign support for the arm-blind description comparison.
 *
 * Seven commands, all reading and writing outside the repository:
 * `schedule` regenerates the frozen slot list; `gate` records the harness's
 * deterministic verdict per trial; `judge` collects one structured,
 * evidence-checked judgement from a self-contained packet; `resolve` re-parses
 * answers whose only failure was trailing prose; `report` aggregates recorded
 * trials into the published utility tables; `manifest` hashes the evidence;
 * `clear-reservation` removes only an abandoned lock and refuses when any
 * recorded evidence is present.
 *
 * Nothing here calls a model except `judge`, and `judge` never retries.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimAttemptDir, clearReservation } from "./evidence-guard.mts";
import {
    buildSchedule,
    docChanges,
    firstBalancedObject,
    labelLeaks,
    type LakeDocument,
} from "./campaign.mts";
import {
    hostDispatchesFromTrail,
    journalIdentityFromTrail,
    verifyOperationsJournal,
} from "../analysis/journal.ts";
import {
    DOCUMENTATION_OUTCOMES,
    PRESERVATION_CASE,
    buildAcPrompt,
    finalistQualifies,
    judgeFailureClass,
    parseAcJudgement,
    rankCandidates,
    sensitivity,
    summariseArm,
    validateAcJudgement,
    type DocState,
    type DocumentationOutcome,
    type JudgeFailureClass,
    type PreservationSpec,
    type RetrievalSpec,
} from "../ac-scoring.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTCOME_KEYS: readonly DocumentationOutcome[] = [
    "useful-create",
    "useful-update",
    "transient",
    "duplicate",
    "misleading",
    "none",
];

/** One JSON object, or a thrown refusal naming the file. */
function recordOf(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object`);
    }
    return value as Record<string, unknown>;
}

/** Read JSON, or null when the file is absent. */
const readJson = (path: string): unknown =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;

/** Read text, or an empty string when the file is absent. */
const readText = (path: string): string =>
    existsSync(path) ? readFileSync(path, "utf8") : "";

/** Write JSON with a trailing newline. */
const writeJson = (path: string, value: unknown): void =>
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");

/** SHA-256 of a string. */
const sha256 = (text: string): string =>
    createHash("sha256").update(text, "utf8").digest("hex");

/** Parse `--flag value` pairs into a map. */
function flags(argv: string[]): Map<string, string | undefined> {
    const parsed = new Map<string, string | undefined>();
    for (let index = 0; index < argv.length; index += 2) {
        const name = argv[index];
        if (name === undefined || !name.startsWith("--")) {
            throw new Error(`unexpected argument ${String(name)}`);
        }
        parsed.set(name, argv[index + 1]);
    }
    return parsed;
}

/** Require a flag value. */
function need(args: Map<string, string | undefined>, name: string): string {
    const value = args.get(name);
    if (!value) throw new Error(`missing ${name}`);
    return value;
}

/** The harness entry point inside one arm worktree. */
const harnessOf = (repo: string): string =>
    join(repo, "tests/fixtures/placement-harness/harness.mts");

/**
 * Collect Markdown documents under a `lakes` root as `{path, contents}`.
 * Paths are lake-qualified (`docs/db/pool.md`), so documents in different
 * lakes stay distinguishable and a multi-lake trial is judged from its whole
 * surface.
 */
function lakeDocs(root: string): LakeDocument[] {
    const found: LakeDocument[] = [];
    const visit = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile() && entry.name.endsWith(".md")) {
                found.push({
                    path: path.slice(root.length + 1),
                    contents: readFileSync(path, "utf8"),
                });
            }
        }
    };
    visit(root);
    return found.sort((left, right) => left.path.localeCompare(right.path));
}

/** One JSON line from an `opencode --format json` trail, or undefined. */
function trailEvent(line: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "object" || value === null) return undefined;
        return value as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

/**
 * The completion evidence of one judge capture.
 *
 * Completion refers to the final assessed response, not to any earlier step: it
 * requires exit 0, no signal or timeout, a nonblank final text part, and a
 * trail whose last event is a `step_finish` with reason `stop` (a truncated or
 * unfinished trail is never treated as a complete answer).
 */
interface CompletionEvidence {
    /** The process exit code, or null when unknown. */
    exit: number | null;
    /** The terminating signal, or null. */
    signal: string | null;
    /** Whether the spawn timed out. */
    timedOut: boolean;
    /** Whether a nonblank final text part was captured. */
    finalTextPresent: boolean;
    /** Whether the trail ends on a `step_finish` with reason `stop`. */
    trailTerminated: boolean;
    /** Whether the capture proves a complete final response. */
    complete: boolean;
}

/**
 * Derive completion evidence from one judge capture.
 * @param stdout The raw JSONL trail.
 * @param answer The extracted final text part.
 * @param exit The recorded exit code, or null when unknown.
 * @param signal The recorded signal, or null.
 * @param timedOut Whether the capture timed out.
 * @returns The completion evidence.
 */
function completionEvidence(
    stdout: string,
    answer: string,
    exit: number | null,
    signal: string | null,
    timedOut: boolean,
): CompletionEvidence {
    const finalTextPresent = answer.trim() !== "";
    const trailTerminated = trailTerminatedOf(stdout);
    return {
        exit,
        signal,
        timedOut,
        finalTextPresent,
        trailTerminated,
        complete: captureComplete(
            exit,
            signal,
            timedOut,
            finalTextPresent,
            trailTerminated,
        ),
    };
}

/** Whether a trail ends on a `step_finish` with reason `stop`. */
function trailTerminatedOf(stdout: string): boolean {
    const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    const event =
        lines.length === 0 ? undefined : trailEvent(lines[lines.length - 1]!);
    const part = event?.part;
    return (
        event?.type === "step_finish" &&
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).reason === "stop"
    );
}

/** Whether the capture proves a complete final response. */
function captureComplete(
    exit: number | null,
    signal: string | null,
    timedOut: boolean,
    finalTextPresent: boolean,
    trailTerminated: boolean,
): boolean {
    return (
        exit === 0 &&
        signal === null &&
        !timedOut &&
        finalTextPresent &&
        trailTerminated
    );
}

/** The final text part of a JSONL trail. */
function finalAnswer(stdout: string): string {
    return (
        stdout
            .split("\n")
            .map(trailEvent)
            .filter((event) => {
                const part = event?.part;
                return (
                    typeof part === "object" &&
                    part !== null &&
                    (part as Record<string, unknown>).type === "text"
                );
            })
            .map((event) => {
                const part = event?.part as Record<string, unknown>;
                return typeof part.text === "string" ? part.text : "";
            })
            .pop() ?? ""
    );
}

interface TokenUsage {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    steps: number;
}

/** Add one step's tokens to a usage total. */
function addStepTokens(
    usage: TokenUsage,
    tokens: Record<string, unknown>,
): void {
    usage.steps += 1;
    usage.input += typeof tokens.input === "number" ? tokens.input : 0;
    usage.output += typeof tokens.output === "number" ? tokens.output : 0;
    usage.reasoning +=
        typeof tokens.reasoning === "number" ? tokens.reasoning : 0;
    const cache =
        typeof tokens.cache === "object" && tokens.cache !== null
            ? (tokens.cache as Record<string, unknown>)
            : {};
    usage.cacheRead += typeof cache.read === "number" ? cache.read : 0;
}

/** Token usage from a recorded trail. */
function usageOf(stdoutPath: string): TokenUsage {
    const usage: TokenUsage = {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        steps: 0,
    };
    for (const line of readText(stdoutPath).split("\n")) {
        const event = line.trim() === "" ? undefined : trailEvent(line);
        const part = event?.part;
        if (
            event?.type === "step_finish" &&
            typeof part === "object" &&
            part !== null
        ) {
            const tokens = (part as Record<string, unknown>).tokens;
            if (typeof tokens === "object" && tokens !== null) {
                addStepTokens(usage, tokens as Record<string, unknown>);
            }
        }
    }
    return usage;
}

/** The input fields of one docs operation, rendered for the judge. */
function inputParts(input: Record<string, unknown>): string[] {
    const parts: string[] = [];
    if (typeof input.search === "string")
        parts.push(`search "${input.search}"`);
    if (typeof input.read === "string") parts.push(`read ${input.read}`);
    if (typeof input.check === "string") parts.push(`check ${input.check}`);
    const add = input.add;
    if (typeof add === "object" && add !== null) {
        const declaration = add as Record<string, unknown>;
        parts.push(
            `${String(declaration.mode ?? "create")} ${String(declaration.path ?? "(body)")}`,
        );
    }
    return parts;
}

/** One verified docs operation, rendered for the judge. */
function operationLine(entry: Record<string, unknown>): string {
    const surface = entry.surface === "codemode-twin" ? "twin" : "native";
    const input =
        typeof entry.input === "object" && entry.input !== null
            ? (entry.input as Record<string, unknown>)
            : {};
    const parts = inputParts(input);
    return `${String(entry.status ?? "unknown")} ${surface} ${parts.join("; ") || "help"}`;
}

/**
 * The operations the judge may see: the journal's credited records only.
 *
 * A journal without its key or host trail cannot be attributed. New campaigns
 * refuse that state; explicit legacy coverage drops the unattributable
 * operations instead of guessing.
 * @param caseDir The trial's result directory.
 * @param allowLegacy Whether absent binding evidence is tolerated.
 * @returns The credited operation lines, or a refusal.
 */
function attributableOperations(
    caseDir: string,
    allowLegacy: boolean,
): { lines?: string[]; reason?: string } {
    const journalPath = join(caseDir, "docs-operations.jsonl");
    if (!existsSync(journalPath)) return { lines: [] };
    const keyPath = join(caseDir, "docs-operations.key");
    const toolsPath = join(caseDir, "tools.jsonl");
    const stdoutPath = join(caseDir, "stdout.jsonl");
    if (!existsSync(keyPath) || !existsSync(toolsPath)) {
        if (allowLegacy) return { lines: [], reason: "legacy-unbound" };
        return {
            reason: "the operation journal has no signing key or host trail; it cannot be attributed",
        };
    }
    const verification = verifyOperationsJournal({
        lines: readText(journalPath)
            .split("\n")
            .filter((line) => line !== ""),
        key: readText(keyPath).trim(),
        identity: journalIdentityFromTrail(readText(stdoutPath)),
        ...(() => {
            const host = hostDispatchesFromTrail(readText(toolsPath));
            return {
                callIds: host.callIds,
                nativeCalls: host.nativeCalls,
                dispatches: host.dispatches,
            };
        })(),
    });
    if (verification.problems.length > 0 || verification.rejected.length > 0) {
        return {
            reason: `the operation journal is not attributable: ${verification.problems[0] ?? `${String(verification.rejected.length)} line(s) rejected`}`,
        };
    }
    return {
        lines: verification.credited.map((entry) =>
            operationLine(entry.record),
        ),
    };
}

/** Changed paths from a writes report. */
function changedPaths(writes: string): string[] {
    return writes
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && line !== "none")
        .map((line) =>
            line
                .replace(/^[a-z]+: /, "")
                .replace(/ \((file|dir|symlink|mode)\)$/, ""),
        );
}

/** The primary-check evidence the judge sees. */
function primaryEvidence(record: unknown): {
    status: string;
    exit: number | null;
    stdout: string;
    stderr: string;
} {
    const value = objectOf(record);
    return {
        status: String(value?.status ?? "missing"),
        exit: typeof value?.exit === "number" ? value.exit : null,
        stdout: String(value?.stdout ?? "").slice(0, 8000),
        stderr: String(value?.stderr ?? "").slice(0, 4000),
    };
}

/**
 * Resolve one case's measurement entry. A declaration may key cases at the
 * top level or nest them under `scenarios`; both are accepted so the same
 * measured campaign file drives the judge packet and the analyser.
 * @param scoringSpec The parsed measurement declaration, when supplied.
 * @param caseId The case id.
 * @returns The case's measurement entry, or an empty object.
 */
function caseSpecOf(
    scoringSpec: unknown,
    caseId: string,
): { preservation?: unknown; retrieval?: unknown } {
    const spec =
        typeof scoringSpec === "object" && scoringSpec !== null
            ? (scoringSpec as Record<string, unknown>)
            : {};
    const scenarios =
        typeof spec.scenarios === "object" && spec.scenarios !== null
            ? (spec.scenarios as Record<string, unknown>)
            : {};
    const entry = scenarios[caseId] ?? spec[caseId] ?? {};
    return typeof entry === "object" && entry !== null
        ? (entry as { preservation?: unknown; retrieval?: unknown })
        : {};
}

/** A declared preservation inventory, or undefined when malformed or absent. */
function preservationSpecOf(value: unknown): PreservationSpec | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const facts = (value as { facts?: unknown }).facts;
    if (!Array.isArray(facts)) return undefined;
    const entries = facts.map((fact) => {
        if (typeof fact !== "object" || fact === null) return undefined;
        const entry = fact as Record<string, unknown>;
        if (
            typeof entry.id !== "string" ||
            typeof entry.label !== "string" ||
            (entry.obsolete !== undefined &&
                typeof entry.obsolete !== "boolean")
        )
            return undefined;
        return {
            id: entry.id,
            label: entry.label,
            ...(entry.obsolete === true ? { obsolete: true } : {}),
        };
    });
    if (entries.some((entry) => entry === undefined)) return undefined;
    return { facts: entries as PreservationSpec["facts"] };
}

/** A declared retrieval finding, or undefined when malformed or absent. */
function retrievalSpecOf(value: unknown): RetrievalSpec | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const entry = value as Record<string, unknown>;
    if (typeof entry.note !== "string" || typeof entry.detail !== "string")
        return undefined;
    if (entry.lake !== undefined && typeof entry.lake !== "string")
        return undefined;
    return {
        note: entry.note,
        detail: entry.detail,
        ...(typeof entry.lake === "string" ? { lake: entry.lake } : {}),
    };
}

/**
 * Assemble one arm-blind packet for a completed trial.
 * @param base The stage's result roots.
 * @param stamp The trial stamp.
 * @param caseId The scenario id.
 * @param truth The scenario-truth map.
 * @returns The packet text and the mutation facts behind it.
 */
function packetFor(
    base: string,
    stamp: string,
    caseId: string,
    truth: Record<string, unknown>,
    scoringSpec: unknown,
    docsOperations: string[],
) {
    const caseDir = join(base, "results", stamp, caseId);
    const caseSpec = caseSpecOf(scoringSpec, caseId);
    const preservation = preservationSpecOf(caseSpec.preservation);
    const retrieval = retrievalSpecOf(caseSpec.retrieval);
    const beforeDocs = lakeDocs(join(base, "fixtures", caseId, "lakes"));
    const afterDocs = lakeDocs(join(caseDir, "live/lakes"));
    const state = docChanges(beforeDocs, afterDocs);
    const scenarioTruth = truth[caseId];
    const prompt = buildAcPrompt({
        taskPrompt: readText(join(caseDir, "prompt.md")),
        standingPermission: readText(
            join(base, "fixtures", caseId, "work/AGENTS.md"),
        ),
        scenarioTruth: typeof scenarioTruth === "string" ? scenarioTruth : "",
        beforeDocs,
        afterDocs,
        changedPaths: changedPaths(readText(join(caseDir, "writes.txt"))),
        primary: primaryEvidence(readJson(join(caseDir, "primary-check.json"))),
        docsOperations,
        answer: readText(join(caseDir, "final.md")),
        requirePreservation:
            caseId === PRESERVATION_CASE && preservation === undefined,
        ...(preservation === undefined
            ? {}
            : { preservationSpec: preservation }),
        ...(retrieval === undefined ? {} : { retrievalSpec: retrieval }),
    });
    return { caseDir, prompt, state };
}

/** The judge spawn arguments for one packet. */
const judgeArgs = (model: string, stamp: string, prompt: string): string[] => [
    "run",
    "--standalone",
    "--auto",
    "--archived",
    "--title",
    `ac-scoring-${sha256(stamp).slice(0, 12)}`,
    "--model",
    model,
    "--format",
    "json",
    prompt,
];

/** Spawn one isolated judge session. */
interface JudgeSpawn {
    launcher: string;
    model: string;
    stamp: string;
    prompt: string;
    runDir: string;
    timeout: number;
}

function spawnJudge({
    launcher,
    model,
    stamp,
    prompt,
    runDir,
    timeout,
}: JudgeSpawn) {
    return spawnSync(launcher, judgeArgs(model, stamp, prompt), {
        cwd: join(runDir, "work"),
        encoding: "utf8",
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        env: {
            ...process.env,
            AC_RUN_DIR: runDir,
            AC_MODEL: model,
            // The judge-visible context travels by name so the launcher uses
            // exactly the values this wrapper scanned before dispatch.
            AC_CONTAINER_RUN_DIR: JUDGE_CHILD.runDir,
            AC_CONTAINER_HOME: JUDGE_CHILD.home,
            AC_CONTAINER_DATA_HOME: JUDGE_CHILD.dataHome,
            AC_CONTAINER_CACHE_HOME: JUDGE_CHILD.cacheHome,
        },
    });
}

/** The stored judgement payload for one parsed answer. */
/**
 * The validation options one case's measurement spec requires: R02 keeps its
 * pinned block, a generic inventory replaces it, and a declared retrieval
 * finding is required.
 */
function judgementOptions(
    caseId: string,
    scoringSpec: unknown,
): {
    requirePreservation: boolean;
    preservationSpec?: PreservationSpec;
    retrieval?: boolean;
} {
    const caseSpec = caseSpecOf(scoringSpec, caseId);
    const preservation = preservationSpecOf(caseSpec.preservation);
    const options: {
        requirePreservation: boolean;
        preservationSpec?: PreservationSpec;
        retrieval?: boolean;
    } = {
        requirePreservation:
            caseId === PRESERVATION_CASE && preservation === undefined,
    };
    if (preservation !== undefined) options.preservationSpec = preservation;
    if (retrievalSpecOf(caseSpec.retrieval) !== undefined)
        options.retrieval = true;
    return options;
}

function judgementPayload(
    parsed: ReturnType<typeof parseAcJudgement>,
    state: DocState,
    caseId: string,
    scoringSpec: unknown,
) {
    const problems =
        parsed.value === undefined
            ? parsed.problems
            : validateAcJudgement(
                  parsed.value,
                  state,
                  judgementOptions(caseId, scoringSpec),
              );
    return {
        problems,
        value:
            problems.length === 0
                ? { status: "judged", ...parsed.value }
                : {
                      status: "invalid-verdict",
                      problems,
                      parsed: parsed.value ?? null,
                  },
    };
}

/** Whether the judge process produced a nonblank answer. */
function judgeProcessOk(
    result: ReturnType<typeof spawnSync>,
    answer: string,
): boolean {
    return (
        result.error === undefined &&
        result.signal === null &&
        result.status === 0 &&
        answer.trim() !== ""
    );
}

/** Write the finished attempt metadata. */
function writeFinishedMeta(
    attemptDir: string,
    state: DocState,
    model: string,
    stamp: string,
    caseId: string,
    started: Record<string, unknown> | null,
    status: number | null,
    completion: CompletionEvidence,
    failureClass: JudgeFailureClass | null,
    packetSha256: string | null,
): void {
    writeJson(join(attemptDir, "meta.json"), {
        stamp,
        caseId,
        judgeModel: model,
        status: "finished",
        startedAt: started?.startedAt ?? null,
        exit: status,
        state,
        packetSha256,
        completion,
        failureClass,
    });
}

/**
 * Record a judge attempt's evidence and return its terminal status.
 * @param attemptDir The attempt directory.
 * @param result The spawned judge result.
 * @param state The mutation facts behind the packet.
 * @param model The judge model route.
 * @param stamp The trial stamp.
 * @param caseId The scenario id.
 * @param scoringSpec The measurement declaration.
 * @param packetSha256 The packet identity both attempts must share.
 * @returns 0 when a usable judgement landed, 1 when it did not.
 */
function recordJudgement(
    attemptDir: string,
    result: ReturnType<typeof spawnSync>,
    state: DocState,
    model: string,
    stamp: string,
    caseId: string,
    scoringSpec: unknown,
    packetSha256: string | null,
) {
    const started = objectOf(readJson(join(attemptDir, "meta.json")));
    const output = String(result.stdout ?? "");
    writeFileSync(join(attemptDir, "output.jsonl"), output, "utf8");
    const answer = finalAnswer(output);
    // The extracted final content is preserved beside the raw trail, so a
    // malformed answer can be diagnosed without re-deriving the extraction.
    writeFileSync(join(attemptDir, "finalAnswer.txt"), answer, "utf8");
    const timedOut =
        (result.error as NodeJS.ErrnoException | undefined)?.code ===
        "ETIMEDOUT";
    const completion = completionEvidence(
        output,
        answer,
        result.status,
        result.signal,
        timedOut,
    );
    const processOk = judgeProcessOk(result, answer);
    const outcome = processOk
        ? verdictOutcome(
              parseAcJudgement(answer),
              state,
              caseId,
              scoringSpec,
              completion,
          )
        : processFailureOutcome(result, completion);
    writeFinishedMeta(
        attemptDir,
        state,
        model,
        stamp,
        caseId,
        started,
        result.status,
        completion,
        outcome.failureClass,
        packetSha256,
    );
    writeJson(join(attemptDir, "judgement.json"), outcome.judgement);
    return outcome.judgement.status === "judged" ? 0 : 1;
}

/** The judgement payload for one parsed verdict. */
function verdictOutcome(
    parsed: ReturnType<typeof parseAcJudgement>,
    state: DocState,
    caseId: string,
    scoringSpec: unknown,
    completion: CompletionEvidence,
): {
    failureClass: JudgeFailureClass | null;
    judgement: Record<string, unknown>;
} {
    const payload = judgementPayload(parsed, state, caseId, scoringSpec);
    if (payload.problems.length === 0) {
        return { failureClass: null, judgement: payload.value };
    }
    const failureClass = judgeFailureClass({
        complete: completion.complete,
        value: parsed.value,
        problems: payload.problems,
    });
    return {
        failureClass,
        judgement: { ...payload.value, failureClass, completion },
    };
}

/** The judgement payload for a process that produced no usable capture. */
function processFailureOutcome(
    result: ReturnType<typeof spawnSync>,
    completion: CompletionEvidence,
): { failureClass: JudgeFailureClass; judgement: Record<string, unknown> } {
    const processFailure =
        result.error !== undefined ||
        result.signal !== null ||
        result.status !== 0;
    const failureClass = processFailure
        ? "transport-or-process"
        : "empty-or-truncated";
    return {
        failureClass,
        judgement: {
            status: "judge-error",
            failureClass,
            completion,
            problems: [`process not ok (exit ${result.status})`],
        },
    };
}

/**
 * Record the deterministic gate verdict for each stamp's recorded trials.
 * @param args `--repo`, `--base`, `--cases`, `--stamps`.
 * @returns 0 when every stamp produced a gate record, else 1.
 */
function gate(args: Map<string, string | undefined>): number {
    const repo = need(args, "--repo");
    const base = need(args, "--base");
    const cases = need(args, "--cases");
    const roots = {
        results: join(base, "results"),
        prompts: join(base, "prompts"),
        fixtures: join(base, "fixtures"),
        rubrics: join(base, "rubrics"),
    };
    let failures = 0;
    for (const stamp of need(args, "--stamps").split(",").filter(Boolean)) {
        const dir = join(roots.results, stamp);
        if (!existsSync(dir)) {
            console.error(`${stamp}: no results directory`);
            failures += 1;
            continue;
        }
        for (const caseId of readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)) {
            spawnSync(
                process.execPath,
                [
                    harnessOf(repo),
                    "judge",
                    caseId,
                    "--stamp",
                    stamp,
                    "--gate-only",
                    "--results",
                    roots.results,
                    "--fixture",
                    cases,
                    "--prompts",
                    roots.prompts,
                    "--fixtures",
                    roots.fixtures,
                    "--rubrics",
                    roots.rubrics,
                ],
                { encoding: "utf8", timeout: 180000 },
            );
            if (!existsSync(join(dir, caseId, "gate.json"))) failures += 1;
        }
    }
    return failures === 0 ? 0 : 1;
}

/**
 * Judge one completed trial once, validating the answer against the recorded
 * mutation facts. A judge failure is recorded; it is never retried.
 * @param args `--base`, `--stamp`, `--case`, `--truth`, `--model`,
 *   `--launcher`, `--workdir`, optional `--timeout` and `--attempt`.
 * @returns 0 when a usable judgement landed, 1 when it did not.
 */
/** The neutral judge-side run directory for one attempt. */
function neutralRunDir(
    args: Map<string, string | undefined>,
    stamp: string,
    caseId: string,
): string {
    return join(
        need(args, "--workdir"),
        sha256(`${stamp}/${caseId}`).slice(0, 16),
    );
}

/**
 * The judge child's complete visible context.
 *
 * Every value is a container path or a neutral agent home. The host evidence
 * path is deliberately absent: an operator root under /home is mounted at
 * `runDir` but is never a working directory, PWD, config path or environment
 * value the child can observe.
 */
const JUDGE_CHILD = {
    runDir: "/judge",
    home: "/tmp/agent-home",
    dataHome: "/tmp/agent-home/.local/share",
    cacheHome: "/tmp/agent-home/.cache",
};

/** The child's working directory, derived from the one mount destination. */
const judgeWorkDir = () => `${JUDGE_CHILD.runDir}/work`;

/** The child's config home, derived from the one mount destination. */
const judgeConfigHome = () => `${JUDGE_CHILD.runDir}/config-home`;

/**
 * Every judge-visible context value, in child-argument order.
 * @returns The container paths and neutral homes the child receives.
 */
const judgeChildSurfaces = () => [
    JUDGE_CHILD.runDir,
    judgeWorkDir(),
    judgeConfigHome(),
    JUDGE_CHILD.home,
    JUDGE_CHILD.dataHome,
    JUDGE_CHILD.cacheHome,
];

/**
 * Why a judge-visible context value cannot be a container path, or null.
 * These are constants, so a failure means the wrapper itself is inconsistent.
 * @returns The refusal, or null.
 */
function judgeContextProblem() {
    const bad = judgeChildSurfaces().filter(
        (value) =>
            !value.startsWith("/") ||
            value.includes(":") ||
            value.includes("\n"),
    );
    return bad.length === 0
        ? null
        : `judge context is not a neutral container path: ${bad.join(", ")}`;
}

/**
 * Why the recorded answer cannot be judged, or null.
 * @param caseDir The trial's result directory.
 * @param allowLegacy Whether absent identity evidence is tolerated.
 * @returns The refusal, or null.
 */
function answerProblemOf(caseDir: string, allowLegacy: boolean): string | null {
    const answerPath = join(caseDir, "final.md");
    if (!existsSync(answerPath)) return "no final answer was recorded";
    const meta = recordOf(
        JSON.parse(readFileSync(join(caseDir, "meta.json"), "utf8")),
        join(caseDir, "meta.json"),
    );
    const recorded = meta.answerHash;
    if (typeof recorded !== "string" || recorded === "") {
        return allowLegacy
            ? null
            : "meta.json records no answer hash; pass --allow-legacy-unbound for read-only legacy evidence";
    }
    return sha256(readText(answerPath)) === recorded
        ? null
        : "the final answer no longer matches meta.answerHash";
}

/**
 * Why the judge request must not dispatch, or null.
 *
 * The scan covers the assembled packet, the model and every value the child
 * actually receives. Host evidence paths are not scanned: they are mounted as
 * a source and are not judge-visible.
 * @param args The parsed flags.
 * @param prompt The assembled packet.
 * @returns The refusal, or null.
 */
function leakProblemOf(
    args: Map<string, string | undefined>,
    prompt: string,
): string | null {
    const leaks = labelLeaks(
        prompt,
        need(args, "--model"),
        ...judgeChildSurfaces(),
    );
    return leaks.length === 0
        ? null
        : `the judge request carries experiment labels: ${leaks.join(", ")}`;
}

/**
 * The attempt-directory preconditions before any judge spend.
 * @param base The stage's result roots.
 * @param stamp The trial stamp.
 * @param caseId The scenario id.
 * @param attemptId The selected attempt id.
 * @returns The attempt directory, or a refusal code and message.
 */
function judgeAttemptOf(
    base: string,
    stamp: string,
    caseId: string,
    attemptId: string,
): {
    code?: number;
    error?: string;
    attemptDir?: string;
    alreadyJudged?: boolean;
} {
    if (!/^attempt-\d{3}$/.test(attemptId)) {
        return {
            code: 1,
            error: `invalid --attempt ${JSON.stringify(attemptId)}`,
        };
    }
    const attemptDir = join(base, "results", stamp, caseId, "ac", attemptId);
    if (existsSync(join(attemptDir, "judgement.json"))) {
        return { attemptDir, alreadyJudged: true };
    }
    if (existsSync(attemptDir)) {
        return {
            code: 1,
            error:
                `refusing to overwrite existing attempt at ${attemptDir}; ` +
                "preserve it and use a new attempt directory",
        };
    }
    if (!existsSync(join(base, "results", stamp, caseId, "meta.json"))) {
        return {
            code: 1,
            error: `refusing to judge ${stamp}/${caseId}: no recorded trial result`,
        };
    }
    return { attemptDir };
}

/**
 * Build and blind-check the judge package without spending.
 * @param args The parsed flags.
 * @param base The stage's result roots.
 * @param stamp The trial stamp.
 * @param caseId The scenario id.
 * @param truth The scenario-truth map.
 * @param allowLegacy Whether absent identity evidence is tolerated.
 * @returns The prompt, state, run directory and attempt directory, or a refusal.
 */
function judgePackage(
    args: Map<string, string | undefined>,
    base: string,
    stamp: string,
    caseId: string,
    truth: Record<string, unknown>,
    allowLegacy: boolean,
):
    | {
          ok: true;
          prompt: string;
          state: DocState;
          runDir: string;
          scoringSpec: unknown;
      }
    | { ok: false; code: number; error: string } {
    const scoringSpec = args.get("--spec")
        ? JSON.parse(readFileSync(need(args, "--spec"), "utf8"))
        : undefined;
    const caseDir = join(base, "results", stamp, caseId);
    const answerProblem = answerProblemOf(caseDir, allowLegacy);
    if (answerProblem !== null) {
        return { ok: false, code: 4, error: answerProblem };
    }
    const operations = attributableOperations(caseDir, allowLegacy);
    if (
        operations.reason !== undefined &&
        operations.reason !== "legacy-unbound"
    ) {
        return { ok: false, code: 4, error: operations.reason };
    }
    const { prompt, state } = packetFor(
        base,
        stamp,
        caseId,
        truth,
        scoringSpec,
        operations.lines ?? [],
    );
    const runDir = neutralRunDir(args, stamp, caseId);
    const contextProblem = judgeContextProblem();
    if (contextProblem !== null) {
        return { ok: false, code: 3, error: contextProblem };
    }
    const leak = leakProblemOf(args, prompt);
    if (leak !== null) {
        return { ok: false, code: 3, error: leak };
    }
    return { ok: true, prompt, state, runDir, scoringSpec };
}

/**
 * Judge one completed trial once, validating the answer against the recorded
 * mutation facts. A judge failure is recorded; it is never retried.
 * @param args `--base`, `--stamp`, `--case`, `--truth`, `--model`,
 *   `--launcher`, `--workdir`, optional `--timeout`, `--attempt` and
 *   `--allow-legacy-unbound`.
 * @returns 0 when a usable judgement landed, 1 when it did not.
 */
function judge(args: Map<string, string | undefined>): number {
    const base = need(args, "--base");
    const stamp = need(args, "--stamp");
    const caseId = need(args, "--case");
    const truth = recordOf(
        JSON.parse(readFileSync(need(args, "--truth"), "utf8")),
        need(args, "--truth"),
    );
    const model = need(args, "--model");
    const attemptId = args.get("--attempt") ?? "attempt-001";
    const precondition = judgeAttemptOf(base, stamp, caseId, attemptId);
    if (precondition.code !== undefined) {
        console.error(precondition.error);
        return precondition.code;
    }
    if (precondition.alreadyJudged === true) return 0;
    const allowLegacy = args.get("--allow-legacy-unbound") === "true";
    const pkg = judgePackage(args, base, stamp, caseId, truth, allowLegacy);
    if (!pkg.ok) {
        console.error(`refusing to judge ${stamp}/${caseId}: ${pkg.error}`);
        return pkg.code;
    }
    const attemptDir = precondition.attemptDir;
    if (attemptDir === undefined) {
        console.error(`refusing to judge ${stamp}/${caseId}: no attempt path`);
        return 1;
    }
    mkdirSync(join(pkg.runDir, "work"), { recursive: true });
    writeFileSync(join(pkg.runDir, "prompt.md"), pkg.prompt, "utf8");
    mkdirSync(dirname(attemptDir), { recursive: true });
    const claim = claimAttemptDir(attemptDir);
    if (!claim.ok) {
        console.error(
            `refusing to overwrite attempt at ${attemptDir}: ${claim.reason}`,
        );
        return 1;
    }
    const packetSha256 = sha256(pkg.prompt);
    writeJson(join(attemptDir, "meta.json"), {
        stamp,
        caseId,
        judgeModel: model,
        status: "started",
        startedAt: new Date().toISOString(),
        state: pkg.state,
        packetSha256,
    });
    // The wrapper records its own dispatch immediately before spawning, so a
    // caller can distinguish a started wrapper from an actual judge call.
    writeJson(join(attemptDir, "dispatch.json"), {
        at: new Date().toISOString(),
        launcher: need(args, "--launcher"),
        model,
        pid: process.pid,
    });
    const result = spawnJudge({
        launcher: need(args, "--launcher"),
        model,
        stamp,
        prompt: pkg.prompt,
        runDir: pkg.runDir,
        timeout: Number(args.get("--timeout") ?? 240000),
    });
    return recordJudgement(
        attemptDir,
        result,
        pkg.state,
        model,
        stamp,
        caseId,
        pkg.scoringSpec,
        packetSha256,
    );
}

/** Resolve one parse-failed attempt, or report that it is not resolvable. */
function resolveAttempt(
    attemptDir: string,
    judgement: Record<string, unknown>,
    scoringSpec: unknown,
): string {
    if (!isParseFailure(judgement)) return "refused";
    if (existsSync(join(attemptDir, "resolution.json"))) return "skipped";
    const output = readText(join(attemptDir, "output.jsonl"));
    const meta = recordOf(
        JSON.parse(readFileSync(join(attemptDir, "meta.json"), "utf8")),
        join(attemptDir, "meta.json"),
    );
    const answer = finalAnswer(output);
    const completion = completionEvidence(
        output,
        answer,
        typeof meta.exit === "number" ? meta.exit : null,
        typeof meta.signal === "string" ? meta.signal : null,
        meta.timedOut === true,
    );
    const record = resolutionRecordOf(
        firstBalancedObject(answer),
        meta,
        scoringSpec,
        completion,
    );
    writeJson(join(attemptDir, "resolution.json"), {
        ...record,
        originalOutputSha256: sha256(output),
        originalJudgement: judgement,
    });
    return record.status === "judged" ? "resolved" : "refused";
}

/** Whether a recorded judgement is a parse failure the resolver may re-read. */
function isParseFailure(judgement: Record<string, unknown>): boolean {
    const problems = judgement.problems;
    return (
        Array.isArray(problems) &&
        problems.includes("verdict is not valid JSON")
    );
}

/** The resolution record for one re-read capture. */
function resolutionRecordOf(
    extracted: string | undefined,
    meta: Record<string, unknown>,
    scoringSpec: unknown,
    completion: CompletionEvidence,
): {
    status: string;
    method: string;
    parsed?: unknown;
    problems?: string[];
    reason?: string;
    failureClass?: JudgeFailureClass | null;
    completion: CompletionEvidence;
} {
    const method = "first-balanced-object";
    const unfinished = completion.complete
        ? "json-syntax"
        : "empty-or-truncated";
    if (extracted === undefined) {
        return {
            status: "unresolved",
            method,
            completion,
            failureClass: unfinished,
        };
    }
    try {
        const parsed = JSON.parse(extracted);
        if (typeof meta.caseId !== "string") {
            throw new Error("meta.json has no caseId");
        }
        const state = recordOf(
            meta.state,
            "meta.json state",
        ) as unknown as DocState;
        const problems = validateAcJudgement(
            parsed,
            state,
            judgementOptions(meta.caseId, scoringSpec),
        );
        if (problems.length === 0) {
            return { status: "judged", method, parsed, completion };
        }
        return {
            status: "unresolved",
            method,
            completion,
            problems,
            failureClass: judgeFailureClass({
                complete: completion.complete,
                value: parsed,
                problems,
            }),
        };
    } catch (error) {
        return {
            status: "unresolved",
            method,
            completion,
            reason: String(error),
            failureClass: unfinished,
        };
    }
}

/**
 * Resolve answers whose only defect was trailing prose after a complete JSON
 * object. Original judgements are preserved; the resolution is separate.
 * @param args `--base`.
 * @returns 0 unless a resolution was refused.
 */
function resolve(args: Map<string, string | undefined>): number {
    const base = need(args, "--base");
    const scoringSpec = args.get("--spec")
        ? JSON.parse(readFileSync(need(args, "--spec"), "utf8"))
        : undefined;
    let refused = 0;
    const visit = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(path);
                continue;
            }
            if (
                entry.name !== "judgement.json" ||
                !path.includes("/ac/attempt-")
            ) {
                continue;
            }
            const attemptDir = path.slice(0, -"judgement.json".length);
            const judgement = recordOf(
                JSON.parse(readFileSync(path, "utf8")),
                path,
            );
            if (judgement.status === "invalid-verdict") {
                if (
                    resolveAttempt(attemptDir, judgement, scoringSpec) ===
                    "refused"
                )
                    refused += 1;
            }
        }
    };
    visit(join(base, "results"));
    return refused === 0 ? 0 : 1;
}

/** Whether a recorded run is usable evidence. */
function usableRun(meta: unknown): boolean {
    if (typeof meta !== "object" || meta === null) return false;
    const value = meta as Record<string, unknown>;
    return (
        value.exit === 0 &&
        value.signal === null &&
        value.timedOut !== true &&
        value.outputOverflow !== true &&
        value.answerValid === true
    );
}

/** The primary result as a scoring category. */
function primaryCategory(record: unknown): "pass" | "fail" | "unknown" {
    const status =
        typeof record === "object" && record !== null
            ? (record as Record<string, unknown>).status
            : undefined;
    if (status === "pass") return "pass";
    if (status === "fail") return "fail";
    return "unknown";
}

/** Whether a trial carries a non-compensable guardrail breach. */
function guardrailOf(meta: unknown, gateAt: unknown): boolean {
    const run =
        typeof meta === "object" && meta !== null
            ? (meta as Record<string, unknown>)
            : {};
    const violations = run.policyViolations;
    if (Array.isArray(violations) && violations.length > 0) return true;
    const gate =
        typeof gateAt === "object" && gateAt !== null
            ? (gateAt as Record<string, unknown>)
            : {};
    return /preserved .* was (added|modified|removed)/.test(
        typeof gate.reason === "string" ? gate.reason : "",
    );
}

/** The still-valid R02 facts whose destructive loss is a guardrail breach. */
const PRESERVED_FACTS = ["poolSize", "acquireTimeout", "startupMigrations"];

/**
 * Whether the judge's semantic assessment records a lost still-valid fact.
 * An absent assessment is unknown, never a breach.
 */
function preservationLost(preservation: unknown): boolean {
    if (preservation === null || typeof preservation !== "object") return false;
    const value = preservation as Record<string, unknown>;
    return PRESERVED_FACTS.some((fact) => {
        const finding = value[fact];
        return (
            typeof finding === "object" &&
            finding !== null &&
            (finding as Record<string, unknown>).state === "lost"
        );
    });
}

/** The recorded guardrail verdict: mutation policy or destructive loss. */
function guardrailFor(
    meta: unknown,
    gateAt: unknown,
    assessment: { preservation?: unknown },
): boolean {
    return (
        guardrailOf(meta, gateAt) || preservationLost(assessment.preservation)
    );
}

/** The duration a recorded run reports, or null. */
function durationOf(meta: unknown): number | null {
    if (typeof meta !== "object" || meta === null) return null;
    const value = meta as Record<string, unknown>;
    const timings =
        typeof value.timings === "object" && value.timings !== null
            ? (value.timings as Record<string, unknown>)
            : {};
    if (typeof timings.totalMs === "number") return timings.totalMs;
    if (
        typeof value.startedAt !== "string" ||
        typeof value.finishedAt !== "string"
    ) {
        return null;
    }
    return Date.parse(value.finishedAt) - Date.parse(value.startedAt);
}

/** The recorded judgement, preferring a deterministic parse resolution. */
function resolvedJudgement(dir: string): Record<string, unknown> | null {
    const resolution = readJson(join(dir, "ac/attempt-001/resolution.json"));
    if (typeof resolution === "object" && resolution !== null) {
        const record = resolution as Record<string, unknown>;
        if (record.status === "judged") {
            const parsed =
                typeof record.parsed === "object" && record.parsed !== null
                    ? (record.parsed as Record<string, unknown>)
                    : {};
            return { status: "judged", ...parsed };
        }
    }
    const judgement = readJson(join(dir, "ac/attempt-001/judgement.json"));
    return typeof judgement === "object" && judgement !== null
        ? (judgement as Record<string, unknown>)
        : null;
}

/** The assessment status when no judgement was recorded. */
const missingStatus = (attempted: boolean): string =>
    attempted ? "unassessed" : "not-run";

/** The documentation outcome when a judgement landed. */
const outcomeOf = (
    judgement: Record<string, unknown> | null,
): DocumentationOutcome | undefined => {
    if (judgement?.status !== "judged") return undefined;
    const value = judgement.documentationOutcome;
    return DOCUMENTATION_OUTCOMES.includes(value as DocumentationOutcome)
        ? (value as DocumentationOutcome)
        : undefined;
};

/** A recorded value, or null when it is absent. */
const orNull = (value: unknown): unknown =>
    value === undefined ? null : value;

/** The evidence list of a judgement, always an array. */
const evidenceOf = (judgement: Record<string, unknown> | null): unknown[] => {
    const evidence = judgement?.evidence;
    return Array.isArray(evidence) ? evidence : [];
};

/** The assessment status of a recorded judgement. */
function judgementStatus(
    judgement: Record<string, unknown> | null,
    attempted: boolean,
): unknown {
    if (judgement?.status) return judgement.status;
    return missingStatus(attempted);
}

/** The resolved assessment of one trial. */
function assessmentOf(dir: string, attempted: boolean) {
    const judgement = resolvedJudgement(dir);
    const acMetaValue = readJson(join(dir, "ac/attempt-001/meta.json"));
    const acMeta =
        typeof acMetaValue === "object" && acMetaValue !== null
            ? (acMetaValue as Record<string, unknown>)
            : null;
    return {
        status: String(judgementStatus(judgement, attempted)),
        outcome: outcomeOf(judgement),
        reason: orNull(judgement?.documentationReason),
        evidence: evidenceOf(judgement),
        preservation: orNull(judgement?.preservation),
        tokens: tokenFieldsOf(acMeta?.usage),
        durationMs: orNull(acMeta?.durationMs),
    };
}

/** Normalise one usage object into four known token fields. */
function tokenFieldsOf(value: unknown): {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
} {
    const usage =
        typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {};
    const cache =
        typeof usage.cache === "object" && usage.cache !== null
            ? (usage.cache as Record<string, unknown>)
            : {};
    return {
        input: typeof usage.input === "number" ? usage.input : 0,
        output: typeof usage.output === "number" ? usage.output : 0,
        reasoning: typeof usage.reasoning === "number" ? usage.reasoning : 0,
        cacheRead: typeof cache.read === "number" ? cache.read : 0,
    };
}

/** One scheduled report slot, including the confirmation role. */
interface ReportSlot {
    slot: number;
    pairId: string;
    repetition: number;
    scenario: string;
    arm: string;
    stamp: string;
    role?: "F" | "A";
}

/** One trial row the legacy report aggregates. */
interface TrialRecord {
    stage: string;
    slot: number;
    stamp: string;
    arm: string;
    role: "F" | "A" | null;
    scenario: string;
    repetition: number;
    attempted: boolean;
    usable: boolean;
    assessmentStatus: string;
    outcome: DocumentationOutcome | undefined;
    primary: "pass" | "fail" | "unknown";
    guardrailBreach: boolean;
    gateStatus: string;
    gateReason: unknown;
    policyViolations: unknown[];
    writes: unknown;
    tokens: TokenUsage;
    durationMs: number | null;
    acDurationMs: unknown;
    acTokens: {
        input: number;
        output: number;
        reasoning: number;
        cacheRead: number;
    };
    acReason: unknown;
    acEvidence: unknown[];
    writesText: string;
}

/** Assemble one trial record from its result directory. */
function trialRecord({
    stage,
    slot,
    arm,
    base,
}: {
    stage: string;
    slot: ReportSlot;
    arm: string;
    base: string;
}): TrialRecord {
    const dir = join(base, "results", slot.stamp, slot.scenario);
    const meta = objectOf(readJson(join(dir, "meta.json")));
    const gateAt = objectOf(readJson(join(dir, "gate.json")));
    const primary = readJson(join(dir, "primary-check.json"));
    const attempted = existsSync(dir);
    const assessment = assessmentOf(dir, attempted);
    return {
        stage,
        slot: slot.slot,
        stamp: slot.stamp,
        arm,
        role: slot.role ?? null,
        scenario: slot.scenario,
        repetition: slot.repetition,
        attempted,
        usable: usableRun(meta),
        assessmentStatus: assessment.status,
        outcome: assessment.outcome,
        primary: primaryCategory(primary),
        guardrailBreach: guardrailFor(meta, gateAt, assessment),
        gateStatus: String(gateAt?.status ?? "missing"),
        gateReason: gateAt?.reason ?? null,
        policyViolations: Array.isArray(meta?.policyViolations)
            ? (meta.policyViolations as unknown[])
            : [],
        writes: meta?.writes ?? null,
        tokens: usageOf(join(dir, "stdout.jsonl")),
        durationMs: durationOf(meta),
        acDurationMs: assessment.durationMs,
        acTokens: assessment.tokens,
        acReason: assessment.reason,
        acEvidence: assessment.evidence,
        writesText: readText(join(dir, "writes.txt")),
    };
}

/** One JSON object, or null when the file is absent. */
function objectOf(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : null;
}

/** One arm's token total, trial and judge kept apart. */
interface TokenTotals {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    judgeInput: number;
    judgeOutput: number;
}

/** Empty token total. */
const emptyTokens = (): TokenTotals => ({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    judgeInput: 0,
    judgeOutput: 0,
});

/** Add one trial's tokens to an arm total. */
function addTokens(total: TokenTotals, trial: TrialRecord): void {
    total.input += trial.tokens.input;
    total.output += trial.tokens.output;
    total.reasoning += trial.tokens.reasoning;
    total.cacheRead += trial.tokens.cacheRead;
    total.judgeInput += trial.acTokens?.input ?? 0;
    total.judgeOutput += trial.acTokens?.output ?? 0;
}

/** The scoring input for one trial. */
const scored = (
    trial: TrialRecord,
): {
    arm: string;
    scenario: string;
    planned: boolean;
    usable: boolean;
    outcome: DocumentationOutcome | undefined;
    primary: "pass" | "fail" | "unknown";
    guardrailBreach: boolean;
} => ({
    arm: trial.arm,
    scenario: trial.scenario,
    planned: true,
    usable: trial.usable,
    outcome: trial.outcome,
    primary: trial.primary,
    guardrailBreach: trial.guardrailBreach,
});

/** Summarise every arm, with the presentation extras the report shows. */
type ArmReport = ReturnType<typeof summariseArm> & {
    attempted: number;
    gatePass: number;
    gateBlocked: number;
    tokens: TokenTotals;
};

function summariseArms(
    arms: string[],
    trials: TrialRecord[],
): Record<string, ArmReport> {
    const summaries: Record<string, ArmReport> = {};
    for (const arm of arms) {
        const rows = trials.filter((trial) => trial.arm === arm);
        const summary: ArmReport = {
            ...summariseArm(rows.map(scored)),
            attempted: 0,
            gatePass: 0,
            gateBlocked: 0,
            tokens: emptyTokens(),
        };
        summary.attempted = rows.filter((trial) => trial.attempted).length;
        summary.gatePass = rows.filter(
            (row) => row.gateStatus === "pass",
        ).length;
        summary.gateBlocked = rows.filter(
            (row) => row.gateStatus === "blocked",
        ).length;
        summary.tokens = rows.reduce((total, trial) => {
            addTokens(total, trial);
            return total;
        }, emptyTokens());
        summaries[arm] = summary;
    }
    return summaries;
}

/** Per-scenario rows for every arm. */
function scenarioRowsFor(arms: string[], trials: TrialRecord[]) {
    const rows: Array<Record<string, unknown>> = [];
    for (const arm of arms) {
        for (const scenario of [
            ...new Set(trials.map((trial) => trial.scenario)),
        ]) {
            const matching = trials.filter(
                (trial) => trial.arm === arm && trial.scenario === scenario,
            );
            if (matching.length === 0) continue;
            const summary = summariseArm(matching.map(scored));
            rows.push({
                arm,
                scenario,
                planned: summary.planned,
                attempted: matching.filter((trial) => trial.attempted).length,
                usable: summary.usable,
                assessed: summary.assessed,
                primaryPass: summary.primaryPass,
                primaryFail: summary.primaryFail,
                primaryUnknown: summary.primaryUnknown,
                gatePass: matching.filter((row) => row.gateStatus === "pass")
                    .length,
                gateBlocked: matching.filter(
                    (row) => row.gateStatus === "blocked",
                ).length,
                outcomes: summary.outcomes,
                total: summary.total,
            });
        }
    }
    return rows;
}

/** The arm a slot runs, resolving confirmation roles through the finalist. */
interface Finalist {
    arm?: string;
    control?: string;
}

function armOf(slot: ReportSlot, finalist: Finalist | null): string {
    if (slot.role === "F") return finalist?.arm ?? "?";
    if (slot.role === "A") return finalist?.control ?? "A";
    return slot.arm;
}

/** The stage base directory for one arm. */
function baseOf(root: string, stage: string, arm: string): string {
    const letter = arm.toLowerCase();
    return stage === "confirmation"
        ? join(root, "gen", letter, "holdout")
        : join(root, "gen", letter);
}

/** Rank eligible arms when the caller supplies the description lengths. */
function rankedFor(
    arms: string[],
    summaries: Record<string, ArmReport>,
    controlArm: string,
    characters: Record<string, number> | null,
) {
    if (!characters) return null;
    const candidates = arms
        .filter((arm) => arm !== controlArm)
        .flatMap((arm) => {
            const charactersForArm = characters[arm];
            const summary = summaries[arm];
            if (charactersForArm === undefined || summary === undefined)
                return [];
            return [{ arm, characters: charactersForArm, summary }];
        });
    return rankCandidates(candidates);
}

/** Render the compact stage summary table. */
function renderSummary(
    stage: string,
    arms: string[],
    summaries: Record<string, ArmReport>,
): string {
    const lines = [
        `# ${stage} summary`,
        "",
        "| Arm | Total | Mean | Primary P/F | Gate pass/blocked | Create/update/transient/duplicate/misleading/none |",
        "| --- | --- | --- | --- | --- | --- |",
    ];
    for (const arm of arms) {
        const summary = summaries[arm];
        if (summary === undefined) continue;
        const outcomes = OUTCOME_KEYS.map((key) => summary.outcomes[key]).join(
            "/",
        );
        lines.push(
            `| ${arm} | ${summary.total} | ${summary.meanPerPlanned?.toFixed(2) ?? "unknown"} | ${summary.primaryPass}/${summary.primaryFail} | ${summary.gatePass}/${summary.gateBlocked} | ${outcomes} |`,
        );
    }
    lines.push(
        "",
        "A useful create or update scores 5; a failed primary check scores -5. Gate outcomes are reported separately and never rescored.",
        "",
    );
    return lines.join("\n");
}

/**
 * Aggregate recorded trials for one stage.
 * @param args `--root`, `--stage`, `--schedule`, `--out-dir`, optional
 *   `--finalist`, optional `--characters`.
 * @returns 0.
 */
function report(args: Map<string, string | undefined>): number {
    const root = need(args, "--root");
    const stage = need(args, "--stage");
    const outDir = need(args, "--out-dir");
    const schedule = recordOf(
        JSON.parse(readFileSync(need(args, "--schedule"), "utf8")),
        need(args, "--schedule"),
    );
    const finalistAt = args.get("--finalist");
    const finalist =
        finalistAt === undefined
            ? null
            : (recordOf(
                  JSON.parse(readFileSync(finalistAt, "utf8")),
                  finalistAt,
              ) as Finalist);
    const charactersAt = args.get("--characters");
    const characters =
        charactersAt === undefined
            ? null
            : (recordOf(
                  JSON.parse(readFileSync(charactersAt, "utf8")),
                  charactersAt,
              ) as Record<string, number>);
    const reportSlots = schedule[stage];
    if (!Array.isArray(reportSlots)) {
        throw new Error(
            `${need(args, "--schedule")}.${stage} must be an array`,
        );
    }
    const trials = reportSlots.map((value) => {
        const slot = recordOf(value, `${stage} slot`) as unknown as ReportSlot;
        const arm = armOf(slot, finalist);
        return trialRecord({
            stage,
            slot,
            arm,
            base: baseOf(root, stage, arm),
        });
    });
    const arms = [...new Set(trials.map((trial) => trial.arm))].sort();
    const summaries = summariseArms(arms, trials);
    const controlArm = finalist?.control ?? "A";
    const analysis = {
        stage,
        weights: { useful: 5, transient: -1, duplicate: -2, misleading: -5 },
        controlArm,
        arms,
        summaries,
        scenarioRows: scenarioRowsFor(arms, trials),
        trials,
        cells: sensitivity(
            Object.fromEntries(
                arms.map((arm) => [
                    arm,
                    trials.filter((trial) => trial.arm === arm).map(scored),
                ]),
            ),
            [3, 5, 8],
            [0.5, 1, 2],
        ),
        ranked: rankedFor(arms, summaries, controlArm, characters),
        qualifying: arms
            .filter((arm) => arm !== controlArm)
            .flatMap((arm) => {
                const control = summaries[controlArm];
                const candidate = summaries[arm];
                if (control === undefined || candidate === undefined) return [];
                return [
                    {
                        arm,
                        verdict: finalistQualifies(control, candidate, 2),
                    },
                ];
            }),
    };
    mkdirSync(outDir, { recursive: true });
    writeJson(join(outDir, `ANALYSIS-${stage}.json`), analysis);
    writeFileSync(
        join(outDir, `REPORT-${stage}.md`),
        renderSummary(stage, arms, summaries),
        "utf8",
    );
    return 0;
}

/** Hash every evidence file, excluding signing keys. */
function evidenceRows(root: string): string[] {
    const walk = (dir: string, files: string[] = []): string[] => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === "node_modules" || entry.name === ".git")
                    continue;
                walk(path, files);
            } else if (entry.isFile()) {
                files.push(path);
            }
        }
        return files;
    };
    const rows: string[] = [];
    for (const dir of ["gen", "controls", "evidence", "logs"]) {
        if (!existsSync(join(root, dir))) continue;
        for (const path of walk(join(root, dir)).sort()) {
            const rel = path.slice(root.length + 1);
            if (rel === "evidence/EVIDENCE.sha256") continue;
            rows.push(
                path.endsWith("docs-operations.key")
                    ? `${"(secret-not-hashed)".padEnd(64)}  ${rel}`
                    : `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${rel}`,
            );
        }
    }
    return rows;
}

/** Read a manifest into a path→hash map. */
function manifestMap(path: string): Map<string, string | undefined> {
    return new Map(
        readText(path)
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => {
                const [hash, ...rest] = line.split("  ");
                return [rest.join("  "), hash];
            }),
    );
}

/**
 * Hash (or verify) every evidence file, excluding signing keys.
 * @param args `--root` and either `--write` or `--verify`.
 * @returns 0 when written or verified, 1 when verification fails.
 */
function manifest(args: Map<string, string | undefined>): number {
    const root = need(args, "--root");
    const rows = evidenceRows(root);
    const path = join(root, "evidence/EVIDENCE.sha256");
    if (args.has("--write")) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, rows.join("\n") + "\n", "utf8");
        return 0;
    }
    const recorded = manifestMap(path);
    const mismatches = rows.filter((line) => {
        const [hash, ...rest] = line.split("  ");
        return recorded.get(rest.join("  ")) !== hash;
    });
    if (mismatches.length > 0 || recorded.size !== rows.length) {
        console.error(`manifest mismatch: ${mismatches.length} row(s)`);
        return 1;
    }
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const command = process.argv[2];
    const args = flags(process.argv.slice(3));
    const status = (() => {
        switch (command) {
            case "schedule": {
                writeJson(need(args, "--out"), {
                    ...buildSchedule(Number(args.get("--seed") ?? 20261110)),
                    generator:
                        "mulberry32; arm order shuffled per block; scenario order rotated",
                });
                return 0;
            }
            case "gate":
                return gate(args);
            case "judge":
                return judge(args);
            case "resolve":
                return resolve(args);
            case "report":
                return report(args);
            case "manifest":
                return manifest(args);
            case "clear-reservation": {
                const cleared = clearReservation(need(args, "--result"));
                if (!cleared.ok) {
                    console.error(cleared.reason);
                    return 1;
                }
                console.log(cleared.reason);
                return 0;
            }
            default:
                console.error(
                    "usage: run.mts schedule|gate|judge|resolve|report|manifest|clear-reservation [--flag value]",
                );
                return 2;
        }
    })();
    process.exit(status);
}

export { gate, judge, report, resolve, manifest, HERE };
