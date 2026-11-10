// Preservation rule for R02. The valid pool facts must survive in any faithful
// wording; the obsolete TLS claim must not remain a current fact. The check is
// deliberately semantic-presence, not exact wording.
const VALID = {
    "pool maximum of 10": /\b(?:max(?:imum)?|pool|connections?)\b[^\n.]{0,60}\b(?:10|ten)\b|\b(?:10|ten)\b[^\n.]{0,60}\b(?:connections?|pool)\b/i,
    "5-second acquire timeout": /\b(?:5|five)\s*(?:\.0)?\s*(?:s\b|sec(?:ond)?s?\b)|\bfive seconds?\b/i,
    "startup migrations": /\bmigrat/i,
};

const OBSOLETE_CURRENT =
    /(?:sslmode\s*=\s*disable|ssl[^\n.]{0,20}\bdisable\b)/i;

const NEGATED = /\b(?:no longer|obsolete|previously|used to|removed|not|never|instead of|replaced)\b/i;

/** The `### Facts` bullets of a knowledge document. */
export function factsBullets(document) {
    const lines = document.split("\n");
    const start = lines.findIndex((line) => /^###\s+Facts\s*$/i.test(line.trim()));
    if (start < 0) return [];
    const bullets = [];
    for (const line of lines.slice(start + 1)) {
        if (/^###?\s+/.test(line.trim())) break;
        if (/^\s*[-*]\s+/.test(line)) bullets.push(line.replace(/^\s*[-*]\s+/, ""));
    }
    return bullets;
}

/**
 * Decide whether a replacement note preserves every still-valid R02 fact and
 * drops the obsolete TLS claim.
 * @param after The replacement document body.
 * @returns The missing valid facts and whether the obsolete claim survives.
 */
export function preservationVerdict(after) {
    const facts = factsBullets(after);
    const text = facts.join("\n");
    const missing = Object.entries(VALID)
        .filter(([, pattern]) => !pattern.test(text))
        .map(([name]) => name);
    const obsolete = facts.some(
        (fact) => OBSOLETE_CURRENT.test(fact) && !NEGATED.test(fact),
    );
    return { missing, obsolete, accepted: missing.length === 0 && !obsolete };
}
