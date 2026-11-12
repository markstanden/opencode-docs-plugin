// Paired productivity-screen runner for the 0.14.0 description comparison.
//
// Safety properties:
// - The schedule and frozen identities must exist before any launch.
// - A launch record is written before the model session starts. It is never
//   overwritten, so a resume cannot relaunch an attempt whose model call may
//   have begun.
// - An existing result directory without meta.json is a started attempt, not
//   a blank slot; it blocks and is reported.
// - The judge runs only for a recorded, usable trial, and ac/run.mjs claims
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
import { credentialFileProblem, loadJudgeKey } from "./env.mjs";
import { parseCampaignLedger } from "../runner/ledger.ts";
import {
    advanceClaim,
    claimBudget,
    readClaims,
    releaseClaim,
    restartDisposition,
} from "../runner/budget.ts";
import { resolveAttemptSelection } from "../runner/selector.ts";
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
const flag = (name) =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const dryRun = argv.includes("--dry-run");
const trialCommand = flag("--trial-command");
const pairFrom = Number(flag("--pair-from") ?? 1);
const pairTo = Number(flag("--pair-to") ?? 8);

const fail = (message) => {
    console.error(`BLOCKER: ${message}`);
    process.exit(2);
};

// Refuse an unsafe credential file before its value is loaded.
const keyProblem = credentialFileProblem(ROOT);
if (keyProblem !== null) fail(keyProblem);
const judgeKeySource = loadJudgeKey(ROOT);

const readJson = (path) =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** The parsed ledger: absence is a state, never an empty trusted ledger. */
const ledgerParse = () =>
    parseCampaignLedger(existsSync(LEDGER) ? readText(LEDGER) : undefined);

/** Why spend is refused now, or null when a clean open ledger permits it. */
const spendRefusal = () => {
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
const shimExecutable = () => {
    try {
        accessSync(join(SHIM, "podman"), constants.X_OK);
        return true;
    } catch {
        return false;
    }
};
const ledger = (entry) => {
    appendFileSync(
        LEDGER,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
        "utf8",
    );
};

const schedule = readJson(join(EVIDENCE, "schedule.json"));
if (schedule === null)
    fail("no frozen schedule; run prepare/schedule.mjs first");
const slots = schedule.slots;

const manifest = readJson(join(ROOT, "prepare/manifest.json"));
const selection = resolveAttemptSelection({
    manifestAttemptId: manifest?.assessment?.attemptId ?? null,
    overrideAttemptId: flag("--attempt-id") ?? null,
});
if (!selection.ok) {
    console.error(`BLOCKER: ${selection.problems.join("; ")}`);
    process.exit(2);
}
const attemptId = selection.selection.attemptId;

const frozen = readJson(join(EVIDENCE, "FROZEN.json"));
const freezeRecord = frozen?.freeze ?? null;
// One authoritative ceiling: the validated freeze record. A missing or legacy
// record yields zero, which every claim refuses.
const ceilings = {
    trial: Number(freezeRecord?.ceilings?.trial ?? 0),
    judge: Number(freezeRecord?.ceilings?.judge ?? 0),
};

/** Capture one external command's trimmed output, or an empty string. */
const capture = (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    return result.status === 0 ? String(result.stdout ?? "").trim() : "";
};

/**
 * Verify the frozen premise against what this invocation would actually use:
 * every immutable input, the source revision, the image identity and the
 * container CLI. A historical freeze without a record returns no problems.
 */
const filesUnder = (dir) => {
    if (!existsSync(dir)) return [];
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...filesUnder(path));
        else if (entry.isFile()) found.push(path);
    }
    return found.sort();
};

const premiseProblems = () => {
    const record = frozen?.freeze ?? null;
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

const armPaths = (arm) => {
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

const resultDir = (slot) => {
    const { base } = armPaths(slot.arm);
    return join(base, "results", slot.stamp, slot.scenario);
};

const truthPath = join(
    ROOT,
    "arms/a/tests/fixtures/placement-harness/prod014/truth.json",
);
const specPath = join(EVIDENCE, "measurement-spec.json");

const attemptsOf = (stamp) => {
    const dir = join(LAUNCHES, stamp);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((name) => /^attempt-\d{3}\.json$/.test(name))
        .sort()
        .map((name) => ({
            id: name.replace(/\.json$/, ""),
            record: readJson(join(dir, name)),
        }));
};

const newAttempt = (slot, status, extra = {}) => {
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

const updateAttempt = (slot, attemptId, patch) => {
    const path = join(LAUNCHES, slot.stamp, `${attemptId}.json`);
    const current = readJson(path);
    if (current === null) throw new Error(`missing attempt record ${path}`);
    writeFileSync(
        path,
        `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`,
        "utf8",
    );
};

const containerRunObserved = (logPath) =>
    /^\S+ run(?:\s|$)/m.test(readText(logPath));

const usableRun = (meta) =>
    meta !== null &&
    meta.exit === 0 &&
    meta.signal === null &&
    meta.timedOut !== true &&
    meta.outputOverflow !== true &&
    meta.answerValid === true;

const hasJudgement = (dir) => {
    const judgement = readJson(join(dir, "ac", attemptId, "judgement.json"));
    if (judgement?.status === "judged") return true;
    const resolution = readJson(join(dir, "ac", attemptId, "resolution.json"));
    return resolution?.status === "judged";
};

const safeHead = (repo) => {
    const result = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
        encoding: "utf8",
    });
    return result.status === 0 ? result.stdout.trim() : "";
};

const envFor = (slot) => {
    const { repo, base, cases } = armPaths(slot.arm);
    return {
        ...process.env,
        PATH: `${SHIM}:${process.env.PATH ?? ""}`,
        CONTAINER_LOG: join(CONTAINER_LOGS, `${slot.stamp}.log`),
        PLACEMENT_TRIAL_IMAGE_ID: freezeRecord?.imageId ?? "",
        PLACEMENT_IMAGE: freezeRecord?.imageId ?? "",
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

const premiseBlock = (slot, boundary) => {
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
const slotProblems = (slot) => {
    const problems = [];
    const { repo, base, cases } = armPaths(slot.arm);
    for (const [label, path] of [
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
    ]) {
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
                (slot) =>
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

const runTrial = (slot, attempt) => {
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
    const meta = readJson(join(dir, "meta.json"));
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
        timedOut: result.error?.code === "ETIMEDOUT",
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

const runGate = (slot) => {
    const { base, cases } = armPaths(slot.arm);
    const result = spawnSync(
        process.execPath,
        [
            join(MEASUREMENT, "tests/fixtures/placement-harness/ac/run.mjs"),
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
    const gate = readJson(join(resultDir(slot), "gate.json"));
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
const judgeSkip = (slot, attemptDir) => {
    if (!hasJudgement(resultDir(slot))) return false;
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
const judgeClaimOf = (slot) => {
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
const judgeRefusal = (slot, attemptDir, result, claim) => {
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

/** Spawn the real judge wrapper for one slot. */
const judgeWrapperResult = (slot, base) =>
    spawnSync(
        process.execPath,
        [
            join(MEASUREMENT, "tests/fixtures/placement-harness/ac/run.mjs"),
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
            attemptId,
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
            env: envFor(slot),
            encoding: "utf8",
            timeout: JUDGE_TIMEOUT + 120000,
        },
    );

/** Resolve a parse-failed judge answer, when one exists. */
const resolveJudge = (base) =>
    spawnSync(
        process.execPath,
        [
            join(MEASUREMENT, "tests/fixtures/placement-harness/ac/run.mjs"),
            "resolve",
            "--base",
            base,
            "--spec",
            specPath,
        ],
        { encoding: "utf8", timeout: 120000 },
    );

/** The terminal status of one judge attempt. */
const judgeStatusOf = (judgement, resolution) => {
    if (resolution?.status === "judged") return "judged-after-resolve";
    return judgement?.status ?? "missing";
};

/** The first defined value, or null. */
const firstValue = (...values) =>
    values.find((value) => value !== undefined && value !== null) ?? null;

/** The terminal facts one judge attempt recorded. */
const judgeExitOf = (attemptDir, result, resolve) => {
    const judgement = readJson(join(attemptDir, "judgement.json"));
    const resolution = readJson(join(attemptDir, "resolution.json"));
    return {
        status: judgeStatusOf(judgement, resolution),
        exit: result.status,
        resolveExit: resolve.status,
        outcome: firstValue(
            judgement?.documentationOutcome,
            resolution?.parsed?.documentationOutcome,
        ),
        retrieval: firstValue(
            judgement?.retrievalApplication?.state,
            resolution?.parsed?.retrievalApplication?.state,
        ),
    };
};

/** Dispatch one claimed judge call and record what actually happened. */
const dispatchJudge = (slot, base, attemptDir, claim) => {
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
const runJudge = (slot) => {
    const { base } = armPaths(slot.arm);
    const attemptDir = join(resultDir(slot), "ac", attemptId);
    if (judgeSkip(slot, attemptDir)) return true;
    const claimed = judgeClaimOf(slot);
    if (claimed.claim === undefined) return false;
    return dispatchJudge(slot, base, attemptDir, claimed.claim);
};
const finishRecordedSlot = (slot, meta) => {
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
    if (!judged) {
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            reason: "no usable judgement; campaign paused",
        });
        console.error(
            `BLOCKER: ${slot.stamp} has no usable ${attemptId} judgement`,
        );
        return "blocked";
    }
    ledger({
        event: "slot-complete",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        judged,
    });
    return "complete";
};

const processSlot = (slot) => {
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
        const meta = readJson(join(dir, "meta.json"));
        if (meta !== null) {
            return finishRecordedSlot(slot, meta);
        }
        if (existsSync(dir)) {
            ledger({
                event: "slot-blocked",
                slot: slot.slot,
                stamp: slot.stamp,
                arm: slot.arm,
                reason: "started attempt has no recorded meta.json; evidence preserved",
                attemptId: latest.id,
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
            attemptId: latest.id,
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

const launchRun = (slot, attempt, claim) => {
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
const earlierSlotRefusal = (firstIndex) => {
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

const firstIndex = slots.findIndex((slot) => {
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
    driver: "prepare/run.mjs",
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
    const pairNumber = Number(pair[0].pairId.slice(1));
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
        pairId: pair[0].pairId,
        slots: pair.map((slot) => slot.slot),
    });
    console.log(`pair ${pair[0].pairId} complete`);
}
ledger({ event: "campaign-complete", pairFrom, pairTo });
console.log("campaign range complete");
