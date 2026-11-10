// Derived rule for the NOTE-02 partial-fix dispute. A documentation update that
// presents the superseded Node 22 floor as the supported/current contract in
// its Summary or Facts is misleading; a completed Node 24 migration is a
// useful update. The rule is deliberately scoped to Summary and Facts so a
// correct "failed approach: major !== 22" note is not punished.
const rejects22 = (text) =>
    /Node\s*22[^\n.]{0,50}\b(?:no longer|not|never|unsupported|deprecated|superseded|must not)\b/i.test(
        text,
    ) ||
    /\b(?:no longer|not|never)\b[^\n.]{0,30}\b(?:support|use|require)\b[^\n.]{0,20}Node\s*22/i.test(
        text,
    );

const claims22 = (text) =>
    !rejects22(text) &&
    (/Node\s*22/i.test(text) ||
        /22\s*or newer/i.test(text) ||
        /\bfloor\b[^\n]{0,12}\b22\b/i.test(text) ||
        /\bminimum\b[^\n]{0,24}\b22\b/i.test(text) ||
        /required\s+is\s+22/i.test(text));

/** The Summary line and `### Facts` bullets of a knowledge document. */
export function claimSurface(document) {
    const lines = document.split("\n");
    const summary = lines.find((line) => /^Summary:/i.test(line)) ?? "";
    const start = lines.findIndex((line) =>
        /^###\s+Facts\s*$/i.test(line.trim()),
    );
    const facts = [];
    if (start >= 0) {
        for (const line of lines.slice(start + 1)) {
            if (/^###?\s+/.test(line.trim())) break;
            if (/^\s*[-*]\s+/.test(line)) facts.push(line);
        }
    }
    return `${summary}\n${facts.join("\n")}`;
}

/**
 * Classify a NOTE-02 documentation update.
 * @param document The replacement document body.
 * @returns `misleading` when the superseded 22 floor is still current,
 *   otherwise `useful-update`.
 */
export function noteVersionVerdict(document) {
    return claims22(claimSurface(document)) ? "misleading" : "useful-update";
}
