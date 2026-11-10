// Deterministic *screen* for R02 preservation. It can reject an explicit
// contradiction or an obsolete current claim, and it can recognise a small set
// of equivalents. A keyword pass is NOT authoritative: every R02 update also
// needs an evidence-based semantic review (see the published review asset).
const VALID = {
    "pool maximum of 10": {
        pattern:
            /\b(?:max(?:imum)?|pool|connections?)\b[^\n.]{0,60}\b(?:10|ten)\b|\b(?:10|ten)\b[^\n.]{0,60}\b(?:connections?|pool)\b/i,
    },
    "5-second acquire timeout": {
        pattern:
            /\b(?:acquire|acquiring|wait|waits|timeout|connection)\b[^\n.]{0,60}\b(?:5|five)\s*(?:\.0)?\s*(?:s\b|sec(?:ond)?s?\b|ms\b|milliseconds?)\b|\b(?:5|five)\s*(?:\.0)?\s*(?:s\b|sec(?:ond)?s?\b|ms\b|milliseconds?)\b[^\n.]{0,60}\b(?:acquire|acquiring|wait|waits|timeout|connection)\b|\b5000\s*(?:ms|milliseconds?)\b/i,
    },
    "startup migrations": { pattern: /\bmigrat/i },
};

const OBSOLETE_CURRENT =
    /(?:sslmode\s*=\s*disable|ssl[^\n.]{0,20}\bdisable\b)/i;

const NEGATED =
    /\b(?:no longer|not|never|unsupported|deprecated|superseded|must not|do not use|removed|obsolete)\b/i;

/** The `### Facts` bullets of a knowledge document. */
export function factsBullets(document) {
    const lines = document.split("\n");
    const start = lines.findIndex((line) =>
        /^###\s+Facts\s*$/i.test(line.trim()),
    );
    if (start < 0) return [];
    const bullets = [];
    for (const line of lines.slice(start + 1)) {
        if (/^###?\s+/.test(line.trim())) break;
        if (/^\s*[-*]\s+/.test(line))
            bullets.push(line.replace(/^\s*[-*]\s+/, ""));
    }
    return bullets;
}

/**
 * Screen a replacement note against the R02 fact inventory. This is a
 * pre-check, not the authoritative guardrail: `accepted` still requires the
 * semantic review recorded in the published review asset.
 * @param after The replacement document body.
 * @returns `rejected` on a contradiction/obsolete current claim, `unknown`
 *   when a valid fact is absent, otherwise `accepted` for semantic review.
 */
export function preservationScreen(after) {
    const facts = factsBullets(after);
    const text = facts.join("\n");
    const contradicted = [
        ...new Set(
            facts
                .filter((fact) => NEGATED.test(fact))
                .flatMap((fact) =>
                    Object.entries(VALID)
                        .filter(([, entry]) => entry.pattern.test(fact))
                        .map(([name]) => name),
                ),
        ),
    ];
    const obsolete = facts.some(
        (fact) => OBSOLETE_CURRENT.test(fact) && !NEGATED.test(fact),
    );
    const missing = Object.entries(VALID)
        .filter(([, entry]) => !entry.pattern.test(text))
        .map(([name]) => name);
    if (obsolete)
        return {
            status: "rejected",
            missing,
            obsolete: true,
            contradicted: [],
            requiresSemanticReview: true,
        };
    if (contradicted.length > 0)
        return {
            status: "rejected",
            missing,
            obsolete: false,
            contradicted,
            requiresSemanticReview: true,
        };
    if (missing.length > 0)
        return {
            status: "unknown",
            missing,
            obsolete: false,
            contradicted: [],
            requiresSemanticReview: true,
        };
    return {
        status: "accepted",
        missing: [],
        obsolete: false,
        contradicted: [],
        requiresSemanticReview: true,
    };
}
