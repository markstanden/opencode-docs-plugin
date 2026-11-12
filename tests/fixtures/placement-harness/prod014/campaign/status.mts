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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseCampaignLedger, eventsByStamp } from "../../analysis/ledger.ts";
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

/** Exit code semantics. */
export type StatusExit = 0 | 1 | 2;

/** Why a step could not be claimed. */
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

/** One observed problem, sanitised. */
export interface ObservationProblem {
    code: string;
    message: string;
}

/** The single suggested next action. */
export interface NextAction {
    kind:
        | "offline-check"
        | "offline-preparation"
        | "operator-decision"
        | "paid-operation"
        | "inspection";
    why: string;
    command?: string;
    cwd?: string;
    envNames?: string[];
    /** An evidence path to inspect when no command is the answer. */
    path?: string;
}

/** Identity and run definition. */
export interface Identity {
    requestedBase?: string;
    resolvedBase?: string;
    sourceHead?: string;
    sourceClean?: boolean;
    sourceRepo?: string;
    campaignId?: string;
    measurementRevision?: string;
    trialModel?: string;
    judgeModel?: string;
    arms?: {
        id: string;
        nativeChars?: number;
        deliveredChars?: number;
        declaredMismatch?: boolean;
    }[];
    slots?: number;
    pairs?: number;
    order?: { slot: number; pairId: string; scenario: string; arm: string }[];
    weights?: Record<string, number>;
    controlArm?: string;
    candidateArm?: string;
    threshold?: number;
    guardrailIds?: string[];
    stoppingRules?: string[];
    ceilings?: { trial: number; judge: number };
    ceilingSource?: string;
    sources: Record<string, string>;
}

/** Local readiness observation. */
export interface Readiness {
    nodeVersion: string;
    containerEngine: { cli: string; version?: string; available: boolean };
    image?: {
        expectedId?: string;
        observedId?: string;
        present: boolean | "indeterminate";
    };
    shimExecutable?: boolean;
    credentials: {
        envFilePresent?: boolean;
        envFileMode?: string;
        modeProblem?: string;
        keyConfigured?: boolean;
        keySources?: string[];
    };
    dependencies?: { armsA: boolean; armsB: boolean; measurement: boolean };
    diskFreeBytes?: number;
    routing?: string;
}

/** One preparation step. */
export interface PrepStep {
    step: string;
    state: StepState;
    detail?: string;
}

/** Live position and accounting. */
export interface Position {
    ledgerState: string;
    ledgerChanging?: boolean;
    eventCount: number;
    lastEvent?: { event: string; at: string | null; detail?: string };
    closedAt?: string | null;
    stopReason?: string | null;
    completedPairs?: string[];
    usableAssessments?: number;
    slots?: {
        slot: number;
        pairId: string;
        scenario: string;
        arm: string;
        stamp: string;
        state: string;
        note?: string;
    }[];
    spend?: {
        trial: { used: number; ceiling: number; remaining: number; basis: string };
        judge: { used: number; ceiling: number; remaining: number; basis: string };
        reserved?: number;
        spawned?: number;
        unresolved?: {
            kind: string;
            stamp?: string;
            state: string;
            path: string;
        }[];
    };
    closingLock?: boolean;
}

/** One observed analysis report. */
export interface ReportObservation {
    dir: string;
    campaignId?: string;
    renderedAt?: string;
    manifestSha256?: string;
    manifestMatches?: boolean;
    ledgerAdvancedSince?: boolean;
    freshness?: "current" | "stale" | "unknown";
    wrongCampaign?: boolean;
    decision?: string;
    recommendation?: string;
    pairedDelta?: number | null;
    guardrailBreaches?: number;
    recording?: Record<string, { planned: number; success: number }>;
    retrieval?: Record<string, { planned: number; applied: number }>;
    coverage?: { completePairs: number; documented: number; assessed: number };
    tokens?: { measuredTrials?: number; unknownTrials?: number; steps?: number | null };
    scope?: string;
}

/** Checkpoint, report and reconciliation observation. */
export interface Checkpoint {
    reportRootGiven?: boolean;
    reports?: ReportObservation[];
    reconciliation?: {
        present: boolean;
        at?: string;
        completedPairs?: number;
        trialLaunches?: number;
        unrunSlots?: number;
        billingTrial?: number | null;
        billingJudge?: number | null;
        currency?: string;
    };
}

/** The one typed result both projections render. */
export interface StatusResult {
    schemaVersion: 1;
    mode: "checkout" | "campaign";
    generatedAt: string;
    phase: string;
    headline: string;
    root?: string;
    identity?: Identity;
    readiness?: Readiness;
    preparation?: PrepStep[];
    position?: Position;
    checkpoint?: Checkpoint;
    nextAction: NextAction;
    gaps: Gap[];
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

interface JsonRead {
    value?: unknown;
    missing?: boolean;
    problem?: string;
}

/** Read and parse a JSON file tolerantly; missing is a state, not an error. */
function readJsonFile(path: string): JsonRead {
    if (!existsSync(path)) return { missing: true };
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

/** Run one local command and capture its trimmed stdout; empty on failure. */
function capture(command: string, args: string[]): string {
    try {
        const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
        return result.status === 0 ? String(result.stdout ?? "").trim() : "";
    } catch {
        return "";
    }
}

/** One git query inside a repo, or null. */
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

    const frozenPath = join(root, "evidence/FROZEN.json");
    const frozen = readJsonFile(frozenPath);
    if (frozen.problem !== undefined) bad(frozenPath, "parseable JSON");
    let freezeRecord: FreezeRecord | null = null;
    if (frozen.value !== undefined) {
        if (!isRecord(frozen.value)) {
            bad(frozenPath, "a JSON object");
        } else {
            const record = frozen.value.freeze;
            if (record !== undefined) {
                if (!isRecord(record)) {
                    bad(frozenPath, "a freeze object");
                } else {
                    freezeRecord = freezeRecordOf(record);
                }
            }
        }
    }

    const identitiesPath = join(root, "evidence/frozen-identities.json");
    const identities = readJsonFile(identitiesPath);
    let frozenIdentities: Record<string, unknown> | null = null;
    if (identities.value !== undefined) {
        if (isRecord(identities.value)) frozenIdentities = identities.value;
        else bad(identitiesPath, "a JSON object");
    }

    const schedulePath = join(root, "evidence/schedule.json");
    const scheduleFile = readJsonFile(schedulePath);
    let schedule: { campaign: string; slots: ScheduleSlotLite[] } | null = null;
    if (scheduleFile.value !== undefined) {
        if (
            !isRecord(scheduleFile.value) ||
            !Array.isArray(scheduleFile.value.slots)
        ) {
            bad(schedulePath, "a campaign and slots array");
        } else {
            const slots: ScheduleSlotLite[] = [];
            let malformed = false;
            for (const entry of scheduleFile.value.slots) {
                if (
                    !isRecord(entry) ||
                    typeof entry.slot !== "number" ||
                    typeof entry.pairId !== "string" ||
                    typeof entry.scenario !== "string" ||
                    (entry.arm !== "A" && entry.arm !== "B") ||
                    typeof entry.stamp !== "string"
                ) {
                    malformed = true;
                    break;
                }
                slots.push({
                    slot: entry.slot,
                    pairId: entry.pairId,
                    scenario: entry.scenario,
                    arm: entry.arm === "A" ? "A" : "B",
                    stamp: entry.stamp,
                });
            }
            if (malformed) {
                bad(schedulePath, "well-formed slots");
            } else {
                schedule = {
                    campaign: str(scheduleFile.value, "campaign") ?? "",
                    slots,
                };
            }
        }
    }

    const manifestPath = join(root, "prepare/manifest.json");
    const manifestFile = readJsonFile(manifestPath);
    let manifest: Record<string, unknown> | null = null;
    if (manifestFile.value !== undefined) {
        if (isRecord(manifestFile.value)) manifest = manifestFile.value;
        else bad(manifestPath, "a JSON object");
    }

    return {
        files: { freezeRecord, frozenIdentities, schedule, manifest },
        hardProblems,
    };
}

/** A tolerant mirror of contracts.mts freezeRecordOf: validate, never exit. */
function freezeRecordOf(record: Record<string, unknown>): FreezeRecord | null {
    const arms = Array.isArray(record.arms)
        ? record.arms.filter(isRecord)
        : null;
    const files = Array.isArray(record.files)
        ? record.files.filter(isRecord)
        : null;
    const inventories = Array.isArray(record.inventories)
        ? record.inventories.filter(isRecord)
        : null;
    const rules = Array.isArray(record.stoppingRules)
        ? record.stoppingRules.filter((rule): rule is string => typeof rule === "string")
        : null;
    if (
        arms === null ||
        files === null ||
        inventories === null ||
        rules === null ||
        typeof record.schemaVersion !== "number" ||
        typeof record.campaign !== "string" ||
        typeof record.sourceRevision !== "string" ||
        typeof record.sourceTree !== "string" ||
        typeof record.imageId !== "string" ||
        typeof record.containerCli !== "string" ||
        typeof record.measurementSha256 !== "string"
    ) {
        return null;
    }
    const ceiling = isRecord(record.ceilings) ? record.ceilings : null;
    const trial = ceiling !== null ? num(ceiling, "trial") : undefined;
    const judge = ceiling !== null ? num(ceiling, "judge") : undefined;
    return {
        schemaVersion: record.schemaVersion,
        campaign: record.campaign,
        sourceRevision: record.sourceRevision,
        sourceTree: record.sourceTree,
        imageId: record.imageId,
        containerCli: record.containerCli,
        measurementSha256: record.measurementSha256,
        arms: arms.map((arm) => ({
            id: str(arm, "id") ?? "?",
            commit: str(arm, "commit") ?? "",
            tree: str(arm, "tree") ?? "",
            clean: arm.clean === true,
            descriptionChars: num(arm, "descriptionChars") ?? 0,
            descriptionHash: str(arm, "descriptionHash") ?? "",
            deliveredChars: num(arm, "deliveredChars") ?? 0,
            deliveredHash: str(arm, "deliveredHash") ?? "",
            annotationChars: num(arm, "annotationChars") ?? 0,
            annotationHash: str(arm, "annotationHash") ?? "",
        })),
        files: files.map((file) => ({
            path: str(file, "path") ?? "",
            sha256: str(file, "sha256") ?? "",
        })),
        inventories: inventories.map((inv) => ({
            path: str(inv, "path") ?? "",
            files: Array.isArray(inv.files)
                ? inv.files
                      .filter(isRecord)
                      .map((file) => ({
                          path: str(file, "path") ?? "",
                          sha256: str(file, "sha256") ?? "",
                      }))
                : [],
        })),
        stoppingRules: rules,
        ceilings: {
            trial: trial ?? 0,
            judge: judge ?? 0,
        },
    };
}

// ---------------------------------------------------------------------------
// Credential observation — presence and mode only, never values.

function observeCredentials(root: string): Readiness["credentials"] {
    const credentials: Readiness["credentials"] = {};
    const envPath = join(root, ".env");
    if (existsSync(envPath)) {
        credentials.envFilePresent = true;
        const mode = statSync(envPath).mode & 0o777;
        const octal = mode.toString(8).padStart(3, "0");
        credentials.envFileMode = octal;
        if ((mode & 0o077) !== 0) {
            credentials.modeProblem = redact(
                `${envPath} is readable beyond its owner (mode ${octal}); chmod 600 it before use`,
            );
        }
    }
    const keySources: string[] = [];
    if (
        typeof process.env.ZAI_API_KEY === "string" &&
        process.env.ZAI_API_KEY !== ""
    ) {
        keySources.push("environment");
    }
    if (
        typeof process.env.ZAI_API_KEY_FILE === "string" &&
        process.env.ZAI_API_KEY_FILE !== ""
    ) {
        credentials.keySources = keySources;
        if (existsSync(process.env.ZAI_API_KEY_FILE)) keySources.push("named file");
    }
    if (credentials.envFilePresent === true) {
        const text = readTextOr(envPath);
        if (text !== null && /^\s*ZAI_API_KEY\s*=\s*\S+/m.test(text)) {
            keySources.push("campaign .env");
        }
    }
    if (keySources.length > 0) {
        credentials.keyConfigured = true;
        credentials.keySources = [...keySources];
    } else {
        credentials.keyConfigured = false;
    }
    return credentials;
}

// ---------------------------------------------------------------------------
// Preparation progress.

function observePreparation(
    root: string,
    files: IdentityFiles,
): { steps: PrepStep[]; freezeProblems: string[] } {
    const steps: PrepStep[] = [];
    const record = files.freezeRecord;

    const checkoutStep = (
        label: string,
        dir: string,
    ): PrepStep => {
        if (!existsSync(dir)) return { step: label, state: "missing" };
        return existsSync(join(dir, "node_modules"))
            ? { step: label, state: "verified", detail: "node_modules installed" }
            : { step: label, state: "present", detail: "node_modules missing" };
    };
    steps.push(checkoutStep("arms/a checkout", join(root, "arms/a")));
    steps.push(checkoutStep("arms/b checkout", join(root, "arms/b")));
    steps.push(checkoutStep("measurement checkout", join(root, "measurement")));
    steps.push({
        step: "materialisation",
        state:
            existsSync(join(root, "prepare")) && existsSync(join(root, "runner"))
                ? "present"
                : "missing",
        detail: "materialise.mts stages prepare/ and pinned runner/ modules",
    });

    // B-only description change: surfaces recorded, and post-freeze matching.
    const surfaces: Record<string, Record<string, unknown> | null> = {};
    for (const arm of ["a", "b"]) {
        const file = readJsonFile(join(root, `evidence/surfaces-${arm}.json`));
        surfaces[arm] =
            file.value !== undefined && isRecord(file.value) ? file.value : null;
    }
    const bChange: PrepStep = { step: "B-only description change", state: "missing" };
    const surfacesA = surfaces["a"] ?? null;
    const surfacesB = surfaces["b"] ?? null;
    if (surfacesA !== null && surfacesB !== null) {
        bChange.state = "present";
        const aHash = str(surfacesA, "nativeHash");
        const bHash = str(surfacesB, "nativeHash");
        bChange.detail = `A ${str(surfacesA, "nativeChars") ?? "?"} chars, B ${str(surfacesB, "nativeChars") ?? "?"} chars`;
        if (record !== null) {
            const frozenA = record.arms.find((arm) => arm.id === "A");
            const frozenB = record.arms.find((arm) => arm.id === "B");
            if (
                frozenA !== undefined &&
                frozenB !== undefined &&
                aHash !== undefined &&
                bHash !== undefined
            ) {
                bChange.state =
                    frozenA.descriptionHash === aHash && frozenB.descriptionHash === bHash
                        ? "verified"
                        : "mismatch";
            }
        }
    }
    steps.push(bChange);

    for (const arm of ["a", "b"]) {
        const fixtures = join(root, "gen", arm, "fixtures");
        let state: StepState = "missing";
        try {
            state =
                existsSync(fixtures) && readdirSync(fixtures).length > 0
                    ? "present"
                    : "missing";
        } catch {
            state = "missing";
        }
        steps.push({ step: `generated fixtures (${arm})`, state });
    }

    // Delivery receipts: request-1.json with a served docs description.
    for (const arm of ["a", "b"]) {
        const request = join(root, `evidence/delivery-${arm}`, "request-1.json");
        const step: PrepStep = {
            step: `delivery receipt (${arm})`,
            state: "missing",
        };
        const file = readJsonFile(request);
        if (file.value !== undefined) {
            step.state = "present";
            const parsed = deliveredDescription(file.value);
            if (parsed.problem !== undefined) {
                step.state = "unverifiable";
                step.detail = parsed.problem;
            } else if (parsed.chars !== undefined) {
                step.state = "verified";
                step.detail = `${parsed.chars} chars delivered`;
                if (record !== null) {
                    const frozen = record.arms.find(
                        (entry) => entry.id === arm.toUpperCase(),
                    );
                    if (frozen !== undefined && frozen.deliveredChars !== parsed.chars) {
                        step.state = "mismatch";
                        step.detail = `delivered ${parsed.chars} chars, freeze declares ${frozen.deliveredChars}`;
                    }
                }
            }
        }
        steps.push(step);
    }

    steps.push({
        step: "measurement spec",
        state: existsSync(join(root, "evidence/measurement-spec.json"))
            ? "present"
            : "missing",
    });

    // Freeze: FROZEN.json plus a fresh verifyFreeze over local inputs.
    const freezeStep: PrepStep = { step: "freeze", state: "missing" };
    const freezeProblems: string[] = [];
    if (record !== null) {
        freezeStep.state = "present";
        const unusable = spendFreezeProblem(record);
        if (unusable !== null) {
            freezeStep.state = "unverifiable";
            freezeStep.detail = unusable;
            freezeProblems.push(unusable);
        } else {
            const observedFiles: FrozenFile[] = record.files.map((file) => ({
                path: file.path,
                sha256: hashFile(join(root, file.path)),
            }));
            const observedInventories: FrozenInventory[] = record.inventories.map(
                (inventory) => ({
                    path: inventory.path,
                    files: filesUnder(join(root, inventory.path)).map((path) => ({
                        path: path.slice(root.length + 1),
                        sha256: hashFile(path),
                    })),
                }),
            );
            const sourceRepo = sourceRepoFor();
            const head =
                sourceRepo === null
                    ? ""
                    : (git(sourceRepo, ["rev-parse", "HEAD"]) ?? "");
            const observedImage =
                record.imageId === ""
                    ? ""
                    : capture("podman", [
                          "image",
                          "inspect",
                          "--format",
                          "{{.Id}}",
                          record.imageId,
                      ]);
            freezeProblems.push(
                ...verifyFreeze(record, {
                    files: observedFiles,
                    inventories: observedInventories,
                    imageId: observedImage,
                    containerCli: capture("podman", ["--version"]),
                    sourceRevision: head,
                }),
            );
            freezeStep.state = freezeProblems.length === 0 ? "verified" : "mismatch";
            freezeStep.detail =
                freezeProblems.length === 0
                    ? "immutable inputs, image and source revision verified"
                    : freezeProblems.join("; ");
        }
    }
    steps.push(freezeStep);

    // Dry run: run.mts --dry-run writes nothing durable, by design.
    steps.push({
        step: "dry run",
        state: "unverifiable",
        detail:
            "run.mts --dry-run records no durable evidence; a passing dry run cannot be observed later",
    });

    return { steps, freezeProblems };
}

/** The served docs description inside a captured provider request. */
function deliveredDescription(
    body: unknown,
): { chars?: number; hash?: string; problem?: string } {
    if (!isRecord(body) || !Array.isArray(body.tools)) {
        return { problem: "capture carries no tools array" };
    }
    for (const tool of body.tools) {
        if (
            isRecord(tool) &&
            isRecord(tool.function) &&
            tool.function.name === "docs" &&
            typeof tool.function.description === "string"
        ) {
            return {
                chars: [...tool.function.description].length,
                hash: createHash("sha256")
                    .update(tool.function.description)
                    .digest("hex"),
            };
        }
    }
    return { problem: "capture does not serve tool docs" };
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
        try {
            const value = JSON.parse(line) as unknown;
            if (isRecord(value) && typeof value.event === "string") {
                lines.push({
                    at: typeof value.at === "string" ? value.at : null,
                    event: value.event,
                    record: value,
                });
            }
        } catch {
            // parseCampaignLedger reports the malformed line.
        }
    }
    return lines;
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
    const firstBytes = ledgerReader(ledgerPath);
    const parsed = parseCampaignLedger(firstBytes ?? undefined);
    // Bounded reread: label a changing observation instead of chasing it.
    const secondBytes = ledgerReader(ledgerPath);
    const changing =
        firstBytes !== null && secondBytes !== null && firstBytes !== secondBytes;
    const bytes = changing ? secondBytes : firstBytes;
    const reparsed = changing ? parseCampaignLedger(bytes ?? undefined) : parsed;
    const lines = rawLines(bytes ?? firstBytes);

    const position: Position = {
        ledgerState: parsed.state,
        eventCount: reparsed.events.length,
    };
    if (changing) position.ledgerChanging = true;
    if (reparsed.state === "closed") position.closedAt = reparsed.closedAt;

    const last = lines.at(-1);
    if (last !== undefined) {
        const detailFields: string[] = [];
        for (const key of ["pairId", "arm", "stamp", "reason", "outcome", "slot"]) {
            const value = last.record[key];
            if (typeof value === "string" || typeof value === "number") {
                detailFields.push(`${key}=${String(value)}`);
            }
        }
        position.lastEvent = {
            event: last.event,
            at: last.at,
            detail: detailFields.join(" "),
        };
    }

    const close = lines.find((line) => line.event === "campaign-closed");
    if (close !== undefined && typeof close.record.reason === "string") {
        position.stopReason = close.record.reason;
    }

    // Slot states from the harness event vocabulary, mapped to categories.
    const slots = files.schedule?.slots ?? [];
    const byStamp = eventsByStamp(reparsed.events);
    const completedPairs = new Set<string>();
    for (const line of lines) {
        if (line.event === "pair-complete" && typeof line.record.pairId === "string") {
            completedPairs.add(line.record.pairId);
        }
    }
    let usableAssessments = 0;
    for (const line of lines) {
        if (line.event === "judge-exit" && line.record.outcome === "judged") {
            usableAssessments += 1;
        }
    }
    position.completedPairs = [...completedPairs].sort();
    position.usableAssessments = usableAssessments;

    const openClaim = (
        stamp: string,
    ): { state?: "reserved" | "spawned"; note?: string } => {
        for (const kind of ["trial", "judge"] as const) {
            const claims = safeReadClaims(evidence, kind);
            const match = claims.find(
                (claim) => claim.stamp === stamp && claim.state !== "closed",
            );
            if (match !== undefined) {
                return {
                    state: match.state === "reserved" ? "reserved" : "spawned",
                    note: `unsettled ${kind} claim (${restartDisposition(match) ?? match.state})`,
                };
            }
        }
        return {};
    };

    position.slots = slots.map((slot) => {
        const events = byStamp.get(slot.stamp);
        const claim = openClaim(slot.stamp);
        let state: string;
        let note: string | undefined;
        if (events?.complete === true) {
            state = "complete";
        } else if (claim.state !== undefined) {
            state = claim.state;
            note = claim.note;
        } else if (events === undefined || events.events.length === 0) {
            state = "unrun";
        } else if (events.blocked && events.launches === 0) {
            state = "refused-before-dispatch";
            const block = lines.find(
                (line) =>
                    line.event === "slot-blocked" && line.record.stamp === slot.stamp,
            );
            if (block !== undefined && typeof block.record.reason === "string") {
                note = block.record.reason;
            }
        } else if (events.launches > 0) {
            const exit = lines.find(
                (line) => line.event === "trial-exit" && line.record.stamp === slot.stamp,
            );
            if (exit === undefined) {
                state = "dispatched";
                note = "no durable trial exit yet";
            } else if (exit.record.usable === true) {
                const judged = lines.some(
                    (line) => line.event === "judge-exit" && line.record.stamp === slot.stamp,
                );
                state = judged ? "adjudicated" : "awaiting-judgement";
            } else {
                state = "failed-unusable";
                note = "trial exited unusable";
            }
        } else {
            state = "indeterminate";
        }
        const observed: {
            slot: number;
            pairId: string;
            scenario: string;
            arm: string;
            stamp: string;
            state: string;
            note?: string;
        } = {
            slot: slot.slot,
            pairId: slot.pairId,
            scenario: slot.scenario,
            arm: slot.arm,
            stamp: slot.stamp,
            state,
        };
        if (note !== undefined) observed.note = note;
        return observed;
    });

    // Spend from claim files; ceilings from the validated freeze record only.
    const ceilings = files.freezeRecord?.ceilings ?? { trial: 0, judge: 0 };
    const usage = (kind: "trial" | "judge") => {
        const used = safeUsage(evidence, kind);
        const ceiling = ceilings[kind];
        return {
            used,
            ceiling,
            remaining: Math.max(0, ceiling - used),
            basis: "claim files under evidence/<kind>, counted from creation",
        };
    };
    const trialClaims = safeReadClaims(evidence, "trial");
    const judgeClaims = safeReadClaims(evidence, "judge");
    const unresolved = [
        ...unresolvedReservations(trialClaims).map((claim) => ({
            claim,
            kind: "trial",
        })),
        ...unresolvedReservations(judgeClaims).map((claim) => ({
            claim,
            kind: "judge",
        })),
    ];
    position.spend = {
        trial: usage("trial"),
        judge: usage("judge"),
        reserved:
            trialClaims.filter((claim) => claim.state === "reserved").length +
            judgeClaims.filter((claim) => claim.state === "reserved").length,
        spawned:
            trialClaims.filter((claim) => claim.state === "spawned").length +
            judgeClaims.filter((claim) => claim.state === "spawned").length,
        unresolved: unresolved.map(({ claim, kind }) => {
            const entry: {
                kind: string;
                stamp?: string;
                state: string;
                path: string;
            } = {
                kind,
                state: claim.state,
                path: join(evidence, kind, claimFileName(claim)),
            };
            if (claim.stamp !== null) entry.stamp = claim.stamp;
            return entry;
        }),
    };
    position.closingLock = existsSync(join(evidence, "CLOSING.lock"));
    return position;
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

// ---------------------------------------------------------------------------
// Checkpoint and reports.

function observeCheckpoint(
    root: string,
    reportRoot: string | undefined,
    position: Position | undefined,
): Checkpoint {
    const checkpoint: Checkpoint = { reportRootGiven: reportRoot !== undefined };

    const reconciliationFile = readJsonFile(
        join(root, "evidence/RECONCILIATION.json"),
    );
    if (reconciliationFile.value !== undefined && isRecord(reconciliationFile.value)) {
        const rec = reconciliationFile.value;
        const billing = isRecord(rec.billing) ? rec.billing : {};
        const trial = isRecord(billing.trial) ? billing.trial : {};
        const judge = isRecord(billing.judge) ? billing.judge : {};
        const reconciliation: NonNullable<Checkpoint["reconciliation"]> = {
            present: true,
        };
        const at = str(rec, "at");
        if (at !== undefined) reconciliation.at = at;
        const pairs = num(rec, "completedPairs");
        if (pairs !== undefined) reconciliation.completedPairs = pairs;
        const launches = num(rec, "trialLaunches");
        if (launches !== undefined) reconciliation.trialLaunches = launches;
        const unrun = Array.isArray(rec.unrunSlots) ? rec.unrunSlots.length : 0;
        reconciliation.unrunSlots = unrun;
        reconciliation.billingTrial = num(trial, "estimated") ?? null;
        reconciliation.billingJudge = num(judge, "estimated") ?? null;
        const currency = str(billing, "currency");
        if (currency !== undefined) reconciliation.currency = currency;
        checkpoint.reconciliation = reconciliation;
    } else {
        checkpoint.reconciliation = { present: false };
    }

    if (reportRoot === undefined) return checkpoint;

    const manifestHash = hashFile(join(root, "prepare/manifest.json"));
    const lastLedgerAt = position?.lastEvent?.at ?? null;
    const dirs: string[] = [];
    // The report root may hold one report per subdirectory (the run card
    // shape) or be a single report directory itself.
    if (existsSync(join(reportRoot, "analysis.json"))) {
        dirs.push(reportRoot);
    }
    try {
        for (const entry of readdirSync(reportRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) dirs.push(join(reportRoot, entry.name));
        }
    } catch {
        if (dirs.length === 0) return checkpoint;
    }
    const reports: ReportObservation[] = [];
    for (const dir of dirs.sort()) {
        const analysisFile = readJsonFile(join(dir, "analysis.json"));
        if (analysisFile.value === undefined || !isRecord(analysisFile.value)) {
            continue;
        }
        reports.push(
            observeReport(dir, analysisFile.value, root, manifestHash, lastLedgerAt),
        );
    }
    checkpoint.reports = reports;
    return checkpoint;
}

/** One analysis report observation; a partial report keeps its own scope. */
function observeReport(
    dir: string,
    analysis: Record<string, unknown>,
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
    const campaignRecord = isRecord(analysis.campaign) ? analysis.campaign : null;
    if (campaignRecord !== null) {
        const id = str(campaignRecord, "id");
        if (id !== undefined) report.campaignId = id;
    }
    if (receipt !== null) {
        const renderedAt = str(receipt, "renderedAt");
        if (renderedAt !== undefined) report.renderedAt = renderedAt;
    }
    const manifestSha = str(analysis, "manifestSha256");
    if (manifestSha !== undefined) report.manifestSha256 = manifestSha;

    if (report.campaignId !== undefined && !identityMatches(root, report.campaignId)) {
        report.wrongCampaign = true;
    }
    let ledgerAdvanced = false;
    if (
        manifestSha !== undefined &&
        manifestHash !== "missing" &&
        report.renderedAt !== undefined &&
        lastLedgerAt !== null
    ) {
        ledgerAdvanced = lastLedgerAt > report.renderedAt;
        report.ledgerAdvancedSince = ledgerAdvanced;
        report.manifestMatches = manifestSha === manifestHash;
        report.freshness =
            report.manifestMatches && !ledgerAdvanced ? "current" : "stale";
    } else if (manifestSha !== undefined && manifestHash !== "missing") {
        report.manifestMatches = manifestSha === manifestHash;
        report.freshness = report.manifestMatches ? "current" : "stale";
    }

    const decision = isRecord(analysis.decision) ? analysis.decision : null;
    if (decision !== null) {
        const overall = str(decision, "overall");
        if (overall !== undefined) report.decision = overall;
    }
    const measures = isRecord(analysis.measures) ? analysis.measures : null;
    if (measures !== null && isRecord(measures.personalTrial)) {
        const recommendation = str(measures.personalTrial, "recommendation");
        if (recommendation !== undefined) report.recommendation = recommendation;
    }
    const paired = isRecord(analysis.paired) ? analysis.paired : null;
    report.pairedDelta = paired !== null ? (num(paired, "delta") ?? null) : null;
    if (isRecord(analysis.pairing)) {
        report.coverage = {
            completePairs: num(analysis.pairing, "completePairs") ?? 0,
            documented: 0,
            assessed: 0,
        };
    }
    const arms = isRecord(analysis.arms) ? analysis.arms : null;
    if (arms !== null) {
        const recording: Record<string, { planned: number; success: number }> = {};
        const retrieval: Record<string, { planned: number; applied: number }> = {};
        let breaches = 0;
        for (const [arm, value] of Object.entries(arms)) {
            if (!isRecord(value)) continue;
            const accounting = isRecord(value.accounting) ? value.accounting : {};
            if (report.coverage !== undefined) {
                report.coverage.documented += num(accounting, "documented") ?? 0;
                report.coverage.assessed += num(accounting, "assessed") ?? 0;
            }
            if (Array.isArray(value.guardrails)) {
                for (const g of value.guardrails) {
                    if (isRecord(g) && g.status === "breached") breaches += 1;
                }
            }
            if (
                measures !== null &&
                isRecord(measures.arms) &&
                isRecord(measures.arms[arm])
            ) {
                const armMeasures = measures.arms[arm];
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
        }
        report.guardrailBreaches = breaches;
        if (Object.keys(recording).length > 0) report.recording = recording;
        if (Object.keys(retrieval).length > 0) report.retrieval = retrieval;
    }
    const usage = isRecord(analysis.usage) ? analysis.usage : null;
    if (usage !== null || analysis.measuredTrials !== undefined) {
        const tokens: NonNullable<ReportObservation["tokens"]> = {
            steps: usage !== null ? (num(usage, "steps") ?? null) : null,
        };
        const measured = num(analysis, "measuredTrials");
        if (measured !== undefined) tokens.measuredTrials = measured;
        const unknown = num(analysis, "unknownTrials");
        if (unknown !== undefined) tokens.unknownTrials = unknown;
        report.tokens = tokens;
    }
    report.scope = `report scope is its own: ${String(report.coverage?.completePairs ?? "?")} complete pairs at render time`;
    return report;
}

/** Whether a report's campaign id matches this root's schedule identity. */
function identityMatches(root: string, campaignId: string): boolean {
    const scheduleFile = readJsonFile(join(root, "evidence/schedule.json"));
    if (scheduleFile.value === undefined || !isRecord(scheduleFile.value)) {
        return true;
    }
    const own = str(scheduleFile.value, "campaign");
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

function checkoutNextAction(
    identity: Identity,
    assetsPresent: boolean,
): ActionResult {
    const gaps: Gap[] = [
        { field: "checkpoint rule (P04 report before continuation)", source: "run-card" },
    ];
    const mismatch =
        identity.resolvedBase !== undefined &&
        identity.sourceHead !== undefined &&
        identity.resolvedBase !== identity.sourceHead;
    if (mismatch) {
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

/** The per-step recipes, keyed by the step names observePreparation emits. */
function preparationRecipe(
    root: string,
    step: string,
): { why: string; command?: string; cwd?: string; envNames?: string[] } | undefined {
    const sourceRepo = sourceRepoFor();
    const withEnv = (command: string, extra: string[] = []): string => {
        const envs = [`CAMPAIGN_ROOT=${shellQuote(root)}`];
        if (sourceRepo !== null) {
            envs.push(`CAMPAIGN_SOURCE_REPO=${shellQuote(sourceRepo)}`);
        } else {
            envs.push("CAMPAIGN_SOURCE_REPO=<measurement-worktree>");
        }
        return `${envs.join(" ")} ${command}`;
    };
    const envNames =
        sourceRepo === null
            ? ["CAMPAIGN_ROOT", "CAMPAIGN_SOURCE_REPO"]
            : ["CAMPAIGN_ROOT", "CAMPAIGN_SOURCE_REPO"];
    switch (step) {
        case "arms/a checkout":
            return {
                why: "run card step 2: arms/a is the base-commit worktree with node_modules installed",
                command:
                    "git worktree add <root>/arms/a <base> && cd <root>/arms/a && npm ci",
            };
        case "arms/b checkout":
            return {
                why: "run card step 2: arms/b is base + replication/patch.mjs",
                command:
                    "git worktree add <root>/arms/b <base> && cd <root>/arms/b && git apply replication/patch.mjs && npm ci",
            };
        case "measurement checkout":
            return {
                why: "run card step 2: measurement is an independent worktree at the same base",
                command:
                    "git worktree add <root>/measurement <base> && cd <root>/measurement && npm ci",
            };
        case "materialisation":
            return {
                why: "run card step 0: materialise stages prepare/ and the pinned runner modules",
                command: `node ${shellQuote("tests/fixtures/placement-harness/prod014/campaign/materialise.mts")} ${shellQuote(root)}`,
                cwd: "<operator checkout at the pinned revision>",
            };
        case "B-only description change":
            return {
                why: "run card step 3: record both arms' surfaces so the freeze can compare registered descriptions",
                command:
                    `node ${shellQuote(join(root, "prepare/surfaces.mts"))} ${shellQuote(join(root, "arms/a"))} ` +
                    `${shellQuote(join(root, "evidence/surfaces-a.json"))} && ` +
                    `node ${shellQuote(join(root, "prepare/surfaces.mts"))} ${shellQuote(join(root, "arms/b"))} ` +
                    `${shellQuote(join(root, "evidence/surfaces-b.json"))}`,
            };
        case "generated fixtures (a)":
        case "generated fixtures (b)":
            return {
                why: "run card step 3: schedule then generate writes gen/<arm> for both arms",
                command: withEnv(
                    `node ${shellQuote(join(root, "prepare/schedule.mts"))} && bash ${shellQuote(join(root, "prepare/generate.sh"))}`,
                ),
                envNames: [...envNames, "CAMPAIGN_ID"],
            };
        case "delivery receipt (a)":
        case "delivery receipt (b)": {
            const arm = step.endsWith("(a)") ? "a" : "b";
            const port = arm === "a" ? "8801" : "8802";
            return {
                why: `run card step 3: delivery probe for arm ${arm} (loopback fake provider)`,
                command:
                    `node ${shellQuote(join(root, "prepare/delivery-probe.mts"))} ` +
                    `${shellQuote(join(root, `evidence/delivery-${arm}/capture.json`))} ` +
                    `${shellQuote(join(root, "arms", arm))} opencode-go/deepseek-v4.1-flash ${shellQuote("Hello.")} ${port}`,
            };
        }
        case "measurement spec":
            return {
                why: "run card step 3: copy the measurement spec into evidence",
                command:
                    `cp ${shellQuote(join(root, "arms/a/tests/fixtures/placement-harness/prod014/measurement.json"))} ` +
                    `${shellQuote(join(root, "evidence/measurement-spec.json"))}`,
            };
        case "freeze":
            return {
                why: "run card step 3: freeze builds/resolves the image and records immutable ids",
                command: withEnv(`node ${shellQuote(join(root, "prepare/freeze.mts"))}`),
                envNames,
            };
        default:
            return undefined;
    }
}

function campaignNextAction(
    root: string,
    files: IdentityFiles,
    readiness: Readiness,
    preparation: PrepStep[],
    freezeProblems: string[],
    position: Position,
    checkpoint: Checkpoint,
): ActionResult {
    const gaps: Gap[] = [];
    const sourceRepo = sourceRepoFor();
    const runCommand = (args: string): string => {
        const envs = [`CAMPAIGN_ROOT=${shellQuote(root)}`];
        envs.push(
            sourceRepo === null
                ? "CAMPAIGN_SOURCE_REPO=<measurement-worktree>"
                : `CAMPAIGN_SOURCE_REPO=${shellQuote(sourceRepo)}`,
        );
        return `${envs.join(" ")} node ${shellQuote(join(root, "prepare/run.mts"))} ${args}`;
    };
    const analyseCommand = (): string => {
        const cd =
            sourceRepo === null
                ? "cd <measurement-worktree>"
                : `cd ${shellQuote(sourceRepo)}`;
        return (
            `${cd} && node tests/fixtures/placement-harness/analysis/analyse.mts ` +
            `--campaign ${shellQuote(join(root, "prepare/manifest.json"))} ` +
            `--evidence-root ${shellQuote(root)} --out <fresh-report-dir>`
        );
    };

    // Authority order mirrors run.mts: the credential file is refused before
    // anything else loads; then closure, reservations, ledger, freeze premise,
    // prerequisites, progression.
    if (readiness.credentials.modeProblem !== undefined) {
        return {
            phase: "blocked-credential-mode",
            headline: readiness.credentials.modeProblem,
            nextAction: {
                kind: "offline-check",
                why: "the runner refuses a credential file readable beyond its owner before loading any value",
                command: `chmod 600 ${shellQuote(join(root, ".env"))}`,
            },
            gaps,
        };
    }
    if (position.closingLock === true) {
        return {
            phase: "close-interrupted",
            headline:
                "a campaign close started and did not finish (CLOSING.lock present)",
            nextAction: {
                kind: "inspection",
                why: "every dispatch refuses while the lock exists; inspect the evidence root, then decide whether to resume close-campaign.mts",
                path: join(root, "evidence"),
            },
            gaps,
        };
    }
    if (position.ledgerState === "closed") {
        return {
            phase: "closed",
            headline: `campaign closed${position.stopReason !== undefined && position.stopReason !== null ? `: ${position.stopReason}` : ""}`,
            nextAction: {
                kind: "inspection",
                why: "read the final report and reconciliation; no further spend is permitted",
                path:
                    checkpoint.reports?.[0]?.dir ??
                    join(root, "evidence/RECONCILIATION.json"),
            },
            gaps,
        };
    }
    const unresolved = position.spend?.unresolved ?? [];
    if (unresolved.length > 0) {
        return {
            phase: "blocked-unresolved-reservation",
            headline: `unsettled ${unresolved[0]?.kind ?? ""} claim blocks every dispatch`,
            nextAction: {
                kind: "inspection",
                why: "the runner never retries a spend whose outcome is unknown; inspect the claim and its launch record before any decision",
                path: unresolved[0]?.path ?? join(root, "evidence"),
            },
            gaps,
        };
    }
    if (position.ledgerState === "malformed") {
        return {
            phase: "blocked-malformed-ledger",
            headline: "the attempt ledger is malformed; no spend can be authorised",
            nextAction: {
                kind: "inspection",
                why: "a partial read cannot prove what spend was authorised; inspect ATTEMPTS.jsonl line by line",
                path: join(root, "evidence/ATTEMPTS.jsonl"),
            },
            gaps,
        };
    }
    if (freezeProblems.length > 0) {
        return {
            phase: "frozen-premise-changed",
            headline: `frozen premise no longer holds: ${freezeProblems[0] ?? ""}`,
            nextAction: {
                kind: "operator-decision",
                why: "changed wording requires a fresh root, fresh materialisation and fresh stamps; never edit a frozen input",
            },
            gaps,
        };
    }
    // run.mts refuses dispatch on a non-executable shim; the freeze hashes
    // cannot see the mode bit, so observe it directly.
    if (readiness.shimExecutable === false) {
        return {
            phase: "blocked-local-prerequisite",
            headline: `the container shim is not executable: ${join(root, "prepare/shim/podman")}`,
            nextAction: {
                kind: "offline-check",
                why: "every dispatch refuses until the shim can be executed again",
                command: `chmod +x ${shellQuote(join(root, "prepare/shim/podman"))}`,
            },
            gaps,
        };
    }

    // Pre-freeze: the earliest missing prerequisite wins.
    if (files.freezeRecord === null) {
        const earliest = preparation.find(
            (step) =>
                step.state === "missing" ||
                step.state === "mismatch" ||
                step.state === "unverifiable",
        );
        if (earliest === undefined || earliest.step === "dry run") {
            // Every real prerequisite is present but no freeze exists.
            const freezeRecipe = preparationRecipe(root, "freeze");
            const freezeNext: NextAction = {
                kind: "offline-preparation",
                why: "run card step 3: freeze builds/resolves the image and records immutable ids",
                envNames: ["CAMPAIGN_ROOT", "CAMPAIGN_SOURCE_REPO"],
            };
            if (freezeRecipe?.command !== undefined) {
                freezeNext.command = freezeRecipe.command;
            }
            return {
                phase: "preparing",
                headline: "all freeze inputs present; freeze not yet written",
                nextAction: freezeNext,
                gaps,
            };
        }
        const recipe = preparationRecipe(root, earliest.step);
        const prep: NextAction = {
            kind: "offline-preparation",
            why: recipe?.why ?? `follow the run card (${RUN_CARD}) from this step`,
        };
        if (recipe?.command !== undefined) prep.command = recipe.command;
        if (recipe?.cwd !== undefined) prep.cwd = recipe.cwd;
        if (recipe?.envNames !== undefined) prep.envNames = recipe.envNames;
        return {
            phase: "preparing",
            headline: `earliest missing prerequisite: ${earliest.step}`,
            nextAction: prep,
            gaps,
        };
    }

    // Frozen: progression by observed pairs and reports.
    const completePairs = new Set(position.completedPairs ?? []);
    const allPairs = new Set((position.slots ?? []).map((slot) => slot.pairId));
    const reports = checkpoint.reports ?? [];
    const current = reports.find(
        (report) => report.freshness === "current" && report.wrongCampaign !== true,
    );
    const staleOrWrong = reports.filter(
        (report) => report.freshness === "stale" || report.wrongCampaign === true,
    );

    if (completePairs.size === 0) {
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
                command: runCommand("--dry-run"),
                envNames: ["CAMPAIGN_ROOT", "CAMPAIGN_SOURCE_REPO"],
            },
            gaps,
        };
    }

    if (allPairs.size > 0 && completePairs.size >= allPairs.size) {
        return {
            phase: "awaiting-closure",
            headline: `all ${allPairs.size} pairs complete; campaign not closed`,
            nextAction: {
                kind: "offline-preparation",
                why: "run card step 5: final analysis then close-campaign reconciles counts and writes the closure record",
                command: `${analyseCommand()} && ${
                    sourceRepo === null
                        ? "CAMPAIGN_SOURCE_REPO=<measurement-worktree> "
                        : `CAMPAIGN_SOURCE_REPO=${shellQuote(sourceRepo)} `
                }CAMPAIGN_ROOT=${shellQuote(root)} node ${shellQuote(join(root, "prepare/close-campaign.mts"))}`,
                envNames: ["CAMPAIGN_ROOT", "CAMPAIGN_SOURCE_REPO"],
            },
            gaps,
        };
    }

    // P01–P04 complete: the checkpoint report governs continuation.
    const checkpointDone = ["P01", "P02", "P03", "P04"].every((pair) =>
        completePairs.has(pair),
    );
    if (checkpointDone && !completePairs.has("P08")) {
        gaps.push({
            field: "P04 blocker judgement (continue only if no blocker, no unusable judge, no premise change)",
            source: "run-card",
        });
        if (current === undefined) {
            return {
                phase: "checkpoint-report-missing",
                headline:
                    checkpoint.reportRootGiven === true && staleOrWrong.length > 0
                        ? "P04 report is stale or wrong-campaign"
                        : "P01–P04 complete; no current checkpoint report",
                nextAction: {
                    kind: "offline-check",
                    why:
                        checkpoint.reportRootGiven === true && staleOrWrong.length > 0
                            ? "the existing report is stale or from another campaign; re-render into a fresh directory before deciding"
                            : "run card step 4: the P04 checkpoint report must exist and be current before continuation",
                    command: analyseCommand(),
                    envNames: ["CAMPAIGN_SOURCE_REPO"],
                },
                gaps,
            };
        }
        return {
            phase: "checkpoint-review",
            headline: `P04 checkpoint report current (${current.recommendation ?? current.decision ?? "decision rendered"}); continuation is a human decision`,
            nextAction: {
                kind: "operator-decision",
                why: `continue only if the report shows no blocker, no unusable judge and no premise change (run card step 4); paid P05–P08 command: ${runCommand("--pair-from 5 --pair-to 8")}`,
                path: current.dir,
            },
            gaps,
        };
    }

    // Mid-range: the next unfinished slot with an open ledger.
    const nextSlot = (position.slots ?? []).find(
        (slot) => slot.state !== "complete" && slot.state !== "adjudicated",
    );
    if (nextSlot !== undefined && position.ledgerState === "open") {
        const spend = position.spend;
        if (
            spend !== undefined &&
            (spend.trial.remaining === 0 || spend.judge.remaining === 0)
        ) {
            return {
                phase: "ceiling-reached",
                headline: `spend ceiling reached (trial ${spend.trial.used}/${spend.trial.ceiling}, judge ${spend.judge.used}/${spend.judge.ceiling}); ${allPairs.size - completePairs.size} pairs unrun`,
                nextAction: {
                    kind: "operator-decision",
                    why: "the frozen ceiling blocks every further claim; a completed P01–P04 range is not campaign completion, and status suggests no dispatch past a ceiling",
                },
                gaps,
            };
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
                    `--pair-from ${pairNumberOf(nextSlot.pairId)} --pair-to 8`,
                ),
                envNames: ["CAMPAIGN_ROOT", "CAMPAIGN_SOURCE_REPO"],
            },
            gaps,
        };
    }

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

/** P01-style pair id to its number. */
function pairNumberOf(pairId: string): number {
    const parsed = Number(pairId.replace(/\D/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
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
    const porcelain = gitRaw(cwd, ["status", "--porcelain"]);
    const clean = porcelain !== null && porcelain.trim() === "";
    const campaignDir = join(
        cwd,
        "tests/fixtures/placement-harness/prod014/campaign",
    );
    const assetsPresent =
        existsSync(join(campaignDir, "materialise.mts")) &&
        existsSync(join(campaignDir, "active")) &&
        existsSync(join(campaignDir, "runner.json"));

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
    identity.sourceClean = clean;
    identity.sourceRepo = cwd;

    const readiness = observeReadiness(cwd, undefined);

    const action = checkoutNextAction(identity, assetsPresent);
    const result: StatusResult = {
        schemaVersion: 1,
        mode: "checkout",
        generatedAt: new Date().toISOString(),
        phase: action.phase,
        headline: action.headline,
        identity,
        readiness,
        nextAction: action.nextAction,
        gaps: action.gaps,
        problems,
    };
    return { result, exit: resolvedBase === null ? 2 : 0 };
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

    if (record !== null && record !== undefined) {
        const image: NonNullable<Readiness["image"]> = {
            present: "indeterminate",
        };
        if (record.imageId !== "") {
            image.expectedId = record.imageId;
            const observed = capture("podman", [
                "image",
                "inspect",
                "--format",
                "{{.Id}}",
                record.imageId,
            ]);
            if (observed !== "") {
                image.observedId = observed;
                image.present = observed === record.imageId;
            }
        }
        readiness.image = image;

        const shimPath = join(root, "prepare/shim/podman");
        if (existsSync(shimPath)) {
            try {
                accessSync(shimPath, constants.X_OK);
                readiness.shimExecutable = true;
            } catch {
                readiness.shimExecutable = false;
            }
        }
        readiness.dependencies = {
            armsA: existsSync(join(root, "arms/a/node_modules")),
            armsB: existsSync(join(root, "arms/b/node_modules")),
            measurement: existsSync(join(root, "measurement/node_modules")),
        };
        readiness.routing = routingObservation(root);
    }
    return readiness;
}

// ---------------------------------------------------------------------------
// Campaign mode.

function observeCampaign(
    root: string,
    reportRoot: string | undefined,
): { result: StatusResult; exit: StatusExit } {
    if (!existsSync(root)) {
        return unreadableRoot(root, `campaign root does not exist: ${root}`);
    }
    try {
        if (!statSync(root).isDirectory()) {
            return unreadableRoot(root, `campaign root is not a directory: ${root}`);
        }
    } catch (error) {
        return unreadableRoot(
            root,
            `campaign root cannot be read: ${redact(error instanceof Error ? error.message : String(error))}`,
        );
    }

    const { files, hardProblems } = readIdentityFiles(root);
    if (hardProblems.length > 0) {
        return {
            result: {
                schemaVersion: 1,
                mode: "campaign",
                generatedAt: new Date().toISOString(),
                phase: "unreadable-evidence",
                headline: `evidence that identifies the campaign cannot be read: ${hardProblems[0]?.message ?? ""}`,
                root,
                nextAction: {
                    kind: "inspection",
                    why: "fix or preserve the named file; a status observation refuses to guess past unreadable evidence",
                },
                gaps: [],
                problems: hardProblems,
            },
            exit: 2,
        };
    }
    const record = files.freezeRecord;

    // Identity: registered pre-freeze, authoritative frozen values afterwards.
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

    const gaps: Gap[] = [...action.gaps];
    if (record === null) {
        gaps.push({
            field: "trial/judge ceilings",
            source: "none until FROZEN.json exists (a missing record reads as zero and blocks every claim)",
        });
    }
    gaps.push({
        field: "checkpoint rule (P04 report before continuation)",
        source: "run-card",
    });
    gaps.push({
        field: "credential validity and delivered model identity",
        source: "none (require their own evidence; status checks presence and mode only)",
    });

    const result: StatusResult = {
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
        gaps,
        problems: [],
    };
    return { result, exit: 0 };
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

/** Identity from durable sources, each field tagged. */
function observeIdentity(root: string, files: IdentityFiles): Identity {
    const identity: Identity = { sources: {} };
    const record = files.freezeRecord;
    const identities = files.frozenIdentities;

    const sourceRepo = sourceRepoFor();
    if (sourceRepo !== null) {
        identity.sourceRepo = sourceRepo;
        const head = git(sourceRepo, ["rev-parse", "HEAD"]);
        if (head !== null) identity.sourceHead = head;
        const porcelain = gitRaw(sourceRepo, ["status", "--porcelain"]);
        identity.sourceClean = porcelain !== null && porcelain.trim() === "";
        identity.sources.sourceHead = `git rev-parse HEAD in CAMPAIGN_SOURCE_REPO (${sourceRepo})`;
    } else {
        identity.sources.sourceHead =
            "CAMPAIGN_SOURCE_REPO unset; actual source HEAD unobserved";
    }

    if (identities !== null) {
        const base = isRecord(identities.base) ? identities.base : {};
        const requested = str(base, "commit");
        if (requested !== undefined) identity.requestedBase = requested;
        identity.sources.requestedBase = "frozen-identities.json base.commit";
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
    } else if (identities !== null) {
        identity.ceilingSource =
            "no FROZEN.json; frozen-identities.json budget is registered but not verified";
    }

    const frozenTop = readJsonFile(join(root, "evidence/FROZEN.json"));
    if (frozenTop.value !== undefined && isRecord(frozenTop.value)) {
        const trialModel = str(frozenTop.value, "trialModel");
        if (trialModel !== undefined) identity.trialModel = trialModel;
        const judgeModel = str(frozenTop.value, "judgeModel");
        if (judgeModel !== undefined) identity.judgeModel = judgeModel;
        const campaign = str(frozenTop.value, "campaign");
        if (campaign !== undefined) identity.campaignId = campaign;
    }

    if (files.schedule !== null) {
        if (files.schedule.campaign !== "") {
            identity.campaignId = files.schedule.campaign;
        }
        identity.slots = files.schedule.slots.length;
        identity.pairs = new Set(files.schedule.slots.map((s) => s.pairId)).size;
        identity.order = files.schedule.slots.map((s) => ({
            slot: s.slot,
            pairId: s.pairId,
            scenario: s.scenario,
            arm: s.arm,
        }));
        identity.sources.schedule = "evidence/schedule.json";
    }

    if (files.manifest !== null) {
        const policy = isRecord(files.manifest.policy)
            ? files.manifest.policy
            : {};
        const weights = isRecord(policy.weights) ? policy.weights : null;
        if (weights !== null) {
            const parsed: Record<string, number> = {};
            for (const [key, value] of Object.entries(weights)) {
                if (typeof value === "number" && Number.isFinite(value)) {
                    parsed[key] = value;
                }
            }
            identity.weights = parsed;
        }
        const selection = isRecord(policy.selection) ? policy.selection : {};
        const control = str(selection, "controlArm");
        if (control !== undefined) identity.controlArm = control;
        const candidate = str(selection, "candidateArm");
        if (candidate !== undefined) identity.candidateArm = candidate;
        const threshold = num(selection, "threshold");
        if (threshold !== undefined) identity.threshold = threshold;
        if (Array.isArray(policy.guardrails)) {
            identity.guardrailIds = policy.guardrails
                .filter(isRecord)
                .map((g) => str(g, "id") ?? "?");
        }
        if (identity.order === undefined && isRecord(files.manifest.schedule)) {
            // No schedule.json yet: the manifest carries the planned order.
            const slots = Array.isArray(files.manifest.schedule.slots)
                ? files.manifest.schedule.slots
                : [];
            const parsed: NonNullable<Identity["order"]> = [];
            for (const entry of slots) {
                if (
                    isRecord(entry) &&
                    typeof entry.slot === "number" &&
                    typeof entry.pairId === "string" &&
                    typeof entry.scenario === "string" &&
                    (entry.arm === "A" || entry.arm === "B")
                ) {
                    parsed.push({
                        slot: entry.slot,
                        pairId: entry.pairId,
                        scenario: entry.scenario,
                        arm: entry.arm,
                    });
                }
            }
            identity.order = parsed;
            identity.slots = parsed.length;
            identity.pairs = new Set(parsed.map((s) => s.pairId)).size;
            identity.sources.schedule =
                "prepare/manifest.json (planned; schedule.json not yet written)";
        }
        identity.sources.policy = "prepare/manifest.json";
    }
    return identity;
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
    const lines: string[] = [];
    const where = result.root === undefined ? "" : ` — ${result.root}`;
    lines.push(`prod014 status [${result.mode}]${where}`);
    lines.push(`phase: ${result.phase}`);
    lines.push(result.headline);
    const spend = result.position?.spend;
    if (spend !== undefined) {
        lines.push(
            `spend: trial ${spend.trial.used}/${spend.trial.ceiling} (${spend.trial.remaining} remaining), judge ${spend.judge.used}/${spend.judge.ceiling} (${spend.judge.remaining} remaining)`,
        );
    }
    lines.push("");

    const identity = result.identity;
    if (identity !== undefined) {
        lines.push("identity:");
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
        lines.push(`  ${bits.join(" · ")}`);
        if (identity.arms !== undefined) {
            lines.push(
                `  arms: ${identity.arms
                    .map(
                        (arm) =>
                            `${arm.id} native ${arm.nativeChars ?? "?"} chars, delivered ${arm.deliveredChars ?? "?"}${arm.declaredMismatch === true ? " (MISMATCH)" : ""}`,
                    )
                    .join(" | ")}`,
            );
        }
        if (identity.slots !== undefined) {
            lines.push(
                `  schedule: ${identity.slots} slots / ${identity.pairs ?? "?"} pairs` +
                    (identity.order === undefined
                        ? ""
                        : `; order ${identity.order
                              .map((slot) => `${slot.pairId}${slot.arm}`)
                              .join(" ")}`),
            );
        }
    }

    const readiness = result.readiness;
    if (readiness !== undefined) {
        lines.push("readiness:");
        lines.push(
            `  node ${readiness.nodeVersion} · ${readiness.containerEngine.cli} ${readiness.containerEngine.version ?? "not found"}`,
        );
        if (readiness.image !== undefined) {
            const expected =
                readiness.image.expectedId === undefined
                    ? "none registered"
                    : readiness.image.expectedId.slice(0, 19);
            lines.push(
                `  image ${expected}: ${readiness.image.present === true ? "present" : readiness.image.present === false ? "CHANGED/ABSENT" : "indeterminate"}`,
            );
        }
        if (readiness.shimExecutable !== undefined) {
            lines.push(
                `  shim ${readiness.shimExecutable ? "executable" : "NOT executable"}`,
            );
        }
        const creds = readiness.credentials;
        lines.push(
            `  credentials: ${creds.keyConfigured === true ? `configured (${(creds.keySources ?? []).join(", ")})` : "NOT configured"}${creds.envFilePresent === true ? `, .env mode ${creds.envFileMode}` : ""}`,
        );
        if (creds.modeProblem !== undefined) {
            lines.push(`  credential problem: ${creds.modeProblem}`);
        }
        if (readiness.dependencies !== undefined) {
            lines.push(
                `  dependencies: arms/a ${ok(readiness.dependencies.armsA)}, arms/b ${ok(readiness.dependencies.armsB)}, measurement ${ok(readiness.dependencies.measurement)}`,
            );
        }
        if (readiness.diskFreeBytes !== undefined) {
            lines.push(`  disk free: ${(readiness.diskFreeBytes / GB).toFixed(1)} GiB`);
        }
        if (readiness.routing !== undefined) {
            lines.push(`  routing: ${readiness.routing}`);
        }
    }

    if (result.preparation !== undefined) {
        lines.push("preparation:");
        for (const step of result.preparation) {
            lines.push(
                `  ${step.state.padEnd(13)} ${step.step}` +
                    (step.detail === undefined ? "" : ` — ${step.detail}`),
            );
        }
    }

    const position = result.position;
    if (position !== undefined) {
        lines.push(
            `position: ledger ${position.ledgerState}${position.ledgerChanging === true ? " (records advanced mid-read)" : ""}, ${position.eventCount} events`,
        );
        if (position.lastEvent !== undefined) {
            lines.push(
                `  last: ${position.lastEvent.event} at ${position.lastEvent.at ?? "?"} ${position.lastEvent.detail ?? ""}`.trimEnd(),
            );
        }
        if (position.completedPairs !== undefined) {
            lines.push(
                `  completed pairs: ${position.completedPairs.join(" ") || "none"} · usable assessments (judge-exit judged): ${position.usableAssessments ?? 0}`,
            );
        }
        if (position.slots !== undefined && detail) {
            for (const slot of position.slots) {
                lines.push(
                    `  slot ${String(slot.slot).padStart(2, "0")} ${slot.pairId} ${slot.scenario} ${slot.arm}: ${slot.state}${slot.note === undefined ? "" : ` (${slot.note})`}`,
                );
            }
        }
        const unresolvedClaims = position.spend?.unresolved ?? [];
        for (const claim of unresolvedClaims) {
            lines.push(`  unsettled: ${claim.path} (${claim.state})`);
        }
        if (position.closingLock === true) {
            lines.push("  CLOSING.lock present");
        }
    }

    const checkpoint = result.checkpoint;
    if (checkpoint !== undefined) {
        lines.push(
            `checkpoint: report root ${checkpoint.reportRootGiven === true ? "given" : "not given (pass --report-root)"}`,
        );
        for (const report of checkpoint.reports ?? []) {
            lines.push(
                `  ${report.dir}: ${report.freshness ?? "unknown"}${report.wrongCampaign === true ? " (WRONG CAMPAIGN)" : ""}${report.recommendation !== undefined ? `, ${report.recommendation}` : ""}${report.decision !== undefined ? `, decision ${report.decision}` : ""}`,
            );
            if (detail && report.recording !== undefined) {
                for (const [arm, counts] of Object.entries(report.recording)) {
                    lines.push(
                        `    recording ${arm}: ${counts.success}/${counts.planned} · retrieval ${report.retrieval?.[arm]?.applied ?? "?"}/${report.retrieval?.[arm]?.planned ?? "?"}`,
                    );
                }
            }
            if (report.pairedDelta !== undefined && report.pairedDelta !== null) {
                lines.push(`    paired delta: ${report.pairedDelta}`);
            }
        }
        const rec = checkpoint.reconciliation;
        if (rec !== undefined) {
            lines.push(
                rec.present
                    ? `  reconciliation: ${rec.at ?? "?"}, ${rec.completedPairs ?? "?"} pairs, ${rec.trialLaunches ?? "?"} launches, billing ${rec.currency ?? "?"} trial ${rec.billingTrial ?? "null"} judge ${rec.billingJudge ?? "null"}`
                    : "  reconciliation: absent",
            );
        }
    }

    lines.push("");
    const action = result.nextAction;
    lines.push(`NEXT (${action.kind}): ${action.why}`);
    if (action.command !== undefined) {
        lines.push(`  command: ${action.command}`);
    }
    if (action.path !== undefined) {
        lines.push(`  evidence: ${action.path}`);
    }
    if (action.cwd !== undefined) {
        lines.push(`  cwd: ${action.cwd}`);
    }
    if ((action.envNames ?? []).length > 0) {
        lines.push(
            `  env: ${(action.envNames ?? []).join(", ")} (names only; values are yours)`,
        );
    }
    if (result.gaps.length > 0) {
        lines.push("");
        lines.push("no durable source for:");
        for (const gap of result.gaps) {
            lines.push(`  ${gap.field} — ${gap.source}`);
        }
    }
    if (result.problems.length > 0) {
        lines.push("");
        lines.push("observation problems:");
        for (const problem of result.problems) {
            lines.push(`  [${problem.code}] ${problem.message}`);
        }
    }
    return lines.join("\n");
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

export interface ParsedArguments {
    base?: string;
    root?: string;
    reportRoot?: string;
    json: boolean;
    detail: boolean;
    help: boolean;
}

/** Parse argv into a request, or a list of usage problems. */
export function parseArguments(
    argv: readonly string[],
): { ok: true; args: ParsedArguments } | { ok: false; problems: string[] } {
    const flags = new Set(["--json", "--detail", "--help", "-h"]);
    const valued = new Set(["--base", "--root", "--report-root"]);
    const args: ParsedArguments = {
        json: argv.includes("--json"),
        detail: argv.includes("--detail"),
        help: argv.includes("--help") || argv.includes("-h"),
    };    const problems: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined) continue;
        if (flags.has(arg)) continue;
        if (valued.has(arg)) {
            const next = argv[index + 1];
            if (next === undefined || next === "" || next.startsWith("--")) {
                problems.push(`${arg} needs a value`);
            } else {
                if (arg === "--base") args.base = next;
                if (arg === "--root") args.root = next;
                if (arg === "--report-root") args.reportRoot = next;
                index += 1;
            }
            continue;
        }
        problems.push(`unknown argument: ${arg}`);
    }
    if (args.base !== undefined && args.root !== undefined) {
        problems.push("--base and --root are separate modes; pass one");
    }
    if (args.base === undefined && args.root === undefined && !args.help) {
        problems.push("pass either --base <revision> or --root <campaign-root>");
    }
    if (args.root === undefined && args.reportRoot !== undefined) {
        problems.push("--report-root applies to campaign mode (--root)");
    }
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, args };
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
    if (!parsed.ok) {
        if (argv.includes("--json")) {
            // JSON mode keeps stdout machine-readable, diagnostics included.
            streams.out(
                renderJson({
                    status: "error",
                    errors: parsed.problems.map((message) => ({
                        code: "usage",
                        message: redact(message),
                    })),
                }),
            );
            return 1;
        }
        streams.err(
            redact(parsed.problems.map((problem) => `usage: ${problem}`).join("\n")),
        );
        streams.err(USAGE);
        return 1;
    }
    const { args } = parsed;
    if (args.help) {
        streams.out(USAGE);
        return 0;
    }
    let observed: { result: StatusResult; exit: StatusExit };
    if (args.base !== undefined) {
        observed = observeCheckout(args.base);
    } else if (args.root !== undefined) {
        observed = observeCampaign(args.root, args.reportRoot);
    } else {
        streams.err("usage: pass either --base <revision> or --root <campaign-root>");
        streams.err(USAGE);
        return 1;
    }
    const { result, exit } = observed;
    if (args.json) {
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
    } else if (exit !== 0) {
        for (const problem of result.problems) {
            streams.err(redact(`[${problem.code}] ${problem.message}`));
        }
        streams.err(result.headline);
    } else {
        streams.out(renderText(result, args.detail));
    }
    return exit;
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
