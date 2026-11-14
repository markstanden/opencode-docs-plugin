/**
 * Opt-in judge recovery: the registered policy, the eligibility decision, the
 * dual spend claim and the checked per-slot selection record.
 *
 * With no registered policy the campaign keeps its historical behaviour: the
 * first unusable assessment stops it. A registered policy permits at most one
 * fresh blind assessment of the same evidence, and only when a complete
 * captured response failed with a JSON syntax error. Every other outcome —
 * transport uncertainty, truncation, schema failure, semantic inconsistency,
 * integrity or freeze problems, unresolved reservations — remains an explicit
 * stop. Nothing here calls a model.
 */

import { createHash } from "node:crypto";
import {
    claimBudget,
    releaseClaim,
    type BudgetClaim,
} from "./budget.ts";

/** The policy schema version this module understands. */
export const RECOVERY_POLICY_VERSION = 1;

/** The single failure class the initial policy may make eligible. */
export const INITIAL_ELIGIBLE_CLASS = "json-syntax";

/** The one failure class an attempt can be recovered from under this policy. */
export type EligibleFailureClass = typeof INITIAL_ELIGIBLE_CLASS;

/** A registered recovery policy, frozen with the campaign manifest. */
export interface RecoveryPolicy {
    /** The schema version; only 1 is accepted. */
    version: number;
    /** The failure classes eligible for recovery; `["json-syntax"]` only. */
    eligibleFailureClasses: EligibleFailureClass[];
    /** Completion evidence is mandatory; this policy cannot waive it. */
    requiresCompletionEvidence: true;
    /** Recoveries per failed slot; exactly one under this policy. */
    maxRecoveriesPerSlot: number;
    /** Campaign-wide recovery attempts. */
    recoveryCeiling: number;
    /** Total judge attempts, initial assessments plus recoveries. */
    totalJudgeAttempts: number;
    /** Requests per attempt the adapter exposes, or null when unavailable. */
    providerRequestLimit: number | null;
}

/** The outcome of reading one registered policy. */
export type PolicyParse =
    | { ok: true; policy: RecoveryPolicy }
    | { ok: false; problems: string[] };

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative integer, or null. */
function countOf(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? value
        : null;
}

/**
 * Read and validate one registered recovery policy.
 *
 * The initial policy is deliberately narrow: completion evidence is mandatory,
 * at most one recovery per slot is permitted, and the only eligible failure
 * class is a JSON syntax failure. A declaration that widens any of those is
 * refused rather than silently honoured, so a registration cannot become a
 * general retry authorisation.
 * @param value The manifest's `assessment.recovery` declaration.
 * @returns The normalised policy, or every problem found.
 */
export function parseRecoveryPolicy(value: unknown): PolicyParse {
    if (!isRecord(value)) {
        return { ok: false, problems: ["recovery policy must be an object"] };
    }
    const problems = [
        ...versionProblems(value),
        ...classProblems(value),
        ...evidenceProblems(value),
        ...budgetProblems(value),
        ...limitProblems(value),
    ];
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, policy: normalisedPolicy(value) };
}

/** Problems with the declared schema version. */
function versionProblems(value: Record<string, unknown>): string[] {
    return value.version === RECOVERY_POLICY_VERSION
        ? []
        : [`recovery policy version must be ${RECOVERY_POLICY_VERSION}`];
}

/** Problems with the eligible failure classes. */
function classProblems(value: Record<string, unknown>): string[] {
    const classes = value.eligibleFailureClasses;
    if (!Array.isArray(classes) || classes.length === 0) {
        return [
            `eligibleFailureClasses must be a nonempty array containing only ${JSON.stringify(INITIAL_ELIGIBLE_CLASS)}`,
        ];
    }
    return classes.some((entry) => entry !== INITIAL_ELIGIBLE_CLASS)
        ? [
              `eligibleFailureClasses may contain only ${JSON.stringify(INITIAL_ELIGIBLE_CLASS)} under policy version ${RECOVERY_POLICY_VERSION}`,
          ]
        : [];
}

/** Problems with the mandatory completion evidence and per-slot bound. */
function evidenceProblems(value: Record<string, unknown>): string[] {
    const problems: string[] = [];
    if (value.requiresCompletionEvidence !== true) {
        problems.push(
            "requiresCompletionEvidence must be true; the initial policy cannot waive it",
        );
    }
    if (value.maxRecoveriesPerSlot !== 1) {
        problems.push("maxRecoveriesPerSlot must be 1 under this policy");
    }
    return problems;
}

/** Problems with the two campaign-wide ceilings. */
function budgetProblems(value: Record<string, unknown>): string[] {
    const problems: string[] = [];
    const recovery = countOf(value.recoveryCeiling);
    if (recovery === null || recovery < 1) {
        problems.push("recoveryCeiling must be a positive integer");
    }
    const total = countOf(value.totalJudgeAttempts);
    if (total === null || total < 1) {
        problems.push("totalJudgeAttempts must be a positive integer");
    } else if (recovery !== null && total < recovery) {
        problems.push(
            "totalJudgeAttempts must be at least the recovery ceiling",
        );
    }
    return problems;
}

/** Problems with the declared provider-request capability. */
function limitProblems(value: Record<string, unknown>): string[] {
    const limit = value.providerRequestLimit;
    if (limit === undefined) {
        return [
            "providerRequestLimit must be declared: null when the adapter exposes no request count",
        ];
    }
    if (limit === null) return [];
    const count = countOf(limit);
    return count === null || count < 1
        ? [
              "providerRequestLimit must be null (not exposed) or a positive integer",
          ]
        : [];
}

/** The validated policy, normalised to its fixed shape. */
function normalisedPolicy(value: Record<string, unknown>): RecoveryPolicy {
    const limit = value.providerRequestLimit;
    return {
        version: RECOVERY_POLICY_VERSION,
        eligibleFailureClasses: [INITIAL_ELIGIBLE_CLASS],
        requiresCompletionEvidence: true,
        maxRecoveriesPerSlot: 1,
        recoveryCeiling: countOf(value.recoveryCeiling) as number,
        totalJudgeAttempts: countOf(value.totalJudgeAttempts) as number,
        providerRequestLimit:
            limit === null || limit === undefined ? null : (limit as number),
    };
}

/**
 * The canonical hash of a registered policy.
 * @param policy The normalised policy.
 * @returns The SHA-256 of its canonical JSON.
 */
export function recoveryPolicySha256(policy: RecoveryPolicy): string {
    return createHash("sha256")
        .update(JSON.stringify(policy), "utf8")
        .digest("hex");
}

/** The facts an eligibility decision is made from. */
export interface RecoveryFacts {
    /** The recorded judgement status of the manifest-selected attempt. */
    attemptStatus: string;
    /** That attempt's machine-readable failure class, when recorded. */
    failureClass: string | null;
    /** Whether that attempt's capture proves a complete final response. */
    completionComplete: boolean | null;
    /** Attempt ids recorded for the slot. */
    attemptIds: readonly string[];
    /** Attempt ids whose judgement status is usable. */
    judgedAttemptIds: readonly string[];
    /** Recovery claims already made campaign-wide. */
    recoveryClaimsUsed: number;
    /** Judge claims already made campaign-wide, initial and recovery. */
    judgeClaimsUsed: number;
    /** The parsed ledger state. */
    ledgerState: "missing" | "malformed" | "open" | "closed";
    /** Freeze-verification problems, empty when the premise is intact. */
    freezeProblems: readonly string[];
    /** Unsettled reservations that forbid a repeat dispatch. */
    unresolvedReservations: readonly string[];
}

/** The eligibility decision for one failed slot. */
export type RecoveryDecision =
    | { eligible: true; attemptId: string }
    | { eligible: false; reason: string };

/** The numeric ordinal of an `attempt-NNN` id. */
function ordinal(attemptId: string): number {
    return Number(attemptId.slice("attempt-".length));
}

/**
 * Decide whether one failed slot may receive its single recovery attempt.
 *
 * Every refusal names the specific fact that stopped it, so a status report can
 * distinguish an ineligible failure from an exhausted budget or a broken
 * premise. A usable first assessment is never replaced.
 * @param policy The registered policy.
 * @param facts The recorded facts for the slot and the campaign.
 * @returns The decision.
 */
export function recoveryDecision(
    policy: RecoveryPolicy,
    facts: RecoveryFacts,
): RecoveryDecision {
    const reason = [
        contextRefusal(facts),
        firstAssessmentRefusal(facts),
        layoutRefusal(policy, facts),
        eligibilityRefusal(policy, facts),
        budgetRefusal(policy, facts),
    ].find((entry) => entry !== null);
    if (reason !== undefined) return { eligible: false, reason };
    return {
        eligible: true,
        attemptId: `attempt-${String(facts.attemptIds.length + 1).padStart(3, "0")}`,
    };
}

/** Refuse when the ledger, the freeze or a reservation forbids dispatch. */
function contextRefusal(facts: RecoveryFacts): string | null {
    if (facts.ledgerState !== "open") {
        return `campaign ledger is ${facts.ledgerState}; no dispatch`;
    }
    if (facts.freezeProblems.length > 0) {
        return `frozen premise changed: ${facts.freezeProblems.join("; ")}`;
    }
    return facts.unresolvedReservations.length > 0
        ? `unresolved reservation(s): ${facts.unresolvedReservations.join(", ")}`
        : null;
}

/** Refuse when a usable assessment already exists for the slot. */
function firstAssessmentRefusal(facts: RecoveryFacts): string | null {
    if (facts.attemptStatus === "judged") {
        return "the first assessment is usable; a valid judgement is never replaced";
    }
    return facts.judgedAttemptIds.length > 0
        ? "a usable assessment already exists for this slot"
        : null;
}

/** Refuse an attempt layout that cannot accept one recovery. */
function layoutRefusal(
    policy: RecoveryPolicy,
    facts: RecoveryFacts,
): string | null {
    const attempts = [...facts.attemptIds].sort();
    if (attempts.length === 0) return "no judge attempt recorded for the slot";
    for (let index = 0; index < attempts.length; index += 1) {
        if (ordinal(attempts[index] as string) !== index + 1) {
            return `attempt sequence is not contiguous: ${attempts.join(", ")}`;
        }
    }
    return attempts.length > policy.maxRecoveriesPerSlot
        ? `a recovery attempt already exists (${attempts.join(", ")}); a second unusable assessment stops the campaign`
        : null;
}

/** Refuse a failure class or capture the policy does not make eligible. */
function eligibilityRefusal(
    policy: RecoveryPolicy,
    facts: RecoveryFacts,
): string | null {
    if (!policy.eligibleFailureClasses.includes(INITIAL_ELIGIBLE_CLASS)) {
        return "policy makes no failure class eligible";
    }
    if (facts.failureClass !== INITIAL_ELIGIBLE_CLASS) {
        return `failure class ${JSON.stringify(facts.failureClass)} is not eligible; only ${INITIAL_ELIGIBLE_CLASS} is`;
    }
    return policy.requiresCompletionEvidence &&
        facts.completionComplete !== true
        ? "completion of the final assessed response cannot be established"
        : null;
}

/** Refuse when either campaign-wide ceiling is exhausted. */
function budgetRefusal(
    policy: RecoveryPolicy,
    facts: RecoveryFacts,
): string | null {
    if (facts.recoveryClaimsUsed >= policy.recoveryCeiling) {
        return `recovery ceiling reached: ${policy.recoveryCeiling} authorised recovery attempt(s)`;
    }
    return facts.judgeClaimsUsed >= policy.totalJudgeAttempts
        ? `total judge-attempt ceiling reached: ${policy.totalJudgeAttempts} authorised attempt(s)`
        : null;
}

/** One attempt's recorded facts, as carried by the selection record. */
export interface SelectionAttempt {
    /** The attempt directory name. */
    attemptId: string;
    /** Its recorded judgement status. */
    judgementStatus: string;
    /** The packet identity it was judged from, or null when unrecorded. */
    packetSha256: string | null;
    /** Its failure class, when it has no usable verdict. */
    failureClass: string | null;
    /** Whether its capture proves a complete final response. */
    complete: boolean | null;
}

/** The per-slot assessment selection, written after a usable judgement lands. */
export interface SelectionRecord {
    /** The record schema version. */
    schemeVersion: number;
    /** The scheduled slot the record belongs to. */
    slot: number;
    /** The scheduled pair id. */
    pairId: string;
    /** The trial stamp. */
    stamp: string;
    /** The arm letter. */
    arm: string;
    /** The scenario id. */
    scenario: string;
    /** The attempt whose judgement the analyser must read. */
    selectedAttemptId: string;
    /** The registered policy hash, or null when none applied. */
    policySha256: string | null;
    /** Every attempt recorded for the slot, in order. */
    attempts: SelectionAttempt[];
}

/** The inputs a selection record is built from. */
export interface SelectionInput {
    /** The scheduled slot. */
    slot: number;
    /** The scheduled pair id. */
    pairId: string;
    /** The trial stamp. */
    stamp: string;
    /** The arm letter. */
    arm: string;
    /** The scenario id. */
    scenario: string;
    /** The attempt whose judgement is authoritative. */
    selectedAttemptId: string;
    /** The registered policy hash, or null when none applied. */
    policySha256: string | null;
    /** Every attempt recorded for the slot. */
    attempts: SelectionAttempt[];
}

/**
 * Build one selection record.
 * @param input The slot identity, the selected attempt and every attempt fact.
 * @returns The record.
 */
export function selectionRecordOf(input: SelectionInput): SelectionRecord {
    return {
        schemeVersion: 1,
        slot: input.slot,
        pairId: input.pairId,
        stamp: input.stamp,
        arm: input.arm,
        scenario: input.scenario,
        selectedAttemptId: input.selectedAttemptId,
        policySha256: input.policySha256,
        attempts: [...input.attempts].sort((left, right) =>
            left.attemptId.localeCompare(right.attemptId),
        ),
    };
}

/** The facts a recorded selection is checked against. */
export interface SelectionFacts {
    /** The scheduled slot, when the caller knows it. */
    slot?: number;
    /** The pair id, when the caller knows it. */
    pairId?: string;
    /** The trial stamp. */
    stamp?: string;
    /** The arm letter, when the caller knows it. */
    arm?: string;
    /** The scenario id. */
    scenario?: string;
    /** Attempt directories actually present for the slot. */
    attemptIds: readonly string[];
    /** The frozen manifest selector. */
    manifestAttemptId: string | null;
    /** The registered policy, or null. */
    policy: RecoveryPolicy | null;
    /** The actual attempt facts, when the caller can re-derive them. */
    attemptFacts?: Record<string, SelectionAttempt>;
}

/**
 * Check one recorded selection against the evidence it claims to describe.
 *
 * The record is evidence, not a trusted pointer: its identity, attempt set,
 * ordering, policy eligibility, packet identity and usable judgement status are
 * all re-derived. A tampered record, an ineligible selection, or a replacement
 * of an already-valid first assessment is refused.
 * @param value The recorded selection, as read from disk.
 * @param facts The actual slot and evidence facts.
 * @returns Every problem; empty means the selection is trustworthy.
 */
export function selectionProblems(
    value: unknown,
    facts: SelectionFacts,
): string[] {
    if (!isRecord(value)) return ["selection record must be an object"];
    const identity = identityProblems(value, facts);
    const selected = value.selectedAttemptId;
    if (typeof selected !== "string" || !/^attempt-\d{3}$/.test(selected)) {
        return [...identity, "selection selectedAttemptId must match attempt-NNN"];
    }
    if (!Array.isArray(value.attempts)) {
        return [...identity, "selection attempts must be an array"];
    }
    const parsed = attemptRecordsOf(value.attempts);
    return [
        ...identity,
        ...parsed.problems,
        ...attemptSetProblems(parsed.recorded, facts),
        ...factProblems(parsed.recorded, facts),
        ...choiceProblems(value, parsed.recorded, selected, facts),
    ];
}

/** The record's own identity against the slot it claims. */
function identityProblems(
    value: Record<string, unknown>,
    facts: SelectionFacts,
): string[] {
    const problems: string[] = [];
    if (value.schemeVersion !== 1) {
        problems.push("selection schemeVersion must be 1");
    }
    for (const field of ["pairId", "stamp", "arm", "scenario"] as const) {
        const expected = facts[field];
        if (expected !== undefined && value[field] !== expected) {
            problems.push(
                `selection ${field} ${JSON.stringify(value[field])} does not match the slot ${JSON.stringify(expected)}`,
            );
        }
    }
    if (facts.slot !== undefined && value.slot !== facts.slot) {
        problems.push("selection slot does not match the schedule");
    }
    return problems;
}

/** One parsed attempt entry, or the reason it is malformed. */
function attemptEntryOf(entry: unknown): {
    attempt?: SelectionAttempt;
    problem?: string;
} {
    const identity = entryIdentityOf(entry);
    if (identity.problem !== undefined) return { problem: identity.problem };
    const attemptId = identity.attemptId as string;
    const problem = entryFieldProblem(entry, `selection attempt ${attemptId}`);
    if (problem !== undefined) return { problem };
    const value = entry as Record<string, unknown>;
    return {
        attempt: {
            attemptId,
            judgementStatus: value.judgementStatus as string,
            packetSha256: value.packetSha256 as string | null,
            failureClass: (value.failureClass ?? null) as string | null,
            complete: (value.complete ?? null) as boolean | null,
        },
    };
}

/** One entry's attempt id, or the shape problem. */
function entryIdentityOf(entry: unknown): {
    attemptId?: string;
    problem?: string;
} {
    if (
        !isRecord(entry) ||
        typeof entry.attemptId !== "string" ||
        !/^attempt-\d{3}$/.test(entry.attemptId)
    ) {
        return { problem: "selection attempt entry is malformed" };
    }
    return { attemptId: entry.attemptId };
}

/** The first malformed field of one attempt entry, or undefined. */
function entryFieldProblem(
    entry: unknown,
    label: string,
): string | undefined {
    const value = entry as Record<string, unknown>;
    if (typeof value.judgementStatus !== "string") {
        return `${label} has no judgement status`;
    }
    if (value.packetSha256 !== null && typeof value.packetSha256 !== "string") {
        return `${label} packetSha256 is malformed`;
    }
    const failureClass = value.failureClass ?? null;
    if (failureClass !== null && typeof failureClass !== "string") {
        return `${label} failureClass is malformed`;
    }
    const complete = value.complete ?? null;
    return complete !== null && typeof complete !== "boolean"
        ? `${label} complete is malformed`
        : undefined;
}

/** Parse every recorded attempt entry, reporting malformed and repeated ones. */
function attemptRecordsOf(entries: unknown[]): {
    recorded: Map<string, SelectionAttempt>;
    problems: string[];
} {
    const recorded = new Map<string, SelectionAttempt>();
    const problems: string[] = [];
    for (const entry of entries) {
        const parsed = attemptEntryOf(entry);
        if (parsed.problem !== undefined) {
            problems.push(parsed.problem);
            continue;
        }
        const attempt = parsed.attempt as SelectionAttempt;
        if (recorded.has(attempt.attemptId)) {
            problems.push(`selection repeats attempt ${attempt.attemptId}`);
            continue;
        }
        recorded.set(attempt.attemptId, attempt);
    }
    return { recorded, problems };
}

/** The claimed attempt set against the attempts actually present. */
function attemptSetProblems(
    recorded: Map<string, SelectionAttempt>,
    facts: SelectionFacts,
): string[] {
    const actual = [...facts.attemptIds].sort();
    const claimed = [...recorded.keys()].sort();
    return claimed.join(",") === actual.join(",")
        ? []
        : [
              `selection attempts ${JSON.stringify(claimed)} do not match the evidence ${JSON.stringify(actual)}`,
          ];
}

/** The claimed attempt facts against the re-derived facts. */
function factProblems(
    recorded: Map<string, SelectionAttempt>,
    facts: SelectionFacts,
): string[] {
    if (facts.attemptFacts === undefined) return [];
    const problems: string[] = [];
    for (const [attemptId, entry] of recorded) {
        const actualEntry = facts.attemptFacts[attemptId];
        if (actualEntry === undefined) continue;
        for (const field of ATTEMPT_FACT_FIELDS) {
            if (entry[field] !== actualEntry[field]) {
                problems.push(
                    `selection ${attemptId} ${field} ${JSON.stringify(entry[field])} does not match the recorded evidence ${JSON.stringify(actualEntry[field])}`,
                );
            }
        }
    }
    return problems;
}

/** The fields the selection record must re-derive exactly. */
const ATTEMPT_FACT_FIELDS = [
    "judgementStatus",
    "packetSha256",
    "failureClass",
    "complete",
] as const;

/** Problems with the chosen attempt and its relation to the manifest. */
function choiceProblems(
    value: Record<string, unknown>,
    recorded: Map<string, SelectionAttempt>,
    selected: string,
    facts: SelectionFacts,
): string[] {
    const problems: string[] = [];
    const selectedEntry = recorded.get(selected);
    if (selectedEntry === undefined) {
        problems.push(`selection names an absent attempt ${selected}`);
    } else if (selectedEntry.judgementStatus !== "judged") {
        problems.push(
            `selection names an unusable attempt ${selected} (${selectedEntry.judgementStatus})`,
        );
    }
    const manifest = facts.manifestAttemptId;
    if (manifest !== null && selected !== manifest) {
        problems.push(
            ...recoveryChoiceProblems(value, recorded, selected, manifest, facts),
        );
    } else {
        problems.push(...firstChoiceProblems(recorded, selected, facts));
    }
    return problems;
}

/** Problems with a selection that differs from the frozen manifest. */
function recoveryChoiceProblems(
    value: Record<string, unknown>,
    recorded: Map<string, SelectionAttempt>,
    selected: string,
    manifest: string,
    facts: SelectionFacts,
): string[] {
    const problems: string[] = [];
    if (facts.policy === null) {
        problems.push(
            "selection differs from the frozen manifest selector with no registered policy",
        );
    } else if (value.policySha256 !== recoveryPolicySha256(facts.policy)) {
        problems.push(
            "selection policySha256 does not match the registered policy",
        );
    }
    const base = recorded.get(manifest);
    if (base === undefined) {
        problems.push(`selection has no entry for the manifest attempt ${manifest}`);
    } else {
        problems.push(
            ...baseEligibilityProblems(base, recorded.get(selected), manifest, facts),
        );
    }
    if (ordinal(selected) !== ordinal(manifest) + 1) {
        problems.push(
            `selection ${selected} is not the next attempt after ${manifest}`,
        );
    }
    const recoveries = facts.attemptIds.filter(
        (attempt) => ordinal(attempt) > ordinal(manifest),
    );
    const permitted = facts.policy?.maxRecoveriesPerSlot ?? 0;
    if (recoveries.length > permitted) {
        problems.push(
            `selection holds ${recoveries.length} recovery attempt(s); at most ${permitted} permitted`,
        );
    }
    return problems;
}

/** Problems with the first attempt a recovery supersedes. */
function baseEligibilityProblems(
    base: SelectionAttempt,
    selected: SelectionAttempt | undefined,
    manifest: string,
    facts: SelectionFacts,
): string[] {
    const problems = baseClassProblems(base, facts);
    if (
        facts.policy?.requiresCompletionEvidence === true &&
        base.complete !== true
    ) {
        problems.push(`selection recovers from incomplete capture for ${manifest}`);
    }
    if (
        base.packetSha256 === null ||
        base.packetSha256 !== selected?.packetSha256
    ) {
        problems.push("selection attempts were judged from different packets");
    }
    return problems;
}

/** Problems with the superseded attempt's status and failure class. */
function baseClassProblems(
    base: SelectionAttempt,
    facts: SelectionFacts,
): string[] {
    const problems: string[] = [];
    if (base.judgementStatus === "judged") {
        problems.push(
            `selection replaces the usable first assessment`,
        );
    }
    if (
        base.failureClass === null ||
        !facts.policy?.eligibleFailureClasses.includes(
            base.failureClass as EligibleFailureClass,
        )
    ) {
        problems.push(
            `selection recovers from an ineligible failure class ${JSON.stringify(base.failureClass)}`,
        );
    }
    return problems;
}

/** Problems with a first-assessment selection beside a later judgement. */
function firstChoiceProblems(
    recorded: Map<string, SelectionAttempt>,
    selected: string,
    facts: SelectionFacts,
): string[] {
    const judgedLater = facts.attemptIds.filter(
        (attempt) =>
            ordinal(attempt) > ordinal(selected) &&
            recorded.get(attempt)?.judgementStatus === "judged",
    );
    return judgedLater.length > 0
        ? [`selection ignores a later usable judgement ${judgedLater.join(", ")}`]
        : [];
}

/**
 * Claim the recovery and judge budgets atomically.
 *
 * The recovery claim is taken first, then the judge claim, each with the
 * filesystem deciding the winner. If the judge claim refuses, the recovery
 * reservation is released only because it provably dispatched nothing; a
 * spawned call keeps consuming both ceilings.
 * @param root The campaign evidence root.
 * @param policy The registered policy.
 * @param identity The slot identity and the logical attempt key.
 * @param identity.stamp The trial stamp the claim names.
 * @param identity.attemptId The recovery attempt id.
 * @param identity.key The logical attempt key; a repeat is refused.
 * @param identity.at An injected claim timestamp, for determinism.
 * @returns Both claims, or the refusal.
 */
export function claimRecoveryBudget(
    root: string,
    policy: RecoveryPolicy,
    identity: {
        stamp: string;
        attemptId: string;
        key: string;
        at?: string;
    },
):
    | { ok: true; recovery: BudgetClaim; judge: BudgetClaim }
    | { ok: false; reason: string } {
    const recovery = claimBudget(
        root,
        "recovery",
        policy.recoveryCeiling,
        identity,
    );
    if (!recovery.ok) {
        return { ok: false, reason: `recovery budget refused: ${recovery.reason}` };
    }
    const judge = claimBudget(
        root,
        "judge",
        policy.totalJudgeAttempts,
        identity,
    );
    if (!judge.ok) {
        releaseClaim(recovery.claim);
        return { ok: false, reason: `judge budget refused: ${judge.reason}` };
    }
    return { ok: true, recovery: recovery.claim, judge: judge.claim };
}
