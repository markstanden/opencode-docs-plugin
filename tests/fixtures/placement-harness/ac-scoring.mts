/**
 * Campaign-level structured scoring for automatic-notetaking trials.
 *
 * The harness's semantic judge answers a case rubric and its deterministic
 * gate answers "was a required write made". A prose comparison needs a
 * third, separate measure: one mutually exclusive documentation outcome per
 * trial, scored by declared utility weights, plus the independent
 * primary-task result. This module is the pure part — prompt construction,
 * strict parsing/validation against the mutation evidence, scoring,
 * sensitivity and the frozen selection rule — so a campaign cannot silently
 * turn a malformed judge answer or a note in a restraint case into a pass.
 *
 * Nothing here calls a model or touches the filesystem.
 */

/** The one documentation outcome a trial receives. */
export type DocumentationOutcome =
    | "useful-create"
    | "useful-update"
    | "transient"
    | "duplicate"
    | "misleading"
    | "none";

/** The scenario whose correction needs a semantic preservation assessment. */
export const PRESERVATION_CASE = "R02";

/** The assessed state of one still-valid fact. */
export type PreservationState = "retained" | "corrected" | "lost";

/** The assessed state of the superseded TLS claim. */
export type ObsoleteClaimState = "removed" | "retained";

/** One fact's evidence-backed preservation finding. */
export interface PreservationFinding {
    /** Whether the fact survived, was corrected, or was lost. */
    state: PreservationState;
    /** The decisive excerpt from the after-trial documents. */
    quote: string;
}

/** The required R02 preservation assessment, one entry per fixed fact. */
export interface PreservationAssessment {
    /** The 10-connection pool cap. */
    poolSize: PreservationFinding;
    /** The 5-second acquire timeout. */
    acquireTimeout: PreservationFinding;
    /** Startup migrations. */
    startupMigrations: PreservationFinding;
    /** The obsolete `sslmode=disable` claim. */
    obsoleteTlsClaim: { state: ObsoleteClaimState; quote: string };
}

/** One configured fact in a scenario-keyed preservation inventory. */
export interface PreservationFactSpec {
    /** Stable fact id, used as the judgement field name. */
    id: string;
    /** Human-readable label for the prompt. */
    label: string;
    /** True when the fact is the superseded claim rather than a still-valid one. */
    obsolete?: boolean;
}

/** A scenario-keyed preservation inventory the judge must assess. */
export interface PreservationSpec {
    /** The facts to assess, in prompt order. */
    facts: PreservationFactSpec[];
}

/** The seeded note and distinctive detail a retrieval assessment is about. */
export interface RetrievalSpec {
    /** Lake-relative path of the seeded note. */
    note: string;
    /** The declared lake holding the note, when the declaration names one. */
    lake?: string;
    /** The actionable detail the task must apply. */
    detail: string;
}

/** The assessed state of a trial's use of a seeded note. */
export type RetrievalState =
    | "applied"
    | "read-not-applied"
    | "search-only"
    | "not-retrieved"
    | "unknown";

/** One trial's retrieval-application finding. */
export interface RetrievalApplication {
    /** Whether the note was retrieved and applied, read only, searched only, etc. */
    state: RetrievalState;
    /** The decisive excerpt, or "(none)". */
    quote: string;
}

/** Everything a judge must state about one trial's documentation. */
export interface AcJudgement {
    /** The one outcome the trial earns. */
    documentationOutcome: DocumentationOutcome;
    /** Why that outcome, naming every mixed component. */
    documentationReason: string;
    /** Decisive excerpts from the resulting documents/evidence. */
    evidence: string[];
    /** The R02 preservation assessment, required only for that scenario. */
    preservation?: PreservationAssessment;
    /** The retrieval-application assessment, when the scenario declares one. */
    retrievalApplication?: RetrievalApplication;
}

/** The mutation facts the judgement is validated against. */
export interface DocState {
    /** Whether any file under the documentation surface changed at all. */
    documentsChanged: boolean;
    /** New Markdown document paths under the documentation surface. */
    createdPaths: string[];
    /** Changed pre-existing Markdown document paths. */
    modifiedPaths: string[];
}

/** Utility weights, frozen before scored sessions. */
export interface UtilityWeights {
    /** Reward for a useful create and a useful update. */
    useful: number;
    /** Penalty for a supported but valueless transient note. */
    transient: number;
    /** Penalty for a duplicate note. */
    duplicate: number;
    /** Penalty for misleading or unsupported documentation. */
    misleading: number;
    /** Penalty for a failed primary task. */
    taskFailure: number;
}

/** The prospective defaults declared by the campaign prompt. */
export const DEFAULT_WEIGHTS: UtilityWeights = {
    useful: 5,
    transient: -1,
    duplicate: -2,
    misleading: -5,
    taskFailure: -5,
};

/** The one documentation outcome a trial receives. */
export const DOCUMENTATION_OUTCOMES: readonly DocumentationOutcome[] = [
    "useful-create",
    "useful-update",
    "transient",
    "duplicate",
    "misleading",
    "none",
];

/** One trial's resolved inputs for scoring. */
export interface ScoredTrial {
    /** The arm the trial belongs to. */
    arm: string;
    /** The scenario it ran. */
    scenario: string;
    /** Whether the trial was planned (a slot in the frozen schedule). */
    planned: boolean;
    /** Whether the session completed with usable evidence. */
    usable: boolean;
    /** The documentation outcome, absent when not assessed. */
    outcome?: DocumentationOutcome | undefined;
    /** The independent primary-check result. */
    primary: "pass" | "fail" | "unknown";
    /** A non-compensable guardrail breach (unauthorised/destructive write). */
    guardrailBreach: boolean;
}

/**
 * Build the arm-blind judge prompt for one trial.
 *
 * Every input is arm-neutral by construction: the task the agent was given,
 * the standing permission, the authoring truth for the scenario, the
 * knowledge-lake documents before and after, the changed paths, the
 * independent primary-check result, the observed docs operations and the
 * final answer. No arm label, candidate description, hypothesis, prior
 * verdict or aggregate result is accepted by this function.
 * @param input The labelled evidence blocks.
 * @param input.taskPrompt The exact task the agent was given.
 * @param input.standingPermission The workspace permission file's contents.
 * @param input.scenarioTruth The scenario's durable-finding facts.
 * @param input.beforeDocs Knowledge-lake documents before the trial.
 * @param input.afterDocs Knowledge-lake documents after the trial.
 * @param input.changedPaths Paths the trial changed.
 * @param input.primary The independent primary-check result.
 * @param input.primary.status The checker's status.
 * @param input.primary.exit Its exit code, or null.
 * @param input.primary.stdout Its captured stdout.
 * @param input.primary.stderr Its captured stderr.
 * @param input.docsOperations Verified docs operations observed.
 * @param input.answer The trial's final answer.
 * @param input.requirePreservation Require the R02 semantic preservation block.
 * @param input.preservationSpec A scenario-keyed preservation inventory.
 * @param input.retrievalSpec A seeded-note retrieval-application assessment.
 * @returns The complete judge prompt.
 */
export function buildAcPrompt(input: {
    taskPrompt: string;
    standingPermission: string;
    scenarioTruth: string;
    beforeDocs: Array<{ path: string; contents: string }>;
    afterDocs: Array<{ path: string; contents: string }>;
    changedPaths: string[];
    primary: {
        status: string;
        exit: number | null;
        stdout: string;
        stderr: string;
    };
    docsOperations: string[];
    answer: string;
    requirePreservation?: boolean;
    preservationSpec?: PreservationSpec;
    retrievalSpec?: RetrievalSpec;
}): string {
    const docs = (entries: Array<{ path: string; contents: string }>) =>
        entries
            .map(
                (entry) =>
                    `- ${entry.path}\n\n\`\`\`\n${entry.contents}\n\`\`\``,
            )
            .join("\n\n") || "(none)";
    const preservation = input.requirePreservation
        ? `
PRESERVATION ASSESSMENT (required for this scenario): the trial corrects an existing note whose other facts stay valid.
Assess each still-valid fact by meaning, not exact wording: a faithful paraphrase, an equivalent number (for example "5000 milliseconds" for 5 seconds), or a clear restatement is "retained"; a changed value is "corrected"; a fact the lake no longer states is "lost".
The obsolete TLS claim is "removed" only when the resulting document no longer asserts it.
Quote the decisive text from the AFTER documents for every entry, or write "(absent)" when the text is gone.
If any still-valid fact is lost, the documentation outcome must be "misleading".
`
        : input.preservationSpec
          ? `
PRESERVATION ASSESSMENT (required for this scenario): the trial corrects an existing note whose other facts stay valid.
Assess each still-valid fact by meaning, not exact wording: a faithful paraphrase, an equivalent restatement or the same value is "retained"; a changed value is "corrected"; a fact the lake no longer states is "lost".
The obsolete claim (${input.preservationSpec.facts
                .filter((fact) => fact.obsolete === true)
                .map((fact) => fact.label)
                .join(
                    ", ",
                )}) is "removed" only when the resulting document no longer asserts it.
Quote the decisive text from the AFTER documents for every entry, or write "(absent)" when the text is gone.
If any still-valid fact is lost, the documentation outcome must be "misleading".
`
          : "";
    const retrieval = input.retrievalSpec
        ? `
RETRIEVAL ASSESSMENT (required for this scenario): ${input.retrievalSpec.lake === undefined ? `the seeded note \`${input.retrievalSpec.note}\`` : `the seeded note \`${input.retrievalSpec.lake}/${input.retrievalSpec.note}\` in the declared lake "${input.retrievalSpec.lake}"`} carries the project-specific detail: ${input.retrievalSpec.detail}
Decide whether the trial's work applied that detail, using the final answer and the observed docs operations above:
- "applied": an attributable docs operation retrieved the note and the work uses its detail;
- "read-not-applied": the note was retrieved but the work does not apply the detail;
- "search-only": only a search or help operation occurred, with no read of the note;
- "not-retrieved": no attributable docs operation retrieved the note;
- "unknown": the evidence cannot tell.
Quote the decisive line from the work or the note, or write "(none)".
`
        : "";
    const retrievalShape = input.retrievalSpec
        ? ',"retrievalApplication":{"state":"applied"|"read-not-applied"|"search-only"|"not-retrieved"|"unknown","quote":"..."}'
        : "";
    const preservationShape = input.requirePreservation
        ? `,"preservation":{"poolSize":{"state":"retained"|"corrected"|"lost","quote":"..."},"acquireTimeout":{"state":"retained"|"corrected"|"lost","quote":"..."},"startupMigrations":{"state":"retained"|"corrected"|"lost","quote":"..."},"obsoleteTlsClaim":{"state":"removed"|"retained","quote":"..."}}`
        : input.preservationSpec
          ? `,"preservation":{${input.preservationSpec.facts
                .map(
                    (fact) =>
                        `"${fact.id}":{"state":${
                            fact.obsolete === true
                                ? '"removed"|"retained"'
                                : '"retained"|"corrected"|"lost"'
                        },"quote":"..."}`,
                )
                .join(",")}}`
          : "";
    const returnShape = `{"documentationOutcome":"useful-create"|"useful-update"|"transient"|"duplicate"|"misleading"|"none","documentationReason":"...","evidence":["..."]${preservationShape}${retrievalShape}}`;
    return `Score ONE completed engineering trial's documentation outcome. Return ONE JSON object and nothing else.

An agent was given the task below in a small synthetic repository. It had standing permission to create or update documentation in the repository knowledge lake, but was never asked to document anything. Some tasks contain a durable, reusable finding worth preserving; others do not.

TASK:
${input.taskPrompt}

STANDING PERMISSION (a workspace file):
${input.standingPermission}

SCENARIO TRUTH (repository-authored facts for this scenario):
${input.scenarioTruth}

KNOWLEDGE-LAKE DOCUMENTS BEFORE THE TRIAL:
${docs(input.beforeDocs)}

KNOWLEDGE-LAKE DOCUMENTS AFTER THE TRIAL:
${docs(input.afterDocs)}

PATHS CHANGED DURING THE TRIAL:
${input.changedPaths.length > 0 ? input.changedPaths.map((path) => `- ${path}`).join("\n") : "(none)"}

INDEPENDENT PRIMARY-TASK CHECK (run by the harness, not by the agent; authoritative for the practical task):
- status: ${input.primary.status}
- exit: ${String(input.primary.exit)}
- stdout:
${input.primary.stdout}
- stderr:
${input.primary.stderr}

OBSERVED DOCS OPERATIONS (verified completions only):
${input.docsOperations.length > 0 ? input.docsOperations.map((line) => `- ${line}`).join("\n") : "(none)"}

FINAL ANSWER:
${input.answer}

Choose exactly ONE documentation outcome:
- "useful-create": a needed, accurate, supported, appropriately placed durable addition that existing coverage lacked.
- "useful-update": a needed, accurate correction or material extension of an existing document, preserving its other valid content.
- "transient": a supported, harmless note with no useful future value (for example one-off session state).
- "duplicate": unnecessary repetition of existing coverage without material new value, including a gratuitous update that adds no fact.
- "misleading": a materially incorrect or unsupported claim, or a repo-local finding generalised beyond its evidence.
- "none": no documentation was created or changed. State in the reason whether this was appropriate restraint or a missed useful opportunity, judged against the scenario truth.

Rules:
- Judge the resulting documents and the evidence, never the final answer's claims about what was written.
- If a document changed, do not answer "none"; if nothing changed, answer "none".
- Classify mixed output by its most adverse component and name every component in the reason.
- Do not reward volume or effort; one trial earns at most one documentation outcome.
- The primary-task result is given, not yours to re-decide.
${preservation}${retrieval}
Return exactly:
${returnShape}`;
}

/** Pull the one JSON object out of a judge's prose, if any. */
export function parseAcJudgement(text: string): {
    value?: Record<string, unknown>;
    problems: string[];
} {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
        return { problems: ["no JSON object in output"] };
    }
    try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value)
        ) {
            return { problems: ["verdict is not a JSON object"] };
        }
        return { value: value as Record<string, unknown>, problems: [] };
    } catch {
        return { problems: ["verdict is not valid JSON"] };
    }
}

/**
 * The machine-readable reason one judge attempt produced no usable verdict.
 *
 * A complete-but-malformed answer (`json-syntax`, `schema`, `semantic`) is a
 * model-output failure; `empty-or-truncated` means the capture itself cannot
 * establish a final assessed response, so it is never eligible for a
 * registered recovery. `transport-or-process` is assigned by the caller that
 * observed the process exit.
 */
export type JudgeFailureClass =
    | "transport-or-process"
    | "empty-or-truncated"
    | "json-syntax"
    | "schema"
    | "semantic";

/**
 * Classify a non-usable parsed answer.
 *
 * Completion refers to the final assessed response: the caller must establish
 * that the trail terminated on the final text part and that the text is
 * nonblank. When completion cannot be established the class is
 * `empty-or-truncated` regardless of the parse failure, because a recovery
 * must never be dispatched against unknown capture.
 * @param input The completion fact, the parsed value (absent on parse failure)
 *   and the recorded problems.
 * @returns The failure class.
 */
export function judgeFailureClass(input: {
    complete: boolean;
    value?: Record<string, unknown> | undefined;
    problems: string[];
}): Exclude<JudgeFailureClass, "transport-or-process"> {
    if (!input.complete) return "empty-or-truncated";
    if (input.value === undefined) return "json-syntax";
    if (judgementSchemaProblems(input.value).length > 0) return "schema";
    return "semantic";
}

/** Schema problems for one parsed judgement: fields, enums and evidence. */
export function judgementSchemaProblems(value: Record<string, unknown>): string[] {
    const problems: string[] = [];
    const outcome = value.documentationOutcome;
    if (
        typeof outcome !== "string" ||
        !DOCUMENTATION_OUTCOMES.includes(outcome as DocumentationOutcome)
    ) {
        problems.push(
            `documentationOutcome must be one of ${DOCUMENTATION_OUTCOMES.join("|")}`,
        );
    }
    if (
        typeof value.documentationReason !== "string" ||
        value.documentationReason.trim() === ""
    ) {
        problems.push("documentationReason must be a nonblank string");
    }
    if (!Array.isArray(value.evidence)) {
        problems.push("evidence must be an array");
        return problems;
    }
    if (
        value.evidence.length === 0 ||
        value.evidence.some(
            (entry) => typeof entry !== "string" || entry.trim() === "",
        )
    ) {
        problems.push("evidence must contain at least one nonblank string");
    }
    return problems;
}

/** Whether a value is a plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The still-valid facts the R02 assessment must judge. */
const PRESERVATION_FACTS = [
    "poolSize",
    "acquireTimeout",
    "startupMigrations",
] as const;

/** Allowed states for a still-valid fact. */
const PRESERVATION_STATES: readonly PreservationState[] = [
    "retained",
    "corrected",
    "lost",
];

/** Allowed states for a retrieval-application finding. */
export const RETRIEVAL_STATES: readonly RetrievalState[] = [
    "applied",
    "read-not-applied",
    "search-only",
    "not-retrieved",
    "unknown",
];

/** Problems with one still-valid fact's preservation finding. */
function factProblems(label: string, entry: unknown): string[] {
    if (!isPlainObject(entry)) {
        return [`preservation.${label} must be an object`];
    }
    const problems: string[] = [];
    if (
        typeof entry.state !== "string" ||
        !PRESERVATION_STATES.includes(entry.state as PreservationState)
    ) {
        problems.push(
            `preservation.${label}.state must be one of ${PRESERVATION_STATES.join("|")}`,
        );
    }
    if (typeof entry.quote !== "string" || entry.quote.trim() === "") {
        problems.push(`preservation.${label}.quote must be a nonblank string`);
    }
    return problems;
}

/** Problems with the obsolete TLS claim's preservation finding. */
function obsoleteProblems(entry: unknown): string[] {
    if (!isPlainObject(entry)) {
        return ["preservation.obsoleteTlsClaim must be an object"];
    }
    const problems: string[] = [];
    if (entry.state !== "removed" && entry.state !== "retained") {
        problems.push(
            'preservation.obsoleteTlsClaim.state must be "removed" or "retained"',
        );
    }
    if (typeof entry.quote !== "string" || entry.quote.trim() === "") {
        problems.push(
            "preservation.obsoleteTlsClaim.quote must be a nonblank string",
        );
    }
    return problems;
}

/** Whether one fact entry records destructive loss. */
function lostFact(entry: unknown): boolean {
    return isPlainObject(entry) && entry.state === "lost";
}

/**
 * Schema problems for one inventory fact's finding.
 * @param fact The declared fact.
 * @param entry The judgement's entry for it.
 * @returns The problems and whether the entry reports loss.
 */
function genericFactProblems(
    fact: PreservationFactSpec,
    entry: unknown,
): { problems: string[]; lost: boolean } {
    if (!isPlainObject(entry)) {
        return {
            problems: [`preservation.${fact.id} must be an object`],
            lost: false,
        };
    }
    const allowed =
        fact.obsolete === true ? ["removed", "retained"] : PRESERVATION_STATES;
    const problems: string[] = [];
    if (
        typeof entry.state !== "string" ||
        !(allowed as readonly string[]).includes(entry.state)
    ) {
        problems.push(
            `preservation.${fact.id}.state must be one of ${allowed.join("|")}`,
        );
    }
    if (typeof entry.quote !== "string" || entry.quote.trim() === "") {
        problems.push(
            `preservation.${fact.id}.quote must be a nonblank string`,
        );
    }
    return {
        problems,
        lost: fact.obsolete !== true && entry.state === "lost",
    };
}

/**
 * Problems raised when an inventory reports destructive loss.
 * @param value The parsed judgement.
 * @param state The mutation facts for the trial.
 * @param lost The lost fact ids.
 * @returns The outcome-consistency problems.
 */
function lostFactProblems(
    value: Record<string, unknown>,
    state: DocState,
    lost: string[],
): string[] {
    if (lost.length === 0) return [];
    const problems: string[] = [];
    if (value.documentationOutcome !== "misleading") {
        problems.push(
            `preservation reports a lost valid fact (${lost.join(", ")}); documentationOutcome must be "misleading"`,
        );
    }
    if (!state.documentsChanged) {
        problems.push(
            "preservation reports a lost valid fact but no documentation document changed",
        );
    }
    return problems;
}

function genericPreservationProblems(
    value: Record<string, unknown>,
    state: DocState,
    spec: PreservationSpec,
): string[] {
    if (!isPlainObject(value.preservation)) {
        return ["preservation must be an object for this scenario"];
    }
    const preservation = value.preservation;
    const problems: string[] = [];
    const lost: string[] = [];
    for (const fact of spec.facts) {
        const outcome = genericFactProblems(fact, preservation[fact.id]);
        problems.push(...outcome.problems);
        if (outcome.lost) lost.push(fact.id);
    }
    return [...problems, ...lostFactProblems(value, state, lost)];
}

/**
 * Problems with the optional retrieval-application finding.
 * @param value The parsed judgement.
 * @returns The problems; empty means a usable assessment.
 */
function retrievalProblems(value: Record<string, unknown>): string[] {
    const retrieval = value.retrievalApplication;
    if (!isPlainObject(retrieval)) {
        return ["retrievalApplication must be an object for this scenario"];
    }
    const problems: string[] = [];
    if (
        typeof retrieval.state !== "string" ||
        !RETRIEVAL_STATES.includes(retrieval.state as RetrievalState)
    ) {
        problems.push(
            `retrievalApplication.state must be one of ${RETRIEVAL_STATES.join("|")}`,
        );
    }
    if (typeof retrieval.quote !== "string" || retrieval.quote.trim() === "") {
        problems.push("retrievalApplication.quote must be a nonblank string");
    }
    return problems;
}

/** Problems with the required R02 semantic preservation assessment. */
function preservationProblems(
    value: Record<string, unknown>,
    state: DocState,
): string[] {
    if (!isPlainObject(value.preservation)) {
        return ["preservation must be an object for this scenario"];
    }
    const preservation = value.preservation;
    const problems = [
        ...PRESERVATION_FACTS.flatMap((fact) =>
            factProblems(fact, preservation[fact]),
        ),
        ...obsoleteProblems(preservation.obsoleteTlsClaim),
    ];
    const lost = PRESERVATION_FACTS.filter((fact) =>
        lostFact(preservation[fact]),
    );
    if (lost.length > 0) {
        if (value.documentationOutcome !== "misleading") {
            problems.push(
                `preservation reports a lost valid fact (${lost.join(", ")}); documentationOutcome must be "misleading"`,
            );
        }
        if (!state.documentsChanged) {
            problems.push(
                "preservation reports a lost valid fact but no documentation document changed",
            );
        }
    }
    return problems;
}

/** The single evidence contradiction between an outcome and the record. */
function outcomeEvidenceProblem(
    decided: DocumentationOutcome,
    state: DocState,
): string | null {
    if (!state.documentsChanged && decided !== "none") {
        return `judged "${decided}" but no documentation document changed`;
    }
    if (state.documentsChanged && decided === "none") {
        return 'judged "none" but a documentation document changed';
    }
    if (decided === "useful-create" && state.createdPaths.length === 0) {
        return 'judged "useful-create" but no document was created';
    }
    if (decided === "useful-update" && state.modifiedPaths.length === 0) {
        return 'judged "useful-update" but no existing document was modified';
    }
    return null;
}

/**
 * Check a parsed judgement against its schema AND the recorded mutation
 * evidence. A judgement that contradicts the evidence is invalid, never
 * silently corrected: "none" with a changed document, or a create with no
 * created document, means the judge did not read the evidence.
 * @param value The parsed judge object.
 * @param state The mutation facts for the trial.
 * @param options Preservation and retrieval requirements.
 * @param options.requirePreservation True for the R02 correction scenario.
 * @param options.preservationSpec A scenario-keyed preservation inventory.
 * @param options.retrieval True when the scenario needs a retrieval finding.
 * @returns The problems; empty means a usable judgement.
 */
export function validateAcJudgement(
    value: Record<string, unknown>,
    state: DocState,
    options: {
        requirePreservation?: boolean;
        preservationSpec?: PreservationSpec;
        retrieval?: boolean;
    } = {},
): string[] {
    const schema = judgementSchemaProblems(value);
    if (schema.length > 0) return schema;
    const problems: string[] = [];
    const contradiction = outcomeEvidenceProblem(
        value.documentationOutcome as DocumentationOutcome,
        state,
    );
    if (contradiction !== null) problems.push(contradiction);
    if (options.requirePreservation) {
        problems.push(...preservationProblems(value, state));
    } else if (options.preservationSpec) {
        problems.push(
            ...genericPreservationProblems(
                value,
                state,
                options.preservationSpec,
            ),
        );
    }
    if (options.retrieval) {
        problems.push(...retrievalProblems(value));
    }
    return problems;
}

/** The documentation component of one trial's utility. */
export function documentationScore(
    outcome: DocumentationOutcome,
    weights: UtilityWeights = DEFAULT_WEIGHTS,
): number {
    switch (outcome) {
        case "useful-create":
        case "useful-update":
            return weights.useful;
        case "transient":
            return weights.transient;
        case "duplicate":
            return weights.duplicate;
        case "misleading":
            return weights.misleading;
        case "none":
            return 0;
    }
}

/**
 * The closed documentation interval for an unassessed outcome: the lowest and
 * highest score any allowed outcome can earn under the declared weights.
 * Derived from the policy, never assumed — a custom duplicate penalty can sit
 * below the misleading penalty, and the interval must follow it.
 * @param weights The frozen utility weights.
 * @returns The lowest and highest possible documentation scores.
 */
export function documentationRange(weights: UtilityWeights = DEFAULT_WEIGHTS): {
    low: number;
    high: number;
} {
    const scores = DOCUMENTATION_OUTCOMES.map((outcome) =>
        documentationScore(outcome, weights),
    );
    return { low: Math.min(...scores), high: Math.max(...scores) };
}

/** The task component's closed bounds for a known or unknown primary result. */
function taskBounds(
    primary: ScoredTrial["primary"],
    weights: UtilityWeights,
): { low: number; high: number } {
    if (primary === "pass") return { low: 0, high: 0 };
    if (primary === "fail") {
        return { low: weights.taskFailure, high: weights.taskFailure };
    }
    return { low: weights.taskFailure, high: 0 };
}

/**
 * One trial's utility, or a closed interval when a component is unknown.
 *
 * An unassessed documentation outcome contributes nothing and is reported as
 * missing, never as zero. The documentation interval is the full range of
 * allowed outcome scores under the declared weights; the task interval
 * retains whatever the primary check already established, so a known pass
 * does not widen the bound as though it too were unknown.
 */
export function trialUtility(
    trial: ScoredTrial,
    weights: UtilityWeights = DEFAULT_WEIGHTS,
): { score: number; low: number; high: number; assessed: boolean } {
    const task = taskBounds(trial.primary, weights);
    if (!trial.usable || trial.outcome === undefined) {
        const range = documentationRange(weights);
        return {
            score: 0,
            low: range.low + task.low,
            high: range.high + task.high,
            assessed: false,
        };
    }
    const documentation = documentationScore(trial.outcome, weights);
    if (trial.primary === "unknown") {
        return {
            score: documentation,
            low: documentation + task.low,
            high: documentation + task.high,
            assessed: false,
        };
    }
    return {
        score: documentation + task.low,
        low: documentation + task.low,
        high: documentation + task.high,
        assessed: true,
    };
}

/** Per-arm aggregate of the frozen trial population. */
export interface ArmSummary {
    /** The arm this summary describes. */
    arm: string;
    /** Planned slots. */
    planned: number;
    /** Slots whose session started. */
    attempted: number;
    /** Slots that completed. */
    completed: number;
    /** Slots with usable evidence. */
    usable: number;
    /** Slots with a usable documentation judgement. */
    assessed: number;
    /** Count of trials per documentation outcome. */
    outcomes: Record<DocumentationOutcome, number>;
    /** Primary checks that passed. */
    primaryPass: number;
    /** Primary checks that failed. */
    primaryFail: number;
    /** Primary checks without a usable result. */
    primaryUnknown: number;
    /** Trials flagged for a non-compensable guardrail breach. */
    guardrailBreaches: number;
    /** Sum of assessed trial utilities. */
    total: number;
    /** Mean over planned slots, or null without a denominator. */
    meanPerPlanned: number | null;
    /** Mean over assessed slots, or null without a denominator. */
    meanPerAssessed: number | null;
    /** Sum of the low bounds of every unassessed planned trial. */
    missingLow: number;
    /** Sum of the high bounds of every unassessed planned trial. */
    missingHigh: number;
}

const emptyOutcomes = (): Record<DocumentationOutcome, number> => ({
    "useful-create": 0,
    "useful-update": 0,
    transient: 0,
    duplicate: 0,
    misleading: 0,
    none: 0,
});

/** Add one trial's outcome and task counts to the summary. */
function countTrial(summary: ArmSummary, trial: ScoredTrial): void {
    if (trial.planned) summary.planned += 1;
    if (trial.usable) {
        summary.completed += 1;
        summary.usable += 1;
    }
    if (trial.outcome !== undefined) summary.outcomes[trial.outcome] += 1;
    if (trial.primary === "pass") summary.primaryPass += 1;
    if (trial.primary === "fail") summary.primaryFail += 1;
    if (trial.primary === "unknown") summary.primaryUnknown += 1;
    if (trial.guardrailBreach) summary.guardrailBreaches += 1;
}

/** Add one trial's utility, keeping unassessed slots as bounds. */
function addTrialUtility(
    summary: ArmSummary,
    trial: ScoredTrial,
    weights: UtilityWeights,
): void {
    const utility = trialUtility(trial, weights);
    if (utility.assessed) {
        summary.assessed += 1;
        summary.total += utility.score;
        return;
    }
    if (!trial.planned) return;
    summary.missingLow += utility.low;
    summary.missingHigh += utility.high;
}

/**
 * Aggregate one arm's trials. Means are reported per planned trial (the
 * pre-registered denominator, with missing trials visible in the bounds) and
 * per assessed trial separately, so an incomplete arm cannot hide behind a
 * smaller denominator.
 * @param trials The arm's planned slots.
 * @param weights The frozen utility weights.
 * @returns The arm summary.
 */
export function summariseArm(
    trials: ScoredTrial[],
    weights: UtilityWeights = DEFAULT_WEIGHTS,
): ArmSummary {
    const summary: ArmSummary = {
        arm: trials[0]?.arm ?? "",
        planned: 0,
        attempted: 0,
        completed: 0,
        usable: 0,
        assessed: 0,
        outcomes: emptyOutcomes(),
        primaryPass: 0,
        primaryFail: 0,
        primaryUnknown: 0,
        guardrailBreaches: 0,
        total: 0,
        meanPerPlanned: null,
        meanPerAssessed: null,
        missingLow: 0,
        missingHigh: 0,
    };
    for (const trial of trials) {
        countTrial(summary, trial);
        addTrialUtility(summary, trial, weights);
    }
    summary.meanPerPlanned =
        summary.planned === 0 ? null : summary.total / summary.planned;
    summary.meanPerAssessed =
        summary.assessed === 0 ? null : summary.total / summary.assessed;
    return summary;
}

/**
 * The frozen finalist rule: a candidate qualifies only with complete
 * assessments for both arms, no guardrail breach, and a default-utility lead
 * of at least the threshold across the compared trials.
 * @param control The control arm summary.
 * @param candidate The candidate arm summary.
 * @param threshold The required lead.
 * @returns Whether the candidate qualifies, and why not when it does not.
 */
export function finalistQualifies(
    control: ArmSummary,
    candidate: ArmSummary,
    threshold: number,
): { qualifies: boolean; reason: string } {
    if (
        control.assessed !== control.planned ||
        candidate.assessed !== candidate.planned
    ) {
        return {
            qualifies: false,
            reason: `incomplete assessment coverage (control ${control.assessed}/${control.planned}, candidate ${candidate.assessed}/${candidate.planned})`,
        };
    }
    if (candidate.guardrailBreaches > 0) {
        return {
            qualifies: false,
            reason: `candidate guardrail breach (${candidate.guardrailBreaches})`,
        };
    }
    const lead = candidate.total - control.total;
    return lead >= threshold
        ? { qualifies: true, reason: `lead ${lead} >= ${threshold}` }
        : { qualifies: false, reason: `lead ${lead} < ${threshold}` };
}

/**
 * Rank the eligible candidates by the frozen order: default utility, then
 * fewer primary-task failures, then fewer misleading outcomes, then fewer
 * description characters, then arm id.
 * @param candidates The candidate summaries with their description lengths.
 * @returns The same list, best first.
 */
export function rankCandidates(
    candidates: Array<{ summary: ArmSummary; characters: number; arm: string }>,
): Array<{ summary: ArmSummary; characters: number; arm: string }> {
    return [...candidates].sort(
        (left, right) =>
            right.summary.total - left.summary.total ||
            left.summary.primaryFail - right.summary.primaryFail ||
            left.summary.outcomes.misleading -
                right.summary.outcomes.misleading ||
            left.characters - right.characters ||
            left.arm.localeCompare(right.arm),
    );
}

/** One sensitivity cell: useful weight × transient penalty. */
export interface SensitivityCell {
    /** The useful create/update weight in this cell. */
    useful: number;
    /** The transient penalty (positive magnitude) in this cell. */
    transient: number;
    /** Total utility per arm. */
    totals: Record<string, number>;
    /** Arms best first. */
    ranking: string[];
}

/**
 * Re-score every arm under the requested weight grid, holding the other
 * penalties fixed at the campaign's declared weights. This explores
 * preferences; it is not nine experiments.
 * @param arms The planned trials, keyed by arm.
 * @param usefulWeights The useful create/update rewards to try.
 * @param transientPenalties The transient penalties to try, as positive
 *   magnitudes applied as negative scores.
 * @param baseWeights The campaign's non-grid weights; defaults to the
 *   prospective defaults so legacy callers keep their frozen baseline.
 * @returns One cell per combination, with totals and the resulting ranking.
 */
export function sensitivity(
    arms: Record<string, ScoredTrial[]>,
    usefulWeights: number[],
    transientPenalties: number[],
    baseWeights: UtilityWeights = DEFAULT_WEIGHTS,
): SensitivityCell[] {
    const cells: SensitivityCell[] = [];
    for (const useful of usefulWeights) {
        for (const transient of transientPenalties) {
            const weights: UtilityWeights = {
                ...baseWeights,
                useful,
                transient: -Math.abs(transient),
            };
            const totals: Record<string, number> = {};
            for (const [arm, trials] of Object.entries(arms)) {
                totals[arm] = summariseArm(trials, weights).total;
            }
            const ranking = Object.keys(totals).sort(
                (left, right) =>
                    (totals[right] ?? 0) - (totals[left] ?? 0) ||
                    left.localeCompare(right),
            );
            cells.push({ useful, transient, totals, ranking });
        }
    }
    return cells;
}
