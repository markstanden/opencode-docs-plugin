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
    const problems: string[] = [];
    if (value.version !== RECOVERY_POLICY_VERSION) {
        problems.push(
            `recovery policy version must be ${RECOVERY_POLICY_VERSION}`,
        );
    }
    const classes = value.eligibleFailureClasses;
    if (!Array.isArray(classes) || classes.length === 0) {
        problems.push(
            `eligibleFailureClasses must be a nonempty array containing only ${JSON.stringify(INITIAL_ELIGIBLE_CLASS)}`,
        );
    } else if (classes.some((entry) => entry !== INITIAL_ELIGIBLE_CLASS)) {
        problems.push(
            `eligibleFailureClasses may contain only ${JSON.stringify(INITIAL_ELIGIBLE_CLASS)} under policy version ${RECOVERY_POLICY_VERSION}`,
        );
    }
    if (value.requiresCompletionEvidence !== true) {
        problems.push(
            "requiresCompletionEvidence must be true; the initial policy cannot waive it",
        );
    }
    if (value.maxRecoveriesPerSlot !== 1) {
        problems.push("maxRecoveriesPerSlot must be 1 under this policy");
    }
    const recoveryCeiling = countOf(value.recoveryCeiling);
    if (recoveryCeiling === null || recoveryCeiling < 1) {
        problems.push("recoveryCeiling must be a positive integer");
    }
    const totalJudgeAttempts = countOf(value.totalJudgeAttempts);
    if (totalJudgeAttempts === null || totalJudgeAttempts < 1) {
        problems.push("totalJudgeAttempts must be a positive integer");
    } else if (
        recoveryCeiling !== null &&
        totalJudgeAttempts < recoveryCeiling
    ) {
        problems.push(
            "totalJudgeAttempts must be at least the recovery ceiling",
        );
    }
    const providerRequestLimit = value.providerRequestLimit;
    if (providerRequestLimit === undefined) {
        problems.push(
            "providerRequestLimit must be declared: null when the adapter exposes no request count",
        );
    } else if (providerRequestLimit !== null) {
        const limit = countOf(providerRequestLimit);
        if (limit === null || limit < 1) {
            problems.push(
                "providerRequestLimit must be null (not exposed) or a positive integer",
            );
        }
    }
    if (problems.length > 0) return { ok: false, problems };
    return {
        ok: true,
        policy: {
            version: RECOVERY_POLICY_VERSION,
            eligibleFailureClasses: [INITIAL_ELIGIBLE_CLASS],
            requiresCompletionEvidence: true,
            maxRecoveriesPerSlot: 1,
            recoveryCeiling: recoveryCeiling as number,
            totalJudgeAttempts: totalJudgeAttempts as number,
            providerRequestLimit:
                providerRequestLimit === null
                    ? null
                    : (providerRequestLimit as number),
        },
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
    const refuse = (reason: string): RecoveryDecision => ({
        eligible: false,
        reason,
    });
    if (facts.ledgerState !== "open") {
        return refuse(`campaign ledger is ${facts.ledgerState}; no dispatch`);
    }
    if (facts.freezeProblems.length > 0) {
        return refuse(`frozen premise changed: ${facts.freezeProblems.join("; ")}`);
    }
    if (facts.unresolvedReservations.length > 0) {
        return refuse(
            `unresolved reservation(s): ${facts.unresolvedReservations.join(", ")}`,
        );
    }
    if (facts.attemptStatus === "judged") {
        return refuse(
            "the first assessment is usable; a valid judgement is never replaced",
        );
    }
    if (facts.judgedAttemptIds.length > 0) {
        return refuse("a usable assessment already exists for this slot");
    }
    const attempts = [...facts.attemptIds].sort();
    if (attempts.length === 0) {
        return refuse("no judge attempt recorded for the slot");
    }
    for (let index = 0; index < attempts.length; index += 1) {
        if (ordinal(attempts[index] as string) !== index + 1) {
            return refuse(
                `attempt sequence is not contiguous: ${attempts.join(", ")}`,
            );
        }
    }
    if (attempts.length > policy.maxRecoveriesPerSlot) {
        return refuse(
            `a recovery attempt already exists (${attempts.join(", ")}); a second unusable assessment stops the campaign`,
        );
    }
    if (!policy.eligibleFailureClasses.includes(INITIAL_ELIGIBLE_CLASS)) {
        return refuse("policy makes no failure class eligible");
    }
    if (facts.failureClass !== INITIAL_ELIGIBLE_CLASS) {
        return refuse(
            `failure class ${JSON.stringify(facts.failureClass)} is not eligible; only ${INITIAL_ELIGIBLE_CLASS} is`,
        );
    }
    if (
        policy.requiresCompletionEvidence &&
        facts.completionComplete !== true
    ) {
        return refuse(
            "completion of the final assessed response cannot be established",
        );
    }
    if (facts.recoveryClaimsUsed >= policy.recoveryCeiling) {
        return refuse(
            `recovery ceiling reached: ${policy.recoveryCeiling} authorised recovery attempt(s)`,
        );
    }
    if (facts.judgeClaimsUsed >= policy.totalJudgeAttempts) {
        return refuse(
            `total judge-attempt ceiling reached: ${policy.totalJudgeAttempts} authorised attempt(s)`,
        );
    }
    return { eligible: true, attemptId: `attempt-${String(attempts.length + 1).padStart(3, "0")}` };
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
    /** The scheduled identity the record belongs to. */
    slot: number;
    pairId: string;
    stamp: string;
    arm: string;
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
    slot: number;
    pairId: string;
    stamp: string;
    arm: string;
    scenario: string;
    selectedAttemptId: string;
    policySha256: string | null;
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
    slot?: number;
    pairId?: string;
    stamp?: string;
    arm?: string;
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
    const selected = value.selectedAttemptId;
    if (typeof selected !== "string" || !/^attempt-\d{3}$/.test(selected)) {
        problems.push("selection selectedAttemptId must match attempt-NNN");
        return problems;
    }
    const attempts = value.attempts;
    if (!Array.isArray(attempts)) {
        problems.push("selection attempts must be an array");
        return problems;
    }
    const recorded = new Map<string, SelectionAttempt>();
    for (const entry of attempts) {
        if (
            !isRecord(entry) ||
            typeof entry.attemptId !== "string" ||
            !/^attempt-\d{3}$/.test(entry.attemptId)
        ) {
            problems.push("selection attempt entry is malformed");
            continue;
        }
        if (recorded.has(entry.attemptId)) {
            problems.push(`selection repeats attempt ${entry.attemptId}`);
            continue;
        }
        if (typeof entry.judgementStatus !== "string") {
            problems.push(
                `selection attempt ${entry.attemptId} has no judgement status`,
            );
            continue;
        }
        if (
            entry.packetSha256 !== null &&
            typeof entry.packetSha256 !== "string"
        ) {
            problems.push(
                `selection attempt ${entry.attemptId} packetSha256 is malformed`,
            );
            continue;
        }
        const failureClass =
            entry.failureClass === undefined || entry.failureClass === null
                ? null
                : entry.failureClass;
        if (failureClass !== null && typeof failureClass !== "string") {
            problems.push(
                `selection attempt ${entry.attemptId} failureClass is malformed`,
            );
            continue;
        }
        const complete =
            entry.complete === undefined || entry.complete === null
                ? null
                : entry.complete;
        if (complete !== null && typeof complete !== "boolean") {
            problems.push(
                `selection attempt ${entry.attemptId} complete is malformed`,
            );
            continue;
        }
        recorded.set(entry.attemptId, {
            attemptId: entry.attemptId,
            judgementStatus: entry.judgementStatus,
            packetSha256: entry.packetSha256,
            failureClass,
            complete,
        });
    }
    const actual = [...facts.attemptIds].sort();
    const claimed = [...recorded.keys()].sort();
    if (claimed.join(",") !== actual.join(",")) {
        problems.push(
            `selection attempts ${JSON.stringify(claimed)} do not match the evidence ${JSON.stringify(actual)}`,
        );
    }
    if (facts.attemptFacts !== undefined) {
        for (const [attemptId, entry] of recorded) {
            const actualEntry = facts.attemptFacts[attemptId];
            if (actualEntry === undefined) continue;
            for (const field of [
                "judgementStatus",
                "packetSha256",
                "failureClass",
                "complete",
            ] as const) {
                if (entry[field] !== actualEntry[field]) {
                    problems.push(
                        `selection ${attemptId} ${field} ${JSON.stringify(entry[field])} does not match the recorded evidence ${JSON.stringify(actualEntry[field])}`,
                    );
                }
            }
        }
    }
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
            if (base.judgementStatus === "judged") {
                problems.push(
                    `selection replaces the usable first assessment ${manifest}`,
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
            if (
                facts.policy?.requiresCompletionEvidence === true &&
                base.complete !== true
            ) {
                problems.push(
                    `selection recovers from incomplete capture for ${manifest}`,
                );
            }
            if (
                base.packetSha256 === null ||
                base.packetSha256 !== selectedEntry?.packetSha256
            ) {
                problems.push(
                    "selection attempts were judged from different packets",
                );
            }
        }
        if (ordinal(selected) !== ordinal(manifest) + 1) {
            problems.push(
                `selection ${selected} is not the next attempt after ${manifest}`,
            );
        }
        const recoveries = actual.filter(
            (attempt) => ordinal(attempt) > ordinal(manifest),
        );
        if (recoveries.length > (facts.policy?.maxRecoveriesPerSlot ?? 0)) {
            problems.push(
                `selection holds ${recoveries.length} recovery attempt(s); at most ${facts.policy?.maxRecoveriesPerSlot ?? 0} permitted`,
            );
        }
    } else {
        // The first assessment must not sit beside a later usable judgement:
        // two valid assessments are never chosen between.
        const judgedLater = actual.filter(
            (attempt) =>
                ordinal(attempt) > ordinal(selected) &&
                recorded.get(attempt)?.judgementStatus === "judged",
        );
        if (judgedLater.length > 0) {
            problems.push(
                `selection ignores a later usable judgement ${judgedLater.join(", ")}`,
            );
        }
    }
    return problems;
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
