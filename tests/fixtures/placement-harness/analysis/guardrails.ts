/**
 * Non-compensable guardrail evaluation.
 *
 * Each declared guardrail is evaluated per trial into pass, fail, unknown or
 * not-applicable with its evidence, then summarised per arm. A missing
 * policy record stays unknown, never a false pass; and a textual gate reason
 * can raise an unresolved guardrail but can never establish semantic loss on
 * its own.
 */
import type {
    GuardrailKind,
    GuardrailSpec,
    PreservationFactSpec,
    PreservationInventorySpec,
    ScenarioIdentity,
} from "./model.ts";
import type {
    Loaded,
    PreservationObservation,
    TrialRecord,
} from "./records.ts";

/** One guardrail's state for one trial. */
export type GuardrailStatus = "pass" | "fail" | "unknown" | "not-applicable";

/** One trial's guardrail finding with its evidence. */
export interface GuardrailTrialFinding {
    /** The evaluated status. */
    status: GuardrailStatus;
    /** Evidence lines supporting a failure or an unresolved state. */
    evidence: string[];
}

/** One guardrail's summary for an arm or population. */
export interface GuardrailArmSummary {
    /** The declared guardrail id. */
    guardrailId: string;
    /** The declared guardrail kind. */
    kind: GuardrailKind;
    /** The declared requirement, quoted verbatim. */
    requirement: string;
    /** The population status: breached, unresolved, clean or not applicable. */
    status: "clean" | "breached" | "unresolved" | "not-applicable";
    /** Per-status trial counts. */
    coverage: Record<GuardrailStatus, number>;
    /** Stamp-prefixed evidence lines for failures and unresolved trials. */
    evidence: string[];
}

/** Wording that marks a gate block as touching a protected path. */
const PRESERVATION_BLOCK = /\bpreserv/i;

/** States that keep a still-valid fact alive. */
const RETAINED_STATES: readonly string[] = ["retained", "corrected"];

/**
 * Evaluate a mutation-policy guardrail from the recorded run metadata.
 * @param record The loaded trial record.
 * @returns Pass with no violations, fail with the recorded violations, or unknown.
 */
function mutationFinding(record: TrialRecord): GuardrailTrialFinding {
    if (record.run.state !== "available") {
        return {
            status: "unknown",
            evidence: ["no recorded run metadata for the mutation policy"],
        };
    }
    const violations = record.run.value.policyViolations;
    if (!Array.isArray(violations)) {
        return {
            status: "unknown",
            evidence: ["no recorded policyViolations field (limited evidence)"],
        };
    }
    if (violations.length === 0) return { status: "pass", evidence: [] };
    return {
        status: "fail",
        evidence: violations.map((one) => `outside policy: ${String(one)}`),
    };
}

/**
 * Evaluate one inventory fact's observation into a guardrail outcome.
 * @param fact The configured fact.
 * @param entry The loaded observation, when present.
 * @returns The outcome and an evidence line for failures and unknowns.
 */
function factOutcome(
    fact: PreservationFactSpec,
    entry: Loaded<PreservationObservation> | undefined,
): { status: "pass" | "fail" | "unknown"; line: string } {
    if (entry === undefined || entry.state === "missing") {
        return {
            status: "unknown",
            line: `${fact.id}: no evidence-backed assessment`,
        };
    }
    if (entry.state !== "available") {
        return {
            status: "unknown",
            line: `${fact.id}: unreadable assessment (${entry.state})`,
        };
    }
    const { state, quote } = entry.value;
    const obsolete = fact.obsoleteCurrentPatterns !== undefined;
    if (obsolete) {
        if (state === "removed") return { status: "pass", line: "" };
        if (state === "retained") {
            return {
                status: "fail",
                line: `${fact.id}: obsolete claim retained: ${quote}`,
            };
        }
    } else {
        if (RETAINED_STATES.includes(state))
            return { status: "pass", line: "" };
        if (state === "lost") {
            return {
                status: "fail",
                line: `${fact.id}: valid fact lost: ${quote}`,
            };
        }
    }
    return {
        status: "unknown",
        line: `${fact.id}: unrecognised preservation state ${JSON.stringify(state)}`,
    };
}

/**
 * Evaluate a preservation inventory against the recorded observations.
 * A failure dominates an unknown; an unknown dominates a pass.
 * @param inventory The configured inventory.
 * @param observed The per-fact observations.
 * @returns The aggregate finding.
 */
function inventoryFinding(
    inventory: PreservationInventorySpec,
    observed: Readonly<Record<string, Loaded<PreservationObservation>>>,
): GuardrailTrialFinding {
    const failures: string[] = [];
    const unknowns: string[] = [];
    for (const fact of inventory.facts) {
        const outcome = factOutcome(fact, observed[fact.id]);
        if (outcome.status === "fail") failures.push(outcome.line);
        else if (outcome.status === "unknown") unknowns.push(outcome.line);
    }
    if (failures.length > 0) return { status: "fail", evidence: failures };
    if (unknowns.length > 0) return { status: "unknown", evidence: unknowns };
    return { status: "pass", evidence: [] };
}

/**
 * Evaluate a destructive-loss guardrail for one trial.
 *
 * With a configured inventory the semantic assessment decides. Without one,
 * the guardrail is not applicable — unless a gate block names a preserved
 * path, which raises an unresolved state: the text cannot prove loss, and an
 * authorised rewrite cannot prove safety.
 * @param record The loaded trial record.
 * @param scenario The trial's declared scenario.
 * @returns The finding.
 */
function lossFinding(
    record: TrialRecord,
    scenario: ScenarioIdentity | undefined,
): GuardrailTrialFinding {
    const inventory = scenario?.preservationInventory;
    if (inventory === undefined) {
        const gate = record.gate;
        const blocked =
            gate.state === "available" &&
            gate.value.status === "blocked" &&
            gate.value.reason !== null &&
            PRESERVATION_BLOCK.test(gate.value.reason);
        return blocked && gate.state === "available"
            ? {
                  status: "unknown",
                  evidence: [gate.value.reason ?? "preserve gate block"],
              }
            : { status: "not-applicable", evidence: [] };
    }
    const observed = record.assessment.preservation;
    if (observed.state !== "available") {
        return {
            status: "unknown",
            evidence: ["no preservation assessment recorded"],
        };
    }
    return inventoryFinding(inventory, observed.value);
}

/**
 * Evaluate one declared guardrail for one trial.
 * @param guardrail The declared guardrail.
 * @param record The loaded trial record.
 * @param scenario The trial's declared scenario, when known.
 * @returns The trial finding.
 */
export function evaluateGuardrail(
    guardrail: GuardrailSpec,
    record: TrialRecord,
    scenario: ScenarioIdentity | undefined,
): GuardrailTrialFinding {
    if (guardrail.kind === "mutation-policy") return mutationFinding(record);
    return lossFinding(record, scenario);
}

/**
 * Derive a population's guardrail status from its coverage counts.
 * @param coverage The per-status counts.
 * @returns Breached on any failure, unresolved on any unknown, else clean.
 */
function populationStatus(
    coverage: Record<GuardrailStatus, number>,
): GuardrailArmSummary["status"] {
    if (coverage.fail > 0) return "breached";
    if (coverage.unknown > 0) return "unresolved";
    if (coverage.pass > 0) return "clean";
    return "not-applicable";
}

/**
 * Summarise every declared guardrail over one population.
 * @param guardrails The declared guardrails.
 * @param scenarios The declared scenarios, for inventory lookup.
 * @param trials The loaded trial records in the population.
 * @returns One summary per guardrail, in declared order.
 */
export function summariseGuardrails(
    guardrails: readonly GuardrailSpec[],
    scenarios: readonly ScenarioIdentity[],
    trials: readonly TrialRecord[],
): GuardrailArmSummary[] {
    const scenarioById = new Map(
        scenarios.map((scenario) => [scenario.id, scenario]),
    );
    return guardrails.map((guardrail) => {
        const coverage: Record<GuardrailStatus, number> = {
            pass: 0,
            fail: 0,
            unknown: 0,
            "not-applicable": 0,
        };
        const evidence: string[] = [];
        for (const trial of trials) {
            const finding = evaluateGuardrail(
                guardrail,
                trial,
                scenarioById.get(trial.identity.scenario),
            );
            coverage[finding.status] += 1;
            if (finding.status === "fail" || finding.status === "unknown") {
                evidence.push(
                    ...finding.evidence.map(
                        (line) => `${trial.identity.stamp}: ${line}`,
                    ),
                );
            }
        }
        return {
            guardrailId: guardrail.id,
            kind: guardrail.kind,
            requirement: guardrail.requirement,
            status: populationStatus(coverage),
            coverage,
            evidence,
        };
    });
}
