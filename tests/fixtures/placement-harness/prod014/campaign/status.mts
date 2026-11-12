// Operator-side status observation for the prod014 campaign.
//
// One read-only command answers: what am I looking at, what has actually been
// verified, what has been spent, and what should I do next. It never writes,
// never dispatches, never touches the network, and never prints credential
// material: only presence, mode bits and env-var *names*.
//
// Modes:
//   node status.mts --base <revision>          # checkout, before a root exists
//   node status.mts --root <campaign-root>     # one campaign's observation
//       [--report-root <dir>] [--detail] [--json]
//
// Exit codes: 0 observation made (including stopped, closed or blocked
// campaigns); 1 broken invocation; 2 unreadable evidence (a file that must be
// readable to identify the campaign exists but cannot be parsed).
//
// This file is not materialised into campaign roots: it lives in the operator
// checkout beside materialise.mts, outside every frozen inventory.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    accessSync,
    constants,
    existsSync,
    readFileSync,
    readdirSync,
    statfsSync,
    statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCampaignLedger, eventsByStamp, type StampEvents } from "../../analysis/ledger.ts";
import {
    claimUsage,
    readClaims,
    restartDisposition,
    type BudgetClaim,
} from "../../analysis/budget.ts";
import { unresolvedReservations } from "../../analysis/closure.ts";
import {
    spendFreezeProblem,
    verifyFreeze,
    type FreezeRecord,
    type FrozenFile,
    type FrozenInventory,
} from "../../analysis/freeze.ts";

// ---------------------------------------------------------------------------
// Result types — one typed result, projected to text and JSON.

/** Exit code semantics: 0 observed, 1 usage, 2 unreadable evidence. */
export type StatusExit = 0 | 1 | 2;

/** Why a preparation step could not be claimed as done. */
export type StepState =
    | "missing"
    | "present"
    | "verified"
    | "mismatch"
    | "unverifiable";

/** A field that exists only in prose (run card, operator instruction) or not at all. */
export interface Gap {
    /** The field that lacks a durable source. */
    field: string;
    /** Where the value currently lives: "run-card", "operator-instruction" or "none". */
    source: string;
}

/** One observed problem, sanitised for display. */
export interface ObservationProblem {
    /** Stable machine code, e.g. "unreadable-evidence" or "usage". */
    code: string;
    /** Human-readable message, credential-material redacted. */
    message: string;
}

/** The single suggested next action. */
export interface NextAction {
    /** What kind of step this is; paid operations are labelled as such. */
    kind:
        | "offline-check"
        | "offline-preparation"
        | "operator-decision"
        | "paid-operation"
        | "inspection";
    /** Why this is the next step, in operator terms. */
    why: string;
    /** The exact existing command to run, shell-quoted. */
    command?: string;
    /** The working directory the command expects. */
    cwd?: string;
    /** Non-secret environment variable *names* the command needs. */
    envNames?: string[];
    /** An evidence path to inspect when no command is the answer. */
    path?: string;
}

/** One arm's registered and delivered description identity. */
export interface ArmIdentity {
    /** Arm letter. */
    id: string;
    /** Registered native description length in characters. */
    nativeChars?: number;
    /** Verified delivered description length in characters. */
    deliveredChars?: number;
    /** Whether the freeze's delivered and registered hashes disagree. */
    declaredMismatch?: boolean;
}

/** One scheduled slot in execution order. */
export interface OrderEntry {
    /** Execution order across the whole schedule. */
    slot: number;
    /** Pair identity, P01…P08. */
    pairId: string;
    /** Scenario id. */
    scenario: string;
    /** Arm letter. */
    arm: string;
}

/** Identity and run definition, every field tagged with its source. */
export interface Identity {
    /** The base the operator asked about (--base or registered). */
    requestedBase?: string;
    /** The revision the freeze or git resolved the base to. */
    resolvedBase?: string;
    /** Actual source HEAD, when a source repo is observable. */
    sourceHead?: string;
    /** Whether the source repo has no uncommitted changes. */
    sourceClean?: boolean;
    /** Where the source repo was observed. */
    sourceRepo?: string;
    /** Campaign id from the schedule or FROZEN.json. */
    campaignId?: string;
    /** Measurement worktree revision. */
    measurementRevision?: string;
    /** Registered trial model id. */
    trialModel?: string;
    /** Registered judge model id. */
    judgeModel?: string;
    /** Per-arm description identities from the freeze. */
    arms?: ArmIdentity[];
    /** Slot count, planned or scheduled. */
    slots?: number;
    /** Pair count, planned or scheduled. */
    pairs?: number;
    /** Slot order with AB/BA assignments. */
    order?: OrderEntry[];
    /** Utility weights from the manifest policy. */
    weights?: Record<string, number>;
    /** Control arm id. */
    controlArm?: string;
    /** Candidate arm id. */
    candidateArm?: string;
    /** Promotion threshold. */
    threshold?: number;
    /** Registered guardrail ids. */
    guardrailIds?: string[];
    /** Registered stopping rules. */
    stoppingRules?: string[];
    /** Registered ceilings; the freeze record's when present. */
    ceilings?: { trial: number; judge: number };
    /** Which durable source the ceilings came from. */
    ceilingSource?: string;
    /** Field name to durable source, for every claimed value. */
    sources: Record<string, string>;
}

/** The container engine observation. */
export interface EngineObservation {
    /** The CLI queried. */
    cli: string;
    /** Its local --version output, when available. */
    version?: string;
    /** Whether any version could be captured. */
    available: boolean;
}

/** The expected container image observation. */
export interface ImageObservation {
    /** The image id the freeze registered. */
    expectedId?: string;
    /** The id the local engine reports, when present. */
    observedId?: string;
    /** Present, absent/changed, or indeterminate when the engine is unavailable. */
    present: boolean | "indeterminate";
}

/** Credential configuration observation: presence and mode only, never values. */
export interface CredentialsObservation {
    /** Whether the campaign root's .env exists. */
    envFilePresent?: boolean;
    /** Its owner-visible mode bits, octal. */
    envFileMode?: string;
    /** Why the runner would refuse it, or absent when safe. */
    modeProblem?: string;
    /** Whether any documented source currently provides a key. */
    keyConfigured?: boolean;
    /** Which sources provide one ("environment", "named file", "campaign .env"). */
    keySources?: string[];
}

/** Local readiness observation. */
export interface Readiness {
    /** The Node runtime version running this command. */
    nodeVersion: string;
    /** Local container engine query result. */
    containerEngine: EngineObservation;
    /** Expected image id and its local presence. */
    image?: ImageObservation;
    /** Whether the campaign shim is executable, when present. */
    shimExecutable?: boolean;
    /** Credential configuration observation. */
    credentials: CredentialsObservation;
    /** Installed dependencies in the three worktrees, when they exist. */
    dependencies?: { armsA: boolean; armsB: boolean; measurement: boolean };
    /** Free bytes on the filesystem holding the root, when cheaply available. */
    diskFreeBytes?: number;
    /** Routing classification from durable evidence only. */
    routing?: string;
}

/** One preparation step. */
export interface PrepStep {
    /** The step name, in run-card order. */
    step: string;
    /** What could be claimed about it. */
    state: StepState;
    /** Supporting detail, when there is any. */
    detail?: string;
}

/** One slot's live position. */
export interface SlotObservation {
    /** Slot number. */
    slot: number;
    /** Pair id. */
    pairId: string;
    /** Scenario id. */
    scenario: string;
    /** Arm letter. */
    arm: string;
    /** Slot stamp. */
    stamp: string;
    /** Observed state in the harness event vocabulary's terms. */
    state: string;
    /** Supporting reason from the evidence, when recorded. */
    note?: string;
}

/** One claim kind's spend against its ceiling. */
export interface SpendKind {
    /** Claim files counted from creation. */
    used: number;
    /** The validated freeze ceiling. */
    ceiling: number;
    /** Ceiling minus used, floored at zero. */
    remaining: number;
    /** The registered counting basis. */
    basis: string;
}

/** One unsettled claim blocking dispatch. */
export interface UnresolvedClaim {
    /** Which claim kind. */
    kind: string;
    /** The slot stamp, when the claim names one. */
    stamp?: string;
    /** The recorded claim state. */
    state: string;
    /** The claim file path. */
    path: string;
}

/** Spend accounting across both claim kinds. */
export interface SpendObservation {
    /** Trial claims against the trial ceiling. */
    trial: SpendKind;
    /** Judge claims against the judge ceiling. */
    judge: SpendKind;
    /** Claims not yet observed to start. */
    reserved?: number;
    /** Claims whose call started and has not closed. */
    spawned?: number;
    /** Claims whose outcome is unknown; they block every dispatch. */
    unresolved?: UnresolvedClaim[];
}

/** Live position and accounting. */
export interface Position {
    /** The structural ledger state: missing, malformed, open or closed. */
    ledgerState: string;
    /** Whether records advanced mid-read; the observation is labelled, not chased. */
    ledgerChanging?: boolean;
    /** Structurally valid event count. */
    eventCount: number;
    /** The last durable event. */
    lastEvent?: { event: string; at: string | null; detail?: string };
    /** The close timestamp, when the ledger is closed. */
    closedAt?: string | null;
    /** The recorded stop reason, when closed. */
    stopReason?: string | null;
    /** Pairs with a pair-complete event. */
    completedPairs?: string[];
    /** Judge attempts observed to end judged. */
    usableAssessments?: number;
    /** Per-slot states, in schedule order. */
    slots?: SlotObservation[];
    /** Spend accounting, when ceilings are registered. */
    spend?: SpendObservation;
    /** Whether an interrupted close left its lock behind. */
    closingLock?: boolean;
}

/** Coverage and token figures a report published. */
export interface ReportCoverage {
    /** Complete pairs at render time. */
    completePairs: number;
    /** Documented trial count across arms. */
    documented: number;
    /** Assessed trial count across arms. */
    assessed: number;
}

/** One analysis report observation. */
export interface ReportObservation {
    /** The report directory. */
    dir: string;
    /** The campaign id the report names. */
    campaignId?: string;
    /** When the analyser rendered it. */
    renderedAt?: string;
    /** The manifest hash the report pinned. */
    manifestSha256?: string;
    /** Whether that hash still matches this root's manifest. */
    manifestMatches?: boolean;
    /** Whether the ledger advanced after rendering. */
    ledgerAdvancedSince?: boolean;
    /** Current, stale, or unknown. */
    freshness?: "current" | "stale" | "unknown";
    /** Whether the report names another campaign. */
    wrongCampaign?: boolean;
    /** The analyser's decision.overall. */
    decision?: string;
    /** The analyser's personal-trial recommendation. */
    recommendation?: string;
    /** Paired utility delta, when published. */
    pairedDelta?: number | null;
    /** Breached guardrail count. */
    guardrailBreaches?: number;
    /** Per-arm recording successes and denominators. */
    recording?: Record<string, { planned: number; success: number }>;
    /** Per-arm retrieval applications and denominators. */
    retrieval?: Record<string, { planned: number; applied: number }>;
    /** Evidence coverage figures. */
    coverage?: ReportCoverage;
    /** Token coverage figures, when published. */
    tokens?: {
        /** Trials with measured token usage. */
        measuredTrials?: number;
        /** Trials with unknown token usage. */
        unknownTrials?: number;
        /** Measured step count. */
        steps?: number | null;
    };
    /** The report's own scope statement; a partial report keeps its scope. */
    scope?: string;
}

/** The reconciliation record observation. */
export interface ReconciliationObservation {
    /** Whether evidence/RECONCILIATION.json exists and parses. */
    present: boolean;
    /** When it was written. */
    at?: string;
    /** Completed pairs it recorded. */
    completedPairs?: number;
    /** Trial launches it recorded. */
    trialLaunches?: number;
    /** Unrun slots it recorded. */
    unrunSlots?: number;
    /** Estimated trial cost, when published. */
    billingTrial?: number | null;
    /** Estimated judge cost, when published. */
    billingJudge?: number | null;
    /** Billing currency. */
    currency?: string;
}

/** Checkpoint, report and reconciliation observation. */
export interface Checkpoint {
    /** Whether an explicit --report-root was given. */
    reportRootGiven?: boolean;
    /** Each observed report, in directory order. */
    reports?: ReportObservation[];
    /** The campaign's reconciliation record. */
    reconciliation?: ReconciliationObservation;
}

/** The one typed result both projections render. */
export interface StatusResult {
    /** Result schema version. */
    schemaVersion: 1;
    /** Which mode produced it. */
    mode: "checkout" | "campaign";
    /** When the observation was made. */
    generatedAt: string;
    /** Short machine phase. */
    phase: string;
    /** One-line human summary. */
    headline: string;
    /** The observed campaign root, in campaign mode. */
    root?: string;
    /** Identity and run definition. */
    identity?: Identity;
    /** Local readiness. */
    readiness?: Readiness;
    /** Preparation progress in run-card order. */
    preparation?: PrepStep[];
    /** Live position and accounting. */
    position?: Position;
    /** Checkpoint, report and reconciliation. */
    checkpoint?: Checkpoint;
    /** The single suggested next action. */
    nextAction: NextAction;
    /** Fields with no durable source. */
    gaps: Gap[];
    /** Observation problems, sanitised. */
    problems: ObservationProblem[];
}

// ---------------------------------------------------------------------------
// Small utilities.

/** Single-quote one shell word so spaces and metacharacters stay inert. */
export function shellQuote(word: string): string {
    return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Strip obvious credential material from any diagnostic line. */
export function redact(text: string): string {
    return text
        .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
        .replace(/\bZAI_API_KEY\s*=\s*\S+/g, "ZAI_API_KEY=[redacted]")
        .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** A nonblank string field, or undefined. */
function str(value: Record<string, unknown>, key: string): string | undefined {
    const field = value[key];
    return typeof field === "string" && field !== "" ? field : undefined;
}

/** A finite number field, or undefined. */
function num(value: Record<string, unknown>, key: string): number | undefined {
    const field = value[key];
    return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

interface JsonRead {
    value?: unknown;
    problem?: string;
}

/** Read and parse a JSON file tolerantly; missing is a state, not an error. */
function readJsonFile(path: string): JsonRead {
    if (!existsSync(path)) return {};
    try {
        return { value: JSON.parse(readFileSync(path, "utf8")) as unknown };
    } catch (error) {
        return {
            problem: `${path} is not parseable JSON: ${redact(
                error instanceof Error ? error.message : String(error),
            )}`,
        };
    }
}

/** Read text, or null when missing/unreadable. */
function readTextOr(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

/** Run one local command and capture its trimmed stdout; empty on failure. */
function capture(command: string, args: string[]): string {
    try {
        const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
        return result.status === 0 ? String(result.stdout ?? "").trim() : "";
    } catch {
        return "";
    }
}

/** One git query whose non-empty output matters, or null. */
function git(repo: string, args: string[]): string | null {
    const out = capture("git", ["-C", repo, ...args]);
    return out === "" ? null : out;
}

/**
 * A git query whose empty success matters (status --porcelain). Null means
 * the query failed; an empty string is a real, clean answer.
 */
function gitRaw(repo: string, args: string[]): string | null {
    try {
        const result = spawnSync("git", ["-C", repo, ...args], {
            encoding: "utf8",
            timeout: 10_000,
        });
        return result.status === 0 ? String(result.stdout ?? "") : null;
    } catch {
        return null;
    }
}

/** Whether a repo has no uncommitted changes, or null when unobservable. */
function gitClean(repo: string): boolean | null {
    const porcelain = gitRaw(repo, ["status", "--porcelain"]);
    return porcelain === null ? null : porcelain.trim() === "";
}

/** SHA-256 of a file's bytes, or "missing". */
function hashFile(path: string): string {
    try {
        return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
        return "missing";
    }
}

/** Every file under a directory, recursively, sorted; [] when absent. */
function filesUnder(dir: string): string[] {
    const found: string[] = [];
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...filesUnder(path));
        else if (entry.isFile()) found.push(path);
    }
    return found.sort();
}

/** Every file under a directory with hashes, root-relative; [] when absent. */
function hashedFilesUnder(root: string, dir: string): FrozenFile[] {
    return filesUnder(join(root, dir)).map((path) => ({
        path: path.slice(root.length + 1),
        sha256: hashFile(path),
    }));
}

/** Free bytes on the filesystem holding a path, when cheaply available. */
function freeBytes(path: string): number | undefined {
    try {
        const stats = statfsSync(path);
        return stats.bsize * stats.bavail;
    } catch {
        return undefined;
    }
}

const GB = 1024 ** 3;

// ---------------------------------------------------------------------------
// Evidence readers (tolerant, never exiting).

interface ScheduleSlotLite {
    slot: number;
    pairId: string;
    scenario: string;
    arm: string;
    stamp: string;
}

interface IdentityFiles {
    freezeRecord: FreezeRecord | null;
    frozenIdentities: Record<string, unknown> | null;
    schedule: { campaign: string; slots: ScheduleSlotLite[] } | null;
    manifest: Record<string, unknown> | null;
}

/**
 * Read and lightly validate the files that identify a campaign. A file that
 * exists but cannot be parsed is a hard problem (exit 2); a missing file is a
 * state, not an error. Exported for the status tests.
 */
export function readIdentityFiles(
    root: string,
): { files: IdentityFiles; hardProblems: ObservationProblem[] } {
    const hardProblems: ObservationProblem[] = [];
    const bad = (path: string, need: string): void => {
        hardProblems.push({
            code: "unreadable-evidence",
            message: `${path} exists but does not carry ${need}`,
        });
    };
    return {
        files: {
            freezeRecord: readFreeze(root, bad),
            frozenIdentities: readIdentities(root, bad),
            schedule: readSchedule(root, bad),
            manifest: readManifest(root, bad),
        },
        hardProblems,
    };
}

/** Read FROZEN.json's freeze record, or null when absent or malformed. */
function readFreeze(
    root: string,
    bad: (path: string, need: string) => void,
): FreezeRecord | null {
    const path = join(root, "evidence/FROZEN.json");
    const read = readJsonFile(path);
    if (read.problem !== undefined) {
        bad(path, "parseable JSON");
        return null;
    }
    if (read.value === undefined) return null;
    if (!isRecord(read.value)) {
        bad(path, "a JSON object");
        return null;
    }
    const record = read.value.freeze;
    if (record === undefined) return null;
    if (!isRecord(record)) {
        bad(path, "a freeze object");
        return null;
    }
    return freezeRecordOf(record);
}

/** Read frozen-identities.json, or null when absent or malformed. */
function readIdentities(
    root: string,
    bad: (path: string, need: string) => void,
): Record<string, unknown> | null {
    const path = join(root, "evidence/frozen-identities.json");
    const read = readJsonFile(path);
    if (read.value === undefined) return null;
    if (!isRecord(read.value)) {
        bad(path, "a JSON object");
        return null;
    }
    return read.value;
}

/** Read schedule.json, or null when absent or malformed. */
function readSchedule(
    root: string,
    bad: (path: string, need: string) => void,
): { campaign: string; slots: ScheduleSlotLite[] } | null {
    const path = join(root, "evidence/schedule.json");
    const read = readJsonFile(path);
    if (read.value === undefined) return null;
    if (!isRecord(read.value) || !Array.isArray(read.value.slots)) {
        bad(path, "a campaign and slots array");
        return null;
    }
    const slots: ScheduleSlotLite[] = [];
    for (const entry of read.value.slots) {
        const slot = slotLiteOf(entry);
        if (slot === undefined) {
            bad(path, "well-formed slots");
            return null;
        }
        slots.push(slot);
    }
    return { campaign: str(read.value, "campaign") ?? "", slots };
}

/** One schedule slot, or undefined when malformed. */
function slotLiteOf(entry: unknown): ScheduleSlotLite | undefined {
    if (!isRecord(entry)) return undefined;
    const arm = entry.arm;
    if (
        typeof entry.slot !== "number" ||
        typeof entry.pairId !== "string" ||
        typeof entry.scenario !== "string" ||
        (arm !== "A" && arm !== "B") ||
        typeof entry.stamp !== "string"
    ) {
        return undefined;
    }
    return {
        slot: entry.slot,
        pairId: entry.pairId,
        scenario: entry.scenario,
        arm: arm === "A" ? "A" : "B",
        stamp: entry.stamp,
    };
}

/** Read prepare/manifest.json, or null when absent or malformed. */
function readManifest(
    root: string,
    bad: (path: string, need: string) => void,
): Record<string, unknown> | null {
    const path = join(root, "prepare/manifest.json");
    const read = readJsonFile(path);
    if (read.value === undefined) return null;
    if (!isRecord(read.value)) {
        bad(path, "a JSON object");
        return null;
    }
    return read.value;
}

/** A tolerant mirror of contracts.mts freezeRecordOf: validate, never exit. */
function freezeRecordOf(record: Record<string, unknown>): FreezeRecord | null {
    const scalars = freezeScalarsOf(record);
    const arms = freezeArmsOf(record);
    const files = freezeFilesOf(record);
    const inventories = freezeInventoriesOf(record);
    const rules = freezeRulesOf(record);
    if (
        scalars === null ||
        arms === null ||
        files === null ||
        inventories === null ||
        rules === null
    ) {
        return null;
    }
    return { ...scalars, arms, files, inventories, stoppingRules: rules, ceilings: freezeCeilingsOf(record) };
}

/** The scalar freeze fields, or null when any is malformed. */
function freezeScalarsOf(
    record: Record<string, unknown>,
): Pick<
    FreezeRecord,
    | "schemaVersion"
    | "campaign"
    | "sourceRevision"
    | "sourceTree"
    | "imageId"
    | "containerCli"
    | "measurementSha256"
> | null {
    const schemaVersion = num(record, "schemaVersion");
    const campaign = str(record, "campaign");
    const sourceRevision = str(record, "sourceRevision");
    const sourceTree = str(record, "sourceTree");
    const imageId = str(record, "imageId");
    const containerCli = str(record, "containerCli");
    const measurementSha256 = str(record, "measurementSha256");
    if (
        schemaVersion === undefined ||
        campaign === undefined ||
        sourceRevision === undefined ||
        sourceTree === undefined ||
        imageId === undefined ||
        containerCli === undefined ||
        measurementSha256 === undefined
    ) {
        return null;
    }
    return {
        schemaVersion,
        campaign,
        sourceRevision,
        sourceTree,
        imageId,
        containerCli,
        measurementSha256,
    };
}

/** The frozen arms, or null when the array is malformed. */
function freezeArmsOf(record: Record<string, unknown>): FreezeRecord["arms"] | null {
    if (!Array.isArray(record.arms)) return null;
    const arms: FreezeRecord["arms"] = [];
    for (const entry of record.arms) {
        if (!isRecord(entry)) return null;
        const arm = frozenArmOf(entry);
        if (arm === null) return null;
        arms.push(arm);
    }
    return arms;
}

/** One frozen arm, or null when a field is malformed. */
function frozenArmOf(entry: Record<string, unknown>): FreezeRecord["arms"][number] | null {
    const id = str(entry, "id");
    const strings = frozenArmStrings(entry);
    const numbers = frozenArmNumbers(entry);
    if (id === undefined || strings === null || numbers === null) return null;
    return {
        id,
        commit: strings[0],
        tree: strings[1],
        clean: entry.clean === true,
        descriptionChars: numbers[0],
        descriptionHash: strings[2],
        deliveredChars: numbers[1],
        deliveredHash: strings[3],
        annotationChars: numbers[2],
        annotationHash: strings[4],
    };
}

/** The five string fields of a frozen arm, or null when any is malformed. */
function frozenArmStrings(entry: Record<string, unknown>): string[] | null {
    const keys = ["commit", "tree", "descriptionHash", "deliveredHash", "annotationHash"];
    const values: string[] = [];
    for (const key of keys) {
        const value = str(entry, key);
        if (value === undefined) return null;
        values.push(value);
    }
    return values;
}

/** The three numeric fields of a frozen arm, or null when any is malformed. */
function frozenArmNumbers(entry: Record<string, unknown>): number[] | null {
    const keys = ["descriptionChars", "deliveredChars", "annotationChars"];
    const values: number[] = [];
    for (const key of keys) {
        const value = num(entry, key);
        if (value === undefined) return null;
        values.push(value);
    }
    return values;
}

/** The frozen single-file inputs, or null when the array is malformed. */
function freezeFilesOf(record: Record<string, unknown>): FrozenFile[] | null {
    if (!Array.isArray(record.files)) return null;
    const files: FrozenFile[] = [];
    for (const entry of record.files) {
        if (!isRecord(entry)) return null;
        const path = str(entry, "path");
        const sha256 = str(entry, "sha256");
        if (path === undefined || sha256 === undefined) return null;
        files.push({ path, sha256 });
    }
    return files;
}

/** The frozen inventories, or null when the array is malformed. */
function freezeInventoriesOf(
    record: Record<string, unknown>,
): FrozenInventory[] | null {
    if (!Array.isArray(record.inventories)) return null;
    const inventories: FrozenInventory[] = [];
    for (const entry of record.inventories) {
        if (!isRecord(entry) || !Array.isArray(entry.files)) return null;
        const path = str(entry, "path");
        if (path === undefined) return null;
        const files: FrozenFile[] = [];
        for (const file of entry.files) {
            if (!isRecord(file)) return null;
            const filePath = str(file, "path");
            const sha256 = str(file, "sha256");
            if (filePath === undefined || sha256 === undefined) return null;
            files.push({ path: filePath, sha256 });
        }
        inventories.push({ path, files });
    }
    return inventories;
}

/** The stopping rules, or null when the array is malformed. */
function freezeRulesOf(record: Record<string, unknown>): string[] | null {
    if (!Array.isArray(record.stoppingRules)) return null;
    const rules: string[] = [];
    for (const rule of record.stoppingRules) {
        if (typeof rule !== "string") return null;
        rules.push(rule);
    }
    return rules;
}

/** The declared ceilings; a record that predates them reads as zero. */
function freezeCeilingsOf(
    record: Record<string, unknown>,
): { trial: number; judge: number } {
    if (!isRecord(record.ceilings)) return { trial: 0, judge: 0 };
    return {
        trial: num(record.ceilings, "trial") ?? 0,
        judge: num(record.ceilings, "judge") ?? 0,
    };
}

// ---------------------------------------------------------------------------
// Credential observation — presence and mode only, never values.

function observeCredentials(root: string): Readiness["credentials"] {
    const credentials: Readiness["credentials"] = {};
    const file = envFileObservation(join(root, ".env"));
    if (file !== null) {
        credentials.envFilePresent = true;
        credentials.envFileMode = file.mode;
        if (file.problem !== undefined) credentials.modeProblem = file.problem;
    }
    const sources = keySourcesOf(root);
    if (sources.length > 0) {
        credentials.keyConfigured = true;
        credentials.keySources = sources;
    } else {
        credentials.keyConfigured = false;
    }
    return credentials;
}

/** One credential file's mode observation, or null when it does not exist. */
function envFileObservation(path: string): {
    mode: string;
    problem?: string;
} | null {
    if (!existsSync(path)) return null;
    const mode = statSync(path).mode & 0o777;
    const octal = mode.toString(8).padStart(3, "0");
    const observation: { mode: string; problem?: string } = { mode: octal };
    if ((mode & 0o077) !== 0) {
        observation.problem = redact(
            `${path} is readable beyond its owner (mode ${octal}); chmod 600 it before use`,
        );
    }
    return observation;
}

/** Which documented sources provide a judge key, without reading values. */
function keySourcesOf(root: string): string[] {
    const sources: string[] = [];
    if (hasEnvironmentKey()) sources.push("environment");
    if (hasNamedKeyFile()) sources.push("named file");
    if (envFileHasKey(root)) sources.push("campaign .env");
    return sources;
}

/** Whether ZAI_API_KEY is set to a non-empty value. */
function hasEnvironmentKey(): boolean {
    const value = process.env.ZAI_API_KEY;
    return typeof value === "string" && value !== "";
}

/** Whether ZAI_API_KEY_FILE names an existing file. */
function hasNamedKeyFile(): boolean {
    const named = process.env.ZAI_API_KEY_FILE;
    return typeof named === "string" && named !== "" && existsSync(named);
}

/** Whether the campaign .env carries a non-empty ZAI_API_KEY line. */
function envFileHasKey(root: string): boolean {
    const text = readTextOr(join(root, ".env"));
    if (text === null) return false;
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("ZAI_API_KEY")) continue;
        const rest = trimmed.slice("ZAI_API_KEY".length).replace(/^[=\s]+/, "");
        if (rest !== "") return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Preparation progress.

function observePreparation(
    root: string,
    files: IdentityFiles,
): { steps: PrepStep[]; freezeProblems: string[] } {
    const record = files.freezeRecord;
    const steps: PrepStep[] = [
        materialisationStep(root),
        checkoutStep("arms/a checkout", join(root, "arms/a")),
        checkoutStep("arms/b checkout", join(root, "arms/b")),
        checkoutStep("measurement checkout", join(root, "measurement")),
        surfacesStep(root, record),
        fixturesStep(root, "a"),
        fixturesStep(root, "b"),
        deliveryStep(root, record, "a"),
        deliveryStep(root, record, "b"),
        specStep(root),
        dryRunStep(),
    ];
    const freeze = freezeStep(root, record);
    steps.splice(steps.length - 1, 0, freeze);
    return { steps, freezeProblems: freeze.problems ?? [] };
}

/** One worktree checkout step: present, or verified with node_modules. */
function checkoutStep(label: string, dir: string): PrepStep {
    if (!existsSync(dir)) return { step: label, state: "missing" };
    if (!existsSync(join(dir, "node_modules"))) {
        return { step: label, state: "present", detail: "node_modules missing" };
    }
    return { step: label, state: "verified", detail: "node_modules installed" };
}

/** The materialisation step: prepare/ and runner/ staged. */
function materialisationStep(root: string): PrepStep {
    const staged =
        existsSync(join(root, "prepare")) && existsSync(join(root, "runner"));
    return {
        step: "materialisation",
        state: staged ? "present" : "missing",
        detail: "materialise.mts stages prepare/ and pinned runner/ modules",
    };
}

/** One arm's generated fixture step. */
function fixturesStep(root: string, arm: string): PrepStep {
    const step: PrepStep = {
        step: `generated fixtures (${arm})`,
        state: "missing",
    };
    try {
        const fixtures = join(root, "gen", arm, "fixtures");
        if (existsSync(fixtures) && readdirSync(fixtures).length > 0) {
            step.state = "present";
        }
    } catch {
        step.state = "missing";
    }
    return step;
}

/** The measurement spec step. */
function specStep(root: string): PrepStep {
    return {
        step: "measurement spec",
        state: existsSync(join(root, "evidence/measurement-spec.json"))
            ? "present"
            : "missing",
    };
}

/** The dry-run step: unverifiable by design, since run.mts records nothing. */
function dryRunStep(): PrepStep {
    return {
        step: "dry run",
        state: "unverifiable",
        detail:
            "run.mts --dry-run records no durable evidence; a passing dry run cannot be observed later",
    };
}

/** The B-only description change step, from surfaces records. */
function surfacesStep(root: string, record: FreezeRecord | null): PrepStep {
    const surfacesA = readSurface(root, "a");
    const surfacesB = readSurface(root, "b");
    const step: PrepStep = { step: "B-only description change", state: "missing" };
    if (surfacesA === null || surfacesB === null) return step;
    step.state = "present";
    step.detail = surfaceDetail(surfacesA, surfacesB);
    const verified = surfacesVerified(record, surfacesA, surfacesB);
    if (verified !== null) step.state = verified;
    return step;
}

/** The recorded native-char detail for both surfaces. */
function surfaceDetail(
    surfacesA: Record<string, unknown>,
    surfacesB: Record<string, unknown>,
): string {
    return `A ${num(surfacesA, "nativeChars") ?? "?"} chars, B ${num(surfacesB, "nativeChars") ?? "?"} chars`;
}

/** "verified" or "mismatch" against the freeze, or null when unjudgeable. */
function surfacesVerified(
    record: FreezeRecord | null,
    surfacesA: Record<string, unknown>,
    surfacesB: Record<string, unknown>,
): StepState | null {
    const aHash = str(surfacesA, "nativeHash");
    const bHash = str(surfacesB, "nativeHash");
    if (record === null || aHash === undefined || bHash === undefined) return null;
    const frozenA = record.arms.find((arm) => arm.id === "A");
    const frozenB = record.arms.find((arm) => arm.id === "B");
    if (frozenA === undefined || frozenB === undefined) return null;
    return frozenA.descriptionHash === aHash && frozenB.descriptionHash === bHash
        ? "verified"
        : "mismatch";
}

/** One arm's surfaces record, or null when absent or malformed. */
function readSurface(root: string, arm: string): Record<string, unknown> | null {
    const read = readJsonFile(join(root, `evidence/surfaces-${arm}.json`));
    return read.value !== undefined && isRecord(read.value) ? read.value : null;
}

/** One arm's delivery receipt step: verified against the freeze when present. */
function deliveryStep(
    root: string,
    record: FreezeRecord | null,
    arm: string,
): PrepStep {
    const step: PrepStep = {
        step: `delivery receipt (${arm})`,
        state: "missing",
    };
    const read = readJsonFile(
        join(root, `evidence/delivery-${arm}`, "request-1.json"),
    );
    if (read.value === undefined) return step;
    step.state = "present";
    const parsed = deliveredDescription(read.value);
    if (parsed.problem !== undefined) {
        step.state = "unverifiable";
        step.detail = parsed.problem;
        return step;
    }
    step.state = "verified";
    step.detail = `${parsed.chars} chars delivered`;
    if (record === null) return step;
    const frozen = record.arms.find((entry) => entry.id === arm.toUpperCase());
    if (frozen !== undefined && frozen.deliveredChars !== parsed.chars) {
        step.state = "mismatch";
        step.detail = `delivered ${parsed.chars} chars, freeze declares ${frozen.deliveredChars}`;
    }
    return step;
}

/** The served docs description inside a captured provider request. */
function deliveredDescription(
    body: unknown,
): { chars?: number; hash?: string; problem?: string } {
    if (!isRecord(body) || !Array.isArray(body.tools)) {
        return { problem: "capture carries no tools array" };
    }
    for (const tool of body.tools) {
        const description = servedDocsDescription(tool);
        if (description === undefined) continue;
        return {
            chars: [...description].length,
            hash: createHash("sha256").update(description).digest("hex"),
        };
    }
    return { problem: "capture does not serve tool docs" };
}

/** The docs tool description one captured tool entry serves, or undefined. */
function servedDocsDescription(tool: unknown): string | undefined {
    if (!isRecord(tool) || !isRecord(tool.function)) return undefined;
    if (tool.function.name !== "docs") return undefined;
    const description = tool.function.description;
    return typeof description === "string" ? description : undefined;
}

/** The freeze step: FROZEN.json plus a fresh verifyFreeze over local inputs. */
function freezeStep(
    root: string,
    record: FreezeRecord | null,
): PrepStep & { problems?: string[] } {
    const step: PrepStep & { problems?: string[] } = {
        step: "freeze",
        state: "missing",
    };
    if (record === null) return step;
    step.state = "present";
    const unusable = spendFreezeProblem(record);
    if (unusable !== null) {
        step.state = "unverifiable";
        step.detail = unusable;
        step.problems = [unusable];
        return step;
    }
    const problems = verifyFreeze(record, freezeObservation(root, record));
    step.state = problems.length === 0 ? "verified" : "mismatch";
    step.detail =
        problems.length === 0
            ? "immutable inputs, image and source revision verified"
            : problems.join("; ");
    step.problems = problems;
    return step;
}

/** The local observation verifyFreeze compares against the freeze. */
function freezeObservation(
    root: string,
    record: FreezeRecord,
): {
    files: FrozenFile[];
    inventories: FrozenInventory[];
    imageId: string;
    containerCli: string;
    sourceRevision: string;
} {
    const sourceRepo = sourceRepoFor();
    const head =
        sourceRepo === null ? "" : (git(sourceRepo, ["rev-parse", "HEAD"]) ?? "");
    return {
        files: record.files.map((file) => ({
            path: file.path,
            sha256: hashFile(join(root, file.path)),
        })),
        inventories: record.inventories.map((inventory) => ({
            path: inventory.path,
            files: hashedFilesUnder(root, inventory.path),
        })),
        imageId:
            record.imageId === ""
                ? ""
                : capture("podman", [
                      "image",
                      "inspect",
                      "--format",
                      "{{.Id}}",
                      record.imageId,
                  ]),
        containerCli: capture("podman", ["--version"]),
        sourceRevision: head,
    };
}

/** Where the source repo is observed: the documented env name, or null. */
function sourceRepoFor(): string | null {
    const repo = process.env.CAMPAIGN_SOURCE_REPO;
    return typeof repo === "string" && repo !== "" ? repo : null;
}

// ---------------------------------------------------------------------------
// Live position.

interface RawLedgerLine {
    at: string | null;
    event: string;
    record: Record<string, unknown>;
}

/** Parse raw ledger lines for payload fields the structural parser drops. */
function rawLines(text: string | null): RawLedgerLine[] {
    if (text === null) return [];
    const lines: RawLedgerLine[] = [];
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (line === "") continue;
        const parsed = parseLedgerLine(line);
        if (parsed !== undefined) lines.push(parsed);
    }
    return lines;
}

/** One structurally usable ledger line, or undefined. */
function parseLedgerLine(line: string): RawLedgerLine | undefined {
    try {
        const value = JSON.parse(line) as unknown;
        if (!isRecord(value) || typeof value.event !== "string") return undefined;
        return {
            at: typeof value.at === "string" ? value.at : null,
            event: value.event,
            record: value,
        };
    } catch {
        // parseCampaignLedger reports the malformed line.
        return undefined;
    }
}

/** The claim file name budget.ts would give this claim. */
function claimFileName(claim: BudgetClaim): string {
    return `${claim.kind}-${String(claim.index).padStart(4, "0")}.claim`;
}

/**
 * Observe live position. The ledger reader is injectable so the tests can
 * prove a ledger that advances mid-read is labelled, not chased.
 */
export function observePosition(
    root: string,
    files: IdentityFiles,
    ledgerReader: (path: string) => string | null = readTextOr,
): Position {
    const evidence = join(root, "evidence");
    const ledgerPath = join(evidence, "ATTEMPTS.jsonl");
    const ledger = readLedgerBounded(ledgerPath, ledgerReader);
    const lines = ledger.lines;
    const position: Position = {
        ledgerState: ledger.firstParse.state,
        eventCount: ledger.reparse.events.length,
    };
    if (ledger.changing) position.ledgerChanging = true;
    if (ledger.reparse.state === "closed") {
        position.closedAt = ledger.reparse.closedAt;
    }
    const last = lastEventOf(lines);
    if (last !== undefined) position.lastEvent = last;
    position.stopReason = stopReasonOf(lines);
    position.completedPairs = completedPairsOf(lines);
    position.usableAssessments = usableAssessmentsOf(lines);
    const schedule = files.schedule;
    if (schedule !== null) {
        position.slots = schedule.slots.map((slot) =>
            slotObservation(slot, evidence, eventsByStamp(ledger.reparse.events), lines),
        );
    }
    position.spend = spendObservation(evidence, files.freezeRecord);
    position.closingLock = existsSync(join(evidence, "CLOSING.lock"));
    return position;
}

/** One bounded ledger read: read twice, label a change, never chase it. */
function readLedgerBounded(
    ledgerPath: string,
    reader: (path: string) => string | null,
): {
    firstParse: ReturnType<typeof parseCampaignLedger>;
    reparse: ReturnType<typeof parseCampaignLedger>;
    changing: boolean;
    lines: RawLedgerLine[];
} {
    const first = reader(ledgerPath);
    const second = reader(ledgerPath);
    const changing =
        first !== null && second !== null && first !== second;
    const bytes = changing ? (second as string) : first;
    return {
        firstParse: parseCampaignLedger(first ?? undefined),
        reparse: parseCampaignLedger(bytes ?? undefined),
        changing,
        lines: rawLines(bytes),
    };
}

/** The last durable event, with its identifying payload fields. */
function lastEventOf(lines: readonly RawLedgerLine[]): Position["lastEvent"] {
    const last = lines.at(-1);
    if (last === undefined) return undefined;
    const detail = lastEventDetailOf(last);
    const event: NonNullable<Position["lastEvent"]> = {
        event: last.event,
        at: last.at,
    };
    if (detail !== "") event.detail = detail;
    return event;
}

/** The identifying payload fields of one event, as one display string. */
function lastEventDetailOf(line: RawLedgerLine): string {
    const parts: string[] = [];
    for (const key of ["pairId", "arm", "stamp", "reason", "outcome", "slot"]) {
        const value = line.record[key];
        if (typeof value === "string" || typeof value === "number") {
            parts.push(`${key}=${String(value)}`);
        }
    }
    return parts.join(" ");
}

/** The recorded stop reason, when the ledger carries a close. */
function stopReasonOf(lines: readonly RawLedgerLine[]): string | null {
    const close = lines.find((line) => line.event === "campaign-closed");
    if (close === undefined) return null;
    return typeof close.record.reason === "string" ? close.record.reason : null;
}

/** The pairs with a pair-complete event. */
function completedPairsOf(lines: readonly RawLedgerLine[]): string[] {
    const pairs = new Set<string>();
    for (const line of lines) {
        if (line.event === "pair-complete" && typeof line.record.pairId === "string") {
            pairs.add(line.record.pairId);
        }
    }
    return [...pairs].sort();
}

/** The judge attempts observed to end judged. */
function usableAssessmentsOf(lines: readonly RawLedgerLine[]): number {
    let judged = 0;
    for (const line of lines) {
        if (line.event === "judge-exit" && line.record.outcome === "judged") {
            judged += 1;
        }
    }
    return judged;
}

/** One slot's observed state, from the harness event vocabulary. */
function slotObservation(
    slot: ScheduleSlotLite,
    evidence: string,
    byStamp: ReturnType<typeof eventsByStamp>,
    lines: readonly RawLedgerLine[],
): SlotObservation {
    const events = byStamp.get(slot.stamp);
    const claim = openClaimOf(evidence, slot.stamp);
    const state = slotStateOf(events, claim, lines, slot.stamp);
    const observation: SlotObservation = {
        slot: slot.slot,
        pairId: slot.pairId,
        scenario: slot.scenario,
        arm: slot.arm,
        stamp: slot.stamp,
        state: state.state,
    };
    if (state.note !== undefined) observation.note = state.note;
    return observation;
}

/** The open (unclosed) claim naming a stamp, across both kinds, or undefined. */
function openClaimOf(
    evidence: string,
    stamp: string,
): { state: string; note: string } | undefined {
    for (const kind of ["trial", "judge"] as const) {
        const claim = findOpenClaim(evidence, kind, stamp);
        if (claim === undefined) continue;
        const disposition = restartDisposition(claim) ?? claim.state;
        return {
            state: claim.state,
            note: `unsettled ${kind} claim (${disposition})`,
        };
    }
    return undefined;
}

/** One open claim of a kind naming a stamp, or undefined. */
function findOpenClaim(
    evidence: string,
    kind: "trial" | "judge",
    stamp: string,
): BudgetClaim | undefined {
    try {
        return readClaims(evidence, kind).find(
            (claim) => claim.stamp === stamp && claim.state !== "closed",
        );
    } catch {
        return undefined;
    }
}

/** One slot's state from its events, its claim, and the raw ledger. */
function slotStateOf(
    events: StampEvents | undefined,
    claim: { state: string; note: string } | undefined,
    lines: readonly RawLedgerLine[],
    stamp: string,
): { state: string; note?: string } {
    if (events !== undefined && events.complete) return { state: "complete" };
    if (claim !== undefined) {
        return { state: claim.state, note: claim.note };
    }
    if (events === undefined || events.events.length === 0) {
        return { state: "unrun" };
    }
    if (events.blocked && events.launches === 0) {
        return { state: "refused-before-dispatch", ...blockedNoteOf(lines, stamp) };
    }
    if (events.launches > 0) {
        return launchedStateOf(lines, stamp);
    }
    return { state: "indeterminate" };
}

/** The recorded block reason, when one exists. */
function blockedNoteOf(
    lines: readonly RawLedgerLine[],
    stamp: string,
): { note?: string } {
    const block = lines.find(
        (line) => line.event === "slot-blocked" && line.record.stamp === stamp,
    );
    if (block === undefined || typeof block.record.reason !== "string") {
        return {};
    }
    return { note: block.record.reason };
}

/** A launched slot's state: awaiting exit, unusable, awaiting judge, judged. */
function launchedStateOf(
    lines: readonly RawLedgerLine[],
    stamp: string,
): { state: string; note?: string } {
    const exit = lines.find(
        (line) => line.event === "trial-exit" && line.record.stamp === stamp,
    );
    if (exit === undefined) {
        return { state: "dispatched", note: "no durable trial exit yet" };
    }
    if (exit.record.usable !== true) {
        return { state: "failed-unusable", note: "trial exited unusable" };
    }
    const judged = lines.some(
        (line) => line.event === "judge-exit" && line.record.stamp === stamp,
    );
    return { state: judged ? "adjudicated" : "awaiting-judgement" };
}

/** Spend accounting from claim files; ceilings from the freeze only. */
function spendObservation(
    evidence: string,
    record: FreezeRecord | null,
): SpendObservation {
    const ceilings = record?.ceilings ?? { trial: 0, judge: 0 };
    const trialClaims = safeReadClaims(evidence, "trial");
    const judgeClaims = safeReadClaims(evidence, "judge");
    const spend: SpendObservation = {
        trial: kindSpend(evidence, "trial", ceilings.trial),
        judge: kindSpend(evidence, "judge", ceilings.judge),
        reserved: countState(trialClaims, "reserved") + countState(judgeClaims, "reserved"),
        spawned: countState(trialClaims, "spawned") + countState(judgeClaims, "spawned"),
        unresolved: unresolvedClaims(evidence, trialClaims, judgeClaims),
    };
    return spend;
}

/** One kind's spend against its ceiling. */
function kindSpend(
    evidence: string,
    kind: "trial" | "judge",
    ceiling: number,
): SpendKind {
    const used = safeUsage(evidence, kind);
    return {
        used,
        ceiling,
        remaining: Math.max(0, ceiling - used),
        basis: "claim files under evidence/<kind>, counted from creation",
    };
}

/** readClaims without letting a read failure abort the observation. */
function safeReadClaims(evidence: string, kind: "trial" | "judge"): BudgetClaim[] {
    try {
        return readClaims(evidence, kind);
    } catch {
        return [];
    }
}

/** claimUsage without letting a read failure abort the observation. */
function safeUsage(evidence: string, kind: "trial" | "judge"): number {
    try {
        return claimUsage(evidence, kind).claimed;
    } catch {
        return 0;
    }
}

/** How many claims of one list carry a state. */
function countState(claims: readonly BudgetClaim[], state: string): number {
    return claims.filter((claim) => claim.state === state).length;
}

/** The claims whose outcome is unknown, with their file paths. */
function unresolvedClaims(
    evidence: string,
    trialClaims: readonly BudgetClaim[],
    judgeClaims: readonly BudgetClaim[],
): UnresolvedClaim[] {
    const named: { claim: BudgetClaim; kind: string }[] = [
        ...unresolvedReservations(trialClaims).map((claim) => ({ claim, kind: "trial" })),
        ...unresolvedReservations(judgeClaims).map((claim) => ({ claim, kind: "judge" })),
    ];
    return named.map(({ claim, kind }) => {
        const entry: UnresolvedClaim = {
            kind,
            state: claim.state,
            path: join(evidence, kind, claimFileName(claim)),
        };
        if (claim.stamp !== null) entry.stamp = claim.stamp;
        return entry;
    });
}

// ---------------------------------------------------------------------------
// Checkpoint and reports.

function observeCheckpoint(
    root: string,
    reportRoot: string | undefined,
    position: Position | undefined,
): Checkpoint {
    const checkpoint: Checkpoint = { reportRootGiven: reportRoot !== undefined };
    checkpoint.reconciliation = observeReconciliation(root);
    if (reportRoot === undefined) return checkpoint;
    checkpoint.reports = observeReports(root, reportRoot, position);
    return checkpoint;
}

/** The campaign's reconciliation record, or present:false. */
function observeReconciliation(root: string): ReconciliationObservation {
    const read = readJsonFile(join(root, "evidence/RECONCILIATION.json"));
    if (read.value === undefined || !isRecord(read.value)) {
        return { present: false };
    }
    return reconciliationOf(read.value);
}

/** One parsed reconciliation record. */
function reconciliationOf(rec: Record<string, unknown>): ReconciliationObservation {
    const reconciliation: ReconciliationObservation = {
        present: true,
        ...reconciliationCounts(rec),
        ...reconciliationBilling(rec),
    };
    const at = str(rec, "at");
    if (at !== undefined) reconciliation.at = at;
    return reconciliation;
}

/** The recorded counts of a reconciliation record. */
function reconciliationCounts(rec: Record<string, unknown>): {
    unrunSlots: number;
    completedPairs?: number;
    trialLaunches?: number;
} {
    const result: {
        unrunSlots: number;
        completedPairs?: number;
        trialLaunches?: number;
    } = {
        unrunSlots: Array.isArray(rec.unrunSlots) ? rec.unrunSlots.length : 0,
    };
    const pairs = num(rec, "completedPairs");
    if (pairs !== undefined) result.completedPairs = pairs;
    const launches = num(rec, "trialLaunches");
    if (launches !== undefined) result.trialLaunches = launches;
    return result;
}

/** The billing estimates of a reconciliation record. */
function reconciliationBilling(rec: Record<string, unknown>): {
    billingTrial: number | null;
    billingJudge: number | null;
    currency?: string;
} {
    const billing = isRecord(rec.billing) ? rec.billing : {};
    const trial = isRecord(billing.trial) ? billing.trial : {};
    const judge = isRecord(billing.judge) ? billing.judge : {};
    const result: {
        billingTrial: number | null;
        billingJudge: number | null;
        currency?: string;
    } = {
        billingTrial: num(trial, "estimated") ?? null,
        billingJudge: num(judge, "estimated") ?? null,
    };
    const currency = str(billing, "currency");
    if (currency !== undefined) result.currency = currency;
    return result;
}

/** Every report under an explicit report root, in directory order. */
function observeReports(
    root: string,
    reportRoot: string,
    position: Position | undefined,
): ReportObservation[] {
    const manifestHash = hashFile(join(root, "prepare/manifest.json"));
    const lastLedgerAt = position?.lastEvent?.at ?? null;
    const reports: ReportObservation[] = [];
    // The report root may hold one report per subdirectory (the run card
    // shape) or be a single report directory itself.
    if (existsSync(join(reportRoot, "analysis.json"))) {
        reports.push(
            observeReport(reportRoot, root, manifestHash, lastLedgerAt),
        );
    }
    for (const dir of reportSubdirs(reportRoot)) {
        reports.push(observeReport(dir, root, manifestHash, lastLedgerAt));
    }
    return reports;
}

/** The subdirectories of a report root, sorted; [] when unreadable. */
function reportSubdirs(reportRoot: string): string[] {
    const dirs: string[] = [];
    try {
        for (const entry of readdirSync(reportRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) dirs.push(join(reportRoot, entry.name));
        }
    } catch {
        return [];
    }
    return dirs.sort();
}

/** One analysis report observation; a partial report keeps its own scope. */
function observeReport(
    dir: string,
    root: string,
    manifestHash: string,
    lastLedgerAt: string | null,
): ReportObservation {
    const read = readJsonFile(join(dir, "analysis.json"));
    if (read.value === undefined || !isRecord(read.value)) {
        return { dir };
    }
    const report = reportIdentity(read.value, dir, root, manifestHash, lastLedgerAt);
    report.pairedDelta = pairedDeltaOf(read.value);
    applyDecisionSummary(report, read.value);
    applyMeasures(report, read.value);
    applyUsage(report, read.value);
    report.scope = `report scope is its own: ${String(report.coverage?.completePairs ?? "?")} complete pairs at render time`;
    return report;
}

/** A report's identity and freshness fields. */
function reportIdentity(
    analysis: Record<string, unknown>,
    dir: string,
    root: string,
    manifestHash: string,
    lastLedgerAt: string | null,
): ReportObservation {
    const receiptFile = readJsonFile(join(dir, "analysis-receipt.json"));
    const receipt =
        receiptFile.value !== undefined && isRecord(receiptFile.value)
            ? receiptFile.value
            : null;
    const report: ReportObservation = { dir };
    applyCampaignId(report, analysis, root);
    if (receipt !== null) {
        const renderedAt = str(receipt, "renderedAt");
        if (renderedAt !== undefined) report.renderedAt = renderedAt;
    }
    applyFreshness(report, analysis, manifestHash, lastLedgerAt);
    return report;
}

/** The report's campaign id, and whether it names another campaign. */
function applyCampaignId(
    report: ReportObservation,
    analysis: Record<string, unknown>,
    root: string,
): void {
    if (!isRecord(analysis.campaign)) return;
    const id = str(analysis.campaign, "id");
    if (id === undefined) return;
    report.campaignId = id;
    if (!identityMatches(root, id)) report.wrongCampaign = true;
}

/** Freshness from the pinned manifest hash and the ledger clock. */
function applyFreshness(
    report: ReportObservation,
    analysis: Record<string, unknown>,
    manifestHash: string,
    lastLedgerAt: string | null,
): void {
    const manifestSha = str(analysis, "manifestSha256");
    if (manifestSha === undefined || manifestHash === "missing") return;
    report.manifestSha256 = manifestSha;
    report.manifestMatches = manifestSha === manifestHash;
    if (report.renderedAt === undefined || lastLedgerAt === null) {
        report.freshness = report.manifestMatches ? "current" : "stale";
        return;
    }
    const advanced = lastLedgerAt > report.renderedAt;
    report.ledgerAdvancedSince = advanced;
    report.freshness = report.manifestMatches && !advanced ? "current" : "stale";
}

/** The paired utility delta, when published. */
function pairedDeltaOf(analysis: Record<string, unknown>): number | null {
    return isRecord(analysis.paired) ? (num(analysis.paired, "delta") ?? null) : null;
}

/** The decision and personal-trial recommendation a report published. */
function applyDecisionSummary(
    report: ReportObservation,
    analysis: Record<string, unknown>,
): void {
    if (isRecord(analysis.decision)) {
        const overall = str(analysis.decision, "overall");
        if (overall !== undefined) report.decision = overall;
    }
    if (!isRecord(analysis.measures) || !isRecord(analysis.measures.personalTrial)) {
        return;
    }
    const recommendation = str(analysis.measures.personalTrial, "recommendation");
    if (recommendation !== undefined) report.recommendation = recommendation;
}

/** Guardrail breaches, coverage and per-arm measures from a report. */
function applyMeasures(
    report: ReportObservation,
    analysis: Record<string, unknown>,
): void {
    const arms = isRecord(analysis.arms) ? analysis.arms : null;
    if (arms === null) return;
    const measures = isRecord(analysis.measures) ? analysis.measures : null;
    const recording: Record<string, { planned: number; success: number }> = {};
    const retrieval: Record<string, { planned: number; applied: number }> = {};
    let breaches = 0;
    for (const [arm, value] of Object.entries(arms)) {
        if (!isRecord(value)) continue;
        breaches += breachedCount(value);
        collectArmMeasures(measures, arm, recording, retrieval);
    }
    report.guardrailBreaches = breaches;
    if (Object.keys(recording).length > 0) report.recording = recording;
    if (Object.keys(retrieval).length > 0) report.retrieval = retrieval;
    applyCoverage(report, analysis, arms);
}

/** Evidence coverage figures: complete pairs plus documented/assessed counts. */
function applyCoverage(
    report: ReportObservation,
    analysis: Record<string, unknown>,
    arms: Record<string, unknown>,
): void {
    let documented = 0;
    let assessed = 0;
    for (const value of Object.values(arms)) {
        if (!isRecord(value) || !isRecord(value.accounting)) continue;
        documented += num(value.accounting, "documented") ?? 0;
        assessed += num(value.accounting, "assessed") ?? 0;
    }
    report.coverage = {
        completePairs: isRecord(analysis.pairing)
            ? (num(analysis.pairing, "completePairs") ?? 0)
            : 0,
        documented,
        assessed,
    };
}

/** How many guardrails one arm breached. */
function breachedCount(arm: Record<string, unknown>): number {
    if (!Array.isArray(arm.guardrails)) return 0;
    return arm.guardrails.filter(
        (g) => isRecord(g) && g.status === "breached",
    ).length;
}

/** One arm's measures into the shared recording/retrieval maps. */
function collectArmMeasures(
    measures: Record<string, unknown> | null,
    arm: string,
    recording: Record<string, { planned: number; success: number }>,
    retrieval: Record<string, { planned: number; applied: number }>,
): void {
    if (measures === null || !isRecord(measures.arms)) return;
    const armMeasures = measures.arms[arm];
    if (!isRecord(armMeasures)) return;
    if (isRecord(armMeasures.recording)) {
        recording[arm] = {
            planned: num(armMeasures.recording, "planned") ?? 0,
            success: num(armMeasures.recording, "success") ?? 0,
        };
    }
    if (isRecord(armMeasures.retrieval)) {
        retrieval[arm] = {
            planned: num(armMeasures.retrieval, "planned") ?? 0,
            applied: num(armMeasures.retrieval, "applied") ?? 0,
        };
    }
}

/** Token coverage figures, when a report published them. */
function applyUsage(
    report: ReportObservation,
    analysis: Record<string, unknown>,
): void {
    const usage = isRecord(analysis.usage) ? analysis.usage : null;
    if (usage === null && analysis.measuredTrials === undefined) return;
    const tokens: NonNullable<ReportObservation["tokens"]> = {
        steps: usage !== null ? (num(usage, "steps") ?? null) : null,
    };
    const measured = num(analysis, "measuredTrials");
    if (measured !== undefined) tokens.measuredTrials = measured;
    const unknown = num(analysis, "unknownTrials");
    if (unknown !== undefined) tokens.unknownTrials = unknown;
    report.tokens = tokens;
}

/** Whether a report's campaign id matches this root's schedule identity. */
function identityMatches(root: string, campaignId: string): boolean {
    const read = readJsonFile(join(root, "evidence/schedule.json"));
    if (read.value === undefined || !isRecord(read.value)) return true;
    const own = str(read.value, "campaign");
    return own === undefined ? true : own === campaignId;
}

// ---------------------------------------------------------------------------
// Next action derivation.

interface ActionResult {
    phase: string;
    headline: string;
    nextAction: NextAction;
    gaps: Gap[];
}

const RUN_CARD = "tests/fixtures/placement-harness/prod014/campaign/README.md";

/** The checkout-mode next action. */
function checkoutNextAction(
    identity: Identity,
    assetsPresent: boolean,
): ActionResult {
    const gaps: Gap[] = [
        { field: "checkpoint rule (P04 report before continuation)", source: "run-card" },
    ];
    if (isBaseMismatch(identity)) {
        return {
            phase: "base-mismatch",
            headline: `HEAD (${identity.sourceHead?.slice(0, 12)}) is not the requested base (${identity.requestedBase?.slice(0, 12)})`,
            nextAction: {
                kind: "operator-decision",
                why: `checkout mode compares --base with HEAD; decide whether to check out ${identity.requestedBase ?? "the base"} or re-pin`,
            },
            gaps,
        };
    }
    if (identity.sourceClean === false) {
        return {
            phase: "dirty-checkout",
            headline: "the operator checkout has uncommitted changes",
            nextAction: {
                kind: "operator-decision",
                why: "materialise records the checked-out sources; commit or stash first so the freeze pins reviewable bytes",
            },
            gaps,
        };
    }
    if (!assetsPresent) {
        return {
            phase: "missing-campaign-tooling",
            headline: "prod014 campaign tooling is absent from this checkout",
            nextAction: {
                kind: "operator-decision",
                why: "materialise.mts, active/ and runner.json must exist at the pinned revision",
            },
            gaps,
        };
    }
    return {
        phase: "unmaterialised-checkout",
        headline: "clean checkout at the requested base; no campaign root yet",
        nextAction: {
            kind: "offline-preparation",
            why: "materialise the campaign root from this commit (run card step 0)",
            command:
                "REV=$(git rev-parse HEAD) && export CAMPAIGN_ROOT=$(mktemp -d) && " +
                `mkdir -p ${shellQuote("$CAMPAIGN_ROOT/evidence")} && ` +
                `node ${shellQuote("tests/fixtures/placement-harness/prod014/campaign/materialise.mts")} ${shellQuote("$CAMPAIGN_ROOT")}`,
            envNames: ["CAMPAIGN_ROOT"],
        },
        gaps,
    };
}

/** Whether checkout mode found HEAD different from the requested base. */
function isBaseMismatch(identity: Identity): boolean {
    return (
        identity.resolvedBase !== undefined &&
        identity.sourceHead !== undefined &&
        identity.resolvedBase !== identity.sourceHead
    );
}

/** One shell-quoted run.mts invocation for this campaign root. */
function runCommand(root: string, sourceRepo: string | null, args: string): string {
    const envs = [`CAMPAIGN_ROOT=${shellQuote(root)}`];
    envs.push(
        sourceRepo === null
            ? "CAMPAIGN_SOURCE_REPO=<measurement-worktree>"
            : `CAMPAIGN_SOURCE_REPO=${shellQuote(sourceRepo)}`,
    );
    return `${envs.join(" ")} node ${shellQuote(join(root, "prepare/run.mts"))} ${args}`;
}

/** The analyse.mts invocation for this campaign root. */
function analyseCommand(root: string, sourceRepo: string | null): string {
    const cd =
        sourceRepo === null
            ? "cd <measurement-worktree>"
            : `cd ${shellQuote(sourceRepo)}`;
    return (
        `${cd} && node tests/fixtures/placement-harness/analysis/analyse.mts ` +
        `--campaign ${shellQuote(join(root, "prepare/manifest.json"))} ` +
        `--evidence-root ${shellQuote(root)} --out <fresh-report-dir>`
    );
}

/** The campaign-mode next action, from the authority-ordered gates. */
function campaignNextAction(
    root: string,
    files: IdentityFiles,
    readiness: Readiness,
    preparation: PrepStep[],
    freezeProblems: string[],
    position: Position,
    checkpoint: Checkpoint,
): ActionResult {
    const gates: (ActionResult | null)[] = [
        credentialGate(root, readiness),
        closingGate(root, position),
        closedGate(root, position, checkpoint),
        reservationGate(root, position),
        malformedLedgerGate(root, position),
        freezeGate(freezeProblems),
        shimGate(root, readiness),
    ];
    const blocked = gates.find((gate) => gate !== null);
    if (blocked !== null && blocked !== undefined) return blocked;
    if (files.freezeRecord === null) {
        return preFreezeAction(root, preparation);
    }
    return frozenAction(root, position, checkpoint);
}

/** The credential-mode gate, first as run.mts refuses it first. */
function credentialGate(root: string, readiness: Readiness): ActionResult | null {
    if (readiness.credentials.modeProblem === undefined) return null;
    return {
        phase: "blocked-credential-mode",
        headline: readiness.credentials.modeProblem,
        nextAction: {
            kind: "offline-check",
            why: "the runner refuses a credential file readable beyond its owner before loading any value",
            command: `chmod 600 ${shellQuote(join(root, ".env"))}`,
        },
        gaps: [],
    };
}

/** The interrupted-close gate. */
function closingGate(root: string, position: Position): ActionResult | null {
    if (position.closingLock !== true) return null;
    return {
        phase: "close-interrupted",
        headline: "a campaign close started and did not finish (CLOSING.lock present)",
        nextAction: {
            kind: "inspection",
            why: "every dispatch refuses while the lock exists; inspect the evidence root, then decide whether to resume close-campaign.mts",
            path: join(root, "evidence"),
        },
        gaps: [],
    };
}

/** The closed-campaign gate. */
function closedGate(
    root: string,
    position: Position,
    checkpoint: Checkpoint,
): ActionResult | null {
    if (position.ledgerState !== "closed") return null;
    const stopped =
        position.stopReason !== undefined && position.stopReason !== null
            ? `: ${position.stopReason}`
            : "";
    return {
        phase: "closed",
        headline: `campaign closed${stopped}`,
        nextAction: {
            kind: "inspection",
            why: "read the final report and reconciliation; no further spend is permitted",
            path:
                checkpoint.reports?.[0]?.dir ??
                join(root, "evidence/RECONCILIATION.json"),
        },
        gaps: [],
    };
}

/** The unresolved-reservation gate: no dispatch past unknown spend. */
function reservationGate(root: string, position: Position): ActionResult | null {
    const unresolved = position.spend?.unresolved ?? [];
    if (unresolved.length === 0) return null;
    return {
        phase: "blocked-unresolved-reservation",
        headline: `unsettled ${unresolved[0]?.kind ?? ""} claim blocks every dispatch`,
        nextAction: {
            kind: "inspection",
            why: "the runner never retries a spend whose outcome is unknown; inspect the claim and its launch record before any decision",
            path: unresolved[0]?.path ?? join(root, "evidence"),
        },
        gaps: [],
    };
}

/** The malformed-ledger gate. */
function malformedLedgerGate(root: string, position: Position): ActionResult | null {
    if (position.ledgerState !== "malformed") return null;
    return {
        phase: "blocked-malformed-ledger",
        headline: "the attempt ledger is malformed; no spend can be authorised",
        nextAction: {
            kind: "inspection",
            why: "a partial read cannot prove what spend was authorised; inspect ATTEMPTS.jsonl line by line",
            path: join(root, "evidence/ATTEMPTS.jsonl"),
        },
        gaps: [],
    };
}

/** The frozen-premise gate: changed wording needs a fresh root. */
function freezeGate(freezeProblems: readonly string[]): ActionResult | null {
    if (freezeProblems.length === 0) return null;
    return {
        phase: "frozen-premise-changed",
        headline: `frozen premise no longer holds: ${freezeProblems[0] ?? ""}`,
        nextAction: {
            kind: "operator-decision",
            why: "changed wording requires a fresh root, fresh materialisation and fresh stamps; never edit a frozen input",
        },
        gaps: [],
    };
}

/** The shim gate: run.mts refuses dispatch on a non-executable shim. */
function shimGate(root: string, readiness: Readiness): ActionResult | null {
    if (readiness.shimExecutable !== false) return null;
    return {
        phase: "blocked-local-prerequisite",
        headline: `the container shim is not executable: ${join(root, "prepare/shim/podman")}`,
        nextAction: {
            kind: "offline-check",
            why: "every dispatch refuses until the shim can be executed again",
            command: `chmod +x ${shellQuote(join(root, "prepare/shim/podman"))}`,
        },
        gaps: [],
    };
}

/** The pre-freeze action: the earliest missing prerequisite in run-card order. */
function preFreezeAction(root: string, preparation: readonly PrepStep[]): ActionResult {
    const earliest = earliestMissing(preparation);
    if (earliest === undefined) return freezeNextAction(root);
    const recipe = preparationRecipe(root, earliest.step);
    return {
        phase: "preparing",
        headline: `earliest missing prerequisite: ${earliest.step}`,
        nextAction: recipeAction(earliest.step, recipe),
        gaps: [],
    };
}

/** The earliest missing, mismatched or unverifiable step, skipping dry run. */
function earliestMissing(preparation: readonly PrepStep[]): PrepStep | undefined {
    const actionable = ["missing", "mismatch", "unverifiable"];
    return preparation.find(
        (step) => actionable.includes(step.state) && step.step !== "dry run",
    );
}

/** A next action from a recipe, with a fallback for unlisted steps. */
function recipeAction(
    step: string,
    recipe: { why: string; command?: string; cwd?: string; envNames?: string[] } | undefined,
): NextAction {
    const action: NextAction = {
        kind: "offline-preparation",
        why:
            recipe?.why ??
            `follow the run card (${RUN_CARD}) from this step (${step})`,
    };
    if (recipe?.command !== undefined) action.command = recipe.command;
    if (recipe?.cwd !== undefined) action.cwd = recipe.cwd;
    if (recipe?.envNames !== undefined) action.envNames = recipe.envNames;
    return action;
}

/** The freeze action, when every freeze input is present but no freeze exists. */
function freezeNextAction(root: string): ActionResult {
    const action: NextAction = {
        kind: "offline-preparation",
        why: "run card step 3: freeze builds/resolves the image and records immutable ids",
        envNames: ["CAMPAIGN_ROOT", "CAMPAIGN_SOURCE_REPO"],
    };
    const command = preparationRecipe(root, "freeze")?.command;
    if (command !== undefined) action.command = command;
    return {
        phase: "preparing",
        headline: "all freeze inputs present; freeze not yet written",
        nextAction: action,
        gaps: [],
    };
}

/** The frozen-campaign progression: dry run, checkpoint, closure or resume. */
function frozenAction(
    root: string,
    position: Position,
    checkpoint: Checkpoint,
): ActionResult {
    const completePairs = new Set(position.completedPairs ?? []);
    const allPairs = new Set((position.slots ?? []).map((slot) => slot.pairId));
    const gaps: Gap[] = [];
    if (completePairs.size === 0) return dryRunNextAction(root, gaps);
    if (allPairs.size > 0 && completePairs.size >= allPairs.size) {
        return closureNextAction(root, allPairs.size, gaps);
    }
    const checkpointAction = checkpointGate(root, completePairs, checkpoint, gaps);
    if (checkpointAction !== null) return checkpointAction;
    return resumeAction(root, position, allPairs.size - completePairs.size, gaps);
}

/** The offline dry-run action for a verified, unstarted freeze. */
function dryRunNextAction(
    root: string,
    gaps: Gap[],
): ActionResult {
    gaps.push({
        field: "dry-run success",
        source: "none (run.mts --dry-run writes no durable record)",
    });
    gaps.push({
        field: "human authorisation for paid dispatch",
        source: "operator-instruction (not recorded in campaign state)",
    });
    return {
        phase: "frozen-ready",
        headline: "freeze verified; no trials dispatched yet",
        nextAction: {
            kind: "offline-check",
            why: "the side-effect-free dry run prints the 16-slot plan and every input check; paid dispatch is a separate human decision",
            command: runCommand(root, sourceRepoFor(), "--dry-run"),
            envNames: ["CAMPAIGN_ROOT", "CAMPAIGN_SOURCE_REPO"],
        },
        gaps,
    };
}

/** The analysis-then-close action for a fully completed campaign. */
function closureNextAction(
    root: string,
    pairCount: number,
    gaps: Gap[],
): ActionResult {
    const sourceRepo = sourceRepoFor();
    const closeEnv =
        sourceRepo === null
            ? "CAMPAIGN_SOURCE_REPO=<measurement-worktree> "
            : `CAMPAIGN_SOURCE_REPO=${shellQuote(sourceRepo)} `;
    return {
        phase: "awaiting-closure",
        headline: `all ${pairCount} pairs complete; campaign not closed`,
        nextAction: {
            kind: "offline-preparation",
            why: "run card step 5: final analysis then close-campaign reconciles counts and writes the closure record",
            command: `${analyseCommand(root, sourceRepo)} && ${closeEnv}CAMPAIGN_ROOT=${shellQuote(root)} node ${shellQuote(join(root, "prepare/close-campaign.mts"))}`,
            envNames: ["CAMPAIGN_ROOT", "CAMPAIGN_SOURCE_REPO"],
        },
        gaps,
    };
}

/** The P04 checkpoint gate; null when the campaign is not at the checkpoint. */
function checkpointGate(
    root: string,
    completePairs: ReadonlySet<string>,
    checkpoint: Checkpoint,
    gaps: Gap[],
): ActionResult | null {
    const checkpointDone = ["P01", "P02", "P03", "P04"].every((pair) =>
        completePairs.has(pair),
    );
    if (!checkpointDone || completePairs.has("P08")) return null;
    gaps.push({
        field: "P04 blocker judgement (continue only if no blocker, no unusable judge, no premise change)",
        source: "run-card",
    });
    const reports = checkpoint.reports ?? [];
    const current = reports.find(
        (report) => report.freshness === "current" && report.wrongCampaign !== true,
    );
    if (current !== undefined) return checkpointReview(current, root);
    return staleCheckpointAction(root, checkpoint, reports);
}

/** The decision handover when the P04 report is current. */
function checkpointReview(
    current: ReportObservation,
    root: string,
): ActionResult {
    const verdict =
        current.recommendation ?? current.decision ?? "decision rendered";
    return {
        phase: "checkpoint-review",
        headline: `P04 checkpoint report current (${verdict}); continuation is a human decision`,
        nextAction: {
            kind: "operator-decision",
            why: `continue only if the report shows no blocker, no unusable judge and no premise change (run card step 4); paid P05–P08 command: ${runCommand(root, sourceRepoFor(), "--pair-from 5 --pair-to 8")}`,
            path: current.dir,
        },
        gaps: [],
    };
}

/** The re-render action when no current P04 report exists. */
function staleCheckpointAction(
    root: string,
    checkpoint: Checkpoint,
    reports: readonly ReportObservation[],
): ActionResult {
    const staleOrWrong =
        checkpoint.reportRootGiven === true &&
        reports.some(
            (report) =>
                report.freshness === "stale" || report.wrongCampaign === true,
        );
    return {
        phase: "checkpoint-report-missing",
        headline: staleOrWrong
            ? "P04 report is stale or wrong-campaign"
            : "P01–P04 complete; no current checkpoint report",
        nextAction: {
            kind: "offline-check",
            why: staleOrWrong
                ? "the existing report is stale or from another campaign; re-render into a fresh directory before deciding"
                : "run card step 4: the P04 checkpoint report must exist and be current before continuation",
            command: analyseCommand(root, sourceRepoFor()),
            envNames: ["CAMPAIGN_SOURCE_REPO"],
        },
        gaps: [],
    };
}

/** The resume action for a mid-range campaign with an open ledger. */
function resumeAction(
    root: string,
    position: Position,
    unrunPairs: number,
    gaps: Gap[],
): ActionResult {
    const nextSlot = (position.slots ?? []).find(
        (slot) => slot.state !== "complete" && slot.state !== "adjudicated",
    );
    if (nextSlot === undefined || position.ledgerState !== "open") {
        return {
            phase: "indeterminate",
            headline: "observation did not resolve to a phase; inspect the evidence",
            nextAction: {
                kind: "inspection",
                why: "no rule matched; read the ledger and claims directly",
                path: join(root, "evidence/ATTEMPTS.jsonl"),
            },
            gaps,
        };
    }
    const spend = position.spend;
    if (spend !== undefined && (spend.trial.remaining === 0 || spend.judge.remaining === 0)) {
        return ceilingReached(unrunPairs, spend, gaps);
    }
    gaps.push({
        field: "human authorisation for paid dispatch",
        source: "operator-instruction (not recorded in campaign state)",
    });
    return {
        phase: "live-in-progress",
        headline: `next unfinished slot ${nextSlot.slot} (${nextSlot.pairId} arm ${nextSlot.arm}, ${nextSlot.state})`,
        nextAction: {
            kind: "paid-operation",
            why: "resuming the range is a paid operation needing human authorisation; the runner refuses unsafe states itself",
            command: runCommand(
                root,
                sourceRepoFor(),
                `--pair-from ${pairNumberOf(nextSlot.pairId)} --pair-to 8`,
            ),
            envNames: ["CAMPAIGN_ROOT", "CAMPAIGN_SOURCE_REPO"],
        },
        gaps,
    };
}

/** The ceiling action: no dispatch is suggested past a frozen ceiling. */
function ceilingReached(
    unrunPairs: number,
    spend: SpendObservation,
    gaps: Gap[],
): ActionResult {
    return {
        phase: "ceiling-reached",
        headline: `spend ceiling reached (trial ${spend.trial.used}/${spend.trial.ceiling}, judge ${spend.judge.used}/${spend.judge.ceiling}); ${unrunPairs} pairs unrun`,
        nextAction: {
            kind: "operator-decision",
            why: "the frozen ceiling blocks every further claim; a completed P01–P04 range is not campaign completion, and status suggests no dispatch past a ceiling",
        },
        gaps,
    };
}

/** P01-style pair id to its number. */
function pairNumberOf(pairId: string): number {
    const parsed = Number(pairId.replace(/\D/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** The per-step recipes, keyed by the step names observePreparation emits. */
function preparationRecipe(
    root: string,
    step: string,
): { why: string; command?: string; cwd?: string; envNames?: string[] } | undefined {
    const builders: Record<
        string,
        () => { why: string; command?: string; cwd?: string; envNames?: string[] }
    > = {
        "arms/a checkout": () => worktreeRecipe("arms/a"),
        "arms/b checkout": () => worktreeRecipe("arms/b"),
        "measurement checkout": () => worktreeRecipe("measurement"),
        materialisation: () => materialiseRecipe(root),
        "B-only description change": () => surfacesRecipe(root),
        "generated fixtures (a)": () => generateRecipe(root),
        "generated fixtures (b)": () => generateRecipe(root),
        "delivery receipt (a)": () => deliveryRecipe(root, "a"),
        "delivery receipt (b)": () => deliveryRecipe(root, "b"),
        "measurement spec": () => specRecipe(root),
        freeze: () => freezeRecipe(root),
    };
    const builder = builders[step];
    return builder === undefined ? undefined : builder();
}

/** One arm/measurement worktree recipe. */
function worktreeRecipe(
    dir: string,
): { why: string; command: string } {
    return {
        why: `run card step 2: ${dir} is a worktree at the base commit with node_modules installed`,
        command: `git worktree add <root>/${dir} <base> && cd <root>/${dir} && npm ci`,
    };
}

/** The materialise recipe, run from the operator checkout. */
function materialiseRecipe(root: string): { why: string; command: string; cwd?: string } {
    return {
        why: "run card step 0: materialise stages prepare/ and the pinned runner modules",
        command: `node ${shellQuote("tests/fixtures/placement-harness/prod014/campaign/materialise.mts")} ${shellQuote(root)}`,
        cwd: "<operator checkout at the pinned revision>",
    };
}

/** The surfaces recipe for both arms. */
function surfacesRecipe(root: string): { why: string; command: string } {
    const surfaces = join(root, "prepare/surfaces.mts");
    return {
        why: "run card step 3: record both arms' surfaces so the freeze can compare registered descriptions",
        command:
            `node ${shellQuote(surfaces)} ${shellQuote(join(root, "arms/a"))} ${shellQuote(join(root, "evidence/surfaces-a.json"))} && ` +
            `node ${shellQuote(surfaces)} ${shellQuote(join(root, "arms/b"))} ${shellQuote(join(root, "evidence/surfaces-b.json"))}`,
    };
}

/** The schedule-then-generate recipe. */
function generateRecipe(root: string): {
    why: string;
    command: string;
    envNames?: string[];
} {
    return {
        why: "run card step 3: schedule then generate writes gen/<arm> for both arms",
        command:
            `CAMPAIGN_ROOT=${shellQuote(root)} node ${shellQuote(join(root, "prepare/schedule.mts"))} && ` +
            `CAMPAIGN_ROOT=${shellQuote(root)} bash ${shellQuote(join(root, "prepare/generate.sh"))}`,
        envNames: ["CAMPAIGN_ROOT", "CAMPAIGN_ID"],
    };
}

/** The delivery-probe recipe for one arm. */
function deliveryRecipe(
    root: string,
    arm: string,
): { why: string; command: string } {
    const port = arm === "a" ? "8801" : "8802";
    return {
        why: `run card step 3: delivery probe for arm ${arm} (loopback fake provider)`,
        command:
            `node ${shellQuote(join(root, "prepare/delivery-probe.mts"))} ` +
            `${shellQuote(join(root, `evidence/delivery-${arm}/capture.json`))} ` +
            `${shellQuote(join(root, "arms", arm))} opencode-go/deepseek-v4.1-flash ${shellQuote("Hello.")} ${port}`,
    };
}

/** The measurement-spec copy recipe. */
function specRecipe(root: string): { why: string; command: string } {
    return {
        why: "run card step 3: copy the measurement spec into evidence",
        command:
            `cp ${shellQuote(join(root, "arms/a/tests/fixtures/placement-harness/prod014/measurement.json"))} ` +
            `${shellQuote(join(root, "evidence/measurement-spec.json"))}`,
    };
}

/** The freeze recipe. */
function freezeRecipe(root: string): {
    why: string;
    command: string;
    envNames?: string[];
} {
    const sourceRepo = sourceRepoFor();
    const source =
        sourceRepo === null
            ? "CAMPAIGN_SOURCE_REPO=<measurement-worktree>"
            : `CAMPAIGN_SOURCE_REPO=${shellQuote(sourceRepo)}`;
    return {
        why: "run card step 3: freeze builds/resolves the image and records immutable ids",
        command: `CAMPAIGN_ROOT=${shellQuote(root)} ${source} node ${shellQuote(join(root, "prepare/freeze.mts"))}`,
        envNames: ["CAMPAIGN_ROOT", "CAMPAIGN_SOURCE_REPO"],
    };
}

// ---------------------------------------------------------------------------
// Checkout mode.

function observeCheckout(base: string): { result: StatusResult; exit: StatusExit } {
    const cwd = process.cwd();
    const problems: ObservationProblem[] = [];
    const resolvedBase = git(cwd, ["rev-parse", base]);
    const head = git(cwd, ["rev-parse", "HEAD"]);
    if (resolvedBase === null) {
        problems.push({
            code: "unreadable-evidence",
            message: redact(
                `cannot resolve --base ${base} in ${cwd}: is it a git repository with that revision?`,
            ),
        });
    }
    const identity: Identity = {
        requestedBase: base,
        sources: {
            requestedBase: "--base argument",
            resolvedBase: "git rev-parse",
            sourceHead: "git rev-parse HEAD",
            sourceClean: "git status --porcelain",
        },
    };
    if (resolvedBase !== null) identity.resolvedBase = resolvedBase;
    if (head !== null) identity.sourceHead = head;
    const clean = gitClean(cwd);
    if (clean !== null) identity.sourceClean = clean;
    identity.sourceRepo = cwd;
    const action = checkoutNextAction(identity, campaignAssetsPresent(cwd));
    const result: StatusResult = {
        schemaVersion: 1,
        mode: "checkout",
        generatedAt: new Date().toISOString(),
        phase: action.phase,
        headline: action.headline,
        identity,
        readiness: observeReadiness(cwd, undefined),
        nextAction: action.nextAction,
        gaps: action.gaps,
        problems,
    };
    return { result, exit: resolvedBase === null ? 2 : 0 };
}

/** Whether this checkout carries the prod014 campaign tooling. */
function campaignAssetsPresent(cwd: string): boolean {
    const campaignDir = join(
        cwd,
        "tests/fixtures/placement-harness/prod014/campaign",
    );
    return (
        existsSync(join(campaignDir, "materialise.mts")) &&
        existsSync(join(campaignDir, "active")) &&
        existsSync(join(campaignDir, "runner.json"))
    );
}

/** The container engine version, via a local query only. */
function observeContainerEngine(): Readiness["containerEngine"] {
    const version = capture("podman", ["--version"]);
    const engine: Readiness["containerEngine"] = {
        cli: "podman",
        available: version !== "",
    };
    if (version !== "") engine.version = version;
    return engine;
}

/** Shared readiness observation for both modes. */
function observeReadiness(
    root: string,
    record: FreezeRecord | null | undefined,
): Readiness {
    const readiness: Readiness = {
        nodeVersion: process.version,
        containerEngine: observeContainerEngine(),
        credentials: observeCredentials(root),
    };
    const disk = freeBytes(root);
    if (disk !== undefined) readiness.diskFreeBytes = disk;
    if (record === null || record === undefined) return readiness;
    const shim = shimObservation(root);
    if (shim !== undefined) readiness.shimExecutable = shim;
    readiness.image = imageObservation(root, record.imageId);
    readiness.dependencies = {
        armsA: existsSync(join(root, "arms/a/node_modules")),
        armsB: existsSync(join(root, "arms/b/node_modules")),
        measurement: existsSync(join(root, "measurement/node_modules")),
    };
    readiness.routing = routingObservation(root);
    return readiness;
}

/** The expected image's local presence, via a local query only. */
function imageObservation(root: string, imageId: string): ImageObservation {
    const observation: ImageObservation = { present: "indeterminate" };
    if (imageId === "") return observation;
    observation.expectedId = imageId;
    const observed = capture("podman", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        imageId,
    ]);
    if (observed !== "") {
        observation.observedId = observed;
        observation.present = observed === imageId;
    }
    return observation;
}

/** Whether the campaign shim is executable, when present. */
function shimObservation(root: string): boolean | undefined {
    const shimPath = join(root, "prepare/shim/podman");
    if (!existsSync(shimPath)) return undefined;
    try {
        accessSync(shimPath, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Campaign mode.

function observeCampaign(
    root: string,
    reportRoot: string | undefined,
): { result: StatusResult; exit: StatusExit } {
    const rootProblem = rootProblemOf(root);
    if (rootProblem !== null) return unreadableRoot(root, rootProblem);
    const { files, hardProblems } = readIdentityFiles(root);
    if (hardProblems.length > 0) {
        return {
            result: unreadableEvidenceResult(root, hardProblems),
            exit: 2,
        };
    }
    const record = files.freezeRecord;
    const identity = observeIdentity(root, files);
    const readiness = observeReadiness(root, record);
    const { steps: preparation, freezeProblems } = observePreparation(root, files);
    const position = observePosition(root, files);
    const checkpoint = observeCheckpoint(root, reportRoot, position);
    const action = campaignNextAction(
        root,
        files,
        readiness,
        preparation,
        freezeProblems,
        position,
        checkpoint,
    );
    return {
        result: {
            schemaVersion: 1,
            mode: "campaign",
            generatedAt: new Date().toISOString(),
            phase: action.phase,
            headline: action.headline,
            root,
            identity,
            readiness,
            preparation,
            position,
            checkpoint,
            nextAction: action.nextAction,
            gaps: withStandardGaps(action.gaps, record),
            problems: [],
        },
        exit: 0,
    };
}

/** Why a root cannot be observed at all, or null. */
function rootProblemOf(root: string): string | null {
    if (!existsSync(root)) return `campaign root does not exist: ${root}`;
    try {
        if (!statSync(root).isDirectory()) {
            return `campaign root is not a directory: ${root}`;
        }
    } catch (error) {
        return `campaign root cannot be read: ${redact(
            error instanceof Error ? error.message : String(error),
        )}`;
    }
    return null;
}

/** The exit-2 result for evidence that identifies the campaign is unreadable. */
function unreadableEvidenceResult(
    root: string,
    problems: readonly ObservationProblem[],
): StatusResult {
    return {
        schemaVersion: 1,
        mode: "campaign",
        generatedAt: new Date().toISOString(),
        phase: "unreadable-evidence",
        headline: `evidence that identifies the campaign cannot be read: ${problems[0]?.message ?? ""}`,
        root,
        nextAction: {
            kind: "inspection",
            why: "fix or preserve the named file; a status observation refuses to guess past unreadable evidence",
        },
        gaps: [],
        problems: [...problems],
    };
}

/** The exit-2 root observation. */
function unreadableRoot(root: string, message: string): {
    result: StatusResult;
    exit: StatusExit;
} {
    return {
        result: {
            schemaVersion: 1,
            mode: "campaign",
            generatedAt: new Date().toISOString(),
            phase: "unreadable-root",
            headline: message,
            root,
            nextAction: {
                kind: "operator-decision",
                why: "pass an explicit --root; status never scans for a newest campaign",
            },
            gaps: [],
            problems: [{ code: "unreadable-evidence", message }],
        },
        exit: 2,
    };
}

/** The gaps every campaign observation carries. */
function withStandardGaps(gaps: readonly Gap[], record: FreezeRecord | null): Gap[] {
    const all = [...gaps];
    if (record === null) {
        all.push({
            field: "trial/judge ceilings",
            source: "none until FROZEN.json exists (a missing record reads as zero and blocks every claim)",
        });
    }
    all.push({
        field: "checkpoint rule (P04 report before continuation)",
        source: "run-card",
    });
    all.push({
        field: "credential validity and delivered model identity",
        source: "none (require their own evidence; status checks presence and mode only)",
    });
    return all;
}

/** Identity from durable sources, each field tagged. */
function observeIdentity(root: string, files: IdentityFiles): Identity {
    const identity: Identity = { sources: {} };
    applySourceRepo(identity);
    applyIdentities(identity, files.frozenIdentities);
    applyFrozenRecord(identity, files.freezeRecord);
    applyFrozenTop(identity, root);
    applySchedule(identity, files.schedule);
    applyManifest(identity, files.manifest);
    return identity;
}

/** Source-HEAD and cleanliness, from the documented env name. */
function applySourceRepo(identity: Identity): void {
    const sourceRepo = sourceRepoFor();
    if (sourceRepo === null) {
        identity.sources.sourceHead =
            "CAMPAIGN_SOURCE_REPO unset; actual source HEAD unobserved";
        return;
    }
    identity.sourceRepo = sourceRepo;
    const head = git(sourceRepo, ["rev-parse", "HEAD"]);
    if (head !== null) identity.sourceHead = head;
    const clean = gitClean(sourceRepo);
    if (clean !== null) identity.sourceClean = clean;
    identity.sources.sourceHead = `git rev-parse HEAD in CAMPAIGN_SOURCE_REPO (${sourceRepo})`;
}

/** Registered pre-freeze identities: base, measurement, models. */
function applyIdentities(
    identity: Identity,
    identities: Record<string, unknown> | null,
): void {
    if (identities === null) return;
    const base = isRecord(identities.base) ? identities.base : {};
    const requested = str(base, "commit");
    if (requested !== undefined) {
        identity.requestedBase = requested;
        identity.sources.requestedBase = "frozen-identities.json base.commit";
    }
    const measurement = isRecord(identities.measurement)
        ? identities.measurement
        : {};
    const revision = str(measurement, "commit");
    if (revision !== undefined) identity.measurementRevision = revision;
    const models = isRecord(identities.models) ? identities.models : {};
    const trial = str(models, "trial") ?? str(models, "trialName");
    if (trial !== undefined) identity.trialModel = trial;
    const judge = str(models, "judge");
    if (judge !== undefined) identity.judgeModel = judge;
}

/** Authoritative post-freeze values: base, arms, stopping rules, ceilings. */
function applyFrozenRecord(
    identity: Identity,
    record: FreezeRecord | null,
): void {
    if (record !== null) {
        identity.resolvedBase = record.sourceRevision;
        identity.arms = record.arms.map((arm) => ({
            id: arm.id,
            nativeChars: arm.descriptionChars,
            deliveredChars: arm.deliveredChars,
            declaredMismatch: arm.deliveredHash !== arm.descriptionHash,
        }));
        identity.stoppingRules = record.stoppingRules;
        identity.ceilingSource =
            "FROZEN.json freeze.ceilings (authoritative post-freeze)";
        return;
    }
    if (identity.requestedBase !== undefined) {
        identity.ceilingSource =
            "no FROZEN.json; frozen-identities.json budget is registered but not verified";
    }
}

/** The FROZEN.json top-level identity fields. */
function applyFrozenTop(identity: Identity, root: string): void {
    const read = readJsonFile(join(root, "evidence/FROZEN.json"));
    if (read.value === undefined || !isRecord(read.value)) return;
    const trialModel = str(read.value, "trialModel");
    if (trialModel !== undefined) identity.trialModel = trialModel;
    const judgeModel = str(read.value, "judgeModel");
    if (judgeModel !== undefined) identity.judgeModel = judgeModel;
    const campaign = str(read.value, "campaign");
    if (campaign !== undefined) identity.campaignId = campaign;
}

/** The schedule: campaign id, slot/pair counts and execution order. */
function applySchedule(
    identity: Identity,
    schedule: IdentityFiles["schedule"],
): void {
    if (schedule === null) return;
    if (schedule.campaign !== "") identity.campaignId = schedule.campaign;
    identity.slots = schedule.slots.length;
    identity.pairs = new Set(schedule.slots.map((s) => s.pairId)).size;
    identity.order = schedule.slots.map((s) => ({
        slot: s.slot,
        pairId: s.pairId,
        scenario: s.scenario,
        arm: s.arm,
    }));
    identity.sources.schedule = "evidence/schedule.json";
}

/** The manifest policy and, when no schedule exists, the planned order. */
function applyManifest(
    identity: Identity,
    manifest: Record<string, unknown> | null,
): void {
    if (manifest === null) return;
    const policy = isRecord(manifest.policy) ? manifest.policy : {};
    applyWeights(identity, policy);
    applySelection(identity, policy);
    applyGuardrails(identity, policy);
    if (identity.order === undefined && isRecord(manifest.schedule)) {
        const order = plannedOrderOf(manifest.schedule);
        identity.order = order;
        identity.slots = order.length;
        identity.pairs = new Set(order.map((s) => s.pairId)).size;
        identity.sources.schedule =
            "prepare/manifest.json (planned; schedule.json not yet written)";
    }
    identity.sources.policy = "prepare/manifest.json";
}

/** The utility weights from the manifest policy. */
function applyWeights(
    identity: Identity,
    policy: Record<string, unknown>,
): void {
    if (!isRecord(policy.weights)) return;
    const weights: Record<string, number> = {};
    for (const [key, value] of Object.entries(policy.weights)) {
        if (typeof value === "number" && Number.isFinite(value)) {
            weights[key] = value;
        }
    }
    identity.weights = weights;
}

/** Control/candidate arms and threshold from the manifest policy. */
function applySelection(
    identity: Identity,
    policy: Record<string, unknown>,
): void {
    if (!isRecord(policy.selection)) return;
    const control = str(policy.selection, "controlArm");
    if (control !== undefined) identity.controlArm = control;
    const candidate = str(policy.selection, "candidateArm");
    if (candidate !== undefined) identity.candidateArm = candidate;
    const threshold = num(policy.selection, "threshold");
    if (threshold !== undefined) identity.threshold = threshold;
}

/** Guardrail ids from the manifest policy. */
function applyGuardrails(
    identity: Identity,
    policy: Record<string, unknown>,
): void {
    if (!Array.isArray(policy.guardrails)) return;
    identity.guardrailIds = policy.guardrails
        .filter(isRecord)
        .map((g) => str(g, "id") ?? "?");
}

/** The planned slot order carried by the manifest. */
function plannedOrderOf(
    schedule: Record<string, unknown>,
): OrderEntry[] {
    const order: OrderEntry[] = [];
    if (!Array.isArray(schedule.slots)) return order;
    for (const entry of schedule.slots) {
        const parsed = plannedSlotOf(entry);
        if (parsed !== undefined) order.push(parsed);
    }
    return order;
}

/** One planned slot, or undefined when malformed. */
function plannedSlotOf(entry: unknown): OrderEntry | undefined {
    if (!isRecord(entry)) return undefined;
    if (
        typeof entry.slot === "number" &&
        typeof entry.pairId === "string" &&
        typeof entry.scenario === "string" &&
        (entry.arm === "A" || entry.arm === "B")
    ) {
        return {
            slot: entry.slot,
            pairId: entry.pairId,
            scenario: entry.scenario,
            arm: entry.arm,
        };
    }
    return undefined;
}

/** Routing classification from durable evidence only. */
function routingObservation(root: string): string {
    const a = existsSync(join(root, "evidence/delivery-a/request-1.json"));
    const b = existsSync(join(root, "evidence/delivery-b/request-1.json"));
    if (a || b) {
        return "delivery probes used the run card's loopback fake provider; live routing is indeterminate from disk";
    }
    return "indeterminate (no delivery captures observed)";
}

// ---------------------------------------------------------------------------
// Projections.

const ok = (good: boolean): string => (good ? "ok" : "missing");

/** Render the compact text projection. */
export function renderText(result: StatusResult, detail: boolean): string {
    const lines: string[] = [
        `prod014 status [${result.mode}]${result.root === undefined ? "" : ` — ${result.root}`}`,
        `phase: ${result.phase}`,
        result.headline,
        ...spendLines(result.position),
        "",
    ];
    lines.push(...identityLines(result.identity));
    lines.push(...readinessLines(result.readiness));
    lines.push(...preparationLines(result.preparation));
    lines.push(...positionLines(result.position, detail));
    lines.push(...checkpointLines(result.checkpoint, detail));
    lines.push("", ...actionLines(result.nextAction));
    lines.push(...gapLines(result.gaps));
    lines.push(...problemLines(result.problems));
    return lines.join("\n");
}

/** The spend lines shown near the top. */
function spendLines(position: Position | undefined): string[] {
    const spend = position?.spend;
    if (spend === undefined) return [];
    return [
        `spend: trial ${spend.trial.used}/${spend.trial.ceiling} (${spend.trial.remaining} remaining), judge ${spend.judge.used}/${spend.judge.ceiling} (${spend.judge.remaining} remaining)`,
    ];
}

/** The identity section. */
function identityLines(identity: Identity | undefined): string[] {
    if (identity === undefined) return [];
    const lines = ["identity:", `  ${identitySummary(identity)}`];
    if (identity.arms !== undefined) {
        lines.push(`  arms: ${identity.arms.map(armSummary).join(" | ")}`);
    }
    if (identity.slots !== undefined) {
        lines.push(scheduleSummary(identity));
    }
    return lines;
}

/** The one-line identity summary, or a note when nothing is durable. */
function identitySummary(identity: Identity): string {
    const bits = [
        identity.campaignId === undefined ? null : `campaign ${identity.campaignId}`,
        identity.sourceHead === undefined
            ? null
            : `HEAD ${identity.sourceHead.slice(0, 12)}`,
        identity.sourceClean === undefined
            ? null
            : `tree ${identity.sourceClean ? "clean" : "dirty"}`,
        identity.measurementRevision === undefined
            ? null
            : `measurement ${identity.measurementRevision.slice(0, 12)}`,
        identity.trialModel === undefined ? null : `trial ${identity.trialModel}`,
        identity.judgeModel === undefined ? null : `judge ${identity.judgeModel}`,
    ].filter((bit): bit is string => bit !== null);
    return bits.length > 0
        ? bits.join(" · ")
        : "(no durable identity yet; no schedule.json and no FROZEN.json)";
}

/** One arm's identity summary. */
function armSummary(arm: ArmIdentity): string {
    const mismatch = arm.declaredMismatch === true ? " (MISMATCH)" : "";
    return `${arm.id} native ${arm.nativeChars ?? "?"} chars, delivered ${arm.deliveredChars ?? "?"}${mismatch}`;
}

/** The schedule summary with slot/pair counts and the AB/BA order. */
function scheduleSummary(identity: Identity): string {
    const order =
        identity.order === undefined
            ? ""
            : `; order ${identity.order.map((slot) => `${slot.pairId}${slot.arm}`).join(" ")}`;
    return `  schedule: ${identity.slots ?? "?"} slots / ${identity.pairs ?? "?"} pairs${order}`;
}

/** The readiness section. */
function readinessLines(readiness: Readiness | undefined): string[] {
    if (readiness === undefined) return [];
    const lines = ["readiness:"];
    lines.push(
        `  node ${readiness.nodeVersion} · ${readiness.containerEngine.cli} ${readiness.containerEngine.version ?? "not found"}`,
    );
    if (readiness.image !== undefined) lines.push(imageLine(readiness.image));
    if (readiness.shimExecutable !== undefined) {
        lines.push(
            `  shim ${readiness.shimExecutable ? "executable" : "NOT executable"}`,
        );
    }
    lines.push(credentialLine(readiness.credentials));
    if (readiness.credentials.modeProblem !== undefined) {
        lines.push(`  credential problem: ${readiness.credentials.modeProblem}`);
    }
    if (readiness.dependencies !== undefined) {
        const deps = readiness.dependencies;
        lines.push(
            `  dependencies: arms/a ${ok(deps.armsA)}, arms/b ${ok(deps.armsB)}, measurement ${ok(deps.measurement)}`,
        );
    }
    if (readiness.diskFreeBytes !== undefined) {
        lines.push(`  disk free: ${(readiness.diskFreeBytes / GB).toFixed(1)} GiB`);
    }
    if (readiness.routing !== undefined) {
        lines.push(`  routing: ${readiness.routing}`);
    }
    return lines;
}

/** One image-presence line. */
function imageLine(image: ImageObservation): string {
    const expected =
        image.expectedId === undefined ? "none registered" : image.expectedId.slice(0, 19);
    const state =
        image.present === true
            ? "present"
            : image.present === false
              ? "CHANGED/ABSENT"
              : "indeterminate";
    return `  image ${expected}: ${state}`;
}

/** One credential-configuration line, presence and mode only. */
function credentialLine(credentials: CredentialsObservation): string {
    const configured =
        credentials.keyConfigured === true
            ? `configured (${(credentials.keySources ?? []).join(", ")})`
            : "NOT configured";
    const file =
        credentials.envFilePresent === true
            ? `, .env mode ${credentials.envFileMode}`
            : "";
    return `  credentials: ${configured}${file}`;
}

/** The preparation section. */
function preparationLines(preparation: PrepStep[] | undefined): string[] {
    if (preparation === undefined) return [];
    const lines = ["preparation:"];
    for (const step of preparation) {
        lines.push(
            `  ${step.state.padEnd(13)} ${step.step}` +
                (step.detail === undefined ? "" : ` — ${step.detail}`),
        );
    }
    return lines;
}

/** The live-position section. */
function positionLines(position: Position | undefined, detail: boolean): string[] {
    if (position === undefined) return [];
    return [
        ...ledgerLine(position),
        ...pairLine(position),
        ...(detail ? slotLines(position) : []),
        ...claimLines(position),
        ...(position.closingLock === true ? ["  CLOSING.lock present"] : []),
    ];
}

/** The ledger state and last-event lines. */
function ledgerLine(position: Position): string[] {
    const changing = position.ledgerChanging === true ? " (records advanced mid-read)" : "";
    const lines = [
        `position: ledger ${position.ledgerState}${changing}, ${position.eventCount} events`,
    ];
    if (position.lastEvent !== undefined) {
        const last = position.lastEvent;
        lines.push(
            `  last: ${last.event} at ${last.at ?? "?"} ${last.detail ?? ""}`.trimEnd(),
        );
    }
    return lines;
}

/** The completed-pairs line. */
function pairLine(position: Position): string[] {
    if (position.completedPairs === undefined) return [];
    return [
        `  completed pairs: ${position.completedPairs.join(" ") || "none"} · usable assessments (judge-exit judged): ${position.usableAssessments ?? 0}`,
    ];
}

/** The per-slot detail lines. */
function slotLines(position: Position): string[] {
    const lines: string[] = [];
    for (const slot of position.slots ?? []) lines.push(slotLine(slot));
    return lines;
}

/** The unsettled-claim lines. */
function claimLines(position: Position): string[] {
    const lines: string[] = [];
    for (const claim of position.spend?.unresolved ?? []) {
        lines.push(`  unsettled: ${claim.path} (${claim.state})`);
    }
    return lines;
}

/** One slot's observation line. */
function slotLine(slot: SlotObservation): string {
    const note = slot.note === undefined ? "" : ` (${slot.note})`;
    return `  slot ${String(slot.slot).padStart(2, "0")} ${slot.pairId} ${slot.scenario} ${slot.arm}: ${slot.state}${note}`;
}

/** The checkpoint section. */
function checkpointLines(checkpoint: Checkpoint | undefined, detail: boolean): string[] {
    if (checkpoint === undefined) return [];
    const given = checkpoint.reportRootGiven === true ? "given" : "not given (pass --report-root)";
    const lines = [`checkpoint: report root ${given}`];
    for (const report of checkpoint.reports ?? []) {
        lines.push(reportLine(report));
        if (detail && report.recording !== undefined) {
            lines.push(...measureLines(report.recording, report.retrieval));
        }
        if (report.pairedDelta !== undefined && report.pairedDelta !== null) {
            lines.push(`    paired delta: ${report.pairedDelta}`);
        }
    }
    const rec = checkpoint.reconciliation;
    if (rec !== undefined) lines.push(reconciliationLine(rec));
    return lines;
}

/** One report observation line. */
function reportLine(report: ReportObservation): string {
    const wrong = report.wrongCampaign === true ? " (WRONG CAMPAIGN)" : "";
    const verdict =
        report.recommendation !== undefined ? `, ${report.recommendation}` : "";
    const decision = report.decision !== undefined ? `, decision ${report.decision}` : "";
    return `  ${report.dir}: ${report.freshness ?? "unknown"}${wrong}${verdict}${decision}`;
}

/** Per-arm recording/retrieval lines in detail view. */
function measureLines(
    recording: Record<string, { planned: number; success: number }>,
    retrieval: Record<string, { planned: number; applied: number }> | undefined,
): string[] {
    const lines: string[] = [];
    for (const [arm, counts] of Object.entries(recording)) {
        lines.push(
            `    recording ${arm}: ${counts.success}/${counts.planned} · retrieval ${retrieval?.[arm]?.applied ?? "?"}/${retrieval?.[arm]?.planned ?? "?"}`,
        );
    }
    return lines;
}

/** One reconciliation line. */
function reconciliationLine(rec: ReconciliationObservation): string {
    if (!rec.present) return "  reconciliation: absent";
    return (
        `  reconciliation: ${rec.at ?? "?"}, ${rec.completedPairs ?? "?"} pairs, ${rec.trialLaunches ?? "?"} launches, ` +
        `billing ${rec.currency ?? "?"} trial ${rec.billingTrial ?? "null"} judge ${rec.billingJudge ?? "null"}`
    );
}

/** The next-action block. */
function actionLines(action: NextAction): string[] {
    const lines = [`NEXT (${action.kind}): ${action.why}`];
    if (action.command !== undefined) lines.push(`  command: ${action.command}`);
    if (action.path !== undefined) lines.push(`  evidence: ${action.path}`);
    if (action.cwd !== undefined) lines.push(`  cwd: ${action.cwd}`);
    if ((action.envNames ?? []).length > 0) {
        lines.push(
            `  env: ${(action.envNames ?? []).join(", ")} (names only; values are yours)`,
        );
    }
    return lines;
}

/** The no-durable-source block. */
function gapLines(gaps: readonly Gap[]): string[] {
    if (gaps.length === 0) return [];
    const lines = ["", "no durable source for:"];
    for (const gap of gaps) lines.push(`  ${gap.field} — ${gap.source}`);
    return lines;
}

/** The observation-problems block. */
function problemLines(problems: readonly ObservationProblem[]): string[] {
    if (problems.length === 0) return [];
    const lines = ["", "observation problems:"];
    for (const problem of problems) {
        lines.push(`  [${problem.code}] ${problem.message}`);
    }
    return lines;
}

/** Render the JSON projection (stdout stays machine-readable). */
export function renderJson(payload: unknown): string {
    return `${JSON.stringify(payload, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// CLI.

const USAGE = `prod014 campaign status — one read-only observation

Usage:
  node status.mts --base <revision> [--json] [--detail]
  node status.mts --root <campaign-root> [--report-root <dir>] [--json] [--detail]

Modes:
  --base <revision>    checkout mode: identity and readiness before a root exists
  --root <path>        campaign mode: observe one explicit campaign root
  --report-root <dir>  where analysis reports live; never scanned for implicitly

Options:
  --json   machine-readable projection on stdout; errors use the same contract:
           {"status":"error","errors":[{"code","message"}]}
  --detail  fuller evidence: per-slot states, per-arm report measures
  --help   this text

Exit codes: 0 observation made (stopped/closed/blocked included);
            1 broken invocation; 2 unreadable evidence.

Reads local files and runs local git/podman queries only. No dispatch, no
network, no secret material in any output.`;

/** The parsed CLI arguments. */
export interface ParsedArguments {
    /** Checkout mode's requested revision. */
    base?: string;
    /** Campaign mode's explicit root. */
    root?: string;
    /** Campaign mode's explicit report root. */
    reportRoot?: string;
    /** Whether stdout must stay machine-readable. */
    json: boolean;
    /** Whether the fuller evidence view is requested. */
    detail: boolean;
    /** Whether usage text was requested. */
    help: boolean;
}

/** Parse argv into a request, or a list of usage problems. */
export function parseArguments(
    argv: readonly string[],
): { ok: true; args: ParsedArguments } | { ok: false; problems: string[] } {
    const args: ParsedArguments = {
        json: argv.includes("--json"),
        detail: argv.includes("--detail"),
        help: argv.includes("--help") || argv.includes("-h"),
    };
    const tokenised = tokenizeArguments(argv);
    const problems = [...tokenised.problems, ...validateArguments(args, tokenised)];
    if (problems.length > 0) return { ok: false, problems };
    const merged: ParsedArguments = { ...args };
    if (tokenised.base !== undefined) merged.base = tokenised.base;
    if (tokenised.root !== undefined) merged.root = tokenised.root;
    if (tokenised.reportRoot !== undefined) merged.reportRoot = tokenised.reportRoot;
    return { ok: true, args: merged };
}

/** One valued argument's parsed value. */
interface ValuedArgs {
    base?: string;
    root?: string;
    reportRoot?: string;
    problems: string[];
}

/** Tokenise argv into valued arguments and usage problems. */
function tokenizeArguments(argv: readonly string[]): ValuedArgs {
    const valued = new Set(["--base", "--root", "--report-root"]);
    const flags = new Set(["--json", "--detail", "--help", "-h"]);
    const parsed: ValuedArgs = { problems: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined || flags.has(arg)) continue;
        if (valued.has(arg)) {
            index = consumeValued(argv, index, arg, parsed);
            continue;
        }
        parsed.problems.push(`unknown argument: ${arg}`);
    }
    return parsed;
}

/** Consume one valued argument; returns the index to resume scanning at. */
function consumeValued(
    argv: readonly string[],
    index: number,
    arg: string,
    parsed: ValuedArgs,
): number {
    const next = argv[index + 1];
    if (next === undefined || next === "" || next.startsWith("--")) {
        parsed.problems.push(`${arg} needs a value`);
        return index;
    }
    if (arg === "--base") parsed.base = next;
    if (arg === "--root") parsed.root = next;
    if (arg === "--report-root") parsed.reportRoot = next;
    return index + 1;
}

/** Cross-argument validation, after tokenising. */
function validateArguments(
    args: ParsedArguments,
    valued: ValuedArgs,
): string[] {
    const problems: string[] = [];
    if (valued.base !== undefined && valued.root !== undefined) {
        problems.push("--base and --root are separate modes; pass one");
    }
    if (valued.base === undefined && valued.root === undefined && !args.help) {
        problems.push("pass either --base <revision> or --root <campaign-root>");
    }
    if (valued.root === undefined && valued.reportRoot !== undefined) {
        problems.push("--report-root applies to campaign mode (--root)");
    }
    return problems;
}

/** Observe and print; the CLI entry calls this once. Exposed for tests. */
export function runStatus(
    argv: readonly string[],
    streams: {
        out: (text: string) => void;
        err: (text: string) => void;
    },
): StatusExit {
    const parsed = parseArguments(argv);
    if (!parsed.ok) return usageError(argv, parsed.problems, streams);
    const { args } = parsed;
    if (args.help) {
        streams.out(USAGE);
        return 0;
    }
    const observed =
        args.base !== undefined
            ? observeCheckout(args.base)
            : observeCampaign(args.root as string, args.reportRoot);
    printObservation(observed, args.json, args.detail, streams);
    return observed.exit;
}

/** A broken invocation: usage text, or the JSON error contract. */
function usageError(
    argv: readonly string[],
    problems: readonly string[],
    streams: { out: (text: string) => void; err: (text: string) => void },
): StatusExit {
    if (argv.includes("--json")) {
        // JSON mode keeps stdout machine-readable, diagnostics included.
        streams.out(
            renderJson({
                status: "error",
                errors: problems.map((message) => ({
                    code: "usage",
                    message: redact(message),
                })),
            }),
        );
        return 1;
    }
    streams.err(redact(problems.map((problem) => `usage: ${problem}`).join("\n")));
    streams.err(USAGE);
    return 1;
}

/** Print one observation under the text or JSON contract. */
function printObservation(
    observed: { result: StatusResult; exit: StatusExit },
    json: boolean,
    detail: boolean,
    streams: { out: (text: string) => void; err: (text: string) => void },
): void {
    const { result, exit } = observed;
    if (json) {
        const payload =
            exit === 0
                ? { status: "ok", result }
                : {
                      status: "error",
                      errors:
                          result.problems.length > 0
                              ? result.problems
                              : [
                                    {
                                        code: "observation-failed",
                                        message: result.headline,
                                    },
                                ],
                  };
        streams.out(renderJson(payload));
        return;
    }
    if (exit !== 0) {
        for (const problem of result.problems) {
            streams.err(redact(`[${problem.code}] ${problem.message}`));
        }
        streams.err(result.headline);
        return;
    }
    streams.out(renderText(result, detail));
}

// Entry guard: importing this module for its pure readers executes nothing.
if (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    process.exit(
        runStatus(process.argv.slice(2), {
            out: (text) => process.stdout.write(`${text}\n`),
            err: (text) => process.stderr.write(`${text}\n`),
        }),
    );
}
