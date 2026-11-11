#!/usr/bin/env node
/**
 * Offline campaign analyser.
 *
 *   node analyse.mts --campaign <manifest> --evidence-root <dir> --out <dir>
 *        [--rerender]
 *
 * Replays a declared campaign from recorded evidence through the standard
 * pipeline — manifest validation, explicit-state loading, accounting,
 * declared-identity pairing, bounds, guardrails, the three-limb decision,
 * the static screen, and stable reporting — without calling a model and
 * without executing campaign-supplied code. Evidence is read-only; outputs
 * must land outside the evidence root; an existing analysis is not
 * overwritten without `--rerender`, and INTERPRETATION.md is never written.
 */
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    sensitivity,
    type ScoredTrial,
    type SensitivityCell,
} from "../ac-scoring.mts";
import {
    accountByArm,
    accountByScenarioArm,
    accountTrials,
    scoreTrial,
    type TrialScored,
} from "./accounting.ts";
import { intervalFromCounts } from "./bounds.ts";
import { evaluateDecision, type DecisionResult } from "./decision.ts";
import { summariseGuardrails, type GuardrailArmSummary } from "./guardrails.ts";
import {
    parseManifest,
    type CampaignManifest,
    type SlotSpec,
} from "./model.ts";
import { pairObservations, pairedComparison } from "./pairing.ts";
import {
    loadTrialRecord,
    readMarkdownTree,
    type EvidenceReader,
    type Loaded,
    type TrialRecord,
} from "./records.ts";
import {
    reconcileFindings,
    type JudgementText,
} from "./screening/reconcile.ts";
import type { Finding } from "./screening/rules.ts";
import { screenTrial } from "./screening/scan.ts";
import {
    ANALYSER_VERSION,
    REPORT_TEMPLATE_VERSION,
    renderAnalysisJson,
    renderReceipt,
    renderReport,
    type AnalysisResult,
    type AnalysisArmReport,
    type PairingSummary,
} from "./render.ts";
import type { AccountingCounts } from "./accounting.ts";

/** Parsed command-line options. */
interface CliOptions {
    /** The manifest path. */
    campaign: string;
    /** The runtime evidence root. */
    evidenceRoot: string;
    /** The fresh output directory. */
    out: string;
    /** Whether to regenerate an existing analysis in place. */
    rerender: boolean;
}

/** The CLI outcome. */
interface CliRun {
    /** The process exit code. */
    status: number;
    /** Messages for stderr/stdout. */
    messages: string[];
}

/**
 * Read the filesystem through the analyser's evidence-reader boundary.
 * @param root The evidence root.
 * @returns The reader.
 */
function fsReader(root: string): EvidenceReader {
    return {
        readTextFile: (path) => {
            const full = join(root, path);
            return existsSync(full)
                ? {
                      state: "available",
                      value: readFileSync(full, "utf8"),
                      source: path,
                  }
                : { state: "missing", source: path };
        },
        readDirectoryEntries: (path) => {
            const full = join(root, path);
            return existsSync(full)
                ? {
                      state: "available",
                      value: readdirSync(full).sort(),
                      source: path,
                  }
                : { state: "missing", source: path };
        },
    };
}

/**
 * Parse the CLI arguments.
 * @param argv The arguments after the script path.
 * @returns The options, or an error message.
 */
function parseArgs(argv: readonly string[]): {
    options?: CliOptions;
    error?: string;
} {
    const values = new Map<string, string>();
    let rerender = false;
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index] ?? "";
        if (flag === "--rerender") {
            rerender = true;
            continue;
        }
        if (!["--campaign", "--evidence-root", "--out"].includes(flag)) {
            return { error: `unexpected argument ${JSON.stringify(flag)}` };
        }
        const value = argv[index + 1];
        if (value === undefined) return { error: `missing value for ${flag}` };
        values.set(flag, value);
        index += 1;
    }
    const campaign = values.get("--campaign");
    const evidenceRoot = values.get("--evidence-root");
    const out = values.get("--out");
    if (campaign === undefined) return { error: "missing --campaign" };
    if (evidenceRoot === undefined) return { error: "missing --evidence-root" };
    if (out === undefined) return { error: "missing --out" };
    return { options: { campaign, evidenceRoot, out, rerender } };
}

/**
 * Resolve a path through any symlinks in its existing prefix, appending the
 * missing tail — the repository's containment pattern.
 * @param path The path to resolve.
 * @returns The symlink-free absolute path.
 */
function resolveWithSymlinks(path: string): string {
    const absolute = resolve(path);
    if (existsSync(absolute)) return realpathSync(absolute);
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(resolveWithSymlinks(parent), absolute.slice(parent.length + 1));
}

/**
 * Refuse output directories that overlap or alias the evidence root.
 * @param out The requested output directory.
 * @param evidenceRoot The evidence root.
 * @returns An error message, or undefined when the destination is safe.
 */
function overlapProblem(out: string, evidenceRoot: string): string | undefined {
    if (!existsSync(evidenceRoot)) {
        return `evidence root does not exist: ${evidenceRoot}`;
    }
    const evidence = realpathSync(evidenceRoot);
    const destination = resolveWithSymlinks(out);
    if (
        destination === evidence ||
        destination.startsWith(`${evidence}/`) ||
        evidence.startsWith(`${destination}/`)
    ) {
        return `output directory overlaps the evidence root: ${out} vs ${evidenceRoot}`;
    }
    return undefined;
}

/**
 * Prepare the output directory, refusing an accidental overwrite.
 * @param options The CLI options.
 * @returns An error message, or undefined when the directory is usable.
 */
function prepareOut(options: CliOptions): string | undefined {
    const overlap = overlapProblem(options.out, options.evidenceRoot);
    if (overlap !== undefined) return overlap;
    if (existsSync(options.out)) {
        const entries = readdirSync(options.out);
        if (entries.length > 0 && !options.rerender) {
            return `output directory is not empty; pass --rerender to regenerate analysis outputs: ${options.out}`;
        }
    } else {
        mkdirSync(options.out, { recursive: true });
    }
    return undefined;
}

/**
 * Read and validate the manifest.
 * @param path The manifest path.
 * @returns The manifest, or problems.
 */
function readManifest(path: string): {
    manifest?: CampaignManifest | undefined;
    problems: string[];
} {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
        return { problems: [`cannot read manifest ${path}: ${String(error)}`] };
    }
    const parsedManifest = parseManifest(raw);
    return {
        manifest: parsedManifest.value,
        problems: parsedManifest.problems,
    };
}

/**
 * Extract changed paths from a recorded writes report.
 * @param writesText The report text.
 * @returns The changed paths.
 */
function changedPathsOf(writesText: string): string[] {
    return writesText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && line !== "none")
        .map((line) =>
            line.replace(/^[a-z]+: /, "").replace(/ \([a-z]+\)$/, ""),
        );
}

/**
 * Load and score every scheduled slot.
 * @param manifest The validated manifest.
 * @param reader The evidence reader.
 * @returns The loaded records and the scored trials.
 */
function loadCampaign(
    manifest: CampaignManifest,
    reader: EvidenceReader,
): { records: TrialRecord[]; scored: TrialScored[] } {
    const scenarioById = new Map(
        manifest.scenarios.map((scenario) => [scenario.id, scenario]),
    );
    const records: TrialRecord[] = [];
    const scored: TrialScored[] = [];
    for (const slot of manifest.schedule.slots) {
        const scenario = scenarioById.get(slot.scenario);
        const resultRoot = manifest.evidence.resultRoots[slot.arm];
        if (resultRoot === undefined) continue;
        const record = loadTrialRecord(reader, {
            resultRoot,
            stamp: slot.stamp,
            scenario: slot.scenario,
            inventoryFactIds:
                scenario?.preservationInventory?.facts.map((fact) => fact.id) ??
                [],
            selectionPolicy: manifest.assessment.selectionPolicy,
        });
        records.push(record);
        scored.push(
            scoreTrial(record, slot, { weights: manifest.policy.weights }),
        );
    }
    return { records, scored };
}

/**
 * Group loaded records by their declared arm.
 * @param manifest The validated manifest.
 * @param records The loaded records.
 * @returns Records keyed by arm id.
 */
function recordsByArm(
    manifest: CampaignManifest,
    records: readonly TrialRecord[],
): Record<string, TrialRecord[]> {
    const grouped: Record<string, TrialRecord[]> = {};
    for (const slot of manifest.schedule.slots) {
        const record = records.find((one) => one.identity.stamp === slot.stamp);
        if (record === undefined) continue;
        grouped[slot.arm] = [...(grouped[slot.arm] ?? []), record];
    }
    return grouped;
}

/**
 * Summarise every declared guardrail for every arm.
 * @param manifest The validated manifest.
 * @param records The loaded records.
 * @returns Guardrail summaries keyed by arm.
 */
function guardrailsByArm(
    manifest: CampaignManifest,
    records: readonly TrialRecord[],
): Record<string, GuardrailArmSummary[]> {
    const grouped = recordsByArm(manifest, records);
    const summaries: Record<string, GuardrailArmSummary[]> = {};
    for (const [arm, armRecords] of Object.entries(grouped)) {
        summaries[arm] = summariseGuardrails(
            manifest.policy.guardrails,
            manifest.scenarios,
            armRecords,
        );
    }
    return summaries;
}

/**
 * Build the per-arm report blocks.
 * @param counts Accounting counts keyed by arm.
 * @param guardrails Guardrail summaries keyed by arm.
 * @returns The arm reports.
 */
function armReports(
    counts: Record<string, AccountingCounts>,
    guardrails: Record<string, GuardrailArmSummary[]>,
): Record<string, AnalysisArmReport> {
    const reports: Record<string, AnalysisArmReport> = {};
    for (const [arm, accounting] of Object.entries(counts)) {
        reports[arm] = {
            accounting,
            interval: intervalFromCounts(accounting),
            guardrails: guardrails[arm] ?? [],
        };
    }
    return reports;
}

/**
 * Build the pairing summary from the pairing result.
 * @param pairing The pairing result.
 * @returns The report summary.
 */
function pairingSummaryOf(
    pairing: ReturnType<typeof pairObservations>,
): PairingSummary {
    return {
        pairs: pairing.pairs.length,
        completePairs: pairing.pairs.filter((pair) => pair.complete).length,
        unmatched: pairing.unmatched.map((row) => ({
            stamp: row.identity.stamp,
            arm: row.identity.arm,
            scenario: row.identity.scenario,
            score: row.utility.score,
        })),
        unpaired: pairing.unpaired.length,
        problems: pairing.problems,
    };
}

/**
 * Build the sensitivity grid over the measured population.
 * @param manifest The validated manifest.
 * @param records The loaded records.
 * @returns The grid, or null when none was frozen.
 */
function sensitivityOf(
    manifest: CampaignManifest,
    records: readonly TrialRecord[],
): SensitivityCell[] | null {
    const grid = manifest.policy.sensitivity;
    if (grid === undefined) return null;
    const arms: Record<string, ScoredTrial[]> = {};
    for (const slot of manifest.schedule.slots) {
        const record = records.find((one) => one.identity.stamp === slot.stamp);
        if (record === undefined) continue;
        const trial = scoreTrial(record, slot, {
            weights: manifest.policy.weights,
        }).trial;
        arms[slot.arm] = [...(arms[slot.arm] ?? []), trial];
    }
    return sensitivity(arms, grid.usefulWeights, grid.transientPenalties);
}

/**
 * Text of a loaded artefact, or an empty string when unavailable.
 * @param loaded The loaded text.
 * @returns The text or an empty string.
 */
function textOf(loaded: Loaded<string>): string {
    return loaded.state === "available" ? loaded.value : "";
}

/**
 * The judgement text a reconciliation can read, when one was judged.
 * @param record The loaded record.
 * @returns The judgement text, or undefined.
 */
function judgementTextOf(record: TrialRecord): JudgementText | undefined {
    if (
        record.assessment.status !== "judged" ||
        record.assessment.reason === undefined
    ) {
        return undefined;
    }
    return {
        reason: record.assessment.reason,
        evidence: record.assessment.evidence,
    };
}

/**
 * Screen one trial and reconcile its findings with the selected judgement.
 * @param manifest The validated manifest.
 * @param reader The evidence reader.
 * @param record The loaded record.
 * @param slot The declared slot.
 * @returns Findings, reconciliation rows, hashed sources and snapshot state.
 */
function screenOne(
    manifest: CampaignManifest,
    reader: EvidenceReader,
    record: TrialRecord,
    slot: SlotSpec,
): {
    findings: Finding[];
    reconciliation: ReturnType<typeof reconcileFindings>;
    sources: Array<{ reference: string; sha256: string }>;
    missingSnapshot: boolean;
} {
    const scenario = manifest.scenarios.find((one) => one.id === slot.scenario);
    const resultRoot = record.identity.resultRoot;
    const beforeDir = join(
        dirname(resultRoot),
        "fixtures",
        slot.scenario,
        "lakes/docs",
    );
    const afterDir = join(
        resultRoot,
        slot.stamp,
        slot.scenario,
        "live/lakes/docs",
    );
    const before = readMarkdownTree(reader, beforeDir);
    const after = readMarkdownTree(reader, afterDir);
    const writesText = textOf(record.artefacts.writesText);
    const result = screenTrial({
        scenario: slot.scenario,
        taskPrompt: textOf(record.artefacts.promptText),
        finalAnswer: textOf(record.artefacts.finalAnswer),
        beforeDocs: before.state === "available" ? before.value : [],
        afterDocs: after.state === "available" ? after.value : [],
        writesText,
        changedPaths: changedPathsOf(writesText),
        inventory: scenario?.preservationInventory,
        transientPatterns: manifest.policy.screening?.transientWordingPatterns,
        durableCounterexamples:
            manifest.policy.screening?.durableCounterexamplePatterns,
    });
    return {
        findings: result.findings,
        reconciliation: reconcileFindings(
            result.findings,
            judgementTextOf(record),
        ),
        sources: result.sources.map((source) => ({
            reference: source.reference,
            sha256: source.sha256,
        })),
        missingSnapshot:
            before.state === "missing" || after.state === "missing",
    };
}

/**
 * Run the static screen over every trial and reconcile with its judgement.
 * @param manifest The validated manifest.
 * @param reader The evidence reader.
 * @param records The loaded records.
 * @returns Findings, reconciliation rows, hashed sources and missing-snapshot count.
 */
function screenCampaign(
    manifest: CampaignManifest,
    reader: EvidenceReader,
    records: readonly TrialRecord[],
): {
    findings: Finding[];
    reconciliation: ReturnType<typeof reconcileFindings>;
    sources: Array<{ reference: string; sha256: string }>;
    missingSnapshots: number;
} {
    const findings: Finding[] = [];
    const reconciliation: ReturnType<typeof reconcileFindings> = [];
    const sources = new Map<string, { reference: string; sha256: string }>();
    let missingSnapshots = 0;
    for (const record of records) {
        const slot = manifest.schedule.slots.find(
            (one) => one.stamp === record.identity.stamp,
        );
        if (slot === undefined) continue;
        const one = screenOne(manifest, reader, record, slot);
        findings.push(...one.findings);
        reconciliation.push(...one.reconciliation);
        for (const source of one.sources) {
            sources.set(`${source.reference}\u0000${source.sha256}`, source);
        }
        if (one.missingSnapshot) missingSnapshots += 1;
    }
    return {
        findings,
        reconciliation,
        sources: [...sources.values()].sort((left, right) =>
            left.reference.localeCompare(right.reference),
        ),
        missingSnapshots,
    };
}

/**
 * Assemble the structured analysis result.
 * @param manifest The validated manifest.
 * @param manifestText The manifest's exact bytes.
 * @param records The loaded records.
 * @param scored The scored trials.
 * @param reader The evidence reader.
 * @returns The result.
 */
function assemble(
    manifest: CampaignManifest,
    manifestText: string,
    records: readonly TrialRecord[],
    scored: readonly TrialScored[],
    reader: EvidenceReader,
): AnalysisResult {
    const slots: readonly SlotSpec[] = manifest.schedule.slots;
    const counts = accountByArm(scored, slots);
    const guardrails = guardrailsByArm(manifest, records);
    const pairing = pairObservations(scored, slots);
    const selection = manifest.policy.selection ?? null;
    const paired =
        selection === null
            ? null
            : pairedComparison(
                  pairing.pairs,
                  selection.controlArm,
                  selection.candidateArm,
              );
    const candidateGuardrails =
        selection === null ? [] : (guardrails[selection.candidateArm] ?? []);
    const decision: DecisionResult = evaluateDecision(
        manifest.policy.selection,
        counts,
        candidateGuardrails,
    );
    const screen = screenCampaign(manifest, reader, records);
    const judgedBy = [
        ...new Set(
            records
                .map((record) =>
                    record.judgeModel.state === "available"
                        ? record.judgeModel.value
                        : undefined,
                )
                .filter((model): model is string => model !== undefined),
        ),
    ].sort();
    const totals = accountTrials(scored, slots.length);
    const limitations = [
        "Worst-case bounds are missing-data intervals, not confidence intervals.",
        `Documented coverage: ${totals.documented}/${totals.planned} planned slots.`,
        `Static-screen findings are advisory and were generated independently of the judge; reconciliation counts only exact excerpt references.`,
        screen.missingSnapshots > 0
            ? `Screening read missing before/after lake snapshots for ${String(screen.missingSnapshots)} trial(s).`
            : "Every screened trial had readable before/after lake snapshots.",
        ...records.flatMap((record) =>
            record.attempt.problems
                .concat(record.primary.problems)
                .concat(record.assessment.problems)
                .map((problem) => `${record.identity.stamp}: ${problem}`),
        ),
        "This analysis made no model calls and executed no campaign-supplied code.",
    ];
    return {
        analysisVersion: ANALYSER_VERSION,
        campaign: {
            id: manifest.campaign.id,
            question: manifest.campaign.question ?? null,
        },
        manifestSha256: sha256OfText(manifestText),
        layout: manifest.evidence.layout,
        selectionPolicy: manifest.assessment.selectionPolicy,
        policyId: manifest.policy.policyId,
        weights: manifest.policy.weights,
        guardrails: manifest.policy.guardrails,
        selection,
        arms: armReports(counts, guardrails),
        scenarios: accountByScenarioArm(scored, slots),
        totals,
        pairing: pairingSummaryOf(pairing),
        paired,
        decision,
        sensitivity: sensitivityOf(manifest, records),
        screening: {
            rulesVersion:
                manifest.policy.screening?.rulesVersion ?? "not-defined",
            findings: screen.findings,
            reconciliation: screen.reconciliation,
        },
        integrity: {
            sources: screen.sources,
            judgedBy,
        },
        limitations,
    };
}

/**
 * SHA-256 of exact text.
 * @param text The text.
 * @returns The lowercase hex digest.
 */
function sha256OfText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Run the analyser.
 * @param argv The arguments after the script path.
 * @returns The exit status and messages.
 */
export function runAnalysis(argv: readonly string[]): CliRun {
    const parsed = parseArgs(argv);
    if (parsed.options === undefined) {
        return {
            status: 2,
            messages: [`analyse: ${parsed.error ?? "bad arguments"}`],
        };
    }
    const options = parsed.options;
    const manifestRead = readManifest(options.campaign);
    if (manifestRead.manifest === undefined) {
        return {
            status: 2,
            messages: manifestRead.problems.map(
                (problem) => `manifest: ${problem}`,
            ),
        };
    }
    const manifest = manifestRead.manifest;
    const prepared = prepareOut(options);
    if (prepared !== undefined) {
        return { status: 1, messages: [`analyse: ${prepared}`] };
    }
    const reader = fsReader(options.evidenceRoot);
    const loaded = loadCampaign(manifest, reader);
    const manifestText = readFileSync(options.campaign, "utf8");
    const result = assemble(
        manifest,
        manifestText,
        loaded.records,
        loaded.scored,
        reader,
    );
    const renderedAt = new Date().toISOString();
    const receipt = {
        analyserVersion: ANALYSER_VERSION,
        templateVersion: REPORT_TEMPLATE_VERSION,
        manifestSha256: result.manifestSha256,
        policyId: result.policyId,
        renderedAt,
        inputs: [
            { reference: "manifest", sha256: result.manifestSha256 },
            ...result.integrity.sources,
        ],
    };
    writeFileSync(
        join(options.out, "analysis.json"),
        renderAnalysisJson(result),
        "utf8",
    );
    writeFileSync(join(options.out, "REPORT.md"), renderReport(result), "utf8");
    writeFileSync(
        join(options.out, "SCREENING.json"),
        `${JSON.stringify(
            {
                rulesVersion: result.screening.rulesVersion,
                findings: result.screening.findings,
                reconciliation: result.screening.reconciliation,
            },
            null,
            2,
        )}\n`,
        "utf8",
    );
    writeFileSync(
        join(options.out, "analysis-receipt.json"),
        renderReceipt(receipt),
        "utf8",
    );
    return {
        status: 0,
        messages: [
            `${manifest.campaign.id}: ${result.decision.overall}; written to ${options.out}`,
        ],
    };
}

if (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    const run = runAnalysis(process.argv.slice(2));
    for (const message of run.messages) {
        if (run.status === 0) console.log(message);
        else console.error(message);
    }
    process.exitCode = run.status;
}
