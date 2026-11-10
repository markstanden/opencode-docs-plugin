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

/** Everything a judge must state about one trial's documentation. */
export interface AcJudgement {
    documentationOutcome: DocumentationOutcome;
    documentationReason: string;
    /** Decisive excerpts from the resulting documents/evidence. */
    evidence: string[];
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

const OUTCOMES: readonly DocumentationOutcome[] = [
    "useful-create",
    "useful-update",
    "transient",
    "duplicate",
    "misleading",
    "none",
];

/** One trial's resolved inputs for scoring. */
export interface ScoredTrial {
    arm: string;
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
 * @returns The complete judge prompt.
 */
export function buildAcPrompt(input: {
    taskPrompt: string;
    standingPermission: string;
    scenarioTruth: string;
    beforeDocs: Array<{ path: string; contents: string }>;
    afterDocs: Array<{ path: string; contents: string }>;
    changedPaths: string[];
    primary: { status: string; exit: number | null; stdout: string; stderr: string };
    docsOperations: string[];
    answer: string;
}): string {
    const docs = (entries: Array<{ path: string; contents: string }>) =>
        entries
            .map((entry) => `- ${entry.path}\n\n\`\`\`\n${entry.contents}\n\`\`\``)
            .join("\n\n") || "(none)";
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

Return exactly:
{"documentationOutcome":"useful-create"|"useful-update"|"transient"|"duplicate"|"misleading"|"none","documentationReason":"...","evidence":["..."]}`;
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
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            return { problems: ["verdict is not a JSON object"] };
        }
        return { value: value as Record<string, unknown>, problems: [] };
    } catch {
        return { problems: ["verdict is not valid JSON"] };
    }
}

/**
 * Check a parsed judgement against its schema AND the recorded mutation
 * evidence. A judgement that contradicts the evidence is invalid, never
 * silently corrected: "none" with a changed document, or a create with no
 * created document, means the judge did not read the evidence.
 * @param value The parsed judge object.
 * @param state The mutation facts for the trial.
 * @returns The problems; empty means a usable judgement.
 */
export function validateAcJudgement(
    value: Record<string, unknown>,
    state: DocState,
): string[] {
    const problems: string[] = [];
    const outcome = value.documentationOutcome;
    if (typeof outcome !== "string" || !OUTCOMES.includes(outcome as DocumentationOutcome)) {
        problems.push(
            `documentationOutcome must be one of ${OUTCOMES.join("|")}`,
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
    } else if (
        value.evidence.length === 0 ||
        value.evidence.some(
            (entry) => typeof entry !== "string" || entry.trim() === "",
        )
    ) {
        problems.push("evidence must contain at least one nonblank string");
    }
    if (problems.length > 0) return problems;

    const decided = outcome as DocumentationOutcome;
    if (!state.documentsChanged && decided !== "none") {
        problems.push(
            `judged "${decided}" but no documentation document changed`,
        );
    }
    if (state.documentsChanged && decided === "none") {
        problems.push("judged \"none\" but a documentation document changed");
    }
    if (decided === "useful-create" && state.createdPaths.length === 0) {
        problems.push("judged \"useful-create\" but no document was created");
    }
    if (decided === "useful-update" && state.modifiedPaths.length === 0) {
        problems.push(
            "judged \"useful-update\" but no existing document was modified",
        );
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
 * One trial's utility, or a closed interval when a component is unknown.
 *
 * An unassessed trial contributes nothing and is reported as missing, never
 * as zero. A known documentation outcome with an unknown primary result is
 * bounded by the worst and best task contributions, so a comparison can say
 * what the missing evidence could change instead of assuming it harmless.
 */
export function trialUtility(
    trial: ScoredTrial,
    weights: UtilityWeights = DEFAULT_WEIGHTS,
): { score: number; low: number; high: number; assessed: boolean } {
    if (!trial.usable || trial.outcome === undefined) {
        return { score: 0, low: weights.misleading + weights.taskFailure, high: weights.useful, assessed: false };
    }
    const documentation = documentationScore(trial.outcome, weights);
    const task =
        trial.primary === "pass"
            ? 0
            : trial.primary === "fail"
              ? weights.taskFailure
              : null;
    if (task === null) {
        return {
            score: documentation,
            low: documentation + weights.taskFailure,
            high: documentation,
            assessed: false,
        };
    }
    return {
        score: documentation + task,
        low: documentation + task,
        high: documentation + task,
        assessed: true,
    };
}

/** Per-arm aggregate of the frozen trial population. */
export interface ArmSummary {
    arm: string;
    planned: number;
    attempted: number;
    completed: number;
    usable: number;
    assessed: number;
    outcomes: Record<DocumentationOutcome, number>;
    primaryPass: number;
    primaryFail: number;
    primaryUnknown: number;
    guardrailBreaches: number;
    total: number;
    meanPerPlanned: number | null;
    meanPerAssessed: number | null;
    /** Sum of the low/high bounds of every unassessed planned trial. */
    missingLow: number;
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
        const utility = trialUtility(trial, weights);
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
        if (utility.assessed) {
            summary.assessed += 1;
            summary.total += utility.score;
        } else if (trial.planned) {
            summary.missingLow += utility.low;
            summary.missingHigh += utility.high;
        }
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
            left.summary.outcomes.misleading - right.summary.outcomes.misleading ||
            left.characters - right.characters ||
            left.arm.localeCompare(right.arm),
    );
}

/** One sensitivity cell: useful weight × transient penalty. */
export interface SensitivityCell {
    useful: number;
    transient: number;
    totals: Record<string, number>;
    ranking: string[];
}

/**
 * Re-score every arm under the requested weight grid, holding the other
 * penalties fixed. This explores preferences; it is not nine experiments.
 * @param arms The planned trials, keyed by arm.
 * @param usefulWeights The useful create/update rewards to try.
 * @param transientPenalties The transient penalties to try, as positive
 *   magnitudes applied as negative scores.
 * @returns One cell per combination, with totals and the resulting ranking.
 */
export function sensitivity(
    arms: Record<string, ScoredTrial[]>,
    usefulWeights: number[],
    transientPenalties: number[],
): SensitivityCell[] {
    const cells: SensitivityCell[] = [];
    for (const useful of usefulWeights) {
        for (const transient of transientPenalties) {
            const weights: UtilityWeights = {
                ...DEFAULT_WEIGHTS,
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
