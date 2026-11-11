/**
 * Interval arithmetic for trial utility bounds.
 *
 * A missing component is reported as a closed interval, never as zero and
 * never as a confidence interval. Arm bounds come from assessed totals plus
 * the summed missing components; with independent arms the candidate-minus-
 * control interval is `candidate.low − control.high .. candidate.high −
 * control.low`.
 */

/** A closed numeric interval. */
export interface Interval {
    /** The lowest value the quantity can take. */
    low: number;
    /** The highest value the quantity can take. */
    high: number;
}

/** The accounting totals an interval can be read from. */
export interface BoundableTotals {
    /** Sum of assessed trial utilities. */
    utilityTotal: number;
    /** Full-population lower bound. */
    utilityLow: number;
    /** Full-population upper bound. */
    utilityHigh: number;
}

/**
 * Read the interval an accounting record already carries.
 * @param counts The accounting totals and their derived bounds.
 * @returns The closed interval.
 */
export function intervalFromCounts(counts: BoundableTotals): Interval {
    return { low: counts.utilityLow, high: counts.utilityHigh };
}

/**
 * Compute a candidate-minus-control interval for independent bounds.
 * The worst case pairs the candidate's low with the control's high and the
 * candidate's high with the control's low.
 * @param candidate The candidate arm's interval.
 * @param control The control arm's interval.
 * @returns The difference interval.
 */
export function differenceInterval(
    candidate: Interval,
    control: Interval,
): Interval {
    return {
        low: candidate.low - control.high,
        high: candidate.high - control.low,
    };
}
