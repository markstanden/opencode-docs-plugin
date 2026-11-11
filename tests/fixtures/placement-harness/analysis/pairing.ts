/**
 * Pairing for the analysis framework.
 *
 * Pairs come from the declared pair identities in the manifest schedule and
 * are matched to observations by declared slot identity — never by array
 * adjacency. A complete pair holds an assessed observation for every declared
 * arm; an incomplete pair yields its assessed sides as unmatched observations,
 * and observations outside any declared pair stay visible as unpaired.
 */
import type { TrialScored } from "./accounting.ts";
import type { Interval } from "./bounds.ts";
import type { SlotSpec } from "./model.ts";

/** One declared pair with its observations by arm. */
export interface PairView {
    /** The declared pair id. */
    pairId: string;
    /** The pair's scenario. */
    scenario: string;
    /** The pair's repetition. */
    repetition: number;
    /** Observations keyed by declared arm; undefined when absent. */
    arms: Record<string, TrialScored | undefined>;
    /** Whether every declared arm has a fully assessed observation. */
    complete: boolean;
    /** Declared arms without a fully assessed observation. */
    missingArms: string[];
}

/** The pairing result for one measured population. */
export interface PairingResult {
    /** Declared pairs in declared order. */
    pairs: PairView[];
    /** Assessed observations in incomplete pairs. */
    unmatched: TrialScored[];
    /** Observations outside any declared pair. */
    unpaired: TrialScored[];
    /** Evidence problems found while pairing (e.g. duplicate observations). */
    problems: string[];
}

/** A candidate-minus-control comparison over complete pairs. */
export interface PairedComparison {
    /** Complete pairs carrying both compared arms. */
    completePairs: number;
    /** Pairs where the control scored higher. */
    controlBetter: number;
    /** Pairs where the candidate scored higher. */
    candidateBetter: number;
    /** Pairs with equal scores. */
    ties: number;
    /** Summed candidate-minus-control delta over complete pairs. */
    delta: number;
    /** Closed delta interval from the per-arm bounds. */
    interval: Interval;
}

/**
 * Build one pair view from its declared slots.
 * @param pairId The declared pair id.
 * @param group The pair's slots, in declared order.
 * @param bySlot First-attempt observations keyed by slot number.
 * @returns The pair view.
 */
function pairViewOf(
    pairId: string,
    group: readonly SlotSpec[],
    bySlot: ReadonlyMap<number, TrialScored>,
): PairView {
    const arms: Record<string, TrialScored | undefined> = {};
    const missingArms: string[] = [];
    for (const slot of group) {
        const row = bySlot.get(slot.slot);
        arms[slot.arm] = row;
        if (row === undefined || !row.utility.assessed) {
            missingArms.push(slot.arm);
        }
    }
    return {
        pairId,
        scenario: group[0]?.scenario ?? "",
        repetition: group[0]?.repetition ?? 0,
        arms,
        complete: missingArms.length === 0,
        missingArms,
    };
}

/**
 * Pair a measured population by declared identity.
 * @param scored The scored trials.
 * @param slots The declared schedule slots.
 * @returns Complete pairs, unmatched observations, unpaired evidence and problems.
 */
export function pairObservations(
    scored: readonly TrialScored[],
    slots: readonly SlotSpec[],
): PairingResult {
    const observed = scored.filter(
        (row) => row.disposition === "first-attempt",
    );
    const problems: string[] = [];
    const bySlot = new Map<number, TrialScored>();
    for (const row of observed) {
        if (row.identity.slot === null) continue;
        if (bySlot.has(row.identity.slot)) {
            problems.push(
                `duplicate first-attempt observation for slot ${String(row.identity.slot)}`,
            );
        } else {
            bySlot.set(row.identity.slot, row);
        }
    }
    const pairIds = [
        ...new Set(
            slots.flatMap((slot) =>
                slot.pairId === undefined ? [] : [slot.pairId],
            ),
        ),
    ];
    const pairs = pairIds.map((pairId) =>
        pairViewOf(
            pairId,
            slots.filter((slot) => slot.pairId === pairId),
            bySlot,
        ),
    );
    const unmatched = pairs
        .filter((pair) => !pair.complete)
        .flatMap((pair) =>
            Object.values(pair.arms).filter(
                (row): row is TrialScored =>
                    row !== undefined && row.utility.assessed,
            ),
        );
    const pairedSlots = new Set(
        slots.flatMap((slot) => (slot.pairId === undefined ? [] : [slot.slot])),
    );
    const unpaired = observed.filter(
        (row) =>
            row.identity.slot === null || !pairedSlots.has(row.identity.slot),
    );
    return { pairs, unmatched, unpaired, problems };
}

/**
 * Compare a candidate arm against a control arm over complete pairs.
 * @param pairs The paired population.
 * @param controlArm The control arm id.
 * @param candidateArm The candidate arm id.
 * @returns Pair counts, the summed delta and its interval.
 */
export function pairedComparison(
    pairs: readonly PairView[],
    controlArm: string,
    candidateArm: string,
): PairedComparison {
    const comparison: PairedComparison = {
        completePairs: 0,
        controlBetter: 0,
        candidateBetter: 0,
        ties: 0,
        delta: 0,
        interval: { low: 0, high: 0 },
    };
    for (const pair of pairs) {
        if (!pair.complete) continue;
        const control = pair.arms[controlArm];
        const candidate = pair.arms[candidateArm];
        if (control === undefined || candidate === undefined) continue;
        comparison.completePairs += 1;
        const delta = candidate.utility.score - control.utility.score;
        comparison.delta += delta;
        comparison.interval.low += candidate.utility.low - control.utility.high;
        comparison.interval.high +=
            candidate.utility.high - control.utility.low;
        if (delta > 0) comparison.candidateBetter += 1;
        else if (delta < 0) comparison.controlBetter += 1;
        else comparison.ties += 1;
    }
    return comparison;
}
