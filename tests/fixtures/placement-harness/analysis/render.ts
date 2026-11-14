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
import type { MeasuresReport } from "./measures.ts";
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

/** One token field's campaign subtotal and independent step coverage. */
export interface TokenFieldCoverage {
    /** Sum over reporting steps, or null when no step reported the field. */
    total: number | null;
    /** Observed steps reporting a numeric value, including explicit zero. */
    measuredSteps: number;
    /** Observed steps not reporting the field. */
    unknownSteps: number;
}

/** Captured token usage, with coverage kept independently per field. */
export interface UsageSummary {
    /** Input-token subtotal and coverage. */
    input: TokenFieldCoverage;
    /** Output-token subtotal and coverage. */
    output: TokenFieldCoverage;
    /** Reasoning-token subtotal and coverage. */
    reasoning: TokenFieldCoverage;
    /** Cache-read-token subtotal and coverage. */
    cacheRead: TokenFieldCoverage;
    /** Observed step_finish events, or null when no trail was readable. */
    steps: number | null;
    /** Trials whose session trail was readable. */
    measuredTrials: number;
    /** Trials whose session trail was unreadable. */
    unknownTrials: number;
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
    /** The recording and retrieval opportunity measures, and the personal-trial screen. */
    measures: MeasuresReport;
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
        /** The one personal-trial decision, shared with the headline. */
        personalTrial: MeasuresReport["personalTrial"];
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
    /** Per-slot assessment selection, from checked selection records. */
    assessmentSelection: {
        /** Every scheduled slot's selected attempt, or null when unrecorded. */
        slots: Array<{
            stamp: string;
            selectedAttemptId: string | null;
            recovered: boolean;
        }>;
        /** Slots whose selection is the frozen first attempt. */
        initial: number;
        /** Slots whose selection is a recovery attempt. */
        recovered: number;
        /** Slots with no selection record (historical evidence). */
        unrecorded: number;
    };
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
    /** Every consumed observation with its identity and explicit state, sorted. */
    inputs: Array<{
        reference: string;
        kind: "file" | "directory";
        sha256: string | null;
        state: "available" | "missing" | "not-a-directory" | "malformed";
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
        `The screening output republishes the one personal-trial decision: **${result.screening.personalTrial.recommendation}**.`,
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
            ["Measure", "Captured", "Coverage", "Unknown"],
            [
                [
                    "Input tokens",
                    num(usage.input.total),
                    `${num(usage.input.measuredSteps)} observed step(s) measured`,
                    `${num(usage.input.unknownSteps)} observed step(s) without this field`,
                ],
                [
                    "Output tokens",
                    num(usage.output.total),
                    `${num(usage.output.measuredSteps)} observed step(s) measured`,
                    `${num(usage.output.unknownSteps)} observed step(s) without this field`,
                ],
                [
                    "Reasoning tokens",
                    num(usage.reasoning.total),
                    `${num(usage.reasoning.measuredSteps)} observed step(s) measured`,
                    `${num(usage.reasoning.unknownSteps)} observed step(s) without this field`,
                ],
                [
                    "Cache-read tokens",
                    num(usage.cacheRead.total),
                    `${num(usage.cacheRead.measuredSteps)} observed step(s) measured`,
                    `${num(usage.cacheRead.unknownSteps)} observed step(s) without this field`,
                ],
                [
                    "Steps observed",
                    num(usage.steps),
                    `${num(usage.measuredTrials)} readable trail(s)`,
                    `${num(usage.unknownTrials)} unreadable trail(s)`,
                ],
                [
                    "Monetary cost",
                    "—",
                    "not recorded",
                    `${num(usage.measuredTrials + usage.unknownTrials)} trial(s)`,
                ],
            ],
        ),
        "",
        "Token fields keep independent coverage: a step reporting only some fields leaves the rest unknown, explicit zeros are measured, and a step without token fields still counts as an observed step.",
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
/**
 * Render the assessment-selection section.
 * @param result The analysis result.
 * @returns Markdown.
 */
function selectionSection(result: AnalysisResult): string {
    const selection = result.assessmentSelection;
    const recovered = selection.slots.filter((slot) => slot.recovered);
    const rows = selection.slots.map((slot) => [
        slot.stamp,
        slot.selectedAttemptId ?? "unrecorded (manifest selector)",
        slot.recovered
            ? "recovered"
            : slot.selectedAttemptId === null
              ? "manifest"
              : "initial",
    ]);
    return [
        "## Assessment selection",
        "",
        `${String(selection.recovered)} recovered, ${String(selection.initial)} initial, ${String(selection.unrecorded)} unrecorded.`,
        "",
        recovered.length === 0
            ? "No slot used a recovery attempt."
            : `Recovered: ${recovered.map((slot) => `${slot.stamp} → ${slot.selectedAttemptId}`).join(", ")}.`,
        "",
        table(["Slot", "Selected attempt", "Kind"], rows),
    ].join("\n");
}

/**
 * Render the full analysis report.
 * @param result The analysis result.
 * @returns Markdown.
 */
export function renderReport(result: AnalysisResult): string {
    const screenHeadline =
        result.measures.status === "available"
            ? `**Personal-trial screen:** ${result.measures.personalTrial.recommendation} — ${escapeCell(result.measures.personalTrial.reasons.join("; ") || "no criterion reported")}.`
            : `**Personal-trial screen:** not applicable — the measurement declaration is ${escapeCell(result.measures.status)}; only the utility threshold is available.`;
    return [
        `# Trial analysis: ${escapeCell(result.campaign.id)}`,
        "",
        screenHeadline,
        "",
        `**Utility threshold (component, not the recommendation):** ${result.decision.overall} — ${escapeCell(result.decision.reasons.join("; ") || result.decision.guardrails.detail)}.`,
        "",
        result.campaign.question === null
            ? ""
            : `Question: ${escapeCell(result.campaign.question)}`,
        "",
        setupSection(result),
        accountingSection(result),
        measuresSection(result),
        scenarioSection(result),
        pairSection(result),
        selectionSection(result),
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
 * Render one arm's opportunity-count row.
 * @param arm The arm id.
 * @param measures The measures report.
 * @returns The table row.
 */
function countRow(arm: string, measures: MeasuresReport): string[] {
    const one = measures.arms[arm];
    const recording = one?.recording ?? {
        success: 0,
        planned: 0,
        unknown: 0,
        notRun: 0,
    };
    const retrieval = one?.retrieval ?? {
        applied: 0,
        planned: 0,
        unknown: 0,
        notRun: 0,
    };
    return [
        arm,
        `${String(recording.success)}/${String(recording.planned)}`,
        String(recording.unknown),
        String(recording.notRun),
        `${String(retrieval.applied)}/${String(retrieval.planned)}`,
        String(retrieval.unknown),
        String(retrieval.notRun),
    ];
}

/**
 * Render one eligible trial's measure row.
 * @param trial The trial measures.
 * @returns The table row.
 */
function measureRow(trial: MeasuresReport["trials"][number]): string[] {
    const recording = trial.recording.eligible
        ? `${trial.recording.success ? "success" : "miss"} (${trial.recording.disposition})`
        : "—";
    const retrieval = trial.retrieval.eligible
        ? `${trial.retrieval.state}${trial.retrieval.read ? " (read)" : " (no read)"}`
        : "—";
    return [
        trial.stamp,
        trial.scenario,
        trial.arm,
        recording,
        retrieval,
        [...trial.recording.evidence, ...trial.retrieval.evidence].join(" ") ||
            "—",
    ];
}

/**
 * Render the opportunity measures and the personal-trial screen.
 * @param result The analysis result.
 * @returns Markdown.
 */
function measuresSection(result: AnalysisResult): string {
    const measures = result.measures;
    const header = [
        "## Opportunity measures",
        "",
        `Declaration: ${escapeCell(measures.status)}${measures.declarationSha256 === null ? "" : ` (sha256 ${measures.declarationSha256})`}.`,
        "",
    ];
    const arms = Object.keys(measures.arms).sort();
    const counts = table(
        [
            "Arm",
            "Recording",
            "Recording unknown",
            "Recording not run",
            "Retrieval",
            "Retrieval unknown",
            "Retrieval not run",
        ],
        arms.map((arm) => countRow(arm, measures)),
    );
    const eligible = measures.trials.filter(
        (trial) => trial.recording.eligible || trial.retrieval.eligible,
    );
    const rows = eligible.map(measureRow);
    const screen = measures.personalTrial;
    return [
        ...header,
        counts,
        "",
        "### Eligible trials",
        "",
        table(
            ["Stamp", "Scenario", "Arm", "Recording", "Retrieval", "Evidence"],
            rows,
        ),
        "",
        "### Personal-trial screen",
        "",
        `Recommendation: **${screen.recommendation}**.`,
        "",
        ...screen.reasons.map((reason) => `- ${reason}`),
        "",
        `Utility threshold (one component, not the recommendation): ${screen.utilityThreshold.status}; lead ${num(screen.utilityThreshold.lead)}; interval ${
            screen.utilityThreshold.interval === null
                ? "—"
                : `${String(screen.utilityThreshold.interval.low)}..${String(screen.utilityThreshold.interval.high)}`
        }. ${screen.utilityThreshold.note}`,
        "",
    ].join("\n");
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
