/**
 * Reconciliation between static-screen findings and the recorded judge layer.
 *
 * A screen finding is not a verdict: this module reports whether the judge's
 * reason or evidence text references the finding, and keeps the two layers
 * distinct. Exact-text reference is deliberately conservative — a paraphrase
 * counts as not referenced, and a short excerpt cannot establish anything.
 */
import type { EvidenceRole, Finding, TrialIdentity } from "./rules.ts";

/** The judge text a reconciliation reads. */
export interface JudgementText {
    /** The judgement's stated reason. */
    reason: string;
    /** The judgement's evidence quotes. */
    evidence: string[];
}

/** One finding's reconciliation status against the judge layer. */
export interface ReconcileRow {
    /** The finding's rule id. */
    ruleId: string;
    /** The finding's inventory fact id, when present. */
    factId: string | undefined;
    /** The trial the finding came from. */
    trial: TrialIdentity;
    /** The evidence role the finding cites. */
    role: EvidenceRole;
    /** The finding's root-relative source reference. */
    source: string;
    /** Whether the judge text references the finding's excerpt. */
    status: "referenced" | "not-referenced" | "unresolved";
}

/**
 * Normalise text for conservative excerpt comparison.
 * @param text The text to normalise.
 * @returns Lowercase words with markdown punctuation collapsed.
 */
function normalise(text: string): string {
    return text
        .toLowerCase()
        .replace(/[`*_#|]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Reconcile screen findings with one judgement layer.
 * @param findings The screen findings.
 * @param judgement The selected judgement's reason and evidence, when judged.
 * @returns One row per finding: referenced, not-referenced or unresolved.
 */
export function reconcileFindings(
    findings: readonly Finding[],
    judgement: JudgementText | undefined,
): ReconcileRow[] {
    const rows = findings.map((finding) => ({
        ruleId: finding.ruleId,
        factId: finding.factId,
        trial: finding.trial,
        role: finding.role,
        source: finding.source.reference,
        status: "unresolved" as ReconcileRow["status"],
    }));
    if (judgement === undefined) return rows;
    const text = normalise([judgement.reason, ...judgement.evidence].join(" "));
    return findings.map((finding, index) => {
        const excerpt = normalise(finding.excerpt);
        const status: ReconcileRow["status"] =
            excerpt.length < 8
                ? "unresolved"
                : text.includes(excerpt)
                  ? "referenced"
                  : "not-referenced";
        return { ...rows[index]!, status };
    });
}
