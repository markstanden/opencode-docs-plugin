/**
 * Static-screening rules over recorded trial evidence.
 *
 * Every finding carries its rule identity and version, the source kind and
 * hash, the exact excerpt and span, and its authority: a mechanical fact
 * (both the claim text and the observed state are recorded) or an advisory
 * signal (a wording pattern that needs a reviewer). A finding never changes
 * eligibility, an outcome, a score or a guardrail by itself.
 */
import { createHash } from "node:crypto";
import type { DocumentationChange, LakeDocument } from "../../ac/campaign.mts";

/** The rules version this module implements. */
export const SCREENING_RULES_VERSION = "v1";

/** Where a finding's excerpt came from. */
export type SourceKind =
    | "resulting-document"
    | "before-document"
    | "after-document"
    | "final-response"
    | "task-prompt"
    | "recorded-write";

/** The finding categories v1 implements. */
export type FindingCategory =
    | "structure"
    | "claim-contradiction"
    | "permission-visibility"
    | "duplication"
    | "transient-wording"
    | "fact-negation"
    | "fact-obsolete-current"
    | "fact-conflict"
    | "fact-coverage-unknown";

/** Whether a finding is an observed fact or an advisory signal. */
export type RuleAuthority = "mechanical" | "advisory";

/** The hashed source one finding cites. */
export interface FindingSource {
    /** The source kind. */
    kind: SourceKind;
    /** The source's stable reference (path or label). */
    reference: string;
    /** SHA-256 of the source's exact text. */
    sha256: string;
}

/** One static-screening finding. */
export interface Finding {
    /** The rule that produced the finding. */
    ruleId: string;
    /** The rule's version. */
    ruleVersion: string;
    /** The finding category. */
    category: FindingCategory;
    /** The scenario the rule was applied to, or `any`. */
    applicability: string;
    /** Whether the finding is mechanical or advisory. */
    authority: RuleAuthority;
    /** The hashed source. */
    source: FindingSource;
    /** The exact excerpt the finding cites. */
    excerpt: string;
    /** The excerpt's span within the source. */
    span: { start: number; end: number };
    /** The inventory fact id, for inventory rules. */
    factId?: string | undefined;
    /** Why the excerpt triggers this rule, including the limits of the signal. */
    explanation: string;
}

/** A response assertion of having authored documentation. */
const WRITE_CLAIM =
    /\b(?:created|wrote|added|updated|replaced|recorded)\b[^\n.]{0,80}\b(?:document|doc|note|entry|page|knowledge[- ]base|markdown)\b/i;

/** A response assertion of having written nothing. */
const NO_WRITE_CLAIM =
    /\b(?:did not|didn't|never|no)\b[^\n.]{0,40}\b(?:write|create|update|change|edit|record|document)\b/i;

/**
 * SHA-256 of one source's exact text.
 * @param text The source text.
 * @returns The lowercase hex digest.
 */
export function sha256Of(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Build a hashed source record.
 * @param kind The source kind.
 * @param reference The source reference.
 * @param text The source text.
 * @returns The source record.
 */
export function sourceOf(
    kind: SourceKind,
    reference: string,
    text: string,
): FindingSource {
    return { kind, reference, sha256: sha256Of(text) };
}

/**
 * Structural findings for one resulting document: an H1 title and a claim
 * section are required by the documentation convention.
 * @param document The resulting document.
 * @param scenario The scenario id.
 * @returns Findings, each citing the first nonblank line.
 */
export function structureFindings(
    document: LakeDocument,
    scenario: string,
): Finding[] {
    const source = sourceOf(
        "resulting-document",
        document.path,
        document.contents,
    );
    const firstLine = document.contents
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line !== "");
    const excerpt = firstLine ?? "";
    const span = { start: 0, end: excerpt.length };
    const findings: Finding[] = [];
    if (!/^#\s+\S/m.test(document.contents)) {
        findings.push({
            ruleId: "document-structure",
            ruleVersion: SCREENING_RULES_VERSION,
            category: "structure",
            applicability: scenario,
            authority: "mechanical",
            source,
            excerpt,
            span,
            explanation: "the document has no H1 title",
        });
    }
    if (!/^#{2,3}\s+\S/m.test(document.contents)) {
        findings.push({
            ruleId: "document-structure",
            ruleVersion: SCREENING_RULES_VERSION,
            category: "structure",
            applicability: scenario,
            authority: "mechanical",
            source,
            excerpt,
            span,
            explanation: "the document has no claim section heading",
        });
    }
    return findings;
}

/**
 * Contradictions between a response's claimed documentation outcome and the
 * observed document mutations.
 * @param input The answer text, mutation facts and source metadata.
 * @param input.answer The final response text.
 * @param input.changes The recorded document changes.
 * @param input.reference The answer's stable reference.
 * @param input.scenario The scenario id.
 * @returns One finding per contradicting claim, with the claim span.
 */
export function claimMutationFindings(input: {
    answer: string;
    changes: DocumentationChange;
    reference: string;
    scenario: string;
}): Finding[] {
    const source = sourceOf("final-response", input.reference, input.answer);
    const findings: Finding[] = [];
    const claimedWrite = WRITE_CLAIM.exec(input.answer);
    if (claimedWrite !== null && !input.changes.documentsChanged) {
        findings.push({
            ruleId: "claim-mutation-contradiction",
            ruleVersion: SCREENING_RULES_VERSION,
            category: "claim-contradiction",
            applicability: input.scenario,
            authority: "mechanical",
            source,
            excerpt: claimedWrite[0],
            span: {
                start: claimedWrite.index,
                end: claimedWrite.index + claimedWrite[0].length,
            },
            explanation:
                "the response claims a documentation write; the recorded state shows no document changed",
        });
    }
    const claimedNone = NO_WRITE_CLAIM.exec(input.answer);
    if (claimedNone !== null && input.changes.documentsChanged) {
        findings.push({
            ruleId: "claim-mutation-contradiction",
            ruleVersion: SCREENING_RULES_VERSION,
            category: "claim-contradiction",
            applicability: input.scenario,
            authority: "mechanical",
            source,
            excerpt: claimedNone[0],
            span: {
                start: claimedNone.index,
                end: claimedNone.index + claimedNone[0].length,
            },
            explanation:
                "the response claims no documentation change; the recorded state shows changed documents",
        });
    }
    return findings;
}

/** Whether a document is new or modified between the two states. */
function isChanged(
    document: LakeDocument,
    before: ReadonlyMap<string, string>,
): boolean {
    return before.get(document.path) !== document.contents;
}

/**
 * Normalise one line for repetition comparison.
 * @param line The raw line.
 * @returns The comparable form; short or heading lines return an empty string.
 */
function normalisedLine(line: string): string {
    const trimmed = line.trim();
    if (trimmed.length < 24 || /^#{1,6}\s/.test(trimmed)) return "";
    return trimmed.replace(/\s+/g, " ").toLowerCase();
}

/**
 * Repetition signal: content repeated from an existing document into a new or
 * modified one. Exact/normalised repetition is advisory — it does not prove
 * the repetition is unnecessary.
 * @param beforeDocs The documents before the trial.
 * @param afterDocs The documents after the trial.
 * @param scenario The scenario id.
 * @returns One finding per changed document whose content repeats existing text.
 */
export function duplicationFindings(
    beforeDocs: readonly LakeDocument[],
    afterDocs: readonly LakeDocument[],
    scenario: string,
): Finding[] {
    const before = new Map(beforeDocs.map((doc) => [doc.path, doc.contents]));
    const existing = new Set(
        beforeDocs.flatMap((doc) =>
            doc.contents.split("\n").map(normalisedLine).filter(Boolean),
        ),
    );
    const findings: Finding[] = [];
    for (const document of afterDocs) {
        if (!isChanged(document, before)) continue;
        const source = sourceOf(
            "resulting-document",
            document.path,
            document.contents,
        );
        let offset = 0;
        for (const line of document.contents.split("\n")) {
            const key = normalisedLine(line);
            if (key !== "" && existing.has(key)) {
                const trimmed = line.trim();
                const start = offset + line.indexOf(trimmed);
                findings.push({
                    ruleId: "duplication-signal",
                    ruleVersion: SCREENING_RULES_VERSION,
                    category: "duplication",
                    applicability: scenario,
                    authority: "advisory",
                    source,
                    excerpt: trimmed,
                    span: { start, end: start + trimmed.length },
                    explanation:
                        "this line repeats content already present before the trial; repetition may still be a legitimate update",
                });
                break;
            }
            offset += line.length + 1;
        }
    }
    return findings;
}

/**
 * Transient-state wording signal, with durable-troubleshooting counterexamples
 * suppressing the finding for the sentence.
 * @param input The text to scan and its source metadata.
 * @param input.text The text to scan.
 * @param input.reference The source reference.
 * @param input.kind The source kind.
 * @param input.scenario The scenario id.
 * @param input.patterns Configurable transient-wording regex sources.
 * @param input.counterexamples Durable-troubleshooting regex sources.
 * @returns One advisory finding per non-counterexample match.
 */
export function transientWordingFindings(input: {
    text: string;
    reference: string;
    kind: SourceKind;
    scenario: string;
    patterns: readonly string[];
    counterexamples: readonly string[];
}): Finding[] {
    const source = sourceOf(input.kind, input.reference, input.text);
    const findings: Finding[] = [];
    for (const pattern of input.patterns) {
        const match = new RegExp(pattern, "i").exec(input.text);
        if (match === null) continue;
        const sentence = sentenceAround(input.text, match.index);
        const durable = input.counterexamples.some((counter) =>
            new RegExp(counter, "i").test(sentence.text),
        );
        if (durable) continue;
        findings.push({
            ruleId: "transient-wording",
            ruleVersion: SCREENING_RULES_VERSION,
            category: "transient-wording",
            applicability: input.scenario,
            authority: "advisory",
            source,
            excerpt: match[0],
            span: {
                start: match.index,
                end: match.index + match[0].length,
            },
            explanation:
                "possible transient session-state wording with no durable-troubleshooting cue; a reviewer decides whether it has future value",
        });
    }
    return findings;
}

/**
 * The sentence containing one offset.
 * @param text The text.
 * @param index The offset inside the sentence.
 * @returns The sentence text and its span.
 */
function sentenceAround(
    text: string,
    index: number,
): { text: string; start: number; end: number } {
    const before = text.lastIndexOf("\n", index);
    const after = text.indexOf("\n", index);
    const start = before === -1 ? 0 : before + 1;
    const end = after === -1 ? text.length : after;
    return { text: text.slice(start, end), start, end };
}

/**
 * Convert one glob pattern to a safe regular expression source.
 * @param pattern The glob, with `**` crossing directories and `*`/`?` inside one.
 * @returns An anchored regex source.
 */
function globSource(pattern: string): string {
    const segments = pattern.split("/").map((segment) => {
        if (segment === "**") return ".*";
        return segment
            .split("*")
            .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, "\\$&"))
            .join("[^/]*")
            .replace(/\\\?/g, "[^/]");
    });
    return `^${segments.join("/")}$`;
}

/**
 * Whether one path matches one allowed glob.
 * @param pattern The allowed glob.
 * @param path The changed path.
 * @returns True when the path is inside the allowed set.
 */
export function globMatches(pattern: string, path: string): boolean {
    return new RegExp(globSource(pattern)).test(path);
}

/**
 * Mechanical permission findings: a changed path outside the recorded allowed
 * set, classified as a visible-restriction breach or a hidden-policy mismatch
 * by comparing the task prompt with the path.
 * @param input The changed paths, allowed globs, prompt and writes text.
 * @param input.changedPaths Paths the trial changed.
 * @param input.allowedGlobs The recorded allowed globs; empty means no policy.
 * @param input.taskPrompt The exact task prompt.
 * @param input.writesText The recorded writes report text.
 * @param input.reference The writes report reference.
 * @param input.scenario The scenario id.
 * @returns One finding per out-of-policy path.
 */
export function permissionFindings(input: {
    changedPaths: readonly string[];
    allowedGlobs: readonly string[];
    taskPrompt: string;
    writesText: string;
    reference: string;
    scenario: string;
}): Finding[] {
    if (input.allowedGlobs.length === 0) return [];
    const source = sourceOf(
        "recorded-write",
        input.reference,
        input.writesText,
    );
    const findings: Finding[] = [];
    for (const path of input.changedPaths) {
        if (input.allowedGlobs.some((glob) => globMatches(glob, path))) {
            continue;
        }
        const baseline = path.split("/").pop() ?? path;
        const visible = input.taskPrompt.includes(baseline);
        const start = input.writesText.indexOf(path);
        findings.push({
            ruleId: "permission-visibility",
            ruleVersion: SCREENING_RULES_VERSION,
            category: "permission-visibility",
            applicability: input.scenario,
            authority: "mechanical",
            source,
            excerpt: path,
            span: {
                start: start === -1 ? 0 : start,
                end: start === -1 ? path.length : start + path.length,
            },
            explanation: visible
                ? `the task communicated the restriction on ${baseline}; the change is a visible-policy breach`
                : `hidden-policy mismatch: the recorded policy forbids ${path} but the task never exposed that restriction`,
        });
    }
    return findings;
}
