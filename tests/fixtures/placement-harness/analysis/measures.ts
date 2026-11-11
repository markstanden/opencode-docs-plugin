/**
 * Recording and retrieval opportunity measures for a productivity screen.
 *
 * The frozen utility answers "what did the trial document". These measures
 * answer two different questions that utility does not: was a durable finding
 * recorded through the plugin into the appropriate lake, and was an existing
 * note retrieved and actually applied to the work. They are pure functions
 * over loaded evidence: a missing journal, a missing judgement and an
 * unattributable read each stay explicit and never become a zero or a pass.
 */
import type { DocumentationOutcome } from "../ac-scoring.mts";
import type { AccountingCounts } from "./accounting.ts";
import type { SlotSpec } from "./model.ts";
import type { TrialRecord } from "./records.ts";

/** The measurement declaration schema version this module parses. */
export const MEASURES_SCHEMA_VERSION = 1;

/** One retrieval opportunity's declared note and assessed facts. */
export interface RetrievalDeclaration {
    /** The lake-relative path of the seeded note. */
    note: string;
    /** The preservation facts the note's correction must keep, when any. */
    facts: string[];
}

/** The declared eligible scenarios for each opportunity measure. */
export interface MeasureDeclarations {
    /** Scenarios counted in the unprompted-recording denominator. */
    recording: string[];
    /** Scenarios counted in the unprompted-retrieval denominator. */
    retrieval: Record<string, RetrievalDeclaration>;
}

/** The outcome of parsing a measurement declaration. */
export interface MeasureDeclarationParse {
    /** The validated declarations, when the input is usable. */
    declarations?: MeasureDeclarations;
    /** Every shape problem, so a malformed declaration is visible. */
    problems: string[];
}

/** One journal operation, from the plugin's own operation journal. */
export interface DocsOperation {
    /** The recorded completion status. */
    status: string;
    /** The delivery surface (native, twin, or Code Mode twin). */
    surface: string;
    /** The operation's verb. */
    verb: "add" | "read" | "search" | "check" | "help" | "unknown";
    /** The typed target of a read or add, when present. */
    target: string | null;
    /** The raw journal line, for the receipt/evidence trail. */
    line: string;
}

/** The recording measure for one trial. */
export interface RecordingMeasure {
    /** Whether the scenario is in the recording denominator. */
    eligible: boolean;
    /** The deterministic disposition of any write. */
    disposition:
        | "verified-write"
        | "gate-blocked"
        | "filesystem-only"
        | "tool-error"
        | "no-write"
        | "unknown"
        | "not-run"
        | "not-eligible";
    /** Whether a verified useful plugin-mediated write landed. */
    success: boolean;
    /** The semantic outcome, when the judge recorded one. */
    outcome: DocumentationOutcome | null;
    /** The recorded gate status, when readable. */
    gate: string | null;
    /** Completed add operations, rendered for evidence. */
    writes: string[];
    /** Supporting evidence lines. */
    evidence: string[];
}

/** The retrieval measure for one trial. */
export interface RetrievalMeasure {
    /** Whether the scenario is in the retrieval denominator. */
    eligible: boolean;
    /** The resolved state: applied, miss, unknown, not run or not eligible. */
    state: "applied" | "miss" | "unknown" | "not-run" | "not-eligible";
    /** Whether an attributable completed read of the declared note exists. */
    read: boolean;
    /** The judge's recorded retrieval state, when present. */
    judgeState: string | null;
    /** The declared target note. */
    note: string | null;
    /** The attributable read operation lines. */
    trace: string[];
    /** Supporting evidence lines. */
    evidence: string[];
}

/** One trial's measures. */
export interface TrialMeasures {
    /** The trial stamp. */
    stamp: string;
    /** The scenario. */
    scenario: string;
    /** The arm. */
    arm: string;
    /** The recording measure. */
    recording: RecordingMeasure;
    /** The retrieval measure. */
    retrieval: RetrievalMeasure;
}

/** One arm's opportunity counts. */
export interface ArmMeasureSummary {
    /** Recording out of the planned four. */
    recording: {
        planned: number;
        success: number;
        miss: number;
        unknown: number;
        notRun: number;
        dispositions: Record<string, number>;
    };
    /** Retrieval out of the planned five. */
    retrieval: {
        planned: number;
        applied: number;
        miss: number;
        unknown: number;
        notRun: number;
        states: Record<string, number>;
    };
}

/** The campaign measures block published in analysis.json. */
export interface MeasuresReport {
    /** Whether the declaration was loaded and usable. */
    status: "available" | "missing" | "malformed";
    /** SHA-256 of the declaration bytes, when available. */
    declarationSha256: string | null;
    /** Per-arm opportunity counts. */
    arms: Record<string, ArmMeasureSummary>;
    /** Every trial's measure, eligible or not. */
    trials: TrialMeasures[];
    /** The personal-trial screen, kept separate from the utility threshold. */
    personalTrial: PersonalTrialDecision;
}

/** The personal-trial screen's decision. */
export interface PersonalTrialDecision {
    /** The screen's recommendation. */
    recommendation: "personal-trial" | "no-promotion" | "inconclusive";
    /** Every criterion and how it was decided. */
    reasons: string[];
    /** The analyser's utility-threshold limb, labelled as one component. */
    utilityThreshold: {
        component: "utility-threshold";
        status: string;
        lead: number | null;
        interval: { low: number; high: number } | null;
        note: string;
    };
}

/** A criterion's decision. */
interface Criterion {
    /** The criterion outcome. */
    status: "pass" | "fail" | "inconclusive";
    /** Supporting reasons. */
    reasons: string[];
}

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A nonblank string array, or undefined when the value is malformed. */
function stringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const strings = value.filter(
        (entry): entry is string =>
            typeof entry === "string" && entry.trim() !== "",
    );
    return strings.length === value.length ? strings : undefined;
}

/** Parse one eligible-scenario list, collecting its problem. */
function idList(
    value: unknown,
    label: string,
    problems: string[],
): string[] | undefined {
    const ids = stringArray(value);
    if (ids === undefined) {
        problems.push(`${label} must be a nonblank string array`);
        return undefined;
    }
    if (new Set(ids).size !== ids.length) {
        problems.push(`${label} repeats a scenario`);
    }
    return ids;
}

/** Parse one retrieval scenario's preservation fact ids. */
function factIds(
    entry: Record<string, unknown>,
    id: string,
    problems: string[],
): string[] | undefined {
    const preservation = entry.preservation;
    if (preservation === undefined) return [];
    if (!isRecord(preservation)) {
        problems.push(`scenarios.${id}.preservation must be an object`);
        return undefined;
    }
    const facts = preservation.facts;
    if (facts === undefined) return [];
    if (!Array.isArray(facts)) {
        problems.push(`scenarios.${id}.preservation.facts must be an array`);
        return undefined;
    }
    const ids = facts.map((fact) =>
        isRecord(fact) && typeof fact.id === "string" ? fact.id.trim() : "",
    );
    if (ids.some((value) => value === "")) {
        problems.push(
            `scenarios.${id}.preservation.facts must carry nonblank ids`,
        );
        return undefined;
    }
    return ids;
}

/** Parse one retrieval scenario declaration. */
function retrievalDeclaration(
    entry: unknown,
    id: string,
    problems: string[],
): RetrievalDeclaration | undefined {
    if (!isRecord(entry)) {
        problems.push(`scenarios.${id} is missing`);
        return undefined;
    }
    const retrieval = entry.retrieval;
    if (!isRecord(retrieval)) {
        problems.push(`scenarios.${id}.retrieval is missing`);
        return undefined;
    }
    if (typeof retrieval.note !== "string" || retrieval.note.trim() === "") {
        problems.push(`scenarios.${id}.retrieval.note must be nonblank`);
        return undefined;
    }
    const facts = factIds(entry, id, problems);
    if (facts === undefined) return undefined;
    return { note: retrieval.note, facts };
}

/**
 * Parse and validate the measurement declaration. The declaration is data:
 * every problem is collected instead of throwing.
 * @param value The parsed `measurement.json` value.
 * @returns The declarations or the collected problems.
 */
export function parseMeasureDeclarations(
    value: unknown,
): MeasureDeclarationParse {
    if (!isRecord(value)) {
        return { problems: ["measurement declaration is not an object"] };
    }
    const problems: string[] = [];
    const recording = idList(
        value.recordingOpportunities,
        "recordingOpportunities",
        problems,
    );
    const retrievalIds = idList(
        value.retrievalOpportunities,
        "retrievalOpportunities",
        problems,
    );
    const scenarios = isRecord(value.scenarios) ? value.scenarios : {};
    const retrieval: Record<string, RetrievalDeclaration> = {};
    for (const id of retrievalIds ?? []) {
        const declaration = retrievalDeclaration(scenarios[id], id, problems);
        if (declaration !== undefined) retrieval[id] = declaration;
    }
    if (problems.length > 0 || recording === undefined) {
        return { problems };
    }
    return { declarations: { recording, retrieval }, problems };
}

/** Parse one journal line into an operation, or a problem. */
function operationOf(
    line: string,
    index: number,
): { operation?: DocsOperation; problem?: string } {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return { problem: `journal line ${String(index + 1)} is not JSON` };
    }
    if (!isRecord(value) || !isRecord(value.input)) {
        return {
            problem: `journal line ${String(index + 1)} has no input`,
        };
    }
    const input = value.input;
    const add = isRecord(input.add) ? input.add : undefined;
    return {
        operation: {
            status: typeof value.status === "string" ? value.status : "unknown",
            surface:
                typeof value.surface === "string" ? value.surface : "unknown",
            verb: verbOf(input, add),
            target: targetOf(input, add),
            line,
        },
    };
}

/** The verb one journal input expresses. */
function verbOf(
    input: Record<string, unknown>,
    add: Record<string, unknown> | undefined,
): DocsOperation["verb"] {
    if (add !== undefined) return "add";
    if (typeof input.read === "string") return "read";
    if (typeof input.search === "string") return "search";
    if (input.check !== undefined) return "check";
    return "help";
}

/** The typed target one journal input names, when any. */
function targetOf(
    input: Record<string, unknown>,
    add: Record<string, unknown> | undefined,
): string | null {
    if (typeof input.read === "string") return input.read;
    if (add !== undefined && typeof add.path === "string") return add.path;
    return null;
}

/**
 * Parse the plugin journal lines into operations, keeping unreadable lines
 * explicit.
 * @param lines The raw journal lines.
 * @returns The operations and any parse problems.
 */
export function parseOperations(lines: readonly string[]): {
    operations: DocsOperation[];
    problems: string[];
} {
    const operations: DocsOperation[] = [];
    const problems: string[] = [];
    for (const [index, line] of lines.entries()) {
        const parsed = operationOf(line, index);
        if (parsed.operation !== undefined) operations.push(parsed.operation);
        if (parsed.problem !== undefined) problems.push(parsed.problem);
    }
    return { operations, problems };
}

/**
 * Whether a typed read or add target names the declared note. Lake-qualified
 * and lake-relative forms both match; a partial fragment does not.
 * @param target The typed operation target.
 * @param note The declared note path.
 * @returns True when the target is the note.
 */
export function targetsNote(target: string, note: string): boolean {
    const normalise = (path: string) => path.replace(/^[a-z0-9_-]+:/i, "");
    const left = normalise(target);
    const right = normalise(note);
    return (
        left === right ||
        left.endsWith(`/${right}`) ||
        right.endsWith(`/${left}`)
    );
}

/** The shared, evidence-only facts one trial's measures read. */
interface MeasureContext {
    record: TrialRecord;
    operations: DocsOperation[];
    parsed: boolean;
    gate: string | null;
    outcome: DocumentationOutcome | null;
    primary: string;
    notRun: boolean;
    recordingEligible: boolean;
    retrievalDeclaration: RetrievalDeclaration | undefined;
}

/** Build the context once so each measure stays small. */
function contextOf(
    record: TrialRecord,
    declarations: MeasureDeclarations,
): MeasureContext {
    const journal = record.artefacts.docsOperations;
    const parsed =
        journal.state === "available"
            ? parseOperations(journal.value)
            : undefined;
    return {
        record,
        operations: parsed?.operations ?? [],
        parsed: parsed !== undefined,
        gate:
            record.gate.state === "available" ? record.gate.value.status : null,
        outcome: record.assessment.outcome ?? null,
        primary: record.primary.status,
        notRun:
            record.attempt.state === "absent" ||
            record.assessment.status === "not-run",
        recordingEligible: declarations.recording.includes(
            record.identity.scenario,
        ),
        retrievalDeclaration: declarations.retrieval[record.identity.scenario],
    };
}

/** The dispositions decided before any write is inspected. */
function earlyDisposition(
    context: MeasureContext,
): { disposition: RecordingMeasure["disposition"]; evidence: string[] } | null {
    if (!context.recordingEligible) {
        return { disposition: "not-eligible", evidence: [] };
    }
    if (context.notRun) {
        return { disposition: "not-run", evidence: [] };
    }
    if (context.gate === "blocked") {
        const reason =
            context.record.gate.state === "available"
                ? String(context.record.gate.value.reason)
                : "unknown";
        return {
            disposition: "gate-blocked",
            evidence: [`gate blocked: ${reason}`],
        };
    }
    if (!context.parsed) {
        return {
            disposition: "unknown",
            evidence: [
                "no readable docs-operation journal; a write cannot be attributed",
            ],
        };
    }
    return null;
}

/** The deterministic disposition of a trial's documentation write. */
function dispositionOf(
    context: MeasureContext,
    completedAdds: DocsOperation[],
    failedAdds: DocsOperation[],
): { disposition: RecordingMeasure["disposition"]; evidence: string[] } {
    const early = earlyDisposition(context);
    if (early !== null) return early;
    if (completedAdds.length > 0) {
        return completedWrite(context);
    }
    if (failedAdds.length > 0) {
        return {
            disposition: "tool-error",
            evidence: ["a docs add operation failed"],
        };
    }
    if (
        (context.outcome === "useful-create" ||
            context.outcome === "useful-update") &&
        context.gate === "pass"
    ) {
        return {
            disposition: "filesystem-only",
            evidence: [
                "the documentation surface changed and passed the gate, but no completed docs add operation was journaled",
            ],
        };
    }
    return { disposition: "no-write", evidence: [] };
}

/** The disposition when at least one completed plugin write exists. */
function completedWrite(context: MeasureContext): {
    disposition: RecordingMeasure["disposition"];
    evidence: string[];
} {
    if (
        context.outcome === "useful-create" ||
        context.outcome === "useful-update"
    ) {
        return context.gate === "pass"
            ? { disposition: "verified-write", evidence: [] }
            : { disposition: "gate-blocked", evidence: [] };
    }
    if (context.outcome === null) {
        return {
            disposition: "unknown",
            evidence: [
                "a completed plugin write exists but no judgement was recorded",
            ],
        };
    }
    return {
        disposition: "no-write",
        evidence: [
            `judgement recorded ${context.outcome} for a completed plugin write`,
        ],
    };
}

/** The judge's retrieval state, from the loaded assessment. */
function judgeRetrieval(record: TrialRecord): {
    state: string | null;
    quote: string | null;
} {
    const retrieval = record.assessment.retrieval;
    return retrieval.state === "available"
        ? { state: retrieval.value.state, quote: retrieval.value.quote }
        : { state: null, quote: null };
}

/** The retrieval state and evidence for one trial. */
function retrievalOf(context: MeasureContext): {
    state: RetrievalMeasure["state"];
    read: boolean;
    judgeState: string | null;
    note: string | null;
    trace: string[];
    evidence: string[];
} {
    const declaration = context.retrievalDeclaration;
    if (declaration === undefined) {
        return {
            state: "not-eligible",
            read: false,
            judgeState: null,
            note: null,
            trace: [],
            evidence: [],
        };
    }
    if (context.notRun) {
        return {
            state: "not-run",
            read: false,
            judgeState: null,
            note: declaration.note,
            trace: [],
            evidence: [],
        };
    }
    const reads = context.operations.filter(
        (operation) =>
            operation.verb === "read" &&
            operation.status === "completed" &&
            operation.target !== null &&
            targetsNote(operation.target, declaration.note),
    );
    const judge = judgeRetrieval(context.record);
    const base = {
        read: reads.length > 0,
        judgeState: judge.state,
        note: declaration.note,
        trace: reads.map((operation) => operation.line),
    };
    if (!context.parsed) {
        return {
            ...base,
            state: "unknown",
            evidence: [
                `docs-operation journal is ${context.record.artefacts.docsOperations.state}; attribution is unknown`,
            ],
        };
    }
    if (!base.read) {
        return {
            ...base,
            state: "miss",
            evidence: [
                `no completed read of ${declaration.note} was attributed to the session`,
            ],
        };
    }
    return { ...base, ...appliedState(context, judge) };
}

/** The applied/miss/unknown decision once an attributable read exists. */
function appliedState(
    context: MeasureContext,
    judge: { state: string | null; quote: string | null },
): { state: RetrievalMeasure["state"]; evidence: string[] } {
    if (judge.state === null) {
        return {
            state: "unknown",
            evidence: [
                "an attributable read exists but no retrieval judgement was recorded",
            ],
        };
    }
    if (judge.state === "applied" && context.primary === "pass") {
        return {
            state: "applied",
            evidence: [
                `judge applied the note: ${judge.quote ?? "(no quote)"}`,
            ],
        };
    }
    if (judge.state === "applied") {
        return {
            state: "unknown",
            evidence: [
                `judge reports applied but the independent primary check is ${context.primary}`,
            ],
        };
    }
    if (judge.state === "unknown") {
        return { state: "unknown", evidence: [] };
    }
    return {
        state: "miss",
        evidence: [`judge recorded ${judge.state}`],
    };
}

/**
 * Measure one trial against the declared opportunities.
 * @param record The loaded trial record.
 * @param declarations The validated declarations.
 * @param arm The declared arm id.
 * @returns The trial measures.
 */
export function measureTrial(
    record: TrialRecord,
    declarations: MeasureDeclarations,
    arm: string,
): TrialMeasures {
    const context = contextOf(record, declarations);
    const completedAdds = context.operations.filter(
        (operation) =>
            operation.verb === "add" && operation.status === "completed",
    );
    const failedAdds = context.operations.filter(
        (operation) =>
            operation.verb === "add" && operation.status !== "completed",
    );
    const write = dispositionOf(context, completedAdds, failedAdds);
    const retrieval = retrievalOf(context);
    return {
        stamp: record.identity.stamp,
        scenario: record.identity.scenario,
        arm,
        recording: {
            eligible: context.recordingEligible,
            disposition: write.disposition,
            success: write.disposition === "verified-write",
            outcome: context.outcome,
            gate: context.gate,
            writes: completedAdds.map((operation) => operation.line),
            evidence: write.evidence,
        },
        retrieval: {
            eligible: context.retrievalDeclaration !== undefined,
            state: retrieval.state,
            read: retrieval.read,
            judgeState: retrieval.judgeState,
            note: retrieval.note,
            trace: retrieval.trace,
            evidence: retrieval.evidence,
        },
    };
}

/** Empty counts for one opportunity type. */
function emptyCounts(): {
    success: number;
    miss: number;
    unknown: number;
    notRun: number;
    dispositions: Record<string, number>;
} {
    return {
        success: 0,
        miss: 0,
        unknown: 0,
        notRun: 0,
        dispositions: {},
    };
}

/** Add one trial to an arm's opportunity counts. */
function countTrial(
    trial: TrialMeasures,
    recording: ReturnType<typeof emptyCounts>,
    retrieval: ReturnType<typeof emptyCounts>,
): void {
    if (trial.recording.eligible) {
        const disposition = trial.recording.disposition;
        recording.dispositions[disposition] =
            (recording.dispositions[disposition] ?? 0) + 1;
        if (trial.recording.success) recording.success += 1;
        else if (disposition === "unknown") recording.unknown += 1;
        else if (disposition === "not-run") recording.notRun += 1;
        else recording.miss += 1;
    }
    if (!trial.retrieval.eligible) return;
    const state = trial.retrieval.state;
    if (state === "applied") retrieval.success += 1;
    else if (state === "unknown") retrieval.unknown += 1;
    else if (state === "not-run") retrieval.notRun += 1;
    else retrieval.miss += 1;
}

/**
 * Summarise the measures per arm.
 * @param trials The trial measures.
 * @param planned The frozen slots.
 * @param declarations The validated declarations.
 * @returns The per-arm counts.
 */
export function summariseMeasures(
    trials: readonly TrialMeasures[],
    planned: readonly SlotSpec[],
    declarations: MeasureDeclarations,
): Record<string, ArmMeasureSummary> {
    const arms = [...new Set(planned.map((slot) => slot.arm))].sort();
    const result: Record<string, ArmMeasureSummary> = {};
    for (const arm of arms) {
        const recording = emptyCounts();
        const retrieval = emptyCounts();
        for (const trial of trials.filter((one) => one.arm === arm)) {
            countTrial(trial, recording, retrieval);
        }
        result[arm] = {
            recording: {
                planned: planned.filter(
                    (slot) =>
                        slot.arm === arm &&
                        declarations.recording.includes(slot.scenario),
                ).length,
                ...recording,
            },
            retrieval: {
                planned: planned.filter(
                    (slot) =>
                        slot.arm === arm &&
                        declarations.retrieval[slot.scenario] !== undefined,
                ).length,
                applied: retrieval.success,
                miss: retrieval.miss,
                unknown: retrieval.unknown,
                notRun: retrieval.notRun,
                states: retrieval.dispositions,
            },
        };
    }
    return result;
}

/** The labelled utility-threshold component. */
function thresholdComponent(threshold: {
    status: string;
    lead: number | null;
    interval: { low: number; high: number } | null;
}): PersonalTrialDecision["utilityThreshold"] {
    return {
        component: "utility-threshold",
        status: threshold.status,
        lead: threshold.lead,
        interval: threshold.interval,
        note: "One component only: a zero-delta 'qualified' at threshold 0 is not the personal-trial recommendation.",
    };
}

/** The known and possible bounds of the two opportunity counts. */
function countBounds(
    control: ArmMeasureSummary,
    candidate: ArmMeasureSummary,
): {
    extraKnown: boolean;
    neitherLowerKnown: boolean;
    neitherLowerRobust: boolean;
    impossibleExtra: boolean;
    unknowns: number;
} {
    return {
        extraKnown:
            candidate.recording.success >= control.recording.success + 1 ||
            candidate.retrieval.applied >= control.retrieval.applied + 1,
        neitherLowerKnown:
            candidate.recording.success >= control.recording.success &&
            candidate.retrieval.applied >= control.retrieval.applied,
        neitherLowerRobust:
            candidate.recording.success >=
                control.recording.success + control.recording.unknown &&
            candidate.retrieval.applied >=
                control.retrieval.applied + control.retrieval.unknown,
        impossibleExtra:
            candidate.recording.success + candidate.recording.unknown <
                control.recording.success + 1 &&
            candidate.retrieval.applied + candidate.retrieval.unknown <
                control.retrieval.applied + 1,
        unknowns:
            control.recording.unknown +
            candidate.recording.unknown +
            control.retrieval.unknown +
            candidate.retrieval.unknown,
    };
}

/** The opportunity-count criterion, with unknowns kept explicit. */
function opportunityCriterion(
    control: ArmMeasureSummary,
    candidate: ArmMeasureSummary,
): Criterion {
    const bounds = countBounds(control, candidate);
    const reasons = [
        `recording: control ${String(control.recording.success)}/${String(control.recording.planned)}, candidate ${String(candidate.recording.success)}/${String(candidate.recording.planned)} (unknown control ${String(control.recording.unknown)}, candidate ${String(candidate.recording.unknown)})`,
        `retrieval: control ${String(control.retrieval.applied)}/${String(control.retrieval.planned)}, candidate ${String(candidate.retrieval.applied)}/${String(candidate.retrieval.planned)} (unknown control ${String(control.retrieval.unknown)}, candidate ${String(candidate.retrieval.unknown)})`,
    ];
    if (
        bounds.unknowns > 0 &&
        !(bounds.extraKnown && bounds.neitherLowerRobust) &&
        !bounds.impossibleExtra
    ) {
        return {
            status: "inconclusive",
            reasons: [
                ...reasons,
                "opportunity outcomes or attribution are unknown and could change the count criterion",
            ],
        };
    }
    if (!bounds.extraKnown || !bounds.neitherLowerKnown) {
        return {
            status: "fail",
            reasons: [
                ...reasons,
                "the candidate has no additional successful recording or applied retrieval with neither count lower (a tie gives no promotion)",
            ],
        };
    }
    return {
        status: "pass",
        reasons: [
            ...reasons,
            "the candidate has at least one additional opportunity with neither count lower",
        ],
    };
}

/** The utility, primary and guardrail quality criterion. */
function qualityCriterion(
    control: AccountingCounts,
    candidate: AccountingCounts,
    guardrails: { status: string; detail: string },
): Criterion {
    if (candidate.utilityTotal < control.utilityTotal) {
        return {
            status: "fail",
            reasons: [
                `weighted utility is lower (control ${String(control.utilityTotal)}, candidate ${String(candidate.utilityTotal)})`,
            ],
        };
    }
    if (candidate.primary.pass < control.primary.pass) {
        return {
            status: "fail",
            reasons: [
                `primary passes are lower (control ${String(control.primary.pass)}, candidate ${String(candidate.primary.pass)})`,
            ],
        };
    }
    if (candidate.outcomes.misleading > control.outcomes.misleading) {
        return {
            status: "fail",
            reasons: [
                `misleading outcomes increased (control ${String(control.outcomes.misleading)}, candidate ${String(candidate.outcomes.misleading)})`,
            ],
        };
    }
    if (guardrails.status === "breached") {
        return {
            status: "fail",
            reasons: [
                `a candidate guardrail is breached: ${guardrails.detail}`,
            ],
        };
    }
    if (guardrails.status === "unresolved") {
        return {
            status: "inconclusive",
            reasons: [
                `a candidate guardrail is unresolved: ${guardrails.detail}`,
            ],
        };
    }
    return {
        status: "pass",
        reasons: [
            "weighted utility and primary passes are not lower, no new misleading outcome, and the candidate guardrails are clean",
        ],
    };
}

/**
 * The incomplete-input checks that make the screen inconclusive before any
 * opportunity or quality comparison.
 * @param control The control arm summary, when present.
 * @param candidate The candidate arm summary, when present.
 * @param controlCounts The control accounting counts, when present.
 * @param candidateCounts The candidate accounting counts, when present.
 * @param coverage The assessment-coverage limb.
 * @param coverage.status The limb's status.
 * @param coverage.detail The limb's reason.
 * @param threshold The labelled utility-threshold component.
 * @returns An inconclusive decision, or null when the inputs are complete.
 */
function earlyInconclusive(
    control: ArmMeasureSummary | undefined,
    candidate: ArmMeasureSummary | undefined,
    controlCounts: AccountingCounts | undefined,
    candidateCounts: AccountingCounts | undefined,
    coverage: { status: string; detail: string },
    threshold: PersonalTrialDecision["utilityThreshold"],
): PersonalTrialDecision | null {
    if (control === undefined || candidate === undefined) {
        return {
            recommendation: "inconclusive",
            reasons: ["an arm has no opportunity summary"],
            utilityThreshold: threshold,
        };
    }
    if (coverage.status !== "pass") {
        return {
            recommendation: "inconclusive",
            reasons: [`coverage: ${coverage.detail}`],
            utilityThreshold: threshold,
        };
    }
    if (controlCounts === undefined || candidateCounts === undefined) {
        return {
            recommendation: "inconclusive",
            reasons: ["accounting counts are missing for an arm"],
            utilityThreshold: threshold,
        };
    }
    if (
        controlCounts.primary.unknown > 0 ||
        candidateCounts.primary.unknown > 0
    ) {
        return {
            recommendation: "inconclusive",
            reasons: [
                "a primary-task result is unknown and could change the pass-count criterion",
            ],
            utilityThreshold: threshold,
        };
    }
    return null;
}

/**
 * The personal-trial screen. The utility threshold is one component; the
 * opportunity counts and quality checks decide the recommendation alongside
 * it.
 * @param controlArm The control arm id.
 * @param candidateArm The candidate arm id.
 * @param measures The per-arm opportunity summaries.
 * @param counts The per-arm accounting counts.
 * @param guardrails The candidate arm's aggregate guardrail status and detail.
 * @param guardrails.status The aggregate status (clean, breached, unresolved).
 * @param guardrails.detail The guardrail evidence.
 * @param coverage The assessment-coverage limb.
 * @param coverage.status The limb's status.
 * @param coverage.detail The limb's reason.
 * @param utilityThreshold The analyser's utility-threshold limb.
 * @param utilityThreshold.status The limb's status.
 * @param utilityThreshold.lead The assessed lead.
 * @param utilityThreshold.interval The full-population interval.
 * @returns The recommendation and every criterion's reason.
 */
export function personalTrialDecision(
    controlArm: string,
    candidateArm: string,
    measures: Record<string, ArmMeasureSummary>,
    counts: Record<string, AccountingCounts>,
    guardrails: { status: string; detail: string },
    coverage: { status: string; detail: string },
    utilityThreshold: {
        status: string;
        lead: number | null;
        interval: { low: number; high: number } | null;
    },
): PersonalTrialDecision {
    const threshold = thresholdComponent(utilityThreshold);
    const control = measures[controlArm];
    const candidate = measures[candidateArm];
    const controlCounts = counts[controlArm];
    const candidateCounts = counts[candidateArm];
    const early = earlyInconclusive(
        control,
        candidate,
        controlCounts,
        candidateCounts,
        coverage,
        threshold,
    );
    if (early !== null) return early;
    const opportunities = opportunityCriterion(
        control as ArmMeasureSummary,
        candidate as ArmMeasureSummary,
    );
    if (opportunities.status !== "pass") {
        return {
            recommendation:
                opportunities.status === "fail"
                    ? "no-promotion"
                    : "inconclusive",
            reasons: opportunities.reasons,
            utilityThreshold: threshold,
        };
    }
    const quality = qualityCriterion(
        controlCounts as AccountingCounts,
        candidateCounts as AccountingCounts,
        guardrails,
    );
    if (quality.status !== "pass") {
        return {
            recommendation:
                quality.status === "fail" ? "no-promotion" : "inconclusive",
            reasons: [...opportunities.reasons, ...quality.reasons],
            utilityThreshold: threshold,
        };
    }
    return {
        recommendation: "personal-trial",
        reasons: [...opportunities.reasons, ...quality.reasons],
        utilityThreshold: threshold,
    };
}
