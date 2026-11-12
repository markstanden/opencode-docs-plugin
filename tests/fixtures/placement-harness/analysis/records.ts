/**
 * Evidence loading for the trial analysis framework.
 *
 * Every record is read through an injected {@link EvidenceReader} and lands
 * in one of four explicit states: available, missing, malformed or
 * unsupported-loaded. Absence is never conflated with emptiness — a missing
 * snapshot is not an empty lake, and an absent judgement is not "none". The
 * ac-v1 adapter reads the layout the 2026-11-10 campaigns recorded (per-arm
 * result roots holding run metadata, gate and primary-check records, judge
 * attempt directories and trial artefacts). A legacy record without the
 * fields it needs stays limited or unknown; it is never silently upgraded.
 *
 * Nothing here touches the filesystem or calls a model: the CLI supplies the
 * reader, and tests supply an in-memory one.
 */
import {
    DOCUMENTATION_OUTCOMES,
    type DocumentationOutcome,
} from "../ac-scoring.mts";
import type { LakeDocument } from "../ac/campaign.mts";
import type { SelectionPolicy } from "./model.ts";
import { parseCampaignLedger } from "./ledger.ts";
import {
    answerIdentityProblem,
    hostDispatchesFromTrail,
    journalIdentityFromTrail,
    verifyOperationsJournal,
    type JournalVerification,
} from "./journal.ts";

/** The explicit state of one loaded record. */
export type Loaded<T> =
    | { state: "available"; value: T; source: string }
    | { state: "missing"; source: string }
    | { state: "not-a-directory"; source: string }
    | { state: "malformed"; source: string; problems: string[] }
    | { state: "unsupported-loaded"; source: string; reason: string };

/** The filesystem boundary the loader reads through. */
export interface EvidenceReader {
    /** Read one UTF-8 text file; a missing file is a state, not an error. */
    readTextFile(path: string): Loaded<string>;
    /** List one directory's entry names, sorted; missing is a state. */
    readDirectoryEntries(path: string): Loaded<string[]>;
}

/** Whether one trial directory proves a recorded run. */
export type AttemptState =
    "recorded" | "reservation-only" | "unknown" | "absent";

/** The gate record as the harness wrote it. */
export interface GateRecord {
    /** The recorded gate status string (e.g. `pass`, `blocked`). */
    status: string;
    /** The recorded reason, or null. */
    reason: string | null;
}

/** One preservation observation as a judgement recorded it. */
export interface PreservationObservation {
    /** The recorded assessment state (e.g. `retained`, `lost`). */
    state: string;
    /** The decisive excerpt the judgement quoted. */
    quote: string;
}

/** Per-fact preservation observations keyed by inventory fact id. */
export type PreservationByFact = Record<
    string,
    Loaded<PreservationObservation>
>;

/** One token field's subtotal and independent step coverage. */
export interface TokenFieldUsage {
    /** Sum over steps that reported this field; meaningful only with coverage. */
    total: number;
    /** Observed steps reporting a numeric value, including explicit zero. */
    measuredSteps: number;
    /** Observed steps not reporting this field. */
    unknownSteps: number;
}

/** Token accounting summed from a recorded session trail, per field. */
export interface TokenUsage {
    /** Observed step_finish events, with or without token telemetry. */
    steps: number;
    /** Input-token subtotal and coverage. */
    input: TokenFieldUsage;
    /** Output-token subtotal and coverage. */
    output: TokenFieldUsage;
    /** Reasoning-token subtotal and coverage. */
    reasoning: TokenFieldUsage;
    /** Cache-read-token subtotal and coverage. */
    cacheRead: TokenFieldUsage;
}

/** One recorded campaign-attempt ledger event. */
export interface LaunchRecord {
    /** Event timestamp, or null when the event carried none. */
    at: string | null;
    /** The recorded event name (e.g. `launch`, `slot-complete`). */
    event: string;
    /** The trial stamp, or null when the event carried none. */
    stamp: string | null;
}

/** The assessment status of one trial's judgement layer. */
export type AssessmentStatus =
    | "judged"
    | "invalid-verdict"
    | "judge-error"
    | "unassessed"
    | "not-run"
    | "unknown";

/** One trial's retrieval-application observation as the judge recorded it. */
export interface RetrievalObservation {
    /** The recorded state (e.g. applied, read-not-applied). */
    state: string;
    /** The decisive excerpt connecting the retrieved detail to the work. */
    quote: string;
}

/** One trial's resolved assessment. */
export interface TrialAssessment {
    /** The status of the selected judgement layer. */
    status: AssessmentStatus;
    /** Which layer the recorded selection policy chose. */
    layer: "judge" | "deterministic-resolution" | "none";
    /** The documentation outcome, undefined when no usable one was recorded. */
    outcome: DocumentationOutcome | undefined;
    /** The judgement's stated reason, when present. */
    reason: string | undefined;
    /** The judgement's evidence quotes, when present. */
    evidence: string[];
    /** Per-fact preservation observations for the scenario's inventory. */
    preservation: Loaded<PreservationByFact>;
    /** The judge's retrieval-application finding, when one was recorded. */
    retrieval: Loaded<RetrievalObservation>;
    /** Every problem found while loading or validating the assessment. */
    problems: string[];
}

/** The artefacts a static screen reads for one trial. */
export interface TrialArtefacts {
    /** The trial's final answer text. */
    finalAnswer: Loaded<string>;
    /** The recorded writes report text. */
    writesText: Loaded<string>;
    /** The recorded docs-operation journal lines. */
    docsOperations: Loaded<string[]>;
    /** The trial's prompt text. */
    promptText: Loaded<string>;
}

/** One trial's loaded evidence. */
export interface TrialRecord {
    /** The declared identity this record was loaded for. */
    identity: { resultRoot: string; stamp: string; scenario: string };
    /** What the trial directory proves about the run. */
    attempt: {
        /** The attempt state derived from directory contents. */
        state: AttemptState;
        /** Usability: true, false, or unknown without a run record. */
        usable: boolean | "unknown";
        /** Why usability holds or fails, for visible limitations. */
        problems: string[];
    };
    /** The run metadata record, for policy and cost fields. */
    run: Loaded<Record<string, unknown>>;
    /** The recorded deterministic gate verdict. */
    gate: Loaded<GateRecord>;
    /** The independent primary-task result. */
    primary: { status: "pass" | "fail" | "unknown"; problems: string[] };
    /** The resolved judgement layer. */
    assessment: TrialAssessment;
    /** The judge model identity, when recorded. */
    judgeModel: Loaded<string>;
    /** Token accounting from the session trail. */
    tokens: Loaded<TokenUsage>;
    /** The trial artefacts a static screen reads. */
    artefacts: TrialArtefacts;
    /**
     * The verified operation-journal evidence. Absent only on a legacy record
     * built without one; the loader always sets it, and an unverified journal
     * earns no credit.
     */
    journal?: JournalVerification;
    /** Why the captured answer is not bound to the run, or null. */
    answerProblem?: string | null;
}

/** Options for loading one trial under the ac-v1 layout. */
export interface TrialRecordOptions {
    /** The arm's result root, relative to the evidence root. */
    resultRoot: string;
    /** The selected judge attempt directory; defaults to `attempt-001`. */
    attemptId?: string;
    /** The trial stamp to load. */
    stamp: string;
    /** The scenario the slot declared. */
    scenario: string;
    /** The scenario's inventory fact ids, for per-fact preservation loading. */
    inventoryFactIds: string[];
    /** The manifest's recorded judgement-layer selection policy. */
    selectionPolicy: SelectionPolicy;
}

/** Wrap a value as available. */
function loaded<T>(value: T, source: string): Loaded<T> {
    return { state: "available", value, source };
}

/** Join two path segments with a slash. */
function joinPath(left: string, right: string): string {
    return `${left}/${right}`;
}

/**
 * Read and parse one JSON file, keeping missing and malformed explicit.
 * @param reader The evidence reader.
 * @param path The file path relative to the evidence root.
 * @returns The parsed value, or the explicit failure state.
 */
function loadJson(reader: EvidenceReader, path: string): Loaded<unknown> {
    const text = reader.readTextFile(path);
    if (text.state !== "available") return text;
    try {
        return loaded(JSON.parse(text.value) as unknown, path);
    } catch (error) {
        return {
            state: "malformed",
            source: path,
            problems: [`invalid JSON (${String(error)})`],
        };
    }
}

/**
 * Read one text file as its nonblank lines.
 * @param reader The evidence reader.
 * @param path The file path relative to the evidence root.
 * @returns The lines, or the explicit failure state.
 */
function loadLines(reader: EvidenceReader, path: string): Loaded<string[]> {
    const text = reader.readTextFile(path);
    if (text.state !== "available") return text;
    return loaded(
        text.value.split("\n").filter((line) => line.trim() !== ""),
        path,
    );
}

/**
 * Walk a directory tree collecting Markdown documents, path-sorted. A
 * non-Markdown name is inspected as a possible directory; a plain file such as
 * `README.txt` answers `not-a-directory` and is skipped, never treated as an
 * empty directory.
 * @param reader The evidence reader.
 * @param dir The directory to walk, relative to the evidence root.
 * @param prefix The display prefix already accumulated.
 * @param docs The accumulated documents.
 * @param problems Accumulated problems for entries that cannot be read.
 */
function walkMarkdown(
    reader: EvidenceReader,
    dir: string,
    prefix: string,
    docs: LakeDocument[],
    problems: string[],
): void {
    const entries = reader.readDirectoryEntries(dir);
    // A file is not a lake subtree: skip it. Any other failure stays a problem.
    if (entries.state === "not-a-directory") return;
    if (entries.state !== "available") {
        problems.push(`${dir}: directory unreadable (${entries.state})`);
        return;
    }
    for (const name of entries.value) {
        if (name.startsWith(".")) continue;
        const child = joinPath(dir, name);
        if (!name.endsWith(".md")) {
            walkMarkdown(reader, child, `${prefix}${name}/`, docs, problems);
            continue;
        }
        const file = reader.readTextFile(child);
        if (file.state === "available") {
            docs.push({ path: `${prefix}${name}`, contents: file.value });
        } else {
            problems.push(`${prefix}${name}: unreadable (${file.state})`);
        }
    }
}

/**
 * Read the Markdown documents under one directory, recursively and sorted.
 * A missing directory stays missing; an existing directory with no Markdown
 * documents is available and empty — absence is never conflated with
 * emptiness.
 * @param reader The evidence reader.
 * @param dir The directory, relative to the evidence root.
 * @returns The documents sorted by path, or the explicit state.
 */
export function readMarkdownTree(
    reader: EvidenceReader,
    dir: string,
): Loaded<LakeDocument[]> {
    const entries = reader.readDirectoryEntries(dir);
    if (entries.state !== "available") return entries;
    const docs: LakeDocument[] = [];
    const problems: string[] = [];
    walkMarkdown(reader, dir, "", docs, problems);
    if (problems.length > 0) {
        return { state: "malformed", source: dir, problems };
    }
    docs.sort((left, right) => left.path.localeCompare(right.path));
    return loaded(docs, dir);
}

/**
 * Derive what one trial directory proves about the run: a recorded run needs
 * a run record; a bare reservation and an unrecorded directory prove nothing.
 * @param reader The evidence reader.
 * @param dir The trial directory, relative to the evidence root.
 * @returns The attempt state and any problems.
 */
function attemptOf(
    reader: EvidenceReader,
    dir: string,
): { state: AttemptState; problems: string[] } {
    const entries = reader.readDirectoryEntries(dir);
    if (entries.state === "missing") return { state: "absent", problems: [] };
    if (entries.state !== "available") {
        return {
            state: "unknown",
            problems: [`directory entries unreadable (${entries.state})`],
        };
    }
    const recorded = entries.value.filter((name) => name !== ".reservation");
    const hasReservation = entries.value.includes(".reservation");
    if (recorded.length === 0 && hasReservation) {
        return { state: "reservation-only", problems: [] };
    }
    if (recorded.length === 0) return { state: "unknown", problems: [] };
    if (!recorded.includes("meta.json")) {
        return {
            state: "unknown",
            problems: ["no run record (meta.json) in the trial directory"],
        };
    }
    return { state: "recorded", problems: [] };
}

/**
 * Derive usability from the recorded run metadata, keeping every failing
 * condition visible. A record without an answer-validity field stays limited
 * rather than being upgraded.
 * @param run The loaded run metadata.
 * @returns Usability and the visible reasons.
 */
function usableOf(run: Loaded<Record<string, unknown>>): {
    usable: boolean | "unknown";
    problems: string[];
} {
    if (run.state === "missing") {
        return {
            usable: "unknown",
            problems: ["no run record to assess usability"],
        };
    }
    if (run.state !== "available") {
        return { usable: false, problems: ["run record unreadable"] };
    }
    const problems: string[] = [];
    const meta = run.value;
    if (meta.exit !== 0) problems.push(`exit is ${String(meta.exit)}`);
    if (meta.signal !== null && meta.signal !== undefined) {
        problems.push(`signal is ${String(meta.signal)}`);
    }
    if (meta.timedOut === true) problems.push("timedOut");
    if (meta.outputOverflow === true) problems.push("outputOverflow");
    if (meta.answerValid !== true) {
        problems.push(
            "no answerValid record (limited evidence, never upgraded)",
        );
    }
    return { usable: problems.length === 0, problems };
}

/**
 * Load the run metadata record.
 * @param reader The evidence reader.
 * @param dir The trial directory, relative to the evidence root.
 * @returns The metadata, or the explicit state.
 */
function loadRun(
    reader: EvidenceReader,
    dir: string,
): Loaded<Record<string, unknown>> {
    return loadJsonObject(reader, joinPath(dir, "meta.json"), "run record");
}

/**
 * Require a loaded JSON value to be an object, remapping other states.
 * @param reader The evidence reader.
 * @param path The file path relative to the evidence root.
 * @param label The display label for shape problems.
 * @returns The object, or the explicit failure state.
 */
function loadJsonObject(
    reader: EvidenceReader,
    path: string,
    label: string,
): Loaded<Record<string, unknown>> {
    const parsed = loadJson(reader, path);
    if (parsed.state === "available") {
        return isRecord(parsed.value)
            ? loaded(parsed.value, parsed.source)
            : {
                  state: "malformed",
                  source: parsed.source,
                  problems: [`${label} is not a JSON object`],
              };
    }
    if (parsed.state === "malformed") {
        return {
            state: "malformed",
            source: parsed.source,
            problems: parsed.problems,
        };
    }
    if (parsed.state === "unsupported-loaded") {
        return {
            state: "unsupported-loaded",
            source: parsed.source,
            reason: parsed.reason,
        };
    }
    return { state: "missing", source: parsed.source };
}

/**
 * Load the recorded gate verdict.
 * @param reader The evidence reader.
 * @param dir The trial directory, relative to the evidence root.
 * @returns The gate record, or the explicit state.
 */
function loadGate(reader: EvidenceReader, dir: string): Loaded<GateRecord> {
    const parsed = loadJsonObject(
        reader,
        joinPath(dir, "gate.json"),
        "gate record",
    );
    if (parsed.state === "missing") return parsed;
    if (parsed.state !== "available") return parsed;
    if (typeof parsed.value.status !== "string") {
        return {
            state: "malformed",
            source: parsed.source,
            problems: ["gate record has no status string"],
        };
    }
    const reason = parsed.value.reason;
    return loaded(
        {
            status: parsed.value.status,
            reason: typeof reason === "string" ? reason : null,
        },
        parsed.source,
    );
}

/**
 * Categorise the primary-task record: only an explicit pass or fail counts;
 * missing, malformed and other statuses stay unknown.
 * @param parsed The loaded primary-check record.
 * @returns The primary category and any loading problems.
 */
function primaryOf(parsed: Loaded<unknown>): {
    status: "pass" | "fail" | "unknown";
    problems: string[];
} {
    if (parsed.state === "missing") return { status: "unknown", problems: [] };
    if (parsed.state === "not-a-directory") {
        return {
            status: "unknown",
            problems: ["primary record is a directory, not a file"],
        };
    }
    if (parsed.state !== "available") {
        return {
            status: "unknown",
            problems:
                parsed.state === "malformed"
                    ? parsed.problems
                    : [parsed.reason],
        };
    }
    if (!isRecord(parsed.value)) {
        return {
            status: "unknown",
            problems: ["primary record is not an object"],
        };
    }
    const status = parsed.value.status;
    if (status === "pass") return { status: "pass", problems: [] };
    if (status === "fail") return { status: "fail", problems: [] };
    return {
        status: "unknown",
        problems: [`unsupported primary status ${JSON.stringify(status)}`],
    };
}

/** The raw judged value a layer selected. */
interface JudgementValue {
    value: Record<string, unknown>;
    layer: "judge" | "deterministic-resolution";
    /** The layer's effective status: judged for a resolution, recorded otherwise. */
    status: string;
}

/** The outcome of looking for a judged deterministic resolution. */
type ResolutionLookup =
    | { state: "selected"; value: JudgementValue }
    | { state: "unresolved" }
    | { state: "absent" }
    | { state: "malformed" };

/**
 * Look for a judged deterministic resolution beside the raw judgement.
 * @param reader The evidence reader.
 * @param attemptDir The attempt directory, relative to the evidence root.
 * @returns The lookup outcome.
 */
function judgedResolutionOf(
    reader: EvidenceReader,
    attemptDir: string,
): ResolutionLookup {
    const resolution = loadJson(
        reader,
        joinPath(attemptDir, "resolution.json"),
    );
    if (resolution.state === "missing") return { state: "absent" };
    if (resolution.state !== "available") return { state: "malformed" };
    if (!isRecord(resolution.value)) return { state: "malformed" };
    if (
        resolution.value.status === "judged" &&
        isRecord(resolution.value.parsed)
    ) {
        return {
            state: "selected",
            value: {
                value: resolution.value.parsed,
                layer: "deterministic-resolution",
                status: "judged",
            },
        };
    }
    return { state: "unresolved" };
}

/**
 * Read the raw judgement as the fallback layer.
 * @param reader The evidence reader.
 * @param attemptDir The attempt directory, relative to the evidence root.
 * @param problems Problem collector.
 * @returns The judgement value, or undefined.
 */
function rawJudgement(
    reader: EvidenceReader,
    attemptDir: string,
    problems: string[],
): JudgementValue | undefined {
    const judgement = loadJson(reader, joinPath(attemptDir, "judgement.json"));
    if (judgement.state !== "available") {
        if (judgement.state === "malformed")
            problems.push(...judgement.problems);
        return undefined;
    }
    if (!isRecord(judgement.value)) {
        problems.push("judgement is not a JSON object");
        return undefined;
    }
    if (typeof judgement.value.status !== "string") {
        problems.push("judgement has no status string");
        return undefined;
    }
    return {
        value: judgement.value,
        layer: "judge",
        status: judgement.value.status,
    };
}

/**
 * Select the judgement layer per the recorded policy. A judged deterministic
 * resolution wins only under resolution-then-judgement; the raw judgement
 * governs under judgement-only, whatever the resolution says.
 * @param reader The evidence reader.
 * @param attemptDir The attempt directory, relative to the evidence root.
 * @param selectionPolicy The recorded selection policy.
 * @param problems Problem collector.
 * @returns The selected judgement value, or undefined.
 */
function selectJudgement(
    reader: EvidenceReader,
    attemptDir: string,
    selectionPolicy: SelectionPolicy,
    problems: string[],
): JudgementValue | undefined {
    if (selectionPolicy !== "resolution-then-judgement") {
        return rawJudgement(reader, attemptDir, problems);
    }
    const resolution = judgedResolutionOf(reader, attemptDir);
    if (resolution.state === "selected") return resolution.value;
    if (resolution.state === "unresolved") {
        problems.push(
            "the recorded resolution stayed unresolved; the raw judgement governs",
        );
    }
    return rawJudgement(reader, attemptDir, problems);
}

/**
 * Extract the documented outcome from a judgement value, reporting an
 * unsupported value instead of silently dropping it.
 * @param value The judgement object.
 * @param problems Problem collector.
 * @returns The outcome, or undefined.
 */
function outcomeOf(
    value: Record<string, unknown>,
    problems: string[],
): DocumentationOutcome | undefined {
    const outcome = value.documentationOutcome;
    if (outcome === undefined) return undefined;
    if (typeof outcome !== "string") {
        problems.push(
            `unsupported documentationOutcome ${JSON.stringify(outcome)}; treated as unassessed, never as none`,
        );
        return undefined;
    }
    const known = DOCUMENTATION_OUTCOMES.find((known) => known === outcome);
    if (known !== undefined) return known;
    problems.push(
        `unsupported documentationOutcome ${JSON.stringify(outcome)}; treated as unassessed, never as none`,
    );
    return undefined;
}

/**
 * Load per-fact preservation observations for the scenario's inventory.
 * @param reader The evidence reader.
 * @param attemptDir The attempt directory, relative to the evidence root.
 * @param factIds The inventory fact ids to load.
 * @returns The per-fact observations, or the explicit state.
 */
function loadPreservation(
    reader: EvidenceReader,
    attemptDir: string,
    factIds: string[],
): Loaded<PreservationByFact> {
    const judgement = loadJson(reader, joinPath(attemptDir, "judgement.json"));
    const resolution = loadJson(
        reader,
        joinPath(attemptDir, "resolution.json"),
    );
    const value =
        resolution.state === "available" && isRecord(resolution.value)
            ? resolution.value.parsed
            : judgement.state === "available"
              ? judgement.value
              : undefined;
    if (!isRecord(value) || !isRecord(value.preservation)) {
        return { state: "missing", source: attemptDir };
    }
    const byFact: PreservationByFact = {};
    for (const factId of factIds) {
        byFact[factId] = preservationFactOf(
            joinPath(attemptDir, `resolution.json#${factId}`),
            value.preservation[factId],
        );
    }
    return loaded(byFact, attemptDir);
}

/**
 * Load one inventory fact's observation, keeping shape problems explicit.
 * @param source The display source for the observation.
 * @param entry The raw fact entry.
 * @returns The observation, or the explicit state.
 */
function preservationFactOf(
    source: string,
    entry: unknown,
): Loaded<PreservationObservation> {
    if (entry === undefined) return { state: "missing", source };
    if (!isRecord(entry)) {
        return {
            state: "malformed",
            source,
            problems: ["preservation entry is not an object"],
        };
    }
    const problems: string[] = [];
    if (typeof entry.state !== "string" || entry.state.trim() === "") {
        problems.push("preservation state must be a nonblank string");
    }
    if (typeof entry.quote !== "string" || entry.quote.trim() === "") {
        problems.push("preservation quote must be a nonblank string");
    }
    if (problems.length > 0) return { state: "malformed", source, problems };
    return loaded(
        { state: entry.state as string, quote: entry.quote as string },
        source,
    );
}

/**
 * Build an assessment for a trial with no usable judgement layer.
 * @param status The assessment status to record.
 * @param source The display source for the missing preservation record.
 * @param problems Problems found while getting here.
 * @returns The assessment.
 */
function unassessedResult(
    status: AssessmentStatus,
    source: string,
    problems: string[],
): TrialAssessment {
    return {
        status,
        layer: "none",
        outcome: undefined,
        reason: undefined,
        evidence: [],
        preservation: { state: "missing", source },
        retrieval: { state: "missing", source },
        problems,
    };
}

/**
 * Report unselected judge attempt directories, so extra judgement layers
 * cannot silently disappear from the record.
 * @param reader The evidence reader.
 * @param acDir The trial's ac directory, relative to the evidence root.
 * @returns One problem per unselected attempt directory.
 */
function unselectedAttemptProblems(
    reader: EvidenceReader,
    acDir: string,
    selectedAttemptId: string,
): string[] {
    const entries = reader.readDirectoryEntries(acDir);
    if (entries.state !== "available") return [];
    const problems: string[] = [];
    for (const name of entries.value) {
        if (!/^attempt-\d+$/.test(name) || name === selectedAttemptId) continue;
        const judgement = loadJson(
            reader,
            joinPath(joinPath(acDir, name), "judgement.json"),
        );
        const judged =
            judgement.state === "available" &&
            isRecord(judgement.value) &&
            judgement.value.status === "judged";
        if (judged) {
            problems.push(`unselected judge attempt present: ${name}`);
        }
    }
    return problems;
}

/**
 * Load the selected judgement layer's assessment.
 * @param reader The evidence reader.
 * @param attemptDir The selected attempt directory.
 * @param options The load options.
 * @param problems Problem collector.
 * @returns The resolved assessment.
 */
function selectedAssessment(
    reader: EvidenceReader,
    attemptDir: string,
    options: TrialRecordOptions,
    problems: string[],
): TrialAssessment {
    const selectedValue = selectJudgement(
        reader,
        attemptDir,
        options.selectionPolicy,
        problems,
    );
    if (selectedValue === undefined) {
        return unassessedResult("unassessed", attemptDir, problems);
    }
    const { status, value, layer } = selectedValue;
    const recorded =
        status === "judged" ||
        status === "invalid-verdict" ||
        status === "judge-error";
    if (!recorded) {
        problems.push(`unsupported judgement status ${JSON.stringify(status)}`);
        return unassessedResult("unassessed", attemptDir, problems);
    }
    return {
        status,
        layer,
        outcome: status === "judged" ? outcomeOf(value, problems) : undefined,
        reason:
            typeof value.documentationReason === "string"
                ? value.documentationReason
                : undefined,
        evidence: evidenceOf(value, problems),
        preservation: loadPreservation(
            reader,
            attemptDir,
            options.inventoryFactIds,
        ),
        retrieval:
            status === "judged"
                ? retrievalOf(value, attemptDir)
                : { state: "missing", source: attemptDir },
        problems,
    };
}

/**
 * Extract the judge's retrieval-application finding, keeping a missing or
 * malformed block explicit rather than treating it as a miss.
 * @param value The judgement object.
 * @param source The display source.
 * @returns The observation, or the explicit state.
 */
function retrievalOf(
    value: Record<string, unknown>,
    source: string,
): Loaded<RetrievalObservation> {
    const entry = value.retrievalApplication;
    if (entry === undefined) return { state: "missing", source };
    if (!isRecord(entry)) {
        return {
            state: "malformed",
            source,
            problems: ["retrievalApplication is not an object"],
        };
    }
    if (typeof entry.state !== "string" || typeof entry.quote !== "string") {
        return {
            state: "malformed",
            source,
            problems: ["retrievalApplication needs string state and quote"],
        };
    }
    return {
        state: "available",
        value: { state: entry.state, quote: entry.quote },
        source,
    };
}

/**
 * Load one trial's assessment through the recorded selection policy.
 * @param reader The evidence reader.
 * @param dir The trial directory, relative to the evidence root.
 * @param attempt The attempt state of the trial directory.
 * @param options The load options.
 * @returns The resolved assessment.
 */
function loadAssessment(
    reader: EvidenceReader,
    dir: string,
    attempt: AttemptState,
    options: TrialRecordOptions,
): TrialAssessment {
    const acDir = joinPath(dir, "ac");
    const attemptId = options.attemptId ?? "attempt-001";
    const problems = unselectedAttemptProblems(reader, acDir, attemptId);
    if (attempt === "absent") {
        return unassessedResult("not-run", acDir, problems);
    }
    if (attempt !== "recorded") {
        return unassessedResult("unknown", acDir, problems);
    }
    const selected = joinPath(acDir, attemptId);
    const attemptDirs = reader.readDirectoryEntries(acDir);
    if (
        attemptDirs.state !== "available" ||
        !attemptDirs.value.includes(attemptId)
    ) {
        return unassessedResult("unassessed", selected, problems);
    }
    return selectedAssessment(reader, selected, options, problems);
}

/**
 * Extract the judgement's evidence quotes, keeping shape problems visible.
 * @param value The judgement object.
 * @param problems Problem collector.
 * @returns The nonblank string quotes; empty when absent or malformed.
 */
function evidenceOf(
    value: Record<string, unknown>,
    problems: string[],
): string[] {
    const evidence = value.evidence;
    if (evidence === undefined) return [];
    if (!Array.isArray(evidence)) {
        problems.push("judgement evidence is not an array");
        return [];
    }
    const quotes = evidence.filter(
        (quote): quote is string =>
            typeof quote === "string" && quote.trim() !== "",
    );
    if (quotes.length !== evidence.length) {
        problems.push("judgement evidence holds non-string or blank entries");
    }
    return quotes;
}

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An empty per-field token total. */
function emptyField(): TokenFieldUsage {
    return { total: 0, measuredSteps: 0, unknownSteps: 0 };
}

/** An empty token total. */
function emptyUsage(): TokenUsage {
    return {
        steps: 0,
        input: emptyField(),
        output: emptyField(),
        reasoning: emptyField(),
        cacheRead: emptyField(),
    };
}

/**
 * Parse one trail line into a JSON object, if it is one.
 * @param line The raw trail line.
 * @returns The object, or undefined when the line is not a JSON object.
 */
function parseTrailLine(line: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Add one reported token field. A numeric value is measured, including an
 * explicit zero; an absent or non-numeric value is unknown and contributes no
 * subtotal.
 * @param field The accumulated field usage.
 * @param value The raw recorded value.
 */
function addTokenField(field: TokenFieldUsage, value: unknown): void {
    if (typeof value === "number") {
        field.total += value;
        field.measuredSteps += 1;
    } else {
        field.unknownSteps += 1;
    }
}

/**
 * Add one trail event's token usage. Every step_finish event counts as an
 * observed step; each token field keeps its own measured/unknown coverage, so
 * a step reporting only `input` never implies a measured zero `output`.
 * @param usage The accumulated usage.
 * @param event The parsed trail event.
 */
function addTokenUsage(
    usage: TokenUsage,
    event: Record<string, unknown>,
): void {
    if (event.type !== "step_finish") return;
    usage.steps += 1;
    const part = isRecord(event.part) ? event.part : {};
    const tokens = isRecord(part.tokens) ? part.tokens : undefined;
    const cache =
        tokens !== undefined && isRecord(tokens.cache)
            ? tokens.cache
            : undefined;
    addTokenField(usage.input, tokens?.input);
    addTokenField(usage.output, tokens?.output);
    addTokenField(usage.reasoning, tokens?.reasoning);
    addTokenField(usage.cacheRead, cache?.read);
}

/**
 * Sum token accounting from a recorded session trail. An unparsable trail is
 * malformed rather than partially summed, so a corrupt line cannot deflate a
 * cost silently.
 * @param reader The evidence reader.
 * @param path The trail path, relative to the evidence root.
 * @returns The summed usage, or the explicit state.
 */
function loadTokens(reader: EvidenceReader, path: string): Loaded<TokenUsage> {
    const lines = loadLines(reader, path);
    if (lines.state !== "available") return lines;
    const usage = emptyUsage();
    const problems: string[] = [];
    for (const [index, line] of lines.value.entries()) {
        const event = parseTrailLine(line);
        if (event === undefined) {
            problems.push(
                `unparsable trail line ${index + 1}: ${line.slice(0, 80)}`,
            );
            continue;
        }
        addTokenUsage(usage, event);
    }
    if (problems.length > 0) {
        return { state: "malformed", source: path, problems };
    }
    return loaded(usage, path);
}

/**
 * Load and verify the plugin's operation journal for one trial.
 *
 * Verification inputs come from the same trial directory: the saved journal,
 * its per-run signing key, the session/message ids in `stdout.jsonl`, and the
 * host dispatches in `tools.jsonl`. A missing journal is absent evidence, not
 * an empty one; an unreadable journal credits nothing.
 * @param reader The evidence reader.
 * @param dir The trial directory, relative to the evidence root.
 * @returns The verification result.
 */
function loadJournalVerification(
    reader: EvidenceReader,
    dir: string,
): JournalVerification {
    const journal = reader.readTextFile(joinPath(dir, "docs-operations.jsonl"));
    if (journal.state === "missing") {
        return {
            state: "absent",
            credited: [],
            rejected: [],
            problems: [],
        };
    }
    const key = reader.readTextFile(joinPath(dir, "docs-operations.key"));
    const stdout = reader.readTextFile(joinPath(dir, "stdout.jsonl"));
    const tools = reader.readTextFile(joinPath(dir, "tools.jsonl"));
    const host =
        tools.state === "available"
            ? hostDispatchesFromTrail(tools.value)
            : { callIds: new Set<string>(), nativeCalls: [], dispatches: [] };
    return verifyOperationsJournal({
        lines: journal.state === "available" ? journal.value.split("\n") : [],
        key: key.state === "available" ? key.value : null,
        identity:
            stdout.state === "available"
                ? journalIdentityFromTrail(stdout.value)
                : { sessions: new Set(), messages: new Set() },
        callIds: host.callIds,
        nativeCalls: host.nativeCalls,
        dispatches: host.dispatches,
    });
}

/**
 * Load one trial's evidence under the ac-v1 layout.
 * @param reader The evidence reader rooted at the evidence root.
 * @param options Which trial to load and how to select judgement layers.
 * @returns The trial record.
 */
export function loadTrialRecord(
    reader: EvidenceReader,
    options: TrialRecordOptions,
): TrialRecord {
    const dir = joinPath(
        joinPath(options.resultRoot, options.stamp),
        options.scenario,
    );
    const attempt = attemptOf(reader, dir);
    const run = loadRun(reader, dir);
    const usability = usableOf(run);
    const finalAnswer = reader.readTextFile(joinPath(dir, "final.md"));
    const answerProblem =
        finalAnswer.state === "available" && run.state === "available"
            ? answerIdentityProblem(finalAnswer.value, run.value.answerHash)
            : null;
    const problems = [...attempt.problems, ...usability.problems];
    if (answerProblem !== null) problems.push(answerProblem);
    return {
        identity: {
            resultRoot: options.resultRoot,
            stamp: options.stamp,
            scenario: options.scenario,
        },
        attempt: {
            state: attempt.state,
            usable: answerProblem === null ? usability.usable : false,
            problems,
        },
        run,
        gate: loadGate(reader, dir),
        primary: primaryOf(
            loadJson(reader, joinPath(dir, "primary-check.json")),
        ),
        assessment: loadAssessment(reader, dir, attempt.state, options),
        judgeModel: loadJudgeModel(
            reader,
            dir,
            options.attemptId ?? "attempt-001",
        ),
        tokens: loadTokens(reader, joinPath(dir, "stdout.jsonl")),
        artefacts: {
            finalAnswer,
            writesText: reader.readTextFile(joinPath(dir, "writes.txt")),
            docsOperations: loadLines(
                reader,
                joinPath(dir, "docs-operations.jsonl"),
            ),
            promptText: reader.readTextFile(joinPath(dir, "prompt.md")),
        },
        journal: loadJournalVerification(reader, dir),
        answerProblem,
    };
}

/**
 * Load the judge model identity from the attempt metadata.
 * @param reader The evidence reader.
 * @param dir The trial directory, relative to the evidence root.
 * @returns The judge model, or the explicit state.
 */
function loadJudgeModel(
    reader: EvidenceReader,
    dir: string,
    attemptId: string,
): Loaded<string> {
    const meta = loadJson(
        reader,
        joinPath(dir, joinPath("ac", joinPath(attemptId, "meta.json"))),
    );
    if (meta.state === "available" && isRecord(meta.value)) {
        const model = meta.value.judgeModel;
        if (typeof model === "string" && model.trim() !== "") {
            return loaded(model, meta.source);
        }
    }
    return { state: "missing", source: meta.source };
}

/**
 * Load the campaign attempt ledger (one JSON event per line).
 * @param reader The evidence reader.
 * @param path The ledger path, relative to the evidence root.
 * @returns The events, or the explicit state.
 */
export function loadLaunchLedger(
    reader: EvidenceReader,
    path: string,
): Loaded<LaunchRecord[]> {
    const text = reader.readTextFile(path);
    if (text.state !== "available") return text;
    const parsed = parseCampaignLedger(text.value);
    if (parsed.state === "malformed") {
        return { state: "malformed", source: path, problems: parsed.problems };
    }
    return loaded(
        parsed.events.map((event) => ({
            at: event.at,
            event: event.event,
            stamp: event.stamp,
        })),
        path,
    );
}
