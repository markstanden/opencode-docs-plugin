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
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
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
import { differenceInterval, intervalFromCounts } from "./bounds.ts";
import { evaluateDecision, type DecisionResult } from "./decision.ts";
import { summariseGuardrails, type GuardrailArmSummary } from "./guardrails.ts";
import {
    parseManifest,
    type CampaignManifest,
    type SelectionSpec,
    type SlotSpec,
} from "./model.ts";
import { pairObservations, pairedComparison } from "./pairing.ts";
import {
    loadLaunchLedger,
    loadTrialRecord,
    readMarkdownTree,
    type EvidenceReader,
    type LaunchRecord,
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
    type LedgerSummary,
    type PairingSummary,
    type UsageSummary,
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

/** One evidence observation recorded at the reader boundary. */
interface ConsumedInput {
    /** The stable root-relative identity. */
    reference: string;
    /** Whether the observation was a file or a directory. */
    kind: "file" | "directory";
    /** SHA-256 of the file bytes or sorted directory entries, or null. */
    sha256: string | null;
    /** The explicit observed state. */
    state: "available" | "missing" | "not-a-directory" | "malformed";
}

/**
 * Record one reader observation. Files and directories are keyed separately so
 * a path probed both ways keeps both identities.
 * @param consumed The trace.
 * @param observation The observation to record.
 */
function traceObservation(
    consumed: Map<string, ConsumedInput>,
    observation: ConsumedInput,
): void {
    consumed.set(
        `${observation.kind}\u0000${observation.reference}`,
        observation,
    );
}

/**
 * Read the filesystem through the analyser's evidence-reader boundary,
 * recording every file and directory observation so the receipt binds to the
 * evidence that determined the result. A readable directory's identity is the
 * SHA-256 of its sorted entries, so a missing tree and a recorded empty tree
 * cannot share a receipt entry.
 * @param root The evidence root.
 * @param consumed The trace collecting every consumed observation.
 * @returns The reader.
 */
function fsReader(
    root: string,
    consumed: Map<string, ConsumedInput>,
): EvidenceReader {
    return {
        readTextFile: (path) => {
            const full = join(root, path);
            let text: string;
            try {
                text = readFileSync(full, "utf8");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
                traceObservation(consumed, {
                    reference: path,
                    kind: "file",
                    sha256: null,
                    state: "missing",
                });
                return { state: "missing", source: path };
            }
            traceObservation(consumed, {
                reference: path,
                kind: "file",
                sha256: sha256OfText(text),
                state: "available",
            });
            return { state: "available", value: text, source: path };
        },
        readDirectoryEntries: (path) => {
            const full = join(root, path);
            let stats;
            try {
                stats = statSync(full);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    traceObservation(consumed, {
                        reference: path,
                        kind: "directory",
                        sha256: null,
                        state: "malformed",
                    });
                    return {
                        state: "malformed",
                        source: path,
                        problems: [
                            `directory state unreadable (${String(error)})`,
                        ],
                    };
                }
                traceObservation(consumed, {
                    reference: path,
                    kind: "directory",
                    sha256: null,
                    state: "missing",
                });
                return { state: "missing", source: path };
            }
            // An ordinary file where a directory was expected — a README.txt
            // beside the notes, say — is a skip, never an empty directory.
            if (!stats.isDirectory()) {
                traceObservation(consumed, {
                    reference: path,
                    kind: "directory",
                    sha256: null,
                    state: "not-a-directory",
                });
                return { state: "not-a-directory", source: path };
            }
            try {
                const value = readdirSync(full).sort();
                traceObservation(consumed, {
                    reference: path,
                    kind: "directory",
                    sha256: sha256OfText(JSON.stringify(value)),
                    state: "available",
                });
                return { state: "available", value, source: path };
            } catch (error) {
                traceObservation(consumed, {
                    reference: path,
                    kind: "directory",
                    sha256: null,
                    state: "malformed",
                });
                return {
                    state: "malformed",
                    source: path,
                    problems: [`directory unreadable (${String(error)})`],
                };
            }
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
 * Build the full-population candidate-minus-control interval.
 * @param selection The declared selection rule, when present.
 * @param counts Accounting counts keyed by arm.
 * @returns The difference interval, or null without a usable pair of arms.
 */
function deltaIntervalOf(
    selection: SelectionSpec | null,
    counts: Record<string, AccountingCounts>,
): { low: number; high: number } | null {
    if (selection === null) return null;
    const control = counts[selection.controlArm];
    const candidate = counts[selection.candidateArm];
    if (control === undefined || candidate === undefined) return null;
    return differenceInterval(
        intervalFromCounts(candidate),
        intervalFromCounts(control),
    );
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
        if (slot.disposition === "excluded") continue;
        const record = records.find((one) => one.identity.stamp === slot.stamp);
        if (record === undefined) continue;
        const trial = scoreTrial(record, slot, {
            weights: manifest.policy.weights,
        }).trial;
        arms[slot.arm] = [...(arms[slot.arm] ?? []), trial];
    }
    return sensitivity(
        arms,
        grid.usefulWeights,
        grid.transientPenalties,
        manifest.policy.weights,
    );
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
    const trialDir = join(resultRoot, slot.stamp, slot.scenario);
    const result = screenTrial({
        trial: {
            stamp: slot.stamp,
            arm: slot.arm,
            scenario: slot.scenario,
        },
        taskPrompt: record.artefacts.promptText,
        finalAnswer: record.artefacts.finalAnswer,
        beforeDocs: before,
        afterDocs: after,
        writesText: record.artefacts.writesText,
        paths: {
            prompt: join(trialDir, "prompt.md"),
            finalAnswer: join(trialDir, "final.md"),
            writes: join(trialDir, "writes.txt"),
            beforeRoot: beforeDir,
            afterRoot: afterDir,
        },
        inventory: scenario?.preservationInventory,
        transientPatterns: manifest.policy.screening?.transientWordingPatterns,
        durableCounterexamples:
            manifest.policy.screening?.durableCounterexamplePatterns,
        mutationPolicy: scenario?.mutationPolicy,
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
 * Sum recorded token usage, keeping absent telemetry unknown rather than zero.
 * @param records The loaded trial records.
 * @returns The usage summary with measured/unknown counts.
 */
/** The token fields whose coverage is tracked independently. */
const TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead"] as const;

/** One field's accumulator while summing the campaign. */
interface FieldAccumulator {
    /** Sum over reporting steps. */
    total: number;
    /** Steps reporting the field. */
    measuredSteps: number;
    /** Steps not reporting the field. */
    unknownSteps: number;
    /** Whether any trial reported the field at all. */
    known: boolean;
}

/**
 * Sum per-field token usage across readable trails, keeping each field's
 * coverage independent. A field is `null` when no observed step reported it;
 * an explicit zero keeps a known zero subtotal.
 * @param records The loaded trial records.
 * @returns The usage summary with per-field coverage.
 */
function usageOf(records: readonly TrialRecord[]): UsageSummary {
    let measuredTrials = 0;
    let unknownTrials = 0;
    let steps = 0;
    let anyTrailReadable = false;
    const accumulators: Record<
        (typeof TOKEN_FIELDS)[number],
        FieldAccumulator
    > = {
        input: { total: 0, measuredSteps: 0, unknownSteps: 0, known: false },
        output: { total: 0, measuredSteps: 0, unknownSteps: 0, known: false },
        reasoning: {
            total: 0,
            measuredSteps: 0,
            unknownSteps: 0,
            known: false,
        },
        cacheRead: {
            total: 0,
            measuredSteps: 0,
            unknownSteps: 0,
            known: false,
        },
    };
    for (const record of records) {
        if (record.tokens.state !== "available") {
            unknownTrials += 1;
            continue;
        }
        measuredTrials += 1;
        anyTrailReadable = true;
        steps += record.tokens.value.steps;
        for (const field of TOKEN_FIELDS) {
            const usage = record.tokens.value[field];
            const accumulator = accumulators[field];
            accumulator.total += usage.total;
            accumulator.measuredSteps += usage.measuredSteps;
            accumulator.unknownSteps += usage.unknownSteps;
            if (usage.measuredSteps > 0) accumulator.known = true;
        }
    }
    const coverageOf = (field: (typeof TOKEN_FIELDS)[number]) => {
        const accumulator = accumulators[field];
        return {
            total: accumulator.known ? accumulator.total : null,
            measuredSteps: accumulator.measuredSteps,
            unknownSteps: accumulator.unknownSteps,
        };
    };
    return {
        input: coverageOf("input"),
        output: coverageOf("output"),
        reasoning: coverageOf("reasoning"),
        cacheRead: coverageOf("cacheRead"),
        steps: anyTrailReadable ? steps : null,
        measuredTrials,
        unknownTrials,
    };
}

/** Per-event and per-stamp counts read from one attempt ledger. */
interface LedgerCounts {
    /** Event counts keyed by event name. */
    events: Record<string, number>;
    /** Launch counts keyed by stamp. */
    launches: Map<string, number>;
    /** Judge-attempt counts keyed by stamp. */
    judgeAttempts: Map<string, number>;
    /** Every stamp the ledger mentions. */
    stamps: Set<string>;
}

/**
 * Count one readable ledger's events and per-stamp launches.
 * @param records The ledger events.
 * @returns The counts.
 */
function countLedger(records: readonly LaunchRecord[]): LedgerCounts {
    const events: Record<string, number> = {};
    const launches = new Map<string, number>();
    const judgeAttempts = new Map<string, number>();
    const stamps = new Set<string>();
    for (const event of records) {
        events[event.event] = (events[event.event] ?? 0) + 1;
        if (event.stamp === null) continue;
        stamps.add(event.stamp);
        const counter =
            event.event === "launch"
                ? launches
                : event.event === "judge-launch"
                  ? judgeAttempts
                  : undefined;
        if (counter !== undefined) {
            counter.set(event.stamp, (counter.get(event.stamp) ?? 0) + 1);
        }
    }
    return { events, launches, judgeAttempts, stamps };
}

/**
 * Reconcile a declared attempt ledger against the frozen schedule.
 * @param manifest The validated manifest.
 * @param ledger The loaded ledger.
 * @returns The ledger summary, or null when none was declared.
 */
function ledgerSummaryOf(
    manifest: CampaignManifest,
    ledger: Loaded<LaunchRecord[]>,
): LedgerSummary | null {
    const reference = manifest.evidence.inputs?.attempts;
    if (reference === undefined) return null;
    const scheduled = manifest.schedule.slots.map((slot) => slot.stamp);
    if (ledger.state !== "available") {
        return {
            reference,
            state: ledger.state === "missing" ? "missing" : "malformed",
            events: {},
            scheduled: scheduled.length,
            launched: 0,
            judged: 0,
            missingLaunches: [],
            missingJudgeAttempts: [],
            unknownStamps: [],
            duplicateLaunches: [],
            problems: ledger.state === "malformed" ? ledger.problems : [],
        };
    }
    const counted = countLedger(ledger.value);
    const declared = new Set(scheduled);
    return {
        reference,
        state: "available",
        events: counted.events,
        scheduled: scheduled.length,
        launched: scheduled.filter((stamp) => counted.launches.has(stamp))
            .length,
        judged: scheduled.filter((stamp) => counted.judgeAttempts.has(stamp))
            .length,
        missingLaunches: scheduled.filter(
            (stamp) => !counted.launches.has(stamp),
        ),
        missingJudgeAttempts: scheduled.filter(
            (stamp) => !counted.judgeAttempts.has(stamp),
        ),
        unknownStamps: [...counted.stamps]
            .filter((stamp) => !declared.has(stamp))
            .sort(),
        duplicateLaunches: [...counted.launches]
            .filter(([, count]) => count > 1)
            .map(([stamp]) => stamp)
            .sort(),
        problems: [],
    };
}

/**
 * Render one ledger limitation line, or none when the ledger is clean.
 * @param ledger The ledger summary, when one was declared.
 * @returns One limitation, or undefined.
 */
function ledgerLimitation(ledger: LedgerSummary | null): string | undefined {
    if (ledger === null) return undefined;
    if (ledger.state !== "available") {
        return `Attempt ledger ${ledger.reference} is ${ledger.state}; launch and judge-attempt coverage stays unknown.`;
    }
    const problems = [
        ledger.missingLaunches.length > 0
            ? `${String(ledger.missingLaunches.length)} scheduled stamp(s) with no recorded launch`
            : undefined,
        ledger.missingJudgeAttempts.length > 0
            ? `${String(ledger.missingJudgeAttempts.length)} scheduled stamp(s) with no recorded judge attempt`
            : undefined,
        ledger.unknownStamps.length > 0
            ? `${String(ledger.unknownStamps.length)} ledger stamp(s) outside the schedule`
            : undefined,
        ledger.duplicateLaunches.length > 0
            ? `${String(ledger.duplicateLaunches.length)} stamp(s) launched more than once`
            : undefined,
    ].filter((problem): problem is string => problem !== undefined);
    if (problems.length === 0) return undefined;
    return `Attempt ledger ${ledger.reference}: ${problems.join("; ")}.`;
}

/**
 * Collect the distinct recorded judge model identities.
 * @param records The loaded records.
 * @returns The sorted model ids.
 */
function judgeModelsOf(records: readonly TrialRecord[]): string[] {
    return [
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
}

/**
 * Load and reconcile the declared attempt ledger, when the manifest names one.
 * @param manifest The validated manifest.
 * @param reader The evidence reader.
 * @returns The ledger summary, or null when none was declared.
 */
function ledgerOf(
    manifest: CampaignManifest,
    reader: EvidenceReader,
): LedgerSummary | null {
    const path = manifest.evidence.inputs?.attempts;
    if (path === undefined) return null;
    return ledgerSummaryOf(manifest, loadLaunchLedger(reader, path));
}

/**
 * Build the campaign identity block.
 * @param manifest The validated manifest.
 * @returns The campaign identity.
 */
function campaignIdentityOf(manifest: CampaignManifest): {
    id: string;
    question: string | null;
} {
    return {
        id: manifest.campaign.id,
        question: manifest.campaign.question ?? null,
    };
}

/**
 * Build the screening report block from one screen result.
 * @param manifest The validated manifest.
 * @param screen The campaign screen.
 * @returns The screening block.
 */
function screeningReportOf(
    manifest: CampaignManifest,
    screen: ReturnType<typeof screenCampaign>,
): AnalysisResult["screening"] {
    return {
        rulesVersion: manifest.policy.screening?.rulesVersion ?? "not-defined",
        findings: screen.findings,
        reconciliation: screen.reconciliation,
    };
}

/**
 * Build the explicit limitations list.
 * @param records The loaded records.
 * @param screen The screening result.
 * @param totals The whole-population accounting.
 * @param usage The token usage summary.
 * @param ledger The ledger summary, when declared.
 * @returns The limitations, rendered verbatim.
 */
function limitationsOf(
    records: readonly TrialRecord[],
    screen: ReturnType<typeof screenCampaign>,
    totals: AccountingCounts,
    usage: UsageSummary,
    ledger: LedgerSummary | null,
): string[] {
    const ledgerLine = ledgerLimitation(ledger);
    return [
        "Worst-case bounds are missing-data intervals, not confidence intervals.",
        `Documented coverage: ${totals.documented}/${totals.planned} planned slots.`,
        "Static-screen findings are advisory and were generated independently of the judge; reconciliation counts only exact excerpt references.",
        screen.missingSnapshots > 0
            ? `Screening read missing before/after lake snapshots for ${String(screen.missingSnapshots)} trial(s).`
            : "Every screened trial had readable before/after lake snapshots.",
        `Token coverage (measured/unknown steps): input ${String(usage.input.measuredSteps)}/${String(usage.input.unknownSteps)}, output ${String(usage.output.measuredSteps)}/${String(usage.output.unknownSteps)}, reasoning ${String(usage.reasoning.measuredSteps)}/${String(usage.reasoning.unknownSteps)}, cache-read ${String(usage.cacheRead.measuredSteps)}/${String(usage.cacheRead.unknownSteps)}; ${String(usage.measuredTrials)} readable and ${String(usage.unknownTrials)} unreadable trial trail(s).`,
        ...(ledgerLine === undefined ? [] : [ledgerLine]),
        ...records.flatMap((record) =>
            record.attempt.problems
                .concat(record.primary.problems)
                .concat(record.assessment.problems)
                .map((problem) => `${record.identity.stamp}: ${problem}`),
        ),
        "This analysis made no model calls and executed no campaign-supplied code.",
    ];
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
    const delta = deltaIntervalOf(selection, counts);
    const decision: DecisionResult = evaluateDecision(
        manifest.policy.selection,
        counts,
        candidateGuardrails,
    );
    const ledgerSummary = ledgerOf(manifest, reader);
    const usage = usageOf(records);
    const screen = screenCampaign(manifest, reader, records);
    const judgedBy = judgeModelsOf(records);
    const totals = accountTrials(scored, slots.length);
    const limitations = limitationsOf(
        records,
        screen,
        totals,
        usage,
        ledgerSummary,
    );
    return {
        analysisVersion: ANALYSER_VERSION,
        campaign: campaignIdentityOf(manifest),
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
        bounds: { delta },
        decision,
        sensitivity: sensitivityOf(manifest, records),
        screening: screeningReportOf(manifest, screen),
        integrity: {
            sources: screen.sources,
            judgedBy,
        },
        usage,
        cost: {
            available: false,
            note: "No monetary cost was recorded; token and step totals are reported without an invented price.",
        },
        ledger: ledgerSummary,
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

/** The fixed output set one run publishes. */
const OUTPUT_NAMES = [
    "analysis.json",
    "REPORT.md",
    "SCREENING.json",
    "analysis-receipt.json",
] as const;

/**
 * Write every byte through the descriptor, never a reopened pathname.
 * @param fd The exclusive-create descriptor.
 * @param contents The full contents.
 */
function writeFullSync(fd: number, contents: string): void {
    const buffer = Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
        const written = writeSync(fd, buffer, offset, buffer.length - offset);
        if (written <= 0) {
            throw new Error(
                `write stalled after ${String(offset)} of ${String(buffer.length)} bytes`,
            );
        }
        offset += written;
    }
}

/**
 * Refuse an output name that is a symlink, a non-file, or an alias of a
 * protected input. Checked before any publication, so a refusal changes
 * nothing.
 * @param target The absolute output path.
 * @param protectedPaths The real paths of inputs a write must never touch.
 * @returns A refusal message, or undefined when the target is safe.
 */
function publicTargetProblem(
    target: string,
    protectedPaths: ReadonlySet<string>,
): string | undefined {
    let stats;
    try {
        stats = lstatSync(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
        return `cannot inspect output ${target}: ${String(error)}`;
    }
    if (stats.isSymbolicLink()) {
        return `refusing to write ${target}: the output name is a symlink`;
    }
    if (!stats.isFile()) {
        return `refusing to write ${target}: the output name is not a regular file`;
    }
    const real = realpathSync(target);
    if (protectedPaths.has(real)) {
        return `refusing to write ${target}: it aliases protected input ${real}`;
    }
    return undefined;
}

/**
 * Collect the real paths of every input a publication must never overwrite:
 * the campaign manifest, authored interpretation and every consumed evidence
 * file.
 * @param options The CLI options.
 * @param consumed The reader trace.
 * @returns The protected real paths.
 */
function protectedPathsOf(
    options: CliOptions,
    consumed: ReadonlyMap<string, ConsumedInput>,
): Set<string> {
    const protectedPaths = new Set<string>();
    const add = (path: string): void => {
        try {
            protectedPaths.add(realpathSync(path));
        } catch {
            // A path that does not exist cannot be aliased by an output.
        }
    };
    add(options.campaign);
    add(join(options.out, "INTERPRETATION.md"));
    for (const reference of consumed.keys()) {
        add(join(options.evidenceRoot, reference));
    }
    return protectedPaths;
}

/** One exclusively created publication temp. */
interface OwnedTemp {
    /** The exclusive-create descriptor. */
    fd: number;
    /** The temp's path, for the atomic rename. */
    temp: string;
}

/**
 * Create one exclusive publication temp beside the target. A foreign object
 * at a candidate name — including a seeded symlink — makes the create fail
 * without touching it, and the bounded retry moves to a fresh name.
 * @param target The absolute target path.
 * @param nextCounter The fresh-name counter.
 * @returns The owned temp, or null when every candidate was occupied.
 */
function acquireTemp(
    target: string,
    nextCounter: () => number,
): OwnedTemp | null {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = `${target}.${String(process.pid)}.${String(nextCounter())}.tmp`;
        try {
            return { fd: openSync(candidate, "wx"), temp: candidate };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    }
    return null;
}

/**
 * Publish the pre-flighted output set. Every exclusive temp is created and
 * fully written before the first rename, so a failure during staging leaves
 * the previous outputs untouched. Each rename then replaces one file
 * atomically, but an interruption between renames can leave outputs from two
 * generations (some new, some previous). A seeded symlink or foreign object at
 * a temp name is never followed or removed.
 * @param out The output directory.
 * @param contents The fixed output names and their bytes.
 */
function publishOutputs(
    out: string,
    contents: ReadonlyMap<string, string>,
): void {
    let counter = 0;
    const nextCounter = (): number => {
        counter += 1;
        return counter;
    };
    const temps: Array<{ temp: string; target: string }> = [];
    try {
        for (const [name, content] of contents) {
            const target = join(out, name);
            const owned = acquireTemp(target, nextCounter);
            if (owned === null) {
                throw new Error(
                    `every candidate temp name for ${target} was occupied; nothing was changed`,
                );
            }
            temps.push({ temp: owned.temp, target });
            try {
                writeFullSync(owned.fd, content);
            } finally {
                closeSync(owned.fd);
            }
        }
        for (const { temp, target } of temps) {
            renameSync(temp, target);
        }
    } catch (error) {
        for (const { temp } of temps) {
            try {
                unlinkSync(temp);
            } catch {
                // A temp already renamed into place owns the target's bytes.
            }
        }
        throw error;
    }
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
    const consumed = new Map<string, ConsumedInput>();
    const reader = fsReader(options.evidenceRoot, consumed);
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
            {
                reference: "campaign-manifest",
                kind: "file" as const,
                sha256: result.manifestSha256,
                state: "available" as const,
            },
            ...[...consumed.values()].sort(
                (left, right) =>
                    left.reference.localeCompare(right.reference) ||
                    left.kind.localeCompare(right.kind),
            ),
        ],
    };
    const protectedPaths = protectedPathsOf(options, consumed);
    for (const name of OUTPUT_NAMES) {
        const problem = publicTargetProblem(
            join(options.out, name),
            protectedPaths,
        );
        if (problem !== undefined) {
            return { status: 1, messages: [`analyse: ${problem}`] };
        }
    }
    publishOutputs(
        options.out,
        new Map<string, string>([
            ["analysis.json", renderAnalysisJson(result)],
            ["REPORT.md", renderReport(result)],
            [
                "SCREENING.json",
                `${JSON.stringify(
                    {
                        rulesVersion: result.screening.rulesVersion,
                        findings: result.screening.findings,
                        reconciliation: result.screening.reconciliation,
                    },
                    null,
                    2,
                )}\n`,
            ],
            ["analysis-receipt.json", renderReceipt(receipt)],
        ]),
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
