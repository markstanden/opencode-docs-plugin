// Paired productivity-screen runner for the 0.14.0 description comparison.
//
// Safety properties:
// - The schedule and frozen identities must exist before any launch.
// - A launch record is written before the model session starts. It is never
//   overwritten, so a resume cannot relaunch an attempt whose model call may
//   have begun.
// - An existing result directory without meta.json is a started attempt, not
//   a blank slot; it blocks and is reported.
// - The judge runs only for a recorded, usable trial, and ac/run.mts claims
//   its attempt directory before spawning the judge model.
// - Gate and judge run from the independent measurement worktree.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    accessSync,
    appendFileSync,
    constants,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { credentialFileProblem, loadJudgeKey } from "./env.mts";
import {
    errorText,
    filesUnder,
    freezeRecordOf,
    manifestOf,
    readText,
    recordOf,
    scheduleOf,
    type ScheduleSlot,
} from "./contracts.mts";
import { parseCampaignLedger, type LedgerParse } from "../runner/ledger.ts";
import {
    advanceClaim,
    claimBudget,
    readClaims,
    releaseClaim,
    restartDisposition,
    type BudgetClaim,
} from "../runner/budget.ts";
import { resolveAttemptSelection } from "../runner/selector.ts";
import {
    claimRecoveryBudget,
    parseRecoveryPolicy,
    recoveryDecision,
    recoveryPolicySha256,
    selectionProblems,
    selectionRecordOf,
    type RecoveryPolicy,
    type SelectionAttempt,
} from "../runner/recovery.ts";
import { spendFreezeProblem, verifyFreeze } from "../runner/freeze.ts";

const ROOT = process.env.CAMPAIGN_ROOT;
if (!ROOT) throw new Error("CAMPAIGN_ROOT is required");
const MAIN = process.env.CAMPAIGN_SOURCE_REPO ?? process.cwd();
const MODEL = "opencode-go/deepseek-v4.1-flash";
const JUDGE = "zai-coding-plan/glm-5.3-flash";
const TRIAL_TIMEOUT = 600000;
const JUDGE_TIMEOUT = 600000;
const SHIM = join(ROOT, "prepare/shim");
const EVIDENCE = join(ROOT, "evidence");
const LEDGER = join(EVIDENCE, "ATTEMPTS.jsonl");
const LAUNCHES = join(EVIDENCE, "launches");
const TRIAL_LOGS = join(ROOT, "logs/trials");
const CONTAINER_LOGS = join(ROOT, "logs/containers");
const MEASUREMENT = join(ROOT, "measurement");

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const dryRun = argv.includes("--dry-run");
const trialCommand = flag("--trial-command");
const pairFrom = Number(flag("--pair-from") ?? 1);
const pairTo = Number(flag("--pair-to") ?? 8);

const fail = (message: string): never => {
    console.error(`BLOCKER: ${message}`);
    process.exit(2);
};

// Refuse an unsafe credential file before its value is loaded.
const keyProblem = credentialFileProblem(ROOT);
if (keyProblem !== null) fail(keyProblem);
const judgeKeySource = loadJudgeKey(ROOT);

const readJson = (path: string): unknown =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;

/** Write JSON with a trailing newline. */
const writeJson = (path: string, value: unknown): void =>
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

/** A plain JSON object, or null when the value is not one. */
const plainRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

/** The parsed ledger: absence is a state, never an empty trusted ledger. */
const ledgerParse = (): LedgerParse => {
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
};

/** Why spend is refused now, or null when a clean open ledger permits it. */
const spendRefusal = (): string | null => {
    const parsed = ledgerParse();
    if (parsed.state === "malformed") {
        return `attempt ledger is malformed: ${parsed.problems.join("; ")}`;
    }
    if (parsed.state === "closed") {
        return "campaign is closed; no launch event or child process is permitted";
    }
    if (existsSync(join(EVIDENCE, "CLOSING.lock"))) {
        return "a campaign close is in progress; no dispatch may start";
    }
    return null;
};

/** Whether the container logging shim can actually be executed. */
const shimExecutable = (): boolean => {
    try {
        accessSync(join(SHIM, "podman"), constants.X_OK);
        return true;
    } catch {
        return false;
    }
};
const ledger = (entry: Record<string, unknown>): void => {
    appendFileSync(
        LEDGER,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
        "utf8",
    );
};

const schedule = scheduleOf(join(EVIDENCE, "schedule.json"));
const slots = schedule.slots;

const manifest = manifestOf(join(ROOT, "prepare/manifest.json"));
const selection = resolveAttemptSelection({
    manifestAttemptId: manifest?.assessment?.attemptId ?? null,
    overrideAttemptId: flag("--attempt-id") ?? null,
});
if (!selection.ok) {
    console.error(`BLOCKER: ${selection.problems.join("; ")}`);
    process.exit(2);
}
const attemptId = selection.selection.attemptId;

// The registered recovery policy is opt-in: with no declaration the campaign
// keeps its historical behaviour, stopping on the first unusable assessment.
const recoveryPolicy: RecoveryPolicy | null = (() => {
    const declared = manifest?.assessment?.recovery;
    if (declared === undefined) return null;
    const parsed = parseRecoveryPolicy(declared);
    if (!parsed.ok) {
        console.error(
            `BLOCKER: registered recovery policy is invalid: ${parsed.problems.join("; ")}`,
        );
        process.exit(2);
    }
    return parsed.policy;
})();

const frozenValue = readJson(join(EVIDENCE, "FROZEN.json"));
const freezeRecord = freezeRecordOf(
    frozenValue === null ? null : recordOf(frozenValue, "FROZEN.json").freeze,
);
// One authoritative trial ceiling from the validated freeze record. The judge
// ceiling is the registered policy's explicit total when one is declared: the
// policy is part of the frozen manifest premise, and its total includes the
// recoveries, so initial assessments and recoveries share one bound.
const ceilings = {
    trial: freezeRecord?.ceilings.trial ?? 0,
    judge:
        recoveryPolicy === null
            ? (freezeRecord?.ceilings.judge ?? 0)
            : recoveryPolicy.totalJudgeAttempts,
};

/** Capture one external command's trimmed output, or an empty string. */
const capture = (command: string, args: string[]): string => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    return result.status === 0 ? String(result.stdout ?? "").trim() : "";
};

/**
 * Verify the frozen premise against what this invocation would actually use:
 * every immutable input, the source revision, the image identity and the
 * container CLI. A historical freeze without a record returns no problems.
 */
const premiseProblems = (): string[] => {
    const record = freezeRecord;
    if (record === null) return ["no freeze record"];
    const unusable = spendFreezeProblem(record);
    if (unusable !== null) return [unusable];
    const files = record.files.map((file) => {
        const path = join(ROOT, file.path);
        return {
            path: file.path,
            sha256: existsSync(path)
                ? createHash("sha256").update(readFileSync(path)).digest("hex")
                : "missing",
        };
    });
    const inventories = record.inventories.map((inventory) => ({
        path: inventory.path,
        files: filesUnder(join(ROOT, inventory.path)).map((path) => ({
            path: path.slice(ROOT.length + 1),
            sha256: createHash("sha256")
                .update(readFileSync(path))
                .digest("hex"),
        })),
    }));
    return verifyFreeze(record, {
        files,
        inventories,
        imageId: capture("podman", [
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            record.imageId,
        ]),
        containerCli: capture("podman", ["--version"]),
        sourceRevision: safeHead(MAIN),
    });
};

const armPaths = (arm: string) => {
    const letter = arm.toLowerCase();
    return {
        repo: join(ROOT, "arms", letter),
        base: join(ROOT, "gen", letter),
        cases: join(
            ROOT,
            "arms",
            letter,
            "tests/fixtures/placement-harness/prod014/cases.json",
        ),
    };
};

const resultDir = (slot: ScheduleSlot) => {
    const { base } = armPaths(slot.arm);
    return join(base, "results", slot.stamp, slot.scenario);
};

const truthPath = join(
    ROOT,
    "arms/a/tests/fixtures/placement-harness/prod014/truth.json",
);
const specPath = join(EVIDENCE, "measurement-spec.json");

interface Attempt {
    attemptId: string;
}

const attemptsOf = (stamp: string): Attempt[] => {
    const dir = join(LAUNCHES, stamp);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => /^attempt-\d{3}\.json$/.test(name))
        .sort()
        .map((name) => ({
            attemptId: name.replace(/\.json$/, ""),
        }));
};

const newAttempt = (
    slot: ScheduleSlot,
    status: string,
    extra: Record<string, unknown> = {},
): { attemptId: string } & Record<string, unknown> => {
    const dir = join(LAUNCHES, slot.stamp);
    mkdirSync(dir, { recursive: true });
    const previous = attemptsOf(slot.stamp);
    const attemptId = `attempt-${String(previous.length + 1).padStart(3, "0")}`;
    const record = {
        campaign: schedule.campaign,
        attemptId,
        slot: slot.slot,
        pairId: slot.pairId,
        repetition: slot.repetition,
        scenario: slot.scenario,
        arm: slot.arm,
        stamp: slot.stamp,
        status,
        launchedAt: new Date().toISOString(),
        ...extra,
    };
    writeFileSync(
        join(dir, `${attemptId}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
    );
    return record;
};

const updateAttempt = (
    slot: ScheduleSlot,
    attemptId: string,
    patch: Record<string, unknown>,
) => {
    const path = join(LAUNCHES, slot.stamp, `${attemptId}.json`);
    const current = recordOf(readJson(path), path);
    writeFileSync(
        path,
        `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`,
        "utf8",
    );
};

const containerRunObserved = (logPath: string): boolean =>
    /^\S+ run(?:\s|$)/m.test(readText(logPath));

const usableRun = (meta: unknown): boolean => {
    if (typeof meta !== "object" || meta === null) return false;
    const value = meta as Record<string, unknown>;
    return (
        value.exit === 0 &&
        value.signal === null &&
        value.timedOut !== true &&
        value.outputOverflow !== true &&
        value.answerValid === true
    );
};

const hasJudgement = (attemptDir: string): boolean => {
    const judgement = readJson(join(attemptDir, "judgement.json"));
    if (
        typeof judgement === "object" &&
        judgement !== null &&
        (judgement as Record<string, unknown>).status === "judged"
    )
        return true;
    const resolution = readJson(join(attemptDir, "resolution.json"));
    return (
        typeof resolution === "object" &&
        resolution !== null &&
        (resolution as Record<string, unknown>).status === "judged"
    );
};

const safeHead = (repo: string): string => {
    const result = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
        encoding: "utf8",
    });
    return result.status === 0 ? result.stdout.trim() : "";
};

const envFor = (slot: ScheduleSlot) => {
    const { repo, base, cases } = armPaths(slot.arm);
    return {
        ...process.env,
        PATH: `${SHIM}:${process.env.PATH ?? ""}`,
        CONTAINER_LOG: join(CONTAINER_LOGS, `${slot.stamp}.log`),
        PLACEMENT_TRIAL_IMAGE_ID: freezeRecord?.imageId ?? "",
        PLACEMENT_CASES: cases,
        PLACEMENT_PROMPTS: join(base, "prompts"),
        PLACEMENT_FIXTURES: join(base, "fixtures"),
        PLACEMENT_RUBRICS: join(base, "rubrics"),
        PLACEMENT_RESULTS: join(base, "results"),
        PLACEMENT_RUN_FIXTURES: join(base, "run-fixtures"),
        PLACEMENT_PLUGIN_COMMIT: safeHead(repo),
        TRIAL_TIMEOUT_MS: String(TRIAL_TIMEOUT),
    };
};

const premiseBlock = (slot: ScheduleSlot, boundary: string) => {
    const problems = premiseProblems();
    if (problems.length === 0) return false;
    ledger({
        event: "slot-blocked",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        reason: `frozen premise changed at ${boundary}: ${problems.join("; ")}`,
    });
    console.error(
        `BLOCKER: ${slot.stamp} frozen premise changed at ${boundary}: ${problems.join("; ")}`,
    );
    return true;
};

/** Pair-level schedule defects. */
const pairProblems = () => {
    const problems = [];
    for (let index = 0; index < slots.length; index += 2) {
        const first = slots[index];
        const second = slots[index + 1];
        if (first === undefined || second === undefined) {
            problems.push(`unpaired slot at index ${index}`);
            continue;
        }
        if (first.pairId !== second.pairId) {
            problems.push(`pair split at ${first.slot}/${second.slot}`);
        }
        if (first.arm === second.arm) {
            problems.push(`pair ${first.pairId} repeats arm ${first.arm}`);
        }
        if (first.scenario !== second.scenario) {
            problems.push(`pair ${first.pairId} mixes scenarios`);
        }
    }
    return problems;
};

/** One slot's missing inputs and stale launch state. */
const slotProblems = (slot: ScheduleSlot) => {
    const problems = [];
    const { repo, base, cases } = armPaths(slot.arm);
    const inputs: Array<[string, string]> = [
        ["arm repo", join(repo, "src/index.ts")],
        ["lockfile", join(repo, "package-lock.json")],
        [
            "container runner",
            join(repo, "tests/fixtures/placement-harness/container-run.sh"),
        ],
        [
            "judge launcher",
            join(
                MEASUREMENT,
                "tests/fixtures/placement-harness/ac/judge-launcher.sh",
            ),
        ],
        ["corpus", cases],
        [
            "generated fixture",
            join(base, "fixtures", slot.scenario, "generation.json"),
        ],
        ["prompt", join(base, "prompts", `${slot.scenario}.md`)],
        ["rubric", join(base, "rubrics", slot.scenario)],
    ];
    for (const [label, path] of inputs) {
        if (!existsSync(path)) {
            problems.push(`${slot.stamp}: missing ${label} (${path})`);
        }
    }
    if (attemptsOf(slot.stamp).length > 0) {
        problems.push(`${slot.stamp}: launch records already exist`);
    }
    if (existsSync(join(base, "results", slot.stamp))) {
        problems.push(`${slot.stamp}: result directory already exists`);
    }
    return problems;
};

/**
 * The judge launch environment: the same envelope plus the immutable image,
 * which only the judge launcher consumes. The trial wrapper identifies its
 * container with PLACEMENT_TRIAL_IMAGE_ID, so the host describe step is never
 * misclassified as an in-container run.
 */
const judgeEnv = (slot: ScheduleSlot) => ({
    ...envFor(slot),
    PLACEMENT_IMAGE: freezeRecord?.imageId ?? "",
});

const dry = () => {
    const problems = [];
    if (slots.length !== 16)
        problems.push(`expected 16 slots, ${slots.length}`);
    problems.push(...pairProblems());
    const stamps = new Set();
    for (const slot of slots) {
        if (stamps.has(slot.stamp))
            problems.push(`duplicate stamp ${slot.stamp}`);
        stamps.add(slot.stamp);
        problems.push(...slotProblems(slot));
    }
    for (const path of [
        join(EVIDENCE, "frozen-identities.json"),
        join(EVIDENCE, "schedule.json"),
        specPath,
        truthPath,
        join(SHIM, "podman"),
    ]) {
        if (!existsSync(path)) problems.push(`missing ${path}`);
    }
    if (!shimExecutable()) {
        problems.push(
            `container logging shim is not executable: ${join(SHIM, "podman")}`,
        );
    }
    if (!existsSync(join(EVIDENCE, "FROZEN.json"))) {
        problems.push("missing evidence/FROZEN.json");
    }
    console.log(
        slots
            .map(
                (slot: ScheduleSlot) =>
                    `slot ${String(slot.slot).padStart(2)} ${slot.pairId} ${slot.scenario} ${slot.arm} ${slot.stamp}`,
            )
            .join("\n"),
    );
    if (problems.length > 0) {
        console.error(problems.join("\n"));
        process.exit(1);
    }
    console.log(
        `\ndry run: ${slots.length} slots, 8 adjacent pairs, no model session`,
    );
};

const runTrial = (slot: ScheduleSlot, attempt: Attempt) => {
    const dir = resultDir(slot);
    const containerLog = join(CONTAINER_LOGS, `${slot.stamp}.log`);
    mkdirSync(TRIAL_LOGS, { recursive: true });
    mkdirSync(CONTAINER_LOGS, { recursive: true });
    writeFileSync(containerLog, "", "utf8");
    const command =
        trialCommand ??
        join(
            ROOT,
            "arms",
            slot.arm.toLowerCase(),
            "tests/fixtures/placement-harness/container-run.sh",
        );
    const started = new Date().toISOString();
    ledger({
        event: "launch",
        attemptId: attempt.attemptId,
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        command,
        // Arm provenance stays with the outer harness; the trial child no
        // longer receives the arm-specific commit or dirty flag.
        pluginCommit: safeHead(armPaths(slot.arm).repo),
    });
    const result = spawnSync(
        command,
        [
            "run",
            slot.scenario,
            "--stamp",
            slot.stamp,
            "--model",
            MODEL,
            "--print-logs",
        ],
        {
            env: envFor(slot),
            encoding: "utf8",
            timeout: TRIAL_TIMEOUT + 120000,
            maxBuffer: 64 * 1024 * 1024,
            shell: trialCommand !== undefined && trialCommand.endsWith(".sh"),
        },
    );
    const finished = new Date().toISOString();
    writeFileSync(
        join(TRIAL_LOGS, `${slot.stamp}.log`),
        `# stdout\n${result.stdout ?? ""}\n# stderr\n${result.stderr ?? ""}\n`,
        "utf8",
    );
    const metaValue = readJson(join(dir, "meta.json"));
    const meta =
        metaValue === null ? null : recordOf(metaValue, join(dir, "meta.json"));
    const containerRun = containerRunObserved(containerLog);
    const usable = usableRun(meta);
    const startedAttempt = meta !== null || existsSync(dir);
    updateAttempt(slot, attempt.attemptId, {
        status:
            meta !== null
                ? "recorded"
                : startedAttempt
                  ? "attempted-unknown"
                  : "pre-model-failure",
        exit: result.status,
        signal: result.signal,
        timedOut:
            (result.error as NodeJS.ErrnoException | undefined)?.code ===
            "ETIMEDOUT",
        startedAt: started,
        finishedAt: finished,
        containerRun,
        resultDir: dir,
        resultRecorded: meta !== null,
        usable,
    });
    ledger({
        event: "trial-exit",
        attemptId: attempt.attemptId,
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        exit: result.status,
        signal: result.signal,
        startedAt: started,
        finishedAt: finished,
        containerRun,
        resultRecorded: meta !== null,
        usable,
    });
    return {
        meta,
        containerRun,
        usable,
        exit: result.status,
        signal: result.signal,
    };
};

const runGate = (slot: ScheduleSlot) => {
    const { base, cases } = armPaths(slot.arm);
    const result = spawnSync(
        process.execPath,
        [
            join(MEASUREMENT, "tests/fixtures/placement-harness/ac/run.mts"),
            "gate",
            "--repo",
            MEASUREMENT,
            "--base",
            base,
            "--cases",
            cases,
            "--stamps",
            slot.stamp,
        ],
        { env: envFor(slot), encoding: "utf8", timeout: 300000 },
    );
    const gateValue = readJson(join(resultDir(slot), "gate.json"));
    const gate =
        gateValue === null
            ? null
            : recordOf(gateValue, join(resultDir(slot), "gate.json"));
    ledger({
        event: "gate",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        exit: result.status,
        status: gate?.status ?? "missing",
        reason: gate?.reason ?? null,
    });
    return gate;
};

/** Record a skipped judge and return true, or false when a call is needed. */
const judgeSkip = (slot: ScheduleSlot, attemptDir: string) => {
    if (!hasJudgement(attemptDir)) return false;
    ledger({
        event: "judge-skipped-existing",
        slot: slot.slot,
        stamp: slot.stamp,
        arm: slot.arm,
        attemptDir,
    });
    return true;
};

/** Claim the judge dispatch, or report why it is blocked. */
const judgeClaimOf = (slot: ScheduleSlot) => {
    const unsettled = readClaims(EVIDENCE, "judge").find(
        (claim) =>
            claim.stamp === slot.stamp && restartDisposition(claim) !== null,
    );
    if (unsettled !== undefined) {
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            stamp: slot.stamp,
            arm: slot.arm,
            reason: "unsettled judge claim from an interrupted invocation",
        });
        console.error(
            `BLOCKER: ${slot.stamp} has an unsettled judge claim; preserve and report`,
        );
        return { blocked: true };
    }
    if (premiseBlock(slot, "judge dispatch")) return { blocked: true };
    const claim = claimBudget(EVIDENCE, "judge", ceilings.judge, {
        stamp: slot.stamp,
        attemptId,
        key: `${slot.stamp}|${attemptId}`,
    });
    if (!claim.ok) {
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            reason: claim.reason,
        });
        console.error(`BLOCKER: ${claim.reason}`);
        return { blocked: true };
    }
    const closedAfterClaim = spendRefusal();
    if (closedAfterClaim !== null) {
        releaseClaim(claim.claim);
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            reason: closedAfterClaim,
        });
        console.error(`BLOCKER: ${closedAfterClaim}`);
        return { blocked: true };
    }
    return { claim: claim.claim };
};

/** Release an undispatched claim and record the refusal. */
const judgeRefusal = (
    slot: ScheduleSlot,
    attemptDir: string,
    result: ReturnType<typeof spawnSync>,
    claim: BudgetClaim,
) => {
    releaseClaim(claim);
    ledger({
        event: "judge-refused",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        exit: result.status,
        reason:
            String(result.stderr ?? "")
                .trim()
                .split("\n")
                .at(-1) ?? "",
        attemptDir,
    });
    console.error(
        `BLOCKER: ${slot.stamp} judge wrapper refused before dispatch: ${String(result.stderr ?? "").trim()}`,
    );
    return false;
};

/** Spawn the real judge wrapper for one slot and attempt. */
const judgeWrapperResult = (
    slot: ScheduleSlot,
    base: string,
    selectedAttemptId: string = attemptId,
) =>
    spawnSync(
        process.execPath,
        [
            join(MEASUREMENT, "tests/fixtures/placement-harness/ac/run.mts"),
            "judge",
            "--base",
            base,
            "--stamp",
            slot.stamp,
            "--case",
            slot.scenario,
            "--truth",
            truthPath,
            "--spec",
            specPath,
            "--attempt",
            selectedAttemptId,
            "--launcher",
            join(
                MEASUREMENT,
                "tests/fixtures/placement-harness/ac/judge-launcher.sh",
            ),
            "--model",
            JUDGE,
            "--workdir",
            join(EVIDENCE, "ac-runs"),
            "--timeout",
            String(JUDGE_TIMEOUT),
        ],
        {
            env: judgeEnv(slot),
            encoding: "utf8",
            timeout: JUDGE_TIMEOUT + 120000,
        },
    );

/** Resolve a parse-failed judge answer, when one exists. */
const resolveJudge = (base: string) =>
    spawnSync(
        process.execPath,
        [
            join(MEASUREMENT, "tests/fixtures/placement-harness/ac/run.mts"),
            "resolve",
            "--base",
            base,
            "--spec",
            specPath,
        ],
        { encoding: "utf8", timeout: 120000 },
    );

/** The terminal status of one judge attempt. */
const judgeStatusOf = (
    judgement: Record<string, unknown> | null,
    resolution: Record<string, unknown> | null,
): string => {
    if (resolution?.status === "judged") return "judged-after-resolve";
    return typeof judgement?.status === "string" ? judgement.status : "missing";
};

/** The first defined value, or null. */
const firstValue = (...values: unknown[]): unknown =>
    values.find((value) => value !== undefined && value !== null) ?? null;

/** A nested object field, or an empty record. */
const nested = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : {};

/** The terminal facts one judge attempt recorded. */
const judgeExitOf = (
    attemptDir: string,
    result: ReturnType<typeof spawnSync>,
    resolve: ReturnType<typeof spawnSync>,
) => {
    const judgementValue = readJson(join(attemptDir, "judgement.json"));
    const resolutionValue = readJson(join(attemptDir, "resolution.json"));
    const judgement =
        typeof judgementValue === "object" && judgementValue !== null
            ? (judgementValue as Record<string, unknown>)
            : null;
    const resolution =
        typeof resolutionValue === "object" && resolutionValue !== null
            ? (resolutionValue as Record<string, unknown>)
            : null;
    const parsed = nested(resolution?.parsed);
    return {
        status: judgeStatusOf(judgement, resolution),
        exit: result.status,
        resolveExit: resolve.status,
        outcome: firstValue(
            judgement?.documentationOutcome,
            parsed.documentationOutcome,
        ),
        retrieval: firstValue(
            nested(judgement?.retrievalApplication).state,
            nested(parsed.retrievalApplication).state,
        ),
    };
};

/** One slot's attempt-directory names, in order. */
const attemptIdsOf = (acDir: string): string[] =>
    existsSync(acDir)
        ? readdirSync(acDir, { withFileTypes: true })
              .filter(
                  (entry) =>
                      entry.isDirectory() && /^attempt-\d{3}$/.test(entry.name),
              )
              .map((entry) => entry.name)
              .sort()
        : [];

/** One attempt's effective status: a resolved verdict is usable. */
const attemptStatusOf = (attemptDir: string): string => {
    const resolution = plainRecord(
        readJson(join(attemptDir, "resolution.json")),
    );
    if (resolution?.status === "judged") return "judged";
    const judgement = plainRecord(readJson(join(attemptDir, "judgement.json")));
    return typeof judgement?.status === "string"
        ? judgement.status
        : "missing";
};

/** The recorded facts of every attempt for one slot, in order. */
const attemptFactsOf = (acDir: string): SelectionAttempt[] =>
    attemptIdsOf(acDir).map((name) => {
        const dir = join(acDir, name);
        const judgement = plainRecord(readJson(join(dir, "judgement.json")));
        const meta = plainRecord(readJson(join(dir, "meta.json")));
        const completion = plainRecord(meta?.completion);
        return {
            attemptId: name,
            judgementStatus: attemptStatusOf(dir),
            packetSha256:
                typeof meta?.packetSha256 === "string"
                    ? meta.packetSha256
                    : null,
            failureClass:
                typeof judgement?.failureClass === "string"
                    ? judgement.failureClass
                    : null,
            complete:
                typeof completion?.complete === "boolean"
                    ? completion.complete
                    : null,
        };
    });

/**
 * Write the per-slot selection record, but only when it re-derives cleanly
 * against the recorded attempts. The record is checked evidence for the
 * analyser, status and closure, never a trusted pointer.
 * @param slot The scheduled slot.
 * @param selectedAttemptId The attempt whose judgement is authoritative.
 * @returns Whether a verifiable selection was published.
 */
const writeSelection = (
    slot: ScheduleSlot,
    selectedAttemptId: string,
): boolean => {
    const acDir = join(resultDir(slot), "ac");
    const record = selectionRecordOf({
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        selectedAttemptId,
        policySha256:
            recoveryPolicy === null
                ? null
                : recoveryPolicySha256(recoveryPolicy),
        attempts: attemptFactsOf(acDir),
    });
    const problems = selectionProblems(record, {
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        attemptIds: attemptIdsOf(acDir),
        manifestAttemptId: manifest?.assessment?.attemptId ?? null,
        policy: recoveryPolicy,
    });
    if (problems.length > 0) {
        ledger({
            event: "selection-invalid",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            selectedAttemptId,
            problems,
        });
        console.error(
            `BLOCKER: ${slot.stamp} selection is not verifiable: ${problems.join("; ")}`,
        );
        return false;
    }
    writeJson(join(acDir, "selection.json"), record);
    return true;
};

/** The facts a recovery decision for one slot is made from. */
const recoveryFactsOf = (slot: ScheduleSlot) => {
    const acDir = join(resultDir(slot), "ac");
    const judgeClaims = readClaims(EVIDENCE, "judge");
    return {
        ...attemptRecordFactsOf(join(acDir, attemptId)),
        attemptIds: attemptIdsOf(acDir),
        judgedAttemptIds: attemptIdsOf(acDir).filter(
            (name) => attemptStatusOf(join(acDir, name)) === "judged",
        ),
        recoveryClaimsUsed: readClaims(EVIDENCE, "recovery").length,
        judgeClaimsUsed: judgeClaims.length,
        ledgerState: ledgerParse().state,
        freezeProblems: premiseProblems(),
        unresolvedReservations: unresolvedClaimNamesOf(judgeClaims, slot),
    };
};

/** The recorded status, failure class and completion of one attempt. */
function attemptRecordFactsOf(dir: string): {
    attemptStatus: string;
    failureClass: string | null;
    completionComplete: boolean | null;
} {
    const judgement = plainRecord(readJson(join(dir, "judgement.json")));
    const meta = plainRecord(readJson(join(dir, "meta.json")));
    const completion = plainRecord(meta?.completion);
    return {
        attemptStatus: attemptStatusOf(dir),
        failureClass:
            typeof judgement?.failureClass === "string"
                ? judgement.failureClass
                : null,
        completionComplete:
            typeof completion?.complete === "boolean"
                ? completion.complete
                : null,
    };
}

/** The unsettled judge claims naming one slot. */
function unresolvedClaimNamesOf(
    claims: readonly BudgetClaim[],
    slot: ScheduleSlot,
): string[] {
    return claims
        .filter(
            (claim) =>
                claim.stamp === slot.stamp &&
                restartDisposition(claim) !== null,
        )
        .map((claim) => `${claim.kind}-${String(claim.index)}`);
}

/**
 * Dispatch the single authorised recovery attempt for one slot.
 *
 * Both ceilings are claimed atomically before the child starts. An uncertain
 * dispatch keeps its claims: the call may have begun, so it is never silently
 * repeated. The first attempt is preserved and the recovery is a fresh blind
 * assessment of the same packet.
 * @param slot The scheduled slot.
 * @param base The arm's stage result root.
 * @param recoveryAttemptId The next attempt id.
 * @returns Whether a usable recovery judgement landed.
 */
const dispatchRecovery = (
    slot: ScheduleSlot,
    base: string,
    recoveryAttemptId: string,
): boolean => {
    const acDir = join(resultDir(slot), "ac");
    const attemptDir = join(acDir, recoveryAttemptId);
    if (existsSync(attemptDir)) {
        return recoveryRefusal(
            slot,
            recoveryAttemptId,
            "a recovery attempt directory already exists; it is never reused",
        );
    }
    const claim = claimRecoveryBudget(EVIDENCE, recoveryPolicy!, {
        stamp: slot.stamp,
        attemptId: recoveryAttemptId,
        key: `${slot.stamp}|${recoveryAttemptId}`,
    });
    if (!claim.ok) {
        return recoveryRefusal(slot, recoveryAttemptId, claim.reason);
    }
    const closedAfterClaim = spendRefusal();
    if (closedAfterClaim !== null) {
        releaseClaim(claim.recovery);
        releaseClaim(claim.judge);
        return recoveryRefusal(slot, recoveryAttemptId, closedAfterClaim);
    }
    return runRecoveryChild(slot, base, attemptDir, recoveryAttemptId, claim);
};

/** Record a refused recovery and return false. */
const recoveryRefusal = (
    slot: ScheduleSlot,
    attemptId: string,
    reason: string,
): boolean => {
    ledger({
        event: "recovery-blocked",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        attemptId,
        reason,
    });
    console.error(`BLOCKER: ${slot.stamp} recovery refused: ${reason}`);
    return false;
};

/**
 * Run one claimed recovery child and record its outcome.
 * @param slot The scheduled slot.
 * @param base The arm's stage result root.
 * @param attemptDir The recovery attempt directory.
 * @param recoveryAttemptId The recovery attempt id.
 * @param claim The dual claim already taken.
 * @returns Whether a usable recovery judgement landed.
 */
const runRecoveryChild = (
    slot: ScheduleSlot,
    base: string,
    attemptDir: string,
    recoveryAttemptId: string,
    claim: { recovery: BudgetClaim; judge: BudgetClaim },
): boolean => {
    const result = judgeWrapperResult(slot, base, recoveryAttemptId);
    if (!existsSync(join(attemptDir, "dispatch.json"))) {
        // The wrapper refused before dispatch; return both reservations.
        releaseClaim(claim.recovery);
        releaseClaim(claim.judge);
        ledger({
            event: "recovery-refused",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            attemptId: recoveryAttemptId,
            exit: result.status,
            reason:
                String(result.stderr ?? "")
                    .trim()
                    .split("\n")
                    .at(-1) ?? "",
        });
        console.error(
            `BLOCKER: ${slot.stamp} recovery wrapper refused before dispatch`,
        );
        return false;
    }
    ledger({
        event: "recovery-launch",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        attemptId: recoveryAttemptId,
        attemptDir,
    });
    advanceClaim(claim.recovery, "spawned");
    advanceClaim(claim.judge, "spawned");
    advanceClaim(claim.recovery, "closed");
    advanceClaim(claim.judge, "closed");
    const resolve = resolveJudge(base);
    const judgement = plainRecord(
        readJson(join(attemptDir, "judgement.json")),
    );
    const status = attemptStatusOf(attemptDir);
    ledger({
        event: "recovery-exit",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        attemptId: recoveryAttemptId,
        status,
        exit: result.status,
        resolveExit: resolve.status,
        outcome: judgement?.documentationOutcome ?? null,
        failureClass: judgement?.failureClass ?? null,
    });
    if (status !== "judged") {
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            reason: "second unusable assessment; campaign stops",
        });
        console.error(
            `BLOCKER: ${slot.stamp} recovery judgement is ${status}; no further attempt is authorised`,
        );
        return false;
    }
    return true;
};

/** Dispatch one claimed judge call and record what actually happened. */
const dispatchJudge = (
    slot: ScheduleSlot,
    base: string,
    attemptDir: string,
    claim: BudgetClaim,
) => {
    const result = judgeWrapperResult(slot, base);
    if (!existsSync(join(attemptDir, "dispatch.json"))) {
        return judgeRefusal(slot, attemptDir, result, claim);
    }
    ledger({
        event: "judge-launch",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        attemptDir,
    });
    advanceClaim(claim, "spawned");
    advanceClaim(claim, "closed");
    const resolve = resolveJudge(base);
    const exit = judgeExitOf(attemptDir, result, resolve);
    ledger({
        event: "judge-exit",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        attemptDir,
        ...exit,
    });
    return exit.status === "judged" || exit.status === "judged-after-resolve";
};

/** Run one judge wrapper, record its dispatch truth and its outcome. */
const runJudge = (slot: ScheduleSlot): string | null => {
    const { base } = armPaths(slot.arm);
    const acDir = join(resultDir(slot), "ac");
    // A published selection is the authority for a resumed run: a recovered
    // slot must not re-target the failed first attempt.
    const selection = plainRecord(readJson(join(acDir, "selection.json")));
    const selectedAttemptId =
        typeof selection?.selectedAttemptId === "string"
            ? selection.selectedAttemptId
            : attemptId;
    const attemptDir = join(acDir, selectedAttemptId);
    if (judgeSkip(slot, attemptDir)) return selectedAttemptId;
    const claimed = judgeClaimOf(slot);
    if (claimed.claim === undefined) return null;
    return dispatchJudge(slot, base, attemptDir, claimed.claim)
        ? selectedAttemptId
        : null;
};
const finishRecordedSlot = (
    slot: ScheduleSlot,
    meta: Record<string, unknown> | null,
) => {
    if (!existsSync(join(resultDir(slot), "gate.json"))) runGate(slot);
    if (!usableRun(meta)) {
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            stamp: slot.stamp,
            arm: slot.arm,
            reason: "recorded trial is not usable",
        });
        console.error(`BLOCKER: ${slot.stamp} recorded an unusable trial`);
        return "blocked";
    }
    const judged = runJudge(slot);
    if (judged !== null) return completeSlot(slot, judged, false);
    if (recoveryPolicy !== null) {
        return recoverSlot(slot, recoveryPolicy);
    }
    return blockSlot(slot, `has no usable ${attemptId} judgement`);
};

/** Record a completed slot with its selected attempt. */
const completeSlot = (
    slot: ScheduleSlot,
    selectedAttemptId: string,
    recovered: boolean,
) => {
    if (!writeSelection(slot, selectedAttemptId)) return "blocked";
    ledger({
        event: "slot-complete",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        judged: true,
        ...(recovered ? { recovered: true, selectedAttemptId } : {}),
    });
    return "complete";
};

/** Evaluate the registered policy and dispatch the one recovery if eligible. */
const recoverSlot = (slot: ScheduleSlot, policy: RecoveryPolicy) => {
    const decision = recoveryDecision(policy, recoveryFactsOf(slot));
    if (!decision.eligible) {
        ledger({
            event: "recovery-blocked",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            reason: decision.reason,
        });
        return blockSlot(
            slot,
            `has no usable ${attemptId} judgement; recovery refused: ${decision.reason}`,
        );
    }
    const { base } = armPaths(slot.arm);
    const recovered = dispatchRecovery(slot, base, decision.attemptId);
    if (!recovered) return "blocked";
    if (!writeSelection(slot, decision.attemptId)) return "blocked";
    console.log(`${slot.stamp}: recovered with ${decision.attemptId}`);
    return completeSlot(slot, decision.attemptId, true);
};

/** Record a blocked slot and return the terminal status. */
const blockSlot = (slot: ScheduleSlot, detail: string) => {
    ledger({
        event: "slot-blocked",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        reason: "no usable judgement; campaign paused",
    });
    console.error(`BLOCKER: ${slot.stamp} ${detail}`);
    return "blocked";
};

const processSlot = (slot: ScheduleSlot) => {
    const dir = resultDir(slot);
    const unsettledTrial = readClaims(EVIDENCE, "trial").find(
        (claim) =>
            claim.stamp === slot.stamp && restartDisposition(claim) !== null,
    );
    if (unsettledTrial !== undefined) {
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            stamp: slot.stamp,
            arm: slot.arm,
            reason: "unsettled trial claim from an interrupted invocation",
        });
        console.error(
            `BLOCKER: ${slot.stamp} has an unsettled trial claim; no duplicate call is authorised`,
        );
        return "blocked";
    }
    const attempts = attemptsOf(slot.stamp);
    const latest = attempts.at(-1);
    if (latest) {
        const metaValue = readJson(join(dir, "meta.json"));
        if (metaValue !== null) {
            return finishRecordedSlot(
                slot,
                recordOf(metaValue, join(dir, "meta.json")),
            );
        }
        if (existsSync(dir)) {
            ledger({
                event: "slot-blocked",
                slot: slot.slot,
                stamp: slot.stamp,
                arm: slot.arm,
                reason: "started attempt has no recorded meta.json; evidence preserved",
                attemptId: latest.attemptId,
            });
            console.error(
                `BLOCKER: ${slot.stamp} started but has no recorded result; preserved at ${dir}`,
            );
            return "blocked";
        }
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            stamp: slot.stamp,
            arm: slot.arm,
            reason: "pre-model failure; no replacement launch authorised",
            attemptId: latest.attemptId,
        });
        console.error(
            `BLOCKER: ${slot.stamp} stopped before the model call; no retry authorised`,
        );
        return "blocked";
    }
    if (premiseBlock(slot, "trial dispatch")) return "blocked";
    const claim = claimBudget(EVIDENCE, "trial", ceilings.trial, {
        stamp: slot.stamp,
        attemptId: "attempt-001",
        key: slot.stamp,
    });
    if (!claim.ok) {
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            stamp: slot.stamp,
            arm: slot.arm,
            reason: claim.reason,
        });
        console.error(`BLOCKER: ${claim.reason}`);
        return "blocked";
    }
    const closedAfterClaim = spendRefusal();
    if (closedAfterClaim !== null) {
        releaseClaim(claim.claim);
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            stamp: slot.stamp,
            arm: slot.arm,
            reason: closedAfterClaim,
        });
        console.error(`BLOCKER: ${closedAfterClaim}`);
        return "blocked";
    }
    const attempt = newAttempt(slot, "launching");
    return launchRun(slot, attempt, claim.claim);
};

const launchRun = (
    slot: ScheduleSlot,
    attempt: Attempt,
    claim: BudgetClaim,
) => {
    const outcome = runTrial(slot, attempt);
    const dispatched =
        outcome.meta !== null ||
        outcome.containerRun ||
        existsSync(resultDir(slot));
    if (!dispatched) {
        // A known pre-model failure dispatched nothing: its reservation is
        // returned so a refusal cannot burn an allowance.
        releaseClaim(claim);
        ledger({
            event: "slot-pre-model-failure",
            slot: slot.slot,
            stamp: slot.stamp,
            arm: slot.arm,
            attemptId: attempt.attemptId,
            exit: outcome.exit,
            signal: outcome.signal,
        });
        console.error(
            `BLOCKER: ${slot.stamp} stopped before the container run; preserve and report`,
        );
        return "blocked";
    }
    advanceClaim(claim, "spawned");
    advanceClaim(claim, "closed");
    if (outcome.meta !== null) {
        return finishRecordedSlot(slot, outcome.meta);
    }
    ledger({
        event: "slot-attempted-unknown",
        slot: slot.slot,
        stamp: slot.stamp,
        arm: slot.arm,
        attemptId: attempt.attemptId,
        exit: outcome.exit,
        signal: outcome.signal,
    });
    console.error(
        `BLOCKER: ${slot.stamp} container ran but recorded no result; the model call may have begun`,
    );
    return "blocked";
};

if (dryRun) {
    dry();
    process.exit(0);
}

const refusal = spendRefusal();
if (refusal !== null) {
    console.error(`BLOCKER: ${refusal}`);
    process.exit(2);
}

/**
 * Why an earlier blocked slot forbids this range, or null.
 * @param firstIndex The index of the first slot in the requested range.
 * @returns The refusal, or null when every earlier slot completed.
 */
const earlierSlotRefusal = (firstIndex: number): string | null => {
    const completed = new Set(
        ledgerParse()
            .events.filter((event) => event.event === "slot-complete")
            .map((event) => event.stamp),
    );
    for (const slot of slots.slice(0, firstIndex)) {
        if (!completed.has(slot.stamp)) {
            return `${slot.stamp} is not complete; a later range cannot skip it`;
        }
    }
    return null;
};

const premise = premiseProblems();
if (premise.length > 0) {
    console.error(`BLOCKER: frozen premise changed: ${premise.join("; ")}`);
    process.exit(2);
}

if (!shimExecutable()) {
    console.error(
        `BLOCKER: container logging shim is not executable: ${join(SHIM, "podman")}`,
    );
    process.exit(2);
}

if (judgeKeySource === null) {
    console.error(
        "BLOCKER: no ZAI_API_KEY (environment, ZAI_API_KEY_FILE or campaign .env)",
    );
    process.exit(2);
}

const firstIndex = slots.findIndex((slot: ScheduleSlot) => {
    const pairNumber = Number(slot.pairId.slice(1));
    return pairNumber >= pairFrom && pairNumber <= pairTo;
});
const earlier = earlierSlotRefusal(firstIndex < 0 ? slots.length : firstIndex);
if (earlier !== null) {
    console.error(`BLOCKER: ${earlier}`);
    process.exit(2);
}

mkdirSync(LAUNCHES, { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });
ledger({
    event: "campaign-start",
    campaign: schedule.campaign,
    driver: "prepare/run.mts",
    scheduleSha256: createHash("sha256")
        .update(JSON.stringify(slots), "utf8")
        .digest("hex"),
    model: MODEL,
    judgeModel: JUDGE,
    pairFrom,
    pairTo,
});

for (let index = 0; index < slots.length; index += 2) {
    const pair = slots.slice(index, index + 2);
    const first = pair[0];
    if (first === undefined) continue;
    const pairNumber = Number(first.pairId.slice(1));
    if (pairNumber < pairFrom || pairNumber > pairTo) continue;
    for (const slot of pair) {
        const status = processSlot(slot);
        if (status !== "complete") {
            console.error(
                `campaign paused at ${slot.stamp}; ${index} slot(s) processed`,
            );
            process.exit(2);
        }
    }
    ledger({
        event: "pair-complete",
        pairId: first.pairId,
        slots: pair.map((slot: ScheduleSlot) => slot.slot),
    });
    console.log(`pair ${first.pairId} complete`);
}
ledger({ event: "campaign-complete", pairFrom, pairTo });
console.log("campaign range complete");
