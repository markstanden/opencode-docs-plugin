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
            /\b(?:acquire|acquiring|wait|waits|timeout|connection)\b[^\n.]{0,60}\b(?:5|five)\s*(?:(?:\.0)\s*)?(?:s\b|sec(?:ond)?s?\b|ms\b|milliseconds?)\b|\b(?:5|five)\s*(?:(?:\.0)\s*)?(?:s\b|sec(?:ond)?s?\b|ms\b|milliseconds?)\b[^\n.]{0,60}\b(?:acquire|acquiring|wait|waits|timeout|connection)\b|\b5000\s*(?:ms|milliseconds?)\b/i,
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
 * Split one fact bullet into independently evaluated assertions. A negation
 * in one clause must not condemn an adjacent affirmative clause; the original
 * bullet is still retained in any trigger for review.
 * @param fact One `### Facts` bullet.
 * @returns The nonblank assertions.
 */
export function assertionsOf(fact) {
    return fact
        .split(/;\s*|\.\s+(?=[A-Z`])/)
        .map((one) => one.trim())
        .filter((one) => one !== "");
}

/** The first match of a pattern in an assertion, with its text and index. */
function spanOf(pattern, assertion) {
    const match = pattern.exec(assertion);
    return match === null ? null : { text: match[0], index: match.index };
}

/**
 * Classify every assertion in the fact bullets into contradiction and
 * obsolete-current triggers, retaining the full bullet and matched spans.
 */
function scanAssertions(facts) {
    const contradictions = [];
    const obsoleteTriggers = [];
    for (const bullet of facts) {
        for (const assertion of assertionsOf(bullet)) {
            const negation = spanOf(NEGATED, assertion);
            for (const [fact, entry] of Object.entries(VALID)) {
                const factSpan = spanOf(entry.pattern, assertion);
                if (negation !== null && factSpan !== null) {
                    contradictions.push({
                        kind: "contradicted",
                        fact,
                        bullet,
                        assertion,
                        negatedSpan: negation.text,
                        factSpan: factSpan.text,
                    });
                }
            }
            const obsoleteSpan = spanOf(OBSOLETE_CURRENT, assertion);
            if (obsoleteSpan !== null && negation === null) {
                obsoleteTriggers.push({
                    kind: "obsolete-current",
                    bullet,
                    assertion,
                    obsoleteSpan: obsoleteSpan.text,
                });
            }
        }
    }
    return { contradictions, obsoleteTriggers };
}

/**
 * Screen a replacement note against the R02 fact inventory. This is a
 * pre-check, not the authoritative guardrail: `accepted` still requires the
 * semantic review recorded in the published review asset.
 * @param after The replacement document body.
 * @returns `rejected` on a contradiction/obsolete current claim, `unknown`
 *   when a valid fact is absent, otherwise `accepted` for semantic review.
 *   Any rejection carries `triggers` with the full bullet, the evaluated
 *   assertion and the matched spans, so a neighbouring negation is visible.
 */
export function preservationScreen(after) {
    const facts = factsBullets(after);
    const text = facts.join("\n");
    const { contradictions, obsoleteTriggers } = scanAssertions(facts);
    const contradicted = [...new Set(contradictions.map((one) => one.fact))];
    const obsolete = obsoleteTriggers.length > 0;
    const missing = Object.entries(VALID)
        .filter(([, entry]) => !entry.pattern.test(text))
        .map(([name]) => name);
    if (obsolete)
        return {
            status: "rejected",
            missing,
            obsolete: true,
            contradicted: [],
            triggers: obsoleteTriggers,
            requiresSemanticReview: true,
        };
    if (contradicted.length > 0)
        return {
            status: "rejected",
            missing,
            obsolete: false,
            contradicted,
            triggers: contradictions,
            requiresSemanticReview: true,
        };
    if (missing.length > 0)
        return {
            status: "unknown",
            missing,
            obsolete: false,
            contradicted: [],
            triggers: [],
            requiresSemanticReview: true,
        };
    return {
        status: "accepted",
        missing: [],
        obsolete: false,
        contradicted: [],
        triggers: [],
        requiresSemanticReview: true,
    };
}
