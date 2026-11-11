/**
 * Stable reporting for the analysis framework.
 *
 * One structured result renders both the versioned machine-readable analysis
 * and the Markdown report, so the numbers and the decision wording cannot
 * drift apart. Rendering is deterministic for identical input; the render
 * timestamp is injected and recorded separately from any execution time.
 * Markdown cells are escaped so evidence text cannot corrupt a table.
 */
import type {
    DocumentationOutcome,
    SensitivityCell,
    UtilityWeights,
} from "../ac-scoring.mts";
import type { AccountingCounts } from "./accounting.ts";
import type { Interval } from "./bounds.ts";
import type { DecisionResult } from "./decision.ts";
import type { GuardrailArmSummary } from "./guardrails.ts";
import type { GuardrailSpec, SelectionSpec } from "./model.ts";
import type { PairedComparison } from "./pairing.ts";
import type { Finding } from "./screening/rules.ts";
import type { ReconcileRow } from "./screening/reconcile.ts";

/** The analyser implementation identity. */
export const ANALYSER_VERSION = "analysis-framework/1";

/** The report template this renderer follows. */
export const REPORT_TEMPLATE_VERSION = "trial-feedback-report/2026-11-10";

/** One arm's report block. */
export interface AnalysisArmReport {
    /** The arm's accounting counts. */
    accounting: AccountingCounts;
    /** The arm's full-population utility interval. */
    interval: Interval;
    /** The arm's guardrail summaries. */
    guardrails: GuardrailArmSummary[];
}

/** The pairing summary included in the report. */
export interface PairingSummary {
    /** Declared pairs. */
    pairs: number;
    /** Pairs with every arm assessed. */
    completePairs: number;
    /** Assessed observations in incomplete pairs. */
    unmatched: Array<{
        stamp: string;
        arm: string;
        scenario: string;
        score: number;
    }>;
    /** Observations outside any declared pair. */
    unpaired: number;
    /** Evidence problems found while pairing. */
    problems: string[];
}

/** Captured token usage, with explicit measured/unknown counts. */
export interface UsageSummary {
    /** Input tokens over measured trials, or null when none was measured. */
    input: number | null;
    /** Output tokens over measured trials, or null when none was measured. */
    output: number | null;
    /** Reasoning tokens over measured trials, or null when none was measured. */
    reasoning: number | null;
    /** Cache-read tokens over measured trials, or null when none was measured. */
    cacheRead: number | null;
    /** Recorded steps over measured trials, or null when none was measured. */
    steps: number | null;
    /** Trials with readable token telemetry. */
    measured: number;
    /** Trials without readable token telemetry. */
    unknown: number;
}

/** Cost availability: token telemetry is not a monetary cost. */
export interface CostSummary {
    /** Whether a recorded cost exists; this analyser records none. */
    available: false;
    /** Why the cost is unavailable. */
    note: string;
}

/** The reconciled attempt-ledger summary. */
export interface LedgerSummary {
    /** The ledger's stable root-relative reference. */
    reference: string;
    /** Whether the ledger was readable. */
    state: "available" | "missing" | "malformed";
    /** Event counts keyed by recorded event name. */
    events: Record<string, number>;
    /** Scheduled slots the campaign declared. */
    scheduled: number;
    /** Scheduled slots with a recorded launch. */
    launched: number;
    /** Scheduled slots with a recorded judge attempt. */
    judged: number;
    /** Scheduled slots with no recorded launch. */
    missingLaunches: string[];
    /** Scheduled slots with no recorded judge attempt. */
    missingJudgeAttempts: string[];
    /** Ledger stamps outside the declared schedule. */
    unknownStamps: string[];
    /** Stamps with more than one recorded launch. */
    duplicateLaunches: string[];
    /** Loading and reconciliation problems. */
    problems: string[];
}

/** The structured analysis result: the single source for every rendering. */
export interface AnalysisResult {
    /** The analysis schema version. */
    analysisVersion: string;
    /** The campaign identity. */
    campaign: { id: string; question: string | null };
    /** SHA-256 of the manifest bytes. */
    manifestSha256: string;
    /** The evidence layout adapter. */
    layout: string;
    /** The recorded judgement-layer policy. */
    selectionPolicy: string;
    /** The frozen policy identity. */
    policyId: string;
    /** The frozen utility weights. */
    weights: UtilityWeights;
    /** The declared guardrails. */
    guardrails: GuardrailSpec[];
    /** The declared selection rule, when present. */
    selection: SelectionSpec | null;
    /** Per-arm reports. */
    arms: Record<string, AnalysisArmReport>;
    /** Per-arm, per-scenario accounting. */
    scenarios: Record<string, Record<string, AccountingCounts>>;
    /** The whole measured population. */
    totals: AccountingCounts;
    /** The pairing summary. */
    pairing: PairingSummary;
    /** The candidate-minus-control comparison, when a rule is declared. */
    paired: PairedComparison | null;
    /** Full-population candidate-minus-control interval, when a rule is declared. */
    bounds: { delta: Interval | null };
    /** The three-limb decision. */
    decision: DecisionResult;
    /** The sensitivity grid, when the campaign froze one. */
    sensitivity: SensitivityCell[] | null;
    /** Static-screen findings and their reconciliation, kept advisory. */
    screening: {
        rulesVersion: string;
        findings: Finding[];
        reconciliation: ReconcileRow[];
    };
    /** Integrity identities. */
    integrity: {
        sources: Array<{ reference: string; sha256: string }>;
        judgedBy: string[];
    };
    /** Captured token usage; never an invented zero. */
    usage: UsageSummary;
    /** Monetary cost availability. */
    cost: CostSummary;
    /** The reconciled attempt ledger, when the campaign declared one. */
    ledger: LedgerSummary | null;
    /** Explicit limitations, rendered verbatim. */
    limitations: string[];
}

/** The receipt written beside the analysis. */
export interface AnalysisReceipt {
    /** The analyser identity. */
    analyserVersion: string;
    /** The report template identity. */
    templateVersion: string;
    /** SHA-256 of the manifest bytes. */
    manifestSha256: string;
    /** The frozen policy identity. */
    policyId: string;
    /** The injected rendering timestamp. */
    renderedAt: string;
    /** Every consumed input with its identity and explicit state, sorted. */
    inputs: Array<{
        reference: string;
        sha256: string | null;
        state: "available" | "missing";
    }>;
}

/**
 * Escape one Markdown table cell.
 * @param value The raw cell value.
 * @returns The escaped, single-line value.
 */
export function escapeCell(value: unknown): string {
    return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** Render one table from headers and rows. */
function table(headers: readonly string[], rows: readonly string[][]): string {
    const lines = [
        `| ${headers.map(escapeCell).join(" | ")} |`,
        `| ${headers.map(() => "---").join(" | ")} |`,
        ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
    ];
    return lines.join("\n");
}

/** A number or an em dash for an absent/unknown value. */
function num(value: number | null | undefined): string {
    return value === null || value === undefined ? "—" : String(value);
}

/** Outcome count summary. */
const OUTCOME_ORDER: readonly DocumentationOutcome[] = [
    "useful-create",
    "useful-update",
    "transient",
    "duplicate",
    "misleading",
    "none",
];

/**
 * Render the setup section.
 * @param result The analysis result.
 * @returns Markdown.
 */
function setupSection(result: AnalysisResult): string {
    const selection = result.selection;
    return [
        "## Frozen setup",
        "",
        table(
            ["Item", "Value"],
            [
                ["Manifest SHA-256", result.manifestSha256],
                ["Evidence layout", result.layout],
                ["Judgement selection policy", result.selectionPolicy],
                ["Policy identity", result.policyId],
                [
                    "Weights",
                    `useful ${result.weights.useful}, transient ${result.weights.transient}, duplicate ${result.weights.duplicate}, misleading ${result.weights.misleading}, taskFailure ${result.weights.taskFailure}`,
                ],
                [
                    "Selection rule",
                    selection === null
                        ? "Not defined"
                        : `control ${selection.controlArm}, candidate ${selection.candidateArm}, threshold ${selection.threshold}, complete coverage ${selection.requireCompleteCoverage}`,
                ],
                [
                    "Guardrails",
                    result.guardrails.length === 0
                        ? "Not defined"
                        : result.guardrails
                              .map(
                                  (guardrail) =>
                                      `${guardrail.id} (${guardrail.kind})`,
                              )
                              .join("; "),
                ],
            ],
        ),
        "",
    ].join("\n");
}

/**
 * Render the accounting section.
 * @param result The analysis result.
 * @returns Markdown.
 */
function accountingSection(result: AnalysisResult): string {
    const rows = Object.entries(result.arms).map(([arm, report]) => {
        const counts = report.accounting;
        return [
            arm,
            num(counts.planned),
            num(counts.recordedLaunches),
            num(counts.completed),
            num(counts.documented),
            num(counts.assessed),
            `${num(counts.gate.pass)}/${num(counts.gate.blocked)}`,
            `${num(counts.primary.pass)}/${num(counts.primary.fail)}/${num(counts.primary.unknown)}`,
            num(counts.utilityTotal),
            `${num(report.interval.low)}..${num(report.interval.high)}`,
        ];
    });
    const outcomeRows = Object.entries(result.arms).map(([arm, report]) => [
        arm,
        ...OUTCOME_ORDER.map((outcome) =>
            num(report.accounting.outcomes[outcome]),
        ),
    ]);
    return [
        "## Accounting",
        "",
        table(
            [
                "Arm",
                "Planned",
                "Recorded",
                "Completed",
                "Documented",
                "Scored",
                "Gate pass/blocked",
                "Primary P/F/U",
                "Utility",
                "Interval",
            ],
            rows,
        ),
        "",
        "Intervals are worst-case missing-data bounds, not confidence intervals.",
        "",
        table(["Arm", ...OUTCOME_ORDER], outcomeRows),
        "",
    ].join("\n");
}

/**
 * Render the per-scenario section.
 * @param result The analysis result.
 * @returns Markdown.
 */
function scenarioSection(result: AnalysisResult): string {
    const rows: string[][] = [];
    for (const [arm, scenarios] of Object.entries(result.scenarios)) {
        for (const [scenario, counts] of Object.entries(scenarios)) {
            rows.push([
                arm,
                scenario,
                num(counts.planned),
                num(counts.documented),
                num(counts.assessed),
                `${num(counts.gate.pass)}/${num(counts.gate.blocked)}`,
                num(counts.utilityTotal),
            ]);
        }
    }
    return [
        "## Per scenario",
        "",
        table(
            [
                "Arm",
                "Scenario",
                "Planned",
                "Documented",
                "Scored",
                "Gate P/B",
                "Utility",
            ],
            rows,
        ),
        "",
    ].join("\n");
}

/**
 * Render the pair section.
 * @param result The analysis result.
 * @returns Markdown.
 */
function pairSection(result: AnalysisResult): string {
    const lines = [
        "## Complete pairs and unmatched observations",
        "",
        `Declared pairs: ${num(result.pairing.pairs)}; complete pairs: ${num(result.pairing.completePairs)}; unmatched observations: ${num(result.pairing.unmatched.length)}; unpaired evidence: ${num(result.pairing.unpaired)}.`,
        "",
    ];
    if (result.pairing.unmatched.length > 0) {
        lines.push(
            table(
                ["Stamp", "Arm", "Scenario", "Observation score"],
                result.pairing.unmatched.map((row) => [
                    row.stamp,
                    row.arm,
                    row.scenario,
                    String(row.score),
                ]),
            ),
            "",
        );
    }
    if (result.pairing.problems.length > 0) {
        lines.push("Pairing problems:", "");
        lines.push(...result.pairing.problems.map((problem) => `- ${problem}`));
        lines.push("");
    }
    if (result.paired !== null) {
        lines.push(
            `Paired comparison: ${num(result.paired.completePairs)} pairs, control better ${num(result.paired.controlBetter)}, candidate better ${num(result.paired.candidateBetter)}, ties ${num(result.paired.ties)}; delta ${num(result.paired.delta)} (interval ${num(result.paired.interval.low)}..${num(result.paired.interval.high)}).`,
            "",
        );
    }
    if (result.bounds.delta !== null) {
        lines.push(
            `Full-population candidate-minus-control interval: ${num(result.bounds.delta.low)}..${num(result.bounds.delta.high)} (worst case, not a confidence interval).`,
            "",
        );
    }
    return lines.join("\n");
}

/**
 * Render the guardrail section.
 * @param result The analysis result.
 * @returns Markdown.
 */
function guardrailSection(result: AnalysisResult): string {
    const rows: string[][] = [];
    for (const [arm, report] of Object.entries(result.arms)) {
        for (const summary of report.guardrails) {
            rows.push([
                arm,
                summary.guardrailId,
                summary.status,
                `pass ${summary.coverage.pass}, fail ${summary.coverage.fail}, unknown ${summary.coverage.unknown}, n/a ${summary.coverage["not-applicable"]}`,
                summary.evidence.slice(0, 3).join("; ") || "—",
            ]);
        }
    }
    return [
        "## Guardrails",
        "",
        table(["Arm", "Guardrail", "Status", "Coverage", "Evidence"], rows),
        "",
    ].join("\n");
}

/**
 * Render the static-screen section.
 * @param result The analysis result.
 * @returns Markdown.
 */
function screeningSection(result: AnalysisResult): string {
    const counted = { referenced: 0, "not-referenced": 0, unresolved: 0 };
    for (const row of result.screening.reconciliation) counted[row.status] += 1;
    const rows = result.screening.findings
        .slice(0, 40)
        .map((finding) => [
            finding.ruleId,
            finding.trial.stamp,
            finding.role,
            finding.source.reference,
            finding.excerpt === "" ? "(no excerpt)" : finding.excerpt,
            finding.explanation,
        ]);
    return [
        "## Static screen (advisory; never changes outcomes)",
        "",
        `Rules ${result.screening.rulesVersion}: ${num(result.screening.findings.length)} finding(s). Judge reconciliation: referenced ${num(counted.referenced)}, not-referenced ${num(counted["not-referenced"])}, unresolved ${num(counted.unresolved)}.`,
        "",
        rows.length === 0
            ? "No findings."
            : table(
                  ["Rule", "Trial", "Role", "Source", "Excerpt", "Explanation"],
                  rows,
              ),
        "",
        "A missing keyword does not prove a lost fact; a matching keyword does not prove truth. Findings are screened independently of the judge and never alter eligibility, outcomes, scores or guardrails.",
        "",
    ].join("\n");
}

/**
 * Render the sensitivity section.
 * @param result The analysis result.
 * @returns Markdown.
 */
function sensitivitySection(result: AnalysisResult): string {
    if (result.sensitivity === null || result.sensitivity.length === 0) {
        return "## Sensitivity\n\nNot defined.\n";
    }
    const arms = Object.keys(result.arms).sort();
    const rows = result.sensitivity.map((cell) => [
        num(cell.useful),
        num(cell.transient),
        ...arms.map((arm) => num(cell.totals[arm])),
        cell.ranking.join(" > "),
    ]);
    return [
        "## Sensitivity",
        "",
        table(["Useful", "Transient", ...arms, "Ranking"], rows),
        "",
        "The grid describes this sample; it is not a set of experiments and it does not repair missing assessments.",
        "",
    ].join("\n");
}

/**
 * Render one ledger summary line, or an explicit absence.
 * @param ledger The ledger summary, when one was declared.
 * @returns Markdown lines.
 */
function ledgerLines(ledger: LedgerSummary | null): string[] {
    if (ledger === null) {
        return ["Attempt ledger: not declared."];
    }
    if (ledger.state !== "available") {
        return [
            `Attempt ledger ${ledger.reference}: ${ledger.state}. Launch and judge-attempt coverage is unknown, not clean.`,
        ];
    }
    const events = Object.entries(ledger.events)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([event, count]) => `${event} ${count}`)
        .join(", ");
    const lines = [
        `Attempt ledger ${ledger.reference}: ${String(ledger.scheduled)} scheduled, ${String(ledger.launched)} launched, ${String(ledger.judged)} judge-attempted; events: ${events}.`,
    ];
    if (ledger.missingLaunches.length > 0) {
        lines.push(`Missing launches: ${ledger.missingLaunches.join(", ")}.`);
    }
    if (ledger.missingJudgeAttempts.length > 0) {
        lines.push(
            `Missing judge attempts: ${ledger.missingJudgeAttempts.join(", ")}.`,
        );
    }
    if (ledger.unknownStamps.length > 0) {
        lines.push(
            `Unknown ledger stamps: ${ledger.unknownStamps.join(", ")}.`,
        );
    }
    if (ledger.duplicateLaunches.length > 0) {
        lines.push(
            `Duplicate launches: ${ledger.duplicateLaunches.join(", ")}.`,
        );
    }
    for (const problem of ledger.problems) {
        lines.push(`Ledger problem: ${problem}`);
    }
    return lines;
}

/**
 * Render the capture, provenance, integrity and cost section.
 * @param result The analysis result.
 * @returns Markdown.
 */
function integritySection(result: AnalysisResult): string {
    const usage = result.usage;
    return [
        "## Capture, integrity and costs",
        "",
        `Judge models recorded: ${result.integrity.judgedBy.length === 0 ? "Not defined" : result.integrity.judgedBy.join(", ")}.`,
        `Hashed input sources: ${num(result.integrity.sources.length)}. The full consumed-input list and the rendering identity are in analysis-receipt.json.`,
        "",
        table(
            ["Measure", "Captured", "Measured trials", "Unknown trials"],
            [
                [
                    "Tokens (input/output/reasoning/cache-read) and steps",
                    usage.measured === 0
                        ? "—"
                        : `${num(usage.input)}/${num(usage.output)}/${num(usage.reasoning)}/${num(usage.cacheRead)} tokens, ${num(usage.steps)} steps`,
                    num(usage.measured),
                    num(usage.unknown),
                ],
                [
                    "Monetary cost",
                    "—",
                    "0",
                    num(usage.measured + usage.unknown),
                ],
            ],
        ),
        "",
        `Cost telemetry: ${result.cost.available ? "recorded" : "unavailable"}. ${result.cost.note}`,
        "",
        ...ledgerLines(result.ledger),
        "",
    ].join("\n");
}

/**
 * Render the limitations section.
 * @param result The analysis result.
 * @returns Markdown.
 */
function limitationSection(result: AnalysisResult): string {
    return [
        "## Limitations",
        "",
        ...result.limitations.map((limitation) => `- ${limitation}`),
        "",
        "Authored interpretation lives in INTERPRETATION.md and is never overwritten by a rerender.",
        "",
    ].join("\n");
}

/**
 * Render the Markdown report from one structured result.
 * @param result The analysis result.
 * @returns The complete report.
 */
export function renderReport(result: AnalysisResult): string {
    return [
        `# Trial analysis: ${escapeCell(result.campaign.id)}`,
        "",
        `**Outcome:** ${result.decision.overall} — ${escapeCell(result.decision.reasons.join("; ") || result.decision.guardrails.detail)}.`,
        "",
        result.campaign.question === null
            ? ""
            : `Question: ${escapeCell(result.campaign.question)}`,
        "",
        setupSection(result),
        accountingSection(result),
        scenarioSection(result),
        pairSection(result),
        guardrailSection(result),
        screeningSection(result),
        sensitivitySection(result),
        integritySection(result),
        limitationSection(result),
    ]
        .filter((section) => section !== "")
        .join("\n");
}

/**
 * Render the versioned machine-readable analysis.
 * @param result The analysis result.
 * @returns The JSON document with a trailing newline.
 */
export function renderAnalysisJson(result: AnalysisResult): string {
    return `${JSON.stringify(result, null, 2)}\n`;
}

/**
 * Render the analysis receipt.
 * @param receipt The receipt fields, including the injected timestamp.
 * @returns The JSON document with a trailing newline.
 */
export function renderReceipt(receipt: AnalysisReceipt): string {
    return `${JSON.stringify(receipt, null, 2)}\n`;
}
