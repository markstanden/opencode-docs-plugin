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
import type { Loaded, TrialRecord } from "./records.ts";

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
    /** The resolved state: applied, miss, unknown or not eligible. */
    state: "applied" | "miss" | "unknown" | "not-eligible";
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
        dispositions: Record<string, number>;
    };
    /** Retrieval out of the planned five. */
    retrieval: {
        planned: number;
        applied: number;
        miss: number;
        unknown: number;
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
    const recording = stringArray(value.recordingOpportunities);
    if (recording === undefined) {
        problems.push("recordingOpportunities must be a nonblank string array");
    } else if (new Set(recording).size !== recording.length) {
        problems.push("recordingOpportunities repeats a scenario");
    }
    const retrievalIds = stringArray(value.retrievalOpportunities);
    if (retrievalIds === undefined) {
        problems.push("retrievalOpportunities must be a nonblank string array");
    } else if (new Set(retrievalIds).size !== retrievalIds.length) {
        problems.push("retrievalOpportunities repeats a scenario");
    }
    const scenarios = isRecord(value.scenarios) ? value.scenarios : {};
    const retrieval: Record<string, RetrievalDeclaration> = {};
    for (const id of retrievalIds ?? []) {
        const entry = scenarios[id];
        if (!isRecord(entry)) {
            problems.push(`scenarios.${id} is missing`);
            continue;
        }
        const retrievalEntry = entry.retrieval;
        if (!isRecord(retrievalEntry)) {
            problems.push(`scenarios.${id}.retrieval is missing`);
            continue;
        }
        if (
            typeof retrievalEntry.note !== "string" ||
            retrievalEntry.note.trim() === ""
        ) {
            problems.push(`scenarios.${id}.retrieval.note must be nonblank`);
            continue;
        }
        const preservation = entry.preservation;
        const facts = isRecord(preservation)
            ? stringArray(
                  Array.isArray(preservation.facts)
                      ? preservation.facts.map((fact) =>
                            isRecord(fact) ? fact.id : undefined,
                        )
                      : undefined,
              )
            : [];
        if (facts === undefined) {
            problems.push(
                `scenarios.${id}.preservation.facts must carry nonblank ids`,
            );
            continue;
        }
        retrieval[id] = {
            note: retrievalEntry.note,
            facts: facts ?? [],
        };
    }
    if (problems.length > 0 || recording === undefined) {
        return { problems };
    }
    return {
        declarations: { recording, retrieval },
        problems,
    };
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
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            problems.push(`journal line ${String(index + 1)} is not JSON`);
            continue;
        }
        if (!isRecord(value) || !isRecord(value.input)) {
            problems.push(`journal line ${String(index + 1)} has no input`);
            continue;
        }
        const input = value.input;
        const add = isRecord(input.add) ? input.add : undefined;
        const verb: DocsOperation["verb"] = add
            ? "add"
            : typeof input.read === "string"
              ? "read"
              : typeof input.search === "string"
                ? "search"
                : input.check !== undefined
                  ? "check"
                  : "help";
        const target =
            typeof input.read === "string"
                ? input.read
                : add !== undefined && typeof add.path === "string"
                  ? add.path
                  : null;
        operations.push({
            status: typeof value.status === "string" ? value.status : "unknown",
            surface:
                typeof value.surface === "string" ? value.surface : "unknown",
            verb,
            target,
            line,
        });
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

/** The judge's retrieval state, from the loaded assessment. */
function judgeRetrieval(
    record: TrialRecord,
): { state: string | null; quote: string | null } {
    const retrieval = record.assessment.retrieval;
    if (retrieval.state === "available") {
        return { state: retrieval.value.state, quote: retrieval.value.quote };
    }
    return { state: null, quote: null };
}

/**
 * Measure one trial against the declared opportunities.
 * @param record The loaded trial record.
 * @param declarations The validated declarations.
 * @returns The trial measures.
 */
export function measureTrial(
    record: TrialRecord,
    declarations: MeasureDeclarations,
    arm: string,
): TrialMeasures {
    const { scenario, stamp } = {
        scenario: record.identity.scenario,
        stamp: record.identity.stamp,
    };
    const journal = record.artefacts.docsOperations;
    const parsed =
        journal.state === "available"
            ? parseOperations(journal.value)
            : undefined;
    const operations = parsed?.operations ?? [];
    const gate =
        record.gate.state === "available" ? record.gate.value.status : null;
    const outcome = record.assessment.outcome ?? null;
    const primary = record.primary.status;
    const recordingEligible = declarations.recording.includes(scenario);
    const retrievalDeclaration = declarations.retrieval[scenario];
    const retrievalEligible = retrievalDeclaration !== undefined;

    const completedAdds = operations.filter(
        (operation) =>
            operation.verb === "add" && operation.status === "completed",
    );
    const failedAdds = operations.filter(
        (operation) =>
            operation.verb === "add" && operation.status !== "completed",
    );

    let disposition: RecordingMeasure["disposition"] = "not-eligible";
    let success = false;
    const recordingEvidence: string[] = [];
    if (recordingEligible) {
        if (gate === "blocked") {
            disposition = "gate-blocked";
            recordingEvidence.push(
                `gate blocked: ${record.gate.state === "available" ? String(record.gate.value.reason) : "unknown"}`,
            );
        } else if (completedAdds.length > 0) {
            if (outcome === "useful-create" || outcome === "useful-update") {
                if (gate === "pass") {
                    disposition = "verified-write";
                    success = true;
                } else {
                    disposition = "gate-blocked";
                }
            } else if (outcome === null) {
                disposition = "unknown";
                recordingEvidence.push(
                    "a completed plugin write exists but no judgement was recorded",
                );
            } else {
                disposition = "no-write";
                recordingEvidence.push(
                    `judgement recorded ${outcome} for a completed plugin write`,
                );
            }
        } else if (parsed === undefined) {
            disposition = "unknown";
            recordingEvidence.push(
                "no readable docs-operation journal; a write cannot be attributed",
            );
        } else if (failedAdds.length > 0) {
            disposition = "tool-error";
            recordingEvidence.push("a docs add operation failed");
        } else if (
            (outcome === "useful-create" || outcome === "useful-update") &&
            gate === "pass"
        ) {
            disposition = "filesystem-only";
            recordingEvidence.push(
                "the documentation surface changed and passed the gate, but no completed docs add operation was journaled",
            );
        } else {
            disposition = "no-write";
        }
    }

    let retrievalState: RetrievalMeasure["state"] = "not-eligible";
    const retrievalTrace: string[] = [];
    const retrievalEvidence: string[] = [];
    let read = false;
    let judgeState: string | null = null;
    if (retrievalEligible) {
        const note = retrievalDeclaration.note;
        const reads = operations.filter(
            (operation) =>
                operation.verb === "read" &&
                operation.status === "completed" &&
                operation.target !== null &&
                targetsNote(operation.target, note),
        );
        read = reads.length > 0;
        retrievalTrace.push(...reads.map((operation) => operation.line));
        const judge = judgeRetrieval(record);
        judgeState = judge.state;
        if (journal.state !== "available") {
            retrievalState = "unknown";
            retrievalEvidence.push(
                `docs-operation journal is ${journal.state}; attribution is unknown`,
            );
        } else if (!read) {
            retrievalState = "miss";
            retrievalEvidence.push(
                `no completed read of ${note} was attributed to the session`,
            );
        } else if (judge.state === null) {
            retrievalState = "unknown";
            retrievalEvidence.push(
                "an attributable read exists but no retrieval judgement was recorded",
            );
        } else if (judge.state === "applied" && primary === "pass") {
            retrievalState = "applied";
            retrievalEvidence.push(
                `judge applied the note: ${judge.quote ?? "(no quote)"}`,
            );
        } else if (judge.state === "applied" && primary !== "pass") {
            retrievalState = "unknown";
            retrievalEvidence.push(
                `judge reports applied but the independent primary check is ${primary}`,
            );
        } else if (judge.state === "unknown") {
            retrievalState = "unknown";
        } else {
            retrievalState = "miss";
            retrievalEvidence.push(`judge recorded ${judge.state}`);
        }
    }

    return {
        stamp,
        scenario,
        arm,
        recording: {
            eligible: recordingEligible,
            disposition,
            success,
            outcome,
            gate,
            writes: completedAdds.map((operation) => operation.line),
            evidence: recordingEvidence,
        },
        retrieval: {
            eligible: retrievalEligible,
            state: retrievalState,
            read,
            judgeState,
            note: retrievalDeclaration?.note ?? null,
            trace: retrievalTrace,
            evidence: retrievalEvidence,
        },
    };
}

/** Empty counts for one opportunity type. */
function emptyCounts(): {
    success: number;
    miss: number;
    unknown: number;
    dispositions: Record<string, number>;
} {
    return { success: 0, miss: 0, unknown: 0, dispositions: {} };
}

/**
 * Summarise the measures per arm.
 * @param trials The trial measures.
 * @param planned The frozen slots.
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
            if (trial.recording.eligible) {
                recording.dispositions[trial.recording.disposition] =
                    (recording.dispositions[trial.recording.disposition] ?? 0) +
                    1;
                if (trial.recording.success) recording.success += 1;
                else if (trial.recording.disposition === "unknown")
                    recording.unknown += 1;
                else recording.miss += 1;
            }
            if (trial.retrieval.eligible) {
                if (trial.retrieval.state === "applied") retrieval.success += 1;
                else if (trial.retrieval.state === "unknown")
                    retrieval.unknown += 1;
                else retrieval.miss += 1;
            }
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
                states: retrieval.dispositions,
            },
        };
    }
    return result;
}

/**
 * The personal-trial screen. The utility threshold is one component; the
 * opportunity counts and quality checks decide the recommendation alongside
 * it.
 * @param input The frozen decision inputs.
 * @returns The recommendation and every criterion's reason.
 */
export function personalTrialDecision(input: {
    controlArm: string;
    candidateArm: string;
    measures: Record<string, ArmMeasureSummary>;
    counts: Record<string, AccountingCounts>;
    guardrails: { status: string; detail: string };
    coverage: { status: string; detail: string };
    utilityThreshold: {
        status: string;
        lead: number | null;
        interval: { low: number; high: number } | null;
    };
}): PersonalTrialDecision {
    const reasons: string[] = [];
    const control = input.measures[input.controlArm];
    const candidate = input.measures[input.candidateArm];
    const utilityThreshold = {
        component: "utility-threshold" as const,
        status: input.utilityThreshold.status,
        lead: input.utilityThreshold.lead,
        interval: input.utilityThreshold.interval,
        note: "One component only: a zero-delta 'qualified' at threshold 0 is not the personal-trial recommendation.",
    };
    if (control === undefined || candidate === undefined) {
        return {
            recommendation: "inconclusive",
            reasons: ["an arm has no opportunity summary"],
            utilityThreshold,
        };
    }
    if (input.coverage.status !== "pass") {
        return {
            recommendation: "inconclusive",
            reasons: [`coverage: ${input.coverage.detail}`],
            utilityThreshold,
        };
    }

    const controlCountsForPrimary = input.counts[input.controlArm];
    const candidateCountsForPrimary = input.counts[input.candidateArm];
    if (
        (controlCountsForPrimary?.primary.unknown ?? 0) > 0 ||
        (candidateCountsForPrimary?.primary.unknown ?? 0) > 0
    ) {
        return {
            recommendation: "inconclusive",
            reasons: [
                "a primary-task result is unknown and could change the pass-count criterion",
            ],
            utilityThreshold,
        };
    }
    const recording = {
        control: control.recording.success,
        candidate: candidate.recording.success,
        controlUnknown: control.recording.unknown,
        candidateUnknown: candidate.recording.unknown,
    };
    const retrieval = {
        control: control.retrieval.applied,
        candidate: candidate.retrieval.applied,
        controlUnknown: control.retrieval.unknown,
        candidateUnknown: candidate.retrieval.unknown,
    };
    const extraKnown =
        candidate.recording.success >= control.recording.success + 1 ||
        candidate.retrieval.applied >= control.retrieval.applied + 1;
    const neitherLowerKnown =
        candidate.recording.success >= control.recording.success &&
        candidate.retrieval.applied >= control.retrieval.applied;
    const neitherLowerRobust =
        candidate.recording.success >=
            control.recording.success + control.recording.unknown &&
        candidate.retrieval.applied >=
            control.retrieval.applied + control.retrieval.unknown;
    const impossibleExtra =
        candidate.recording.success + candidate.recording.unknown <
            control.recording.success + 1 &&
        candidate.retrieval.applied + candidate.retrieval.unknown <
            control.retrieval.applied + 1;

    if (control.recording.unknown > 0 || candidate.recording.unknown > 0) {
        // Unknowns can only help the candidate or the control; decide whether
        // the interval already settles the opportunity criterion.
        if (!(extraKnown && neitherLowerRobust) && !impossibleExtra) {
            return {
                recommendation: "inconclusive",
                reasons: [
                    `recording opportunities have unknown outcomes (control ${String(control.recording.unknown)}, candidate ${String(candidate.recording.unknown)}) that could change the count criterion`,
                ],
                utilityThreshold,
            };
        }
    }
    if (control.retrieval.unknown > 0 || candidate.retrieval.unknown > 0) {
        if (!(extraKnown && neitherLowerRobust) && !impossibleExtra) {
            return {
                recommendation: "inconclusive",
                reasons: [
                    `retrieval opportunities have unknown attribution (control ${String(control.retrieval.unknown)}, candidate ${String(candidate.retrieval.unknown)}) that could change the count criterion`,
                ],
                utilityThreshold,
            };
        }
    }

    reasons.push(
        `recording: control ${String(recording.control)}/${String(control.recording.planned)}, candidate ${String(recording.candidate)}/${String(candidate.recording.planned)} (unknown control ${String(recording.controlUnknown)}, candidate ${String(recording.candidateUnknown)})`,
    );
    reasons.push(
        `retrieval: control ${String(retrieval.control)}/${String(control.retrieval.planned)}, candidate ${String(retrieval.candidate)}/${String(candidate.retrieval.planned)} (unknown control ${String(retrieval.controlUnknown)}, candidate ${String(retrieval.candidateUnknown)})`,
    );

    if (!extraKnown || !neitherLowerKnown) {
        return {
            recommendation: "no-promotion",
            reasons: [
                ...reasons,
                "the candidate has no additional successful recording or applied retrieval with neither count lower (a tie gives no promotion)",
            ],
            utilityThreshold,
        };
    }
    reasons.push(
        "the candidate has at least one additional opportunity with neither count lower",
    );

    const controlCounts = input.counts[input.controlArm];
    const candidateCounts = input.counts[input.candidateArm];
    if (controlCounts === undefined || candidateCounts === undefined) {
        return {
            recommendation: "inconclusive",
            reasons: [...reasons, "accounting counts are missing for an arm"],
            utilityThreshold,
        };
    }
    if (candidateCounts.utilityTotal < controlCounts.utilityTotal) {
        return {
            recommendation: "no-promotion",
            reasons: [
                ...reasons,
                `weighted utility is lower (control ${String(controlCounts.utilityTotal)}, candidate ${String(candidateCounts.utilityTotal)})`,
            ],
            utilityThreshold,
        };
    }
    if (candidateCounts.primary.pass < controlCounts.primary.pass) {
        return {
            recommendation: "no-promotion",
            reasons: [
                ...reasons,
                `primary passes are lower (control ${String(controlCounts.primary.pass)}, candidate ${String(candidateCounts.primary.pass)})`,
            ],
            utilityThreshold,
        };
    }
    if (
        candidateCounts.outcomes.misleading > controlCounts.outcomes.misleading
    ) {
        return {
            recommendation: "no-promotion",
            reasons: [
                ...reasons,
                `misleading outcomes increased (control ${String(controlCounts.outcomes.misleading)}, candidate ${String(candidateCounts.outcomes.misleading)})`,
            ],
            utilityThreshold,
        };
    }
    if (input.guardrails.status === "breached") {
        return {
            recommendation: "no-promotion",
            reasons: [
                ...reasons,
                `a candidate guardrail is breached: ${input.guardrails.detail}`,
            ],
            utilityThreshold,
        };
    }
    if (input.guardrails.status === "unresolved") {
        return {
            recommendation: "inconclusive",
            reasons: [
                ...reasons,
                `a candidate guardrail is unresolved: ${input.guardrails.detail}`,
            ],
            utilityThreshold,
        };
    }
    return {
        recommendation: "personal-trial",
        reasons: [
            ...reasons,
            "weighted utility and primary passes are not lower, no new misleading outcome, and the candidate guardrails are clean",
        ],
        utilityThreshold,
    };
}
