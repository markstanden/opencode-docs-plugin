/**
 * The NOTE-02 partial-fix rule, scoped to the historical correction.
 *
 * A documentation update that presents the superseded Node 22 floor as the
 * supported/current contract in its Summary or Facts is misleading; a
 * completed Node 24 migration is a useful update. Assertions are evaluated
 * separately so a rejecting clause in one sentence cannot suppress an
 * affirmative claim in another, and Failed approaches stay context.
 *
 * This helper is deliberately not a general semantic classifier.
 */
import { claimSurfaceOf } from "./inventory.ts";

/** The two classifications the historical NOTE-02 review used. */
export type NoteVersionVerdict = "useful-update" | "misleading";

/** Whether one assertion rejects the Node 22 floor. */
const rejects22 = (text: string): boolean =>
    /Node\s*22[^\n.]{0,50}\b(?:no longer|not|never|unsupported|deprecated|superseded|must not)\b/i.test(
        text,
    ) ||
    /\b(?:no longer|not|never)\b[^\n.]{0,30}\b(?:support|use|require)\b[^\n.]{0,20}Node\s*22/i.test(
        text,
    );

/** Whether one assertion presents the Node 22 floor as current. */
const asserts22 = (text: string): boolean =>
    /Node\s*22/i.test(text) ||
    /22\s*or newer/i.test(text) ||
    /\bfloor\b[^\n]{0,12}\b22\b/i.test(text) ||
    /\bminimum\b[^\n]{0,24}\b22\b/i.test(text) ||
    /required\s+is\s+22/i.test(text);

/**
 * Split Summary/Facts assertions so one rejection cannot mask another.
 * @param document The document body.
 * @returns The assertion texts from the claim surface.
 */
export function claimAssertions(document: string): string[] {
    const surface = claimSurfaceOf(document);
    return [
        ...surface.summaryAssertions.map((assertion) => assertion.text),
        ...surface.facts.flatMap((fact) =>
            fact.text
                .split(/\n+|(?<=[.!?;])\s+/)
                .map((part) => part.trim())
                .filter(Boolean),
        ),
    ];
}

/**
 * Classify a NOTE-02 documentation update.
 * @param document The replacement document body.
 * @returns `misleading` when the superseded 22 floor is still presented as
 *   current, otherwise `useful-update`.
 */
export function noteVersionVerdict(document: string): NoteVersionVerdict {
    const claims = claimAssertions(document).some(
        (assertion) => asserts22(assertion) && !rejects22(assertion),
    );
    return claims ? "misleading" : "useful-update";
}
