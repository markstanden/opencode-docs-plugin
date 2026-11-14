// Close an offline campaign from its durable evidence, without a model call.
//
// Order matters: the ledger is parsed first, a malformed ledger publishes
// nothing, an already-closed ledger preserves every prior artefact byte, and a
// close lock serialises against dispatches. Accounting is derived from the
// frozen schedule, launch claims, result directories and each attempt's own
// trail. A partial campaign closes at its real scope; human-review packets are
// generated once, and only for observed retrieval opportunities.
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseCampaignLedger, type LedgerParse } from "../runner/ledger.ts";
import {
    readClaims,
    restartDisposition,
    type BudgetClaim,
} from "../runner/budget.ts";
import {
    closeCampaign,
    deriveClosure,
    type JudgeAttempt,
    type SlotObservation,
    type TokenFields,
} from "../runner/closure.ts";
import {
    parseRecoveryPolicy,
    selectionProblems,
    type RecoveryPolicy,
    type SelectionAttempt,
} from "../runner/recovery.ts";
import {
    errorText,
    freezeRecordOf,
    manifestOf,
    readJson as readJsonValue,
    readText,
    recordOf,
    scheduleOf,
    type ScheduleSlot,
} from "./contracts.mts";

const ROOT = process.env.CAMPAIGN_ROOT;
if (!ROOT) throw new Error("CAMPAIGN_ROOT is required");
const EVIDENCE = join(ROOT, "evidence");
const LEDGER = join(EVIDENCE, "ATTEMPTS.jsonl");
const RECONCILIATION = join(EVIDENCE, "RECONCILIATION.json");
const LOCK = join(EVIDENCE, "CLOSING.lock");

const readJson = (path: string): unknown =>
    existsSync(path) ? readJsonValue(path) : null;
const write = (path: string, body: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, path);
};
const ledger = (entry: Record<string, unknown>): void =>
    appendFileSync(
        LEDGER,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );

const caseDir = (slot: {
    arm: string;
    stamp: string;
    scenario: string;
}): string =>
    join(
        ROOT,
        "gen",
        slot.arm.toLowerCase(),
        "results",
        slot.stamp,
        slot.scenario,
    );

/**
 * Sum one JSONL trail's step and per-field token evidence.
 *
 * A malformed line makes the whole trail unreadable: steps and tokens become
 * unknown rather than a plausible zero.
 */
interface Usage {
    steps: number | null;
    tokens: TokenFields | null;
    malformed: boolean;
    /** Why the trail could not be read, when it exists but is unreadable. */
    problem?: string;
}

interface TokenSamples {
    input: (number | null)[];
    output: (number | null)[];
    reasoning: (number | null)[];
    cacheRead: (number | null)[];
}

interface TokenRates {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
}

function usageOf(path: string): Usage {
    if (!existsSync(path))
        return { steps: null, tokens: null, malformed: false };
    let text: string;
    try {
        text = readText(path);
    } catch (error) {
        return {
            steps: null,
            tokens: null,
            malformed: true,
            problem: `unreadable trail ${path}: ${errorText(error)}`,
        };
    }
    if (text.trim() === "") return emptyUsage();
    const parsed = tokensFromTrail(text);
    if (parsed.malformed) {
        return { steps: null, tokens: null, malformed: true };
    }
    return { steps: parsed.steps, tokens: parsed.tokens, malformed: false };
}

/** Zero token fields, for a successful trail with no steps. */
function emptyTokens(): TokenFields {
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
}

/** An empty, successful trail: zero steps and zero tokens. */
function emptyUsage(): Usage {
    return { steps: 0, tokens: emptyTokens(), malformed: false };
}

/** Read one trail's step count and per-field token samples. */
function tokensFromTrail(text: string): {
    steps: number;
    tokens: TokenFields;
    malformed: boolean;
} {
    let steps = 0;
    let malformed = false;
    const fields: TokenSamples = {
        input: [],
        output: [],
        reasoning: [],
        cacheRead: [],
    };
    for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        const event = parseTrailLine(line);
        if (event === undefined) {
            malformed = true;
            continue;
        }
        if (event.type !== "step_finish") continue;
        steps += 1;
        const part = event.part;
        pushTokenSample(
            fields,
            typeof part === "object" && part !== null
                ? (part as Record<string, unknown>).tokens
                : undefined,
        );
    }
    return {
        steps,
        tokens: steps === 0 ? emptyTokens() : summedTokens(fields),
        malformed,
    };
}

/** One token total per field, or null when any observation omitted it. */
function summedTokens(fields: TokenSamples): TokenFields {
    const sum = (values: (number | null)[]): number | null => {
        if (values.length === 0 || values.includes(null)) return null;
        return values.reduce<number>((total, value) => total + (value ?? 0), 0);
    };
    return {
        input: sum(fields.input),
        output: sum(fields.output),
        reasoning: sum(fields.reasoning),
        cacheRead: sum(fields.cacheRead),
    };
}

/** One parsed trail line, or undefined when it is not JSON. */
function parseTrailLine(line: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "object" || value === null) return undefined;
        return value as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

/** Record one step's token fields, keeping a missing field explicit. */
function pushTokenSample(fields: TokenSamples, tokens: unknown): void {
    const value =
        typeof tokens === "object" && tokens !== null
            ? (tokens as Record<string, unknown>)
            : {};
    const cache =
        typeof value.cache === "object" && value.cache !== null
            ? (value.cache as Record<string, unknown>)
            : {};
    fields.input.push(typeof value.input === "number" ? value.input : null);
    fields.output.push(typeof value.output === "number" ? value.output : null);
    fields.reasoning.push(
        typeof value.reasoning === "number" ? value.reasoning : null,
    );
    fields.cacheRead.push(typeof cache.read === "number" ? cache.read : null);
}

type AttemptStatus = JudgeAttempt["status"];

/** One JSON object, or null when the file is absent. */
function objectOrNull(path: string): Record<string, unknown> | null {
    const value = readJson(path);
    return value === null ? null : recordOf(value, path);
}

/** The recorded terminal status, narrowed to the accounting vocabulary. */
function attemptStatus(
    judgement: Record<string, unknown> | null,
    meta: Record<string, unknown> | null,
): AttemptStatus {
    const status = judgement?.status;
    if (
        status === "judged" ||
        status === "invalid-verdict" ||
        status === "judge-error" ||
        status === "started" ||
        status === "unknown"
    )
        return status;
    return startedStatus(meta);
}

/** One judge attempt's evidence, including whether its judgement is usable. */
function judgeAttemptOf(dir: string): JudgeAttempt & { readProblem?: string } {
    const meta = objectOrNull(join(dir, "meta.json"));
    const judgement = objectOrNull(join(dir, "judgement.json"));
    const resolution = objectOrNull(join(dir, "resolution.json"));
    const usage = usageOf(join(dir, "output.jsonl"));
    const usable = isUsableJudgement(judgement, resolution);
    return {
        attemptId: basename(dir),
        spawned: meta !== null || usage.steps !== null,
        reachedInference: (usage.steps ?? 0) > 0,
        steps: usage.steps,
        tokens: usage.tokens,
        status: usable ? "judged" : attemptStatus(judgement, meta),
        durationMs: durationOf(meta),
        ...attemptEvidenceOf(meta, judgement),
        ...(usage.problem === undefined ? {} : { readProblem: usage.problem }),
    };
}

/** One attempt's recorded duration, or null. */
function durationOf(meta: Record<string, unknown> | null): number | null {
    return meta !== null && typeof meta.durationMs === "number"
        ? meta.durationMs
        : null;
}

/** The selection facts one attempt records: packet, class and completion. */
function attemptEvidenceOf(
    meta: Record<string, unknown> | null,
    judgement: Record<string, unknown> | null,
): {
    packetSha256: string | null;
    failureClass: string | null;
    complete: boolean | null;
} {
    const completion =
        meta !== null &&
        typeof meta.completion === "object" &&
        meta.completion !== null
            ? (meta.completion as Record<string, unknown>)
            : null;
    return {
        packetSha256:
            meta !== null && typeof meta.packetSha256 === "string"
                ? meta.packetSha256
                : null,
        failureClass:
            judgement !== null && typeof judgement.failureClass === "string"
                ? judgement.failureClass
                : null,
        complete:
            completion !== null && typeof completion.complete === "boolean"
                ? completion.complete
                : null,
    };
}

/** The journal input fields a human-review packet renders. */
interface JournalInput {
    add?: { mode?: string; path?: string };
    read?: string;
    search?: string;
    check?: string;
}

/** The add declaration of one journal input, when present. */
function addInputOf(value: unknown): JournalInput["add"] {
    if (typeof value !== "object" || value === null) return undefined;
    const add = value as Record<string, unknown>;
    return {
        ...(typeof add.mode === "string" ? { mode: add.mode } : {}),
        ...(typeof add.path === "string" ? { path: add.path } : {}),
    };
}

/** One journal input, validated field by field. */
function journalInputOf(value: unknown): JournalInput {
    if (typeof value !== "object" || value === null) return {};
    const input = value as Record<string, unknown>;
    const add = addInputOf(input.add);
    return {
        ...(add === undefined ? {} : { add }),
        ...(typeof input.read === "string" ? { read: input.read } : {}),
        ...(typeof input.search === "string" ? { search: input.search } : {}),
        ...(typeof input.check === "string" ? { check: input.check } : {}),
    };
}

/** One attributed operation, rendered for a human-review packet. */
function operationSummary(entry: Record<string, unknown>): string {
    const input = journalInputOf(entry.input);
    const target = input.read ?? input.add?.path ?? "";
    const verb = operationVerb(input, target);
    return `- ${String(entry.surface ?? "native")} — ${String(entry.status ?? "unknown")} — ${verb}`;
}

/** The human-readable verb of one journal input. */
function operationVerb(input: JournalInput, target: string): string {
    if (input.add) return `${input.add.mode ?? "write"} ${target}`;
    if (input.read) return `read ${target}`;
    if (input.search) return `search "${input.search}"`;
    return input.check ? "check" : "help";
}

/** Whether a judgement or its resolution is usable. */
function isUsableJudgement(
    judgement: Record<string, unknown> | null,
    resolution: Record<string, unknown> | null,
): boolean {
    return judgement?.status === "judged" || resolution?.status === "judged";
}

/** The status an attempt without a judgement reports. */
function startedStatus(meta: Record<string, unknown> | null): AttemptStatus {
    return meta?.status === "started" ? "started" : "unknown";
}

/** Whether one slot has a usable judge attempt. */
const hasUsableJudgement = (slot: SlotObservation): boolean =>
    slot.judgeAttempts.some((attempt) => attempt.status === "judged");

/** Pairs whose two recorded slots both carry a usable judgement. */
function completedPairsOf(observations: SlotObservation[]): number {
    const byPair = new Map<string, SlotObservation[]>();
    for (const slot of observations) {
        if (slot.pairId === null) continue;
        const entry = byPair.get(slot.pairId) ?? [];
        entry.push(slot);
        byPair.set(slot.pairId, entry);
    }
    let complete = 0;
    for (const slots of byPair.values()) {
        if (
            slots.length === 2 &&
            slots.every((slot) => slot.recorded && hasUsableJudgement(slot))
        ) {
            complete += 1;
        }
    }
    return complete;
}

/**
 * A catalogue estimate, or null when any subtotal is unknown. An unknown is
 * never coerced to zero.
 */
function estimate(tokens: TokenFields, rates: TokenRates): number | null {
    const fields = ["input", "output", "reasoning", "cacheRead"] as const;
    if (fields.some((field) => tokens[field] === null)) return null;
    return fields.reduce(
        (total, field) =>
            total + ((tokens[field] ?? 0) / 1_000_000) * rates[field],
        0,
    );
}

const ledgerParse = ((): LedgerParse => {
    try {
        return parseCampaignLedger(
            existsSync(LEDGER) ? readText(LEDGER) : undefined,
        );
    } catch (error) {
        return {
            state: "malformed",
            events: [],
            problems: [`ledger is unreadable: ${errorText(error)}`],
            closedAt: null,
        };
    }
})();
if (ledgerParse.state === "malformed") {
    console.error(
        `ledger is malformed; nothing is published: ${ledgerParse.problems.join("; ")}`,
    );
    process.exit(1);
}
if (ledgerParse.state === "closed") {
    const prior = readText(RECONCILIATION);
    if (prior !== "") {
        process.stdout.write(prior);
    } else {
        console.log(JSON.stringify({ state: "closed", reconciliation: null }));
    }
    process.exit(0);
}

interface RetrievalDeclaration {
    lake: string;
    note: string;
    detail: string;
}

interface MeasurementSpec {
    retrievalOpportunities: string[];
    scenarios: Record<string, { retrieval?: RetrievalDeclaration }>;
}

/** One scenario's retrieval declaration, when present. */
function retrievalOf(
    value: unknown,
    label: string,
): RetrievalDeclaration | undefined {
    if (value === undefined) return undefined;
    const retrieval = recordOf(value, label);
    if (
        typeof retrieval.lake !== "string" ||
        typeof retrieval.note !== "string" ||
        typeof retrieval.detail !== "string"
    ) {
        throw new Error(`${label} needs lake, note and detail`);
    }
    return {
        lake: retrieval.lake,
        note: retrieval.note,
        detail: retrieval.detail,
    };
}

/** The measurement declaration, validated for the fields closure renders. */
function measurementOf(path: string): MeasurementSpec {
    const value = recordOf(readJsonValue(path), path);
    const opportunities = value.retrievalOpportunities;
    if (
        !Array.isArray(opportunities) ||
        opportunities.some((entry) => typeof entry !== "string")
    ) {
        throw new Error(`${path}.retrievalOpportunities must be strings`);
    }
    const scenarios = recordOf(value.scenarios ?? {}, `${path}.scenarios`);
    const declared: Record<string, { retrieval?: RetrievalDeclaration }> = {};
    for (const [id, entry] of Object.entries(scenarios)) {
        const scenario = recordOf(entry, `${path}.scenarios.${id}`);
        const retrieval = retrievalOf(
            scenario.retrieval,
            `${path}.scenarios.${id}.retrieval`,
        );
        declared[id] = retrieval === undefined ? {} : { retrieval };
    }
    return {
        retrievalOpportunities: opportunities as string[],
        scenarios: declared,
    };
}

const schedule = scheduleOf(join(EVIDENCE, "schedule.json"));
const measurement = measurementOf(join(EVIDENCE, "measurement-spec.json"));
const slots = schedule.slots;
const frozenValue = readJson(join(EVIDENCE, "FROZEN.json"));
const frozen = freezeRecordOf(
    frozenValue === null ? null : recordOf(frozenValue, "FROZEN.json").freeze,
);
const manifest = manifestOf(join(ROOT, "prepare/manifest.json"));
const recoveryPolicy: RecoveryPolicy | null = (() => {
    const declared = manifest?.assessment?.recovery;
    if (declared === undefined) return null;
    const parsed = parseRecoveryPolicy(declared);
    if (!parsed.ok) {
        console.error(
            `registered recovery policy is invalid: ${parsed.problems.join("; ")}`,
        );
        process.exit(1);
    }
    return parsed.policy;
})();
// The registered policy's total is the authoritative judge-attempt ceiling;
// the freeze record keeps the historical initial budget.
const judgeCeiling =
    recoveryPolicy === null
        ? (frozen?.ceilings.judge ?? 0)
        : recoveryPolicy.totalJudgeAttempts;

/** Every recorded attempt for one slot, collecting unreadable trails. */
function attemptsOfSlot(acDir: string, readProblems: string[]): JudgeAttempt[] {
    if (!existsSync(acDir)) return [];
    return readdirSync(acDir)
        .filter((name) => /^attempt-\d{3}$/.test(name))
        .sort()
        .map((name) => {
            const attempt = judgeAttemptOf(join(acDir, name));
            if (attempt.readProblem !== undefined) {
                readProblems.push(attempt.readProblem);
            }
            return attempt;
        });
}

/** The published selection for one slot, checked against its attempts. */
function selectedAttemptOf(
    slot: ScheduleSlot,
    attempts: readonly JudgeAttempt[],
    readProblems: string[],
): string | null {
    const selection = objectOrNull(join(caseDir(slot), "ac", "selection.json"));
    if (selection === null) return null;
    for (const problem of selectionProblemTexts(selection, slot, attempts)) {
        readProblems.push(`${slot.stamp}: ${problem}`);
    }
    return typeof selection.selectedAttemptId === "string"
        ? selection.selectedAttemptId
        : null;
}

/** The checked-evidence problems one recorded selection carries. */
function selectionProblemTexts(
    selection: Record<string, unknown>,
    slot: ScheduleSlot,
    attempts: readonly JudgeAttempt[],
): string[] {
    return selectionProblems(selection, {
        slot: slot.slot,
        pairId: slot.pairId ?? "",
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        attemptIds: attempts.map((attempt) => attempt.attemptId),
        manifestAttemptId: manifest?.assessment?.attemptId ?? null,
        policy: recoveryPolicy,
        attemptFacts: attemptFactsOf(attempts),
    });
}

/** The selection facts each recorded attempt carries. */
function attemptFactsOf(
    attempts: readonly JudgeAttempt[],
): Record<string, SelectionAttempt> {
    const facts: Record<string, SelectionAttempt> = {};
    for (const attempt of attempts) {
        facts[attempt.attemptId] = {
            attemptId: attempt.attemptId,
            judgementStatus: attempt.status,
            packetSha256: attempt.packetSha256 ?? null,
            failureClass: attempt.failureClass ?? null,
            complete: attempt.complete ?? null,
        };
    }
    return facts;
}

/** One slot's observation, derived from its durable evidence. */
function observationOf(
    slot: ScheduleSlot,
    trialClaims: readonly BudgetClaim[],
    readProblems: string[],
): SlotObservation {
    const dir = caseDir(slot);
    const attempts = attemptsOfSlot(join(dir, "ac"), readProblems);
    const selectedAttemptId = selectedAttemptOf(slot, attempts, readProblems);
    const meta = objectOrNull(join(dir, "meta.json"));
    const timings =
        meta !== null &&
        typeof meta.timings === "object" &&
        meta.timings !== null
            ? (meta.timings as Record<string, unknown>)
            : {};
    const usage = usageOf(join(dir, "stdout.jsonl"));
    if (usage.problem !== undefined) readProblems.push(usage.problem);
    return {
        slot: slot.slot,
        pairId: slot.pairId ?? null,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        launched: launchedOf(slot, dir, trialClaims),
        recorded: meta !== null,
        trialSteps: usage.steps,
        trialTokens: usage.tokens,
        trialDurationMs:
            typeof timings.totalMs === "number" ? timings.totalMs : null,
        judgeAttempts: attempts,
        selectedAttemptId,
    };
}

/** Whether one slot's trial reached a launch, from any durable source. */
function launchedOf(
    slot: ScheduleSlot,
    dir: string,
    trialClaims: readonly BudgetClaim[],
): boolean {
    return (
        existsSync(dir) ||
        trialClaims.some(
            (claim) => claim.stamp === slot.stamp && claim.state !== "reserved",
        ) ||
        ledgerParse.events.some(
            (event) => event.event === "launch" && event.stamp === slot.stamp,
        )
    );
}

let lockHeld = false;
try {
    writeFileSync(LOCK, `${String(process.pid)}\n`, {
        encoding: "utf8",
        flag: "wx",
    });
    lockHeld = true;
} catch {
    console.error(
        "a campaign close is already in progress (or was interrupted); inspect evidence/CLOSING.lock before retrying",
    );
    process.exit(1);
}

try {
    const trialClaims = readClaims(EVIDENCE, "trial");
    const judgeClaims = readClaims(EVIDENCE, "judge");
    const unresolved = [...trialClaims, ...judgeClaims].filter(
        (claim) => restartDisposition(claim) !== null,
    );
    if (unresolved.length > 0) {
        console.error(
            `${String(unresolved.length)} reservation(s) never closed; a campaign with unknown spend cannot close`,
        );
        process.exit(1);
    }

    const readProblems: string[] = [];
    const observations: SlotObservation[] = slots.map((slot) =>
        observationOf(slot, trialClaims, readProblems),
    );

    const report = deriveClosure({
        scheduledSlots: slots.length,
        observations,
        trialClaims,
        judgeClaims,
        ceilings: {
            trial: frozen?.ceilings.trial ?? 0,
            judge: judgeCeiling,
        },
        closed: false,
    });

    const observed = observations.filter(
        (slot) =>
            slot.launched || slot.recorded || slot.judgeAttempts.length > 0,
    );
    const decision = closeCampaign(report);
    if (!decision.ok) {
        console.error(decision.problems.join("\n"));
        process.exit(1);
    }

    const trialEstimate = estimate(report.trial.tokens, {
        input: 0.15,
        output: 0.6,
        reasoning: 0.6,
        cacheRead: 0.003,
    });
    const judgeEstimate = estimate(report.judge.tokens, {
        input: 0.0334,
        output: 0.1163,
        reasoning: 0.1163,
        cacheRead: 0.0081,
    });

    const reconciliation = {
        at: new Date().toISOString(),
        campaign: schedule.campaign,
        closedAt: report.stoppedAt,
        scheduledSlots: report.scheduledSlots,
        observedSlots: report.observedSlots,
        completedPairs: completedPairsOf(observations),
        trialLaunches: report.trialLaunches,
        trial: {
            attempts: report.trial.attempts,
            reachedInference: report.trial.inferred,
            steps: report.trial.steps,
            tokens: report.trial.tokens,
            tokenCoverage: report.trial.tokenCoverage,
            durationMs: report.trial.durationMs,
        },
        judge: {
            attempts: report.judge.attempts,
            initialAttempts: report.judge.initialAttempts,
            recoveryAttempts: report.judge.recoveryAttempts,
            reachedInference: report.judge.inferred,
            usableJudgements: report.judge.usableJudgements,
            unusableJudgements: report.judge.unusableJudgements,
            steps: report.judge.steps,
            tokens: report.judge.tokens,
            tokenCoverage: report.judge.tokenCoverage,
            durationMs: report.judge.durationMs,
        },
        selectedAttempts: observations
            .filter((slot) => slot.selectedAttemptId !== null)
            .map((slot) => ({
                slot: slot.slot,
                stamp: slot.stamp,
                selectedAttemptId: slot.selectedAttemptId,
            })),
        budgets: {
            trialCeiling: frozen?.ceilings.trial ?? 0,
            judgeCeiling,
            recoveryCeiling: recoveryPolicy?.recoveryCeiling ?? null,
            recoveryUsed: readClaims(EVIDENCE, "recovery").length,
            judgeUsed: report.judge.attempts,
        },
        stopReason: (() => {
            const lastBlocked = readText(LEDGER)
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as Record<string, unknown>)
                .filter(
                    (event) =>
                        event.event === "slot-blocked" ||
                        event.event === "recovery-blocked",
                )
                .at(-1);
            return typeof lastBlocked?.reason === "string"
                ? lastBlocked.reason
                : null;
        })(),
        unrunSlots: observations
            .filter((slot) => !observed.includes(slot))
            .map((slot) => ({
                slot: slot.slot,
                pairId: slot.pairId,
                stamp: slot.stamp,
                scenario: slot.scenario,
                arm: slot.arm,
            })),
        problems: [...report.problems, ...readProblems],
        billing: {
            currency: "USD",
            trial: {
                model: "opencode-go/deepseek-v4.1-flash",
                basis: "catalogue rates 0.15 input / 0.60 output per Mtok, 0.003 cache-read",
                estimated:
                    trialEstimate === null
                        ? null
                        : Number(trialEstimate.toFixed(4)),
                kind: "catalogue estimate from recorded tokens; no invoice",
            },
            judge: {
                model: "zai-coding-plan/glm-5.3-flash",
                basis: "coding-plan subscription; catalogue rates shown for scale only",
                estimated:
                    judgeEstimate === null
                        ? null
                        : Number(judgeEstimate.toFixed(4)),
                kind: "plan credits, not a separate invoice",
            },
            actualInvoice: "unknown/not available",
        },
    };

    // Publish only after the close decision succeeded.
    write(RECONCILIATION, `${JSON.stringify(reconciliation, null, 2)}\n`);
    ledger({ ...decision.event, reason: "derived from durable evidence" });
    for (const slot of reconciliation.unrunSlots) {
        ledger({
            event: "slot-unrun",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            scenario: slot.scenario,
            arm: slot.arm,
            reason: "campaign closed before launch",
        });
    }

    const packetDir = join(EVIDENCE, "human-review/packets");
    if (!existsSync(packetDir)) {
        const affected = observed.filter((slot) =>
            (measurement.retrievalOpportunities ?? []).includes(slot.scenario),
        );
        const mulberry32 = (seed: number): (() => number) => {
            let state = seed >>> 0;
            return () => {
                state = (state + 0x6d2b79f5) >>> 0;
                let t = state;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        };
        const random = mulberry32(20261111);
        const shuffled = [...affected];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const swap = Math.floor(random() * (index + 1));
            const current = shuffled[index];
            const target = shuffled[swap];
            if (current === undefined || target === undefined) continue;
            shuffled[index] = target;
            shuffled[swap] = current;
        }
        const map = shuffled.map((slot, index) => ({
            packet: `HR-${String(index + 1).padStart(2, "0")}`,
            stamp: slot.stamp,
            scenario: slot.scenario,
            arm: slot.arm,
        }));
        const operationsOf = (slot: SlotObservation): string[] =>
            readText(join(caseDir(slot), "docs-operations.jsonl"))
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) =>
                    operationSummary(
                        recordOf(JSON.parse(line), "docs operation"),
                    ),
                );
        for (const entry of map) {
            const slot = affected.find((one) => one.stamp === entry.stamp);
            const declaration =
                slot === undefined
                    ? undefined
                    : measurement.scenarios[slot.scenario]?.retrieval;
            if (slot === undefined || declaration === undefined) continue;
            const dir = caseDir(slot);
            const body = `# Human review packet ${entry.packet}

This packet is arm-blind. Assess only the evidence below.

## Task

${readText(join(dir, "prompt.md"))}

## Retrieval criterion

Target note: \`${declaration.lake}/${declaration.note}\`

Seeded detail: ${declaration.detail}

## Attributed docs operations

${operationsOf(slot).join("\n") || "- (none)"}

## Final answer

\`\`\`
${readText(join(dir, "final.md")).trim()}
\`\`\`
`;
            write(join(packetDir, `${entry.packet}.md`), body);
        }
        write(
            join(EVIDENCE, "human-review/MAPPING.json"),
            `${JSON.stringify(
                {
                    note: "Open only after every packet has been assessed.",
                    seed: 20261111,
                    packets: map,
                },
                null,
                2,
            )}\n`,
        );
        ledger({
            event: "human-review-packets",
            packets: map.length,
            seed: 20261111,
        });
    }

    console.log(JSON.stringify(reconciliation, null, 2));
} finally {
    if (lockHeld) rmSync(LOCK, { force: true });
}
