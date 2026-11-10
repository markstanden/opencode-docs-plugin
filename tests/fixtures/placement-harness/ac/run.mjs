#!/usr/bin/env node
/**
 * Campaign support for the arm-blind description comparison.
 *
 * Six commands, all reading and writing outside the repository:
 * `schedule` regenerates the frozen slot list; `gate` records the harness's
 * deterministic verdict per trial; `judge` collects one structured,
 * evidence-checked judgement from a self-contained packet; `resolve` re-parses
 * answers whose only failure was trailing prose; `report` aggregates recorded
 * trials into the published utility tables; `manifest` hashes the evidence.
 *
 * Nothing here calls a model except `judge`, and `judge` never retries.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    buildSchedule,
    docChanges,
    firstBalancedObject,
    labelLeaks,
} from "./campaign.mts";
import {
    buildAcPrompt,
    finalistQualifies,
    parseAcJudgement,
    rankCandidates,
    sensitivity,
    summariseArm,
    validateAcJudgement,
} from "../ac-scoring.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTCOME_KEYS = [
    "useful-create",
    "useful-update",
    "transient",
    "duplicate",
    "misleading",
    "none",
];

/** Read JSON, or null when the file is absent. */
const readJson = (path) =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;

/** Read text, or an empty string when the file is absent. */
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** Write JSON with a trailing newline. */
const writeJson = (path, value) =>
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");

/** SHA-256 of a string. */
const sha256 = (text) =>
    createHash("sha256").update(text, "utf8").digest("hex");

/** Parse `--flag value` pairs into a map. */
function flags(argv) {
    const parsed = new Map();
    for (let index = 0; index < argv.length; index += 2) {
        if (!argv[index].startsWith("--")) {
            throw new Error(`unexpected argument ${argv[index]}`);
        }
        parsed.set(argv[index], argv[index + 1]);
    }
    return parsed;
}

/** Require a flag value. */
function need(args, name) {
    const value = args.get(name);
    if (!value) throw new Error(`missing ${name}`);
    return value;
}

/** The harness entry point inside one arm worktree. */
const harnessOf = (repo) =>
    join(repo, "tests/fixtures/placement-harness/harness.mts");

/** Collect Markdown documents under a root as `{path, contents}`. */
function lakeDocs(root) {
    const found = [];
    const visit = (dir) => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile() && entry.name.endsWith(".md")) {
                found.push({
                    path: path.slice(root.length + 1),
                    contents: readFileSync(path, "utf8"),
                });
            }
        }
    };
    visit(root);
    return found.sort((left, right) => left.path.localeCompare(right.path));
}

/** One JSON line from an `opencode --format json` trail, or undefined. */
function trailEvent(line) {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
}

/** The final text part of a JSONL trail. */
function finalAnswer(stdout) {
    return (
        (stdout ?? "")
            .split("\n")
            .map(trailEvent)
            .filter((event) => event?.part?.type === "text")
            .map((event) => event.part.text)
            .pop() ?? ""
    );
}

/** Add one step's tokens to a usage total. */
function addStepTokens(usage, tokens) {
    usage.steps += 1;
    usage.input += tokens.input ?? 0;
    usage.output += tokens.output ?? 0;
    usage.reasoning += tokens.reasoning ?? 0;
    usage.cacheRead += tokens.cache?.read ?? 0;
}

/** Token usage from a recorded trail. */
function usageOf(stdoutPath) {
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, steps: 0 };
    for (const line of readText(stdoutPath).split("\n")) {
        const event = line.trim() === "" ? undefined : trailEvent(line);
        if (event?.type === "step_finish" && event.part?.tokens) {
            addStepTokens(usage, event.part.tokens);
        }
    }
    return usage;
}

/** The input fields of one docs operation, rendered for the judge. */
function inputParts(input) {
    const parts = [];
    if (typeof input.search === "string")
        parts.push(`search "${input.search}"`);
    if (typeof input.read === "string") parts.push(`read ${input.read}`);
    if (typeof input.check === "string") parts.push(`check ${input.check}`);
    if (input.add) {
        parts.push(
            `${input.add.mode ?? "create"} ${input.add.path ?? "(body)"}`,
        );
    }
    return parts;
}

/** One verified docs operation, rendered for the judge. */
function operationLine(entry) {
    const surface = entry.surface === "codemode-twin" ? "twin" : "native";
    const parts = inputParts(entry.input ?? {});
    return `${entry.status ?? "unknown"} ${surface} ${parts.join("; ") || "help"}`;
}

/** Verified docs operations from a journal file. */
function documentedOperations(path) {
    return readText(path)
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map(trailEvent)
        .filter((entry) => entry !== undefined)
        .map(operationLine);
}

/** Changed paths from a writes report. */
function changedPaths(writes) {
    return writes
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && line !== "none")
        .map((line) =>
            line
                .replace(/^[a-z]+: /, "")
                .replace(/ \((file|dir|symlink|mode)\)$/, ""),
        );
}

/** The primary-check evidence the judge sees. */
function primaryEvidence(record) {
    return {
        status: record?.status ?? "missing",
        exit: record?.exit ?? null,
        stdout: String(record?.stdout ?? "").slice(0, 8000),
        stderr: String(record?.stderr ?? "").slice(0, 4000),
    };
}

/**
 * Assemble one arm-blind packet for a completed trial.
 * @param base The stage's result roots.
 * @param stamp The trial stamp.
 * @param caseId The scenario id.
 * @param truth The scenario-truth map.
 * @returns The packet text and the mutation facts behind it.
 */
function packetFor(base, stamp, caseId, truth) {
    const caseDir = join(base, "results", stamp, caseId);
    const beforeDocs = lakeDocs(join(base, "fixtures", caseId, "lakes/docs"));
    const afterDocs = lakeDocs(join(caseDir, "live/lakes/docs"));
    const state = docChanges(beforeDocs, afterDocs);
    const prompt = buildAcPrompt({
        taskPrompt: readText(join(caseDir, "prompt.md")),
        standingPermission: readText(
            join(base, "fixtures", caseId, "work/AGENTS.md"),
        ),
        scenarioTruth: truth[caseId],
        beforeDocs,
        afterDocs,
        changedPaths: changedPaths(readText(join(caseDir, "writes.txt"))),
        primary: primaryEvidence(readJson(join(caseDir, "primary-check.json"))),
        docsOperations: documentedOperations(
            join(caseDir, "docs-operations.jsonl"),
        ),
        answer: readText(join(caseDir, "final.md")),
    });
    return { caseDir, prompt, state };
}

/** The judge spawn arguments for one packet. */
const judgeArgs = (model, stamp, prompt) => [
    "run",
    "--standalone",
    "--auto",
    "--archived",
    "--title",
    `ac-scoring-${sha256(stamp).slice(0, 12)}`,
    "--model",
    model,
    "--format",
    "json",
    prompt,
];

/** Spawn one isolated judge session. */
function spawnJudge({ launcher, model, stamp, prompt, runDir, timeout }) {
    return spawnSync(launcher, judgeArgs(model, stamp, prompt), {
        cwd: join(runDir, "work"),
        encoding: "utf8",
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, AC_RUN_DIR: runDir, AC_MODEL: model },
    });
}

/** Record a judge attempt's evidence and return its terminal status. */
function recordJudgement(attemptDir, result, state, model, stamp, caseId) {
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(
        join(attemptDir, "output.jsonl"),
        result.stdout ?? "",
        "utf8",
    );
    writeJson(join(attemptDir, "meta.json"), {
        stamp,
        caseId,
        judgeModel: model,
        exit: result.status,
        state,
    });
    const answer = finalAnswer(result.stdout);
    const processOk =
        result.error === undefined &&
        result.signal === null &&
        result.status === 0 &&
        answer.trim() !== "";
    if (!processOk) {
        writeJson(join(attemptDir, "judgement.json"), {
            status: "judge-error",
            problems: [`process not ok (exit ${result.status})`],
        });
        return 1;
    }
    const parsed = parseAcJudgement(answer);
    const problems =
        parsed.value === undefined
            ? parsed.problems
            : validateAcJudgement(parsed.value, state);
    writeJson(
        join(attemptDir, "judgement.json"),
        problems.length === 0
            ? { status: "judged", ...parsed.value }
            : {
                  status: "invalid-verdict",
                  problems,
                  parsed: parsed.value ?? null,
              },
    );
    return problems.length === 0 ? 0 : 1;
}

/**
 * Record the deterministic gate verdict for each stamp's recorded trials.
 * @param args `--repo`, `--base`, `--cases`, `--stamps`.
 * @returns 0 when every stamp produced a gate record, else 1.
 */
function gate(args) {
    const repo = need(args, "--repo");
    const base = need(args, "--base");
    const cases = need(args, "--cases");
    const roots = {
        results: join(base, "results"),
        prompts: join(base, "prompts"),
        fixtures: join(base, "fixtures"),
        rubrics: join(base, "rubrics"),
    };
    let failures = 0;
    for (const stamp of need(args, "--stamps").split(",").filter(Boolean)) {
        const dir = join(roots.results, stamp);
        if (!existsSync(dir)) {
            console.error(`${stamp}: no results directory`);
            failures += 1;
            continue;
        }
        for (const caseId of readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)) {
            spawnSync(
                process.execPath,
                [
                    harnessOf(repo),
                    "judge",
                    caseId,
                    "--stamp",
                    stamp,
                    "--gate-only",
                    "--results",
                    roots.results,
                    "--fixture",
                    cases,
                    "--prompts",
                    roots.prompts,
                    "--fixtures",
                    roots.fixtures,
                    "--rubrics",
                    roots.rubrics,
                ],
                { encoding: "utf8", timeout: 180000 },
            );
            if (!existsSync(join(dir, caseId, "gate.json"))) failures += 1;
        }
    }
    return failures === 0 ? 0 : 1;
}

/**
 * Judge one completed trial once, validating the answer against the recorded
 * mutation facts. A judge failure is recorded; it is never retried.
 * @param args `--base`, `--stamp`, `--case`, `--truth`, `--model`,
 *   `--launcher`, `--workdir`, optional `--timeout`.
 * @returns 0 when a usable judgement landed, 1 when it did not.
 */
function judge(args) {
    const base = need(args, "--base");
    const stamp = need(args, "--stamp");
    const caseId = need(args, "--case");
    const truth = JSON.parse(readFileSync(need(args, "--truth"), "utf8"));
    const model = need(args, "--model");
    const attemptDir = join(
        base,
        "results",
        stamp,
        caseId,
        "ac",
        "attempt-001",
    );
    if (existsSync(join(attemptDir, "judgement.json"))) return 0;
    const { prompt, state } = packetFor(base, stamp, caseId, truth);
    const leaks = labelLeaks(prompt);
    if (leaks.length > 0) {
        console.error(
            `refusing a packet with label leaks: ${leaks.join(", ")}`,
        );
        return 3;
    }
    const runDir = join(need(args, "--workdir"), `${stamp}-${caseId}`);
    mkdirSync(join(runDir, "work"), { recursive: true });
    writeFileSync(join(runDir, "prompt.md"), prompt, "utf8");
    const result = spawnJudge({
        launcher: need(args, "--launcher"),
        model,
        stamp,
        prompt,
        runDir,
        timeout: Number(args.get("--timeout") ?? 240000),
    });
    return recordJudgement(attemptDir, result, state, model, stamp, caseId);
}

/** Resolve one parse-failed attempt, or report that it is not resolvable. */
function resolveAttempt(attemptDir, judgement) {
    if (!judgement.problems?.includes("verdict is not valid JSON")) {
        return "refused";
    }
    if (existsSync(join(attemptDir, "resolution.json"))) return "skipped";
    const output = readText(join(attemptDir, "output.jsonl"));
    const meta = JSON.parse(
        readFileSync(join(attemptDir, "meta.json"), "utf8"),
    );
    const extracted = firstBalancedObject(finalAnswer(output));
    const record = { status: "unresolved", method: "first-balanced-object" };
    if (extracted !== undefined) {
        try {
            const parsed = JSON.parse(extracted);
            const problems = validateAcJudgement(parsed, meta.state);
            if (problems.length === 0) {
                record.status = "judged";
                record.parsed = parsed;
            } else {
                record.problems = problems;
            }
        } catch (error) {
            record.reason = String(error);
        }
    }
    writeJson(join(attemptDir, "resolution.json"), {
        ...record,
        originalOutputSha256: sha256(output),
        originalJudgement: judgement,
    });
    return record.status === "judged" ? "resolved" : "refused";
}

/**
 * Resolve answers whose only defect was trailing prose after a complete JSON
 * object. Original judgements are preserved; the resolution is separate.
 * @param args `--base`.
 * @returns 0 unless a resolution was refused.
 */
function resolve(args) {
    const base = need(args, "--base");
    let refused = 0;
    const visit = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(path);
                continue;
            }
            if (
                entry.name !== "judgement.json" ||
                !path.includes("/ac/attempt-")
            ) {
                continue;
            }
            const attemptDir = path.slice(0, -"judgement.json".length);
            const judgement = JSON.parse(readFileSync(path, "utf8"));
            if (judgement.status === "invalid-verdict") {
                if (resolveAttempt(attemptDir, judgement) === "refused")
                    refused += 1;
            }
        }
    };
    visit(join(base, "results"));
    return refused === 0 ? 0 : 1;
}

/** Whether a recorded run is usable evidence. */
function usableRun(meta) {
    return (
        meta !== null &&
        meta.exit === 0 &&
        meta.signal === null &&
        meta.timedOut !== true &&
        meta.outputOverflow !== true &&
        meta.answerValid === true
    );
}

/** The primary result as a scoring category. */
function primaryCategory(record) {
    if (record?.status === "pass") return "pass";
    if (record?.status === "fail") return "fail";
    return "unknown";
}

/** Whether a trial carries a non-compensable guardrail breach. */
function guardrailOf(meta, gateAt) {
    if ((meta?.policyViolations?.length ?? 0) > 0) return true;
    return /preserved .* was (added|modified|removed)/.test(
        gateAt?.reason ?? "",
    );
}

/** The duration a recorded run reports, or null. */
function durationOf(meta) {
    if (typeof meta?.timings?.totalMs === "number") return meta.timings.totalMs;
    if (
        typeof meta?.startedAt !== "string" ||
        typeof meta?.finishedAt !== "string"
    ) {
        return null;
    }
    return Date.parse(meta.finishedAt) - Date.parse(meta.startedAt);
}

/** The recorded judgement, preferring a deterministic parse resolution. */
function resolvedJudgement(dir) {
    const resolution = readJson(join(dir, "ac/attempt-001/resolution.json"));
    if (resolution?.status === "judged") {
        return { status: "judged", ...resolution.parsed };
    }
    return readJson(join(dir, "ac/attempt-001/judgement.json"));
}

/** The assessment status when no judgement was recorded. */
const missingStatus = (attempted) => (attempted ? "unassessed" : "not-run");

/** The documentation outcome when a judgement landed. */
const outcomeOf = (judgement) =>
    judgement?.status === "judged" ? judgement.documentationOutcome : undefined;

/** A recorded value, or null when it is absent. */
const orNull = (value) => (value === undefined ? null : value);

/** The evidence list of a judgement, always an array. */
const evidenceOf = (judgement) => {
    const evidence = orNull(judgement?.evidence);
    return evidence === null ? [] : evidence;
};

/** The assessment status of a recorded judgement. */
function judgementStatus(judgement, attempted) {
    if (judgement?.status) return judgement.status;
    return missingStatus(attempted);
}

/** The resolved assessment of one trial. */
function assessmentOf(dir, attempted) {
    const judgement = resolvedJudgement(dir);
    const acMeta = readJson(join(dir, "ac/attempt-001/meta.json"));
    return {
        status: judgementStatus(judgement, attempted),
        outcome: outcomeOf(judgement),
        reason: orNull(judgement?.documentationReason),
        evidence: evidenceOf(judgement),
        tokens: orNull(acMeta?.usage),
        durationMs: orNull(acMeta?.durationMs),
    };
}

/** Assemble one trial record from its result directory. */
function trialRecord({ stage, slot, arm, base }) {
    const dir = join(base, "results", slot.stamp, slot.scenario);
    const meta = readJson(join(dir, "meta.json"));
    const gateAt = readJson(join(dir, "gate.json"));
    const primary = readJson(join(dir, "primary-check.json"));
    const attempted = existsSync(dir);
    const assessment = assessmentOf(dir, attempted);
    return {
        stage,
        slot: slot.slot,
        stamp: slot.stamp,
        arm,
        role: slot.role ?? null,
        scenario: slot.scenario,
        repetition: slot.repetition,
        attempted,
        usable: usableRun(meta),
        assessmentStatus: assessment.status,
        outcome: assessment.outcome,
        primary: primaryCategory(primary),
        guardrailBreach: guardrailOf(meta, gateAt),
        gateStatus: gateAt?.status ?? "missing",
        gateReason: gateAt?.reason ?? null,
        policyViolations: meta?.policyViolations ?? [],
        writes: meta?.writes ?? null,
        tokens: usageOf(join(dir, "stdout.jsonl")),
        durationMs: durationOf(meta),
        acDurationMs: assessment.durationMs,
        acTokens: assessment.tokens,
        acReason: assessment.reason,
        acEvidence: assessment.evidence,
        writesText: readText(join(dir, "writes.txt")),
    };
}

/** Empty token total. */
const emptyTokens = () => ({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    judgeInput: 0,
    judgeOutput: 0,
});

/** Add one trial's tokens to an arm total. */
function addTokens(total, trial) {
    total.input += trial.tokens.input;
    total.output += trial.tokens.output;
    total.reasoning += trial.tokens.reasoning;
    total.cacheRead += trial.tokens.cacheRead;
    total.judgeInput += trial.acTokens?.input ?? 0;
    total.judgeOutput += trial.acTokens?.output ?? 0;
}

/** The scoring input for one trial. */
const scored = (trial) => ({
    arm: trial.arm,
    scenario: trial.scenario,
    planned: true,
    usable: trial.usable,
    outcome: trial.outcome,
    primary: trial.primary,
    guardrailBreach: trial.guardrailBreach,
});

/** Summarise every arm, with the presentation extras the report shows. */
function summariseArms(arms, trials) {
    const summaries = {};
    for (const arm of arms) {
        const rows = trials.filter((trial) => trial.arm === arm);
        const summary = summariseArm(rows.map(scored));
        summary.attempted = rows.filter((trial) => trial.attempted).length;
        summary.gatePass = rows.filter(
            (row) => row.gateStatus === "pass",
        ).length;
        summary.gateBlocked = rows.filter(
            (row) => row.gateStatus === "blocked",
        ).length;
        summary.tokens = rows.reduce((total, trial) => {
            addTokens(total, trial);
            return total;
        }, emptyTokens());
        summaries[arm] = summary;
    }
    return summaries;
}

/** Per-scenario rows for every arm. */
function scenarioRowsFor(arms, trials) {
    const rows = [];
    for (const arm of arms) {
        for (const scenario of [
            ...new Set(trials.map((trial) => trial.scenario)),
        ]) {
            const matching = trials.filter(
                (trial) => trial.arm === arm && trial.scenario === scenario,
            );
            if (matching.length === 0) continue;
            const summary = summariseArm(matching.map(scored));
            rows.push({
                arm,
                scenario,
                planned: summary.planned,
                attempted: matching.filter((trial) => trial.attempted).length,
                usable: summary.usable,
                assessed: summary.assessed,
                primaryPass: summary.primaryPass,
                primaryFail: summary.primaryFail,
                primaryUnknown: summary.primaryUnknown,
                gatePass: matching.filter((row) => row.gateStatus === "pass")
                    .length,
                gateBlocked: matching.filter(
                    (row) => row.gateStatus === "blocked",
                ).length,
                outcomes: summary.outcomes,
                total: summary.total,
            });
        }
    }
    return rows;
}

/** The arm a slot runs, resolving confirmation roles through the finalist. */
function armOf(slot, finalist) {
    if (slot.role === "F") return finalist?.arm ?? "?";
    if (slot.role === "A") return finalist?.control ?? "A";
    return slot.arm;
}

/** The stage base directory for one arm. */
function baseOf(root, stage, arm) {
    const letter = arm.toLowerCase();
    return stage === "confirmation"
        ? join(root, "gen", letter, "holdout")
        : join(root, "gen", letter);
}

/** Rank eligible arms when the caller supplies the description lengths. */
function rankedFor(arms, summaries, controlArm, characters) {
    if (!characters) return null;
    return rankCandidates(
        arms
            .filter((arm) => arm !== controlArm)
            .map((arm) => ({
                arm,
                characters: characters[arm],
                summary: summaries[arm],
            })),
    );
}

/** Render the compact stage summary table. */
function renderSummary(stage, arms, summaries) {
    const lines = [
        `# ${stage} summary`,
        "",
        "| Arm | Total | Mean | Primary P/F | Gate pass/blocked | Create/update/transient/duplicate/misleading/none |",
        "| --- | --- | --- | --- | --- | --- |",
    ];
    for (const arm of arms) {
        const summary = summaries[arm];
        const outcomes = OUTCOME_KEYS.map((key) => summary.outcomes[key]).join(
            "/",
        );
        lines.push(
            `| ${arm} | ${summary.total} | ${summary.meanPerPlanned?.toFixed(2) ?? "unknown"} | ${summary.primaryPass}/${summary.primaryFail} | ${summary.gatePass}/${summary.gateBlocked} | ${outcomes} |`,
        );
    }
    lines.push(
        "",
        "A useful create or update scores 5; a failed primary check scores -5. Gate outcomes are reported separately and never rescored.",
        "",
    );
    return lines.join("\n");
}

/**
 * Aggregate recorded trials for one stage.
 * @param args `--root`, `--stage`, `--schedule`, `--out-dir`, optional
 *   `--finalist`, optional `--characters`.
 * @returns 0.
 */
function report(args) {
    const root = need(args, "--root");
    const stage = need(args, "--stage");
    const outDir = need(args, "--out-dir");
    const schedule = JSON.parse(readFileSync(need(args, "--schedule"), "utf8"));
    const finalistAt = args.get("--finalist");
    const finalist = finalistAt
        ? JSON.parse(readFileSync(finalistAt, "utf8"))
        : null;
    const charactersAt = args.get("--characters");
    const characters = charactersAt
        ? JSON.parse(readFileSync(charactersAt, "utf8"))
        : null;
    const trials = (schedule[stage] ?? []).map((slot) => {
        const arm = armOf(slot, finalist);
        return trialRecord({
            stage,
            slot,
            arm,
            base: baseOf(root, stage, arm),
        });
    });
    const arms = [...new Set(trials.map((trial) => trial.arm))].sort();
    const summaries = summariseArms(arms, trials);
    const controlArm = finalist?.control ?? "A";
    const analysis = {
        stage,
        weights: { useful: 5, transient: -1, duplicate: -2, misleading: -5 },
        controlArm,
        arms,
        summaries,
        scenarioRows: scenarioRowsFor(arms, trials),
        trials,
        cells: sensitivity(
            Object.fromEntries(
                arms.map((arm) => [
                    arm,
                    trials.filter((trial) => trial.arm === arm).map(scored),
                ]),
            ),
            [3, 5, 8],
            [0.5, 1, 2],
        ),
        ranked: rankedFor(arms, summaries, controlArm, characters),
        qualifying: arms
            .filter((arm) => arm !== controlArm)
            .map((arm) => ({
                arm,
                verdict: finalistQualifies(
                    summaries[controlArm],
                    summaries[arm],
                    2,
                ),
            })),
    };
    mkdirSync(outDir, { recursive: true });
    writeJson(join(outDir, `ANALYSIS-${stage}.json`), analysis);
    writeFileSync(
        join(outDir, `REPORT-${stage}.md`),
        renderSummary(stage, arms, summaries),
        "utf8",
    );
    return 0;
}

/** Hash every evidence file, excluding signing keys. */
function evidenceRows(root) {
    const walk = (dir, files = []) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === "node_modules" || entry.name === ".git")
                    continue;
                walk(path, files);
            } else if (entry.isFile()) {
                files.push(path);
            }
        }
        return files;
    };
    const rows = [];
    for (const dir of ["gen", "controls", "evidence", "logs"]) {
        for (const path of walk(join(root, dir)).sort()) {
            const rel = path.slice(root.length + 1);
            if (rel === "evidence/EVIDENCE.sha256") continue;
            rows.push(
                path.endsWith("docs-operations.key")
                    ? `${"(secret-not-hashed)".padEnd(64)}  ${rel}`
                    : `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${rel}`,
            );
        }
    }
    return rows;
}

/** Read a manifest into a path→hash map. */
function manifestMap(path) {
    return new Map(
        readText(path)
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => {
                const [hash, ...rest] = line.split("  ");
                return [rest.join("  "), hash];
            }),
    );
}

/**
 * Hash (or verify) every evidence file, excluding signing keys.
 * @param args `--root` and either `--write` or `--verify`.
 * @returns 0 when written or verified, 1 when verification fails.
 */
function manifest(args) {
    const root = need(args, "--root");
    const rows = evidenceRows(root);
    const path = join(root, "evidence/EVIDENCE.sha256");
    if (args.get("--write") !== undefined) {
        writeFileSync(path, rows.join("\n") + "\n", "utf8");
        return 0;
    }
    const recorded = manifestMap(path);
    const mismatches = rows.filter((line) => {
        const [hash, ...rest] = line.split("  ");
        return recorded.get(rest.join("  ")) !== hash;
    });
    if (mismatches.length > 0 || recorded.size !== rows.length) {
        console.error(`manifest mismatch: ${mismatches.length} row(s)`);
        return 1;
    }
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const command = process.argv[2];
    const args = flags(process.argv.slice(3));
    const status = (() => {
        switch (command) {
            case "schedule": {
                writeJson(need(args, "--out"), {
                    ...buildSchedule(Number(args.get("--seed") ?? 20261110)),
                    generator:
                        "mulberry32; arm order shuffled per block; scenario order rotated",
                });
                return 0;
            }
            case "gate":
                return gate(args);
            case "judge":
                return judge(args);
            case "resolve":
                return resolve(args);
            case "report":
                return report(args);
            case "manifest":
                return manifest(args);
            default:
                console.error(
                    "usage: run.mjs schedule|gate|judge|resolve|report|manifest [--flag value]",
                );
                return 2;
        }
    })();
    process.exit(status);
}

export { gate, judge, report, resolve, manifest, HERE };
