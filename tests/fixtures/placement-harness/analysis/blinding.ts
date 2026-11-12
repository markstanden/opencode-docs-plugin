/**
 * Blinding checks for the trial child and the judge packet.
 *
 * The A/B description difference is the treatment and must survive. What must
 * not cross either boundary is the arm's identity or mapping: an arm label, an
 * arm-specific worktree path or commit, or a revealing stamp such as
 * `pd-A-r0-S02`.
 */

/** One detected exposure. */
export interface BlindingFinding {
    /** The field or value that carried the leak. */
    field: string;
    /** The matched fragment, never a whole secret. */
    fragment: string;
}

/** Patterns that reveal an arm rather than the treatment. */
const ARM_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
    { label: "stamp", pattern: /pd-[AB]-r\d/ },
    { label: "arm-path", pattern: /(?:^|[^A-Za-z0-9])arms?[/_-][ab](?:[^A-Za-z0-9]|$)/i },
    { label: "arm-flag", pattern: /(?:^|[^A-Za-z0-9])arm[-_ ]?[ab](?:[^A-Za-z0-9]|$)/i },
];

/**
 * Find arm-revealing fragments in one value.
 * @param field The field or path the value came from.
 * @param value The inspected text.
 * @returns One finding per matched pattern, with only the matched fragment.
 */
export function blindingFindings(
    field: string,
    value: string,
): BlindingFinding[] {
    const findings: BlindingFinding[] = [];
    for (const { label, pattern } of ARM_PATTERNS) {
        const match = pattern.exec(value);
        if (match === null) continue;
        findings.push({ field, fragment: `${label}:${match[0].trim()}` });
    }
    return findings;
}

/**
 * Inspect trial-child environment entries.
 *
 * Provenance variables differ per arm (the plugin commit and dirty flag), so
 * they are arm-revealing at the trial boundary; the caller keeps them in the
 * outer harness instead. Image and fixture identities are identical for both
 * arms and allowed.
 * @param env The environment the trial container receives.
 * @returns Every exposure found.
 */
export function trialEnvFindings(
    env: Readonly<Record<string, string | undefined>>,
): BlindingFinding[] {
    const findings: BlindingFinding[] = [];
    for (const [key, value] of Object.entries(env)) {
        if (
            (key === "PLACEMENT_PLUGIN_COMMIT" ||
                key === "PLACEMENT_PLUGIN_DIRTY") &&
            value !== undefined &&
            value !== ""
        ) {
            findings.push({ field: key, fragment: "arm-specific provenance" });
        }
        if (value !== undefined && value !== "") {
            findings.push(...blindingFindings(key, value));
        }
    }
    return findings;
}

/**
 * Inspect every string field of a nested judge-packet object.
 * @param packet The packet value, already parsed when it is JSON.
 * @param prefix The dotted path accumulated so far.
 * @returns Every exposure found in keys or values.
 */
export function packetFindings(
    packet: unknown,
    prefix = "packet",
): BlindingFinding[] {
    if (typeof packet === "string") return blindingFindings(prefix, packet);
    if (Array.isArray(packet)) {
        return packet.flatMap((entry, index) =>
            packetFindings(entry, `${prefix}[${String(index)}]`),
        );
    }
    if (typeof packet !== "object" || packet === null) return [];
    return Object.entries(packet).flatMap(([key, value]) => [
        ...blindingFindings(`${prefix}.${key}`, key),
        ...packetFindings(value, `${prefix}.${key}`),
    ]);
}
