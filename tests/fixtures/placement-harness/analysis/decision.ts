/**
 * Decision evaluation for the analysis framework.
 *
 * The frozen selection rule is evaluated as three separate limbs — assessment
 * coverage, the utility threshold and the non-compensable guardrails — and one
 * overall outcome. Missing rules report "not defined" instead of inventing
 * defaults; an unknown limb can prevent qualification without proving that
 * the candidate failed the performance threshold.
 */
import type { AccountingCounts } from "./accounting.ts";
import {
    differenceInterval,
    intervalFromCounts,
    type Interval,
} from "./bounds.ts";
import type { GuardrailArmSummary } from "./guardrails.ts";
import type { SelectionSpec } from "./model.ts";

/** The coverage limb. */
export interface CoverageLimb {
    /** Whether the required coverage is complete. */
    status: "pass" | "fail" | "not-applicable" | "not-defined";
    /** The observed documented/planned coverage, rendered for reports. */
    detail: string;
}

/** The utility threshold limb. */
export interface ThresholdLimb {
    /** Whether the candidate's lead meets the threshold. */
    status: "pass" | "fail" | "inconclusive" | "not-defined";
    /** Candidate minus control over the assessed populations, or null. */
    lead: number | null;
    /** The full-population candidate-minus-control interval, when available. */
    interval: Interval | null;
    /** The threshold comparison, rendered for reports. */
    detail: string;
}

/** The guardrail limb for the candidate arm. */
export interface GuardrailLimb {
    /** Whether a non-compensable breach is established or unresolved. */
    status: "clean" | "breached" | "unresolved" | "not-defined";
    /** The breached or unresolved guardrail ids, rendered for reports. */
    detail: string;
}

/** The decision result. */
export interface DecisionResult {
    /** The overall outcome under the declared rule. */
    overall: "qualified" | "not-qualified" | "inconclusive" | "not-defined";
    /** The coverage limb. */
    coverage: CoverageLimb;
    /** The threshold limb. */
    threshold: ThresholdLimb;
    /** The guardrail limb. */
    guardrails: GuardrailLimb;
    /** Human-readable reasons for the non-passing limbs. */
    reasons: string[];
}

/**
 * Build the result for a campaign without a usable declared rule.
 * @param detail Why no rule could be evaluated.
 * @returns The not-defined decision.
 */
function notDefined(detail: string): DecisionResult {
    return {
        overall: "not-defined",
        coverage: { status: "not-defined", detail },
        threshold: {
            status: "not-defined",
            lead: null,
            interval: null,
            detail,
        },
        guardrails: { status: "not-defined", detail },
        reasons: [detail],
    };
}

/**
 * Evaluate the coverage limb against the declared rule.
 * @param selection The declared selection rule.
 * @param control The control arm counts.
 * @param candidate The candidate arm counts.
 * @returns The coverage limb.
 */
function coverageLimb(
    selection: SelectionSpec,
    control: AccountingCounts,
    candidate: AccountingCounts,
): CoverageLimb {
    if (!selection.requireCompleteCoverage) {
        return {
            status: "not-applicable",
            detail: "the rule does not require complete coverage",
        };
    }
    const complete =
        control.documented === control.planned &&
        candidate.documented === candidate.planned;
    return {
        status: complete ? "pass" : "fail",
        detail: `assessment coverage: control ${control.documented}/${control.planned}, candidate ${candidate.documented}/${candidate.planned}`,
    };
}

/**
 * Evaluate the utility threshold limb against the full-population interval.
 * The rule is defined on the full design, so a threshold passes only when
 * every missing-data completion clears it and fails only when none can; a
 * crossing interval is inconclusive. The assessed lead stays descriptive.
 * @param selection The declared selection rule.
 * @param control The control arm counts.
 * @param candidate The candidate arm counts.
 * @returns The threshold limb.
 */
function thresholdLimb(
    selection: SelectionSpec,
    control: AccountingCounts,
    candidate: AccountingCounts,
): ThresholdLimb {
    const delta: Interval = differenceInterval(
        intervalFromCounts(candidate),
        intervalFromCounts(control),
    );
    if (control.assessed === 0 || candidate.assessed === 0) {
        return {
            status: "inconclusive",
            lead: null,
            interval: delta,
            detail: "no fully scored trials to compare",
        };
    }
    const lead = candidate.utilityTotal - control.utilityTotal;
    const status: ThresholdLimb["status"] =
        delta.low >= selection.threshold
            ? "pass"
            : delta.high < selection.threshold
              ? "fail"
              : "inconclusive";
    return {
        status,
        lead,
        interval: delta,
        detail: `lead ${lead === null ? "unknown" : String(lead)}; full-population interval ${delta.low}..${delta.high} vs threshold ${selection.threshold}`,
    };
}

/**
 * Evaluate the guardrail limb over the candidate arm's summaries.
 * @param guardrails The candidate arm's guardrail summaries.
 * @returns The guardrail limb.
 */
function guardrailLimb(
    guardrails: readonly GuardrailArmSummary[],
): GuardrailLimb {
    if (guardrails.length === 0) {
        return {
            status: "not-defined",
            detail: "the campaign declared no guardrails",
        };
    }
    const breached = guardrails
        .filter((summary) => summary.status === "breached")
        .map((summary) => summary.guardrailId);
    if (breached.length > 0) {
        return {
            status: "breached",
            detail: `breached: ${breached.join(", ")}`,
        };
    }
    const unresolved = guardrails
        .filter((summary) => summary.status === "unresolved")
        .map((summary) => summary.guardrailId);
    if (unresolved.length > 0) {
        return {
            status: "unresolved",
            detail: `unresolved: ${unresolved.join(", ")}`,
        };
    }
    return { status: "clean", detail: "no established or unresolved breach" };
}

/**
 * Combine the limbs into the overall outcome.
 * @param coverage The coverage limb.
 * @param threshold The threshold limb.
 * @param guardrails The guardrail limb.
 * @returns The overall outcome.
 */
function overallOf(
    coverage: CoverageLimb,
    threshold: ThresholdLimb,
    guardrails: GuardrailLimb,
): DecisionResult["overall"] {
    if (coverage.status === "fail") return "inconclusive";
    if (guardrails.status === "breached") return "not-qualified";
    if (guardrails.status === "unresolved") return "inconclusive";
    if (threshold.status === "inconclusive") return "inconclusive";
    if (threshold.status === "fail") return "not-qualified";
    return "qualified";
}

/**
 * Evaluate the declared decision rule for a candidate against its control.
 * @param selection The frozen selection rule, or undefined when none was frozen.
 * @param arms The accounting counts keyed by arm id.
 * @param guardrails The candidate arm's guardrail summaries.
 * @returns The three limbs and the overall outcome.
 */
export function evaluateDecision(
    selection: SelectionSpec | undefined,
    arms: Readonly<Record<string, AccountingCounts>>,
    guardrails: readonly GuardrailArmSummary[],
): DecisionResult {
    if (selection === undefined) {
        return notDefined("the campaign froze no selection rule");
    }
    const control = arms[selection.controlArm];
    const candidate = arms[selection.candidateArm];
    if (control === undefined || candidate === undefined) {
        return notDefined(
            `selection names an arm with no accounting: ${selection.controlArm}/${selection.candidateArm}`,
        );
    }
    const coverage = coverageLimb(selection, control, candidate);
    const threshold = thresholdLimb(selection, control, candidate);
    const guardrail = guardrailLimb(guardrails);
    const reasons: string[] = [];
    if (coverage.status === "fail") reasons.push(coverage.detail);
    if (threshold.status === "fail") reasons.push(threshold.detail);
    if (guardrail.status === "breached" || guardrail.status === "unresolved") {
        reasons.push(guardrail.detail);
    }
    return {
        overall: overallOf(coverage, threshold, guardrail),
        coverage,
        threshold,
        guardrails: guardrail,
        reasons,
    };
}
