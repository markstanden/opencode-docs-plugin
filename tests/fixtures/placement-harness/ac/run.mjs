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
    documentationScore,
    finalistQualifies,
    parseAcJudgement,
    rankCandidates,
    sensitivity,
    summariseArm,
    validateAcJudgement,
} from "../ac-scoring.mts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read JSON, or null when the file is absent. */
const readJson = (path) =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;

/** Read text, or an empty string when the file is absent. */
const readText = (path) =>
    existsSync(path) ? readFileSync(path, "utf8") : "";

/** Write JSON with a trailing newline. */
const writeJson = (path, value) =>
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");

/** SHA-256 of a string. */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

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

/** Token usage from an `opencode run --format json` trail. */
function usageOf(stdoutPath) {
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, steps: 0 };
    for (const line of readText(stdoutPath).split("\n")) {
        if (line.trim() === "") continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }
        if (event.type !== "step_finish" || !event.part?.tokens) continue;
        usage.steps += 1;
        usage.input += event.part.tokens.input ?? 0;
        usage.output += event.part.tokens.output ?? 0;
        usage.reasoning += event.part.tokens.reasoning ?? 0;
        usage.cacheRead += event.part.tokens.cache?.read ?? 0;
    }
    return usage;
}

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

/**
 * Record the deterministic gate verdict for each stamp's recorded trials.
 * @param args `--repo`, `--base`, `--cases`, `--stamps`.
 * @returns 0 when every stamp produced a gate record, else 1.
 */
function gate(args) {
    const repo = need(args, "--repo");
    const base = need(args, "--base");
    const stamps = need(args, "--stamps").split(",").filter(Boolean);
    const roots = {
        results: join(base, "results"),
        prompts: join(base, "prompts"),
        fixtures: join(base, "fixtures"),
        rubrics: join(base, "rubrics"),
    };
    let failures = 0;
    for (const stamp of stamps) {
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
                    need(args, "--cases"),
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
 * Assemble one arm-blind packet for a completed trial.
 * @param base The stage's result roots.
 * @param stamp The trial stamp.
 * @param caseId The scenario id.
 * @param truth The scenario-truth map.
 * @returns The packet pieces and the mutation facts behind them.
 */
function packetFor(base, stamp, caseId, truth) {
    const caseDir = join(base, "results", stamp, caseId);
    const beforeDocs = lakeDocs(join(base, "fixtures", caseId, "lakes/docs"));
    const afterDocs = lakeDocs(join(caseDir, "live/lakes/docs"));
    const state = docChanges(beforeDocs, afterDocs);
    const writes = readText(join(caseDir, "writes.txt"));
    const primary = readJson(join(caseDir, "primary-check.json"));
    const operations = [];
    for (const line of readText(join(caseDir, "docs-operations.jsonl")).split("\n")) {
        if (line.trim() === "") continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        const input = entry.input ?? {};
        const parts = [];
        if (typeof input.search === "string") parts.push(`search "${input.search}"`);
        if (typeof input.read === "string") parts.push(`read ${input.read}`);
        if (typeof input.check === "string") parts.push(`check ${input.check}`);
        if (input.add) {
            parts.push(`${input.add.mode ?? "create"} ${input.add.path ?? "(body)"}`);
        }
        operations.push(
            `${entry.status ?? "unknown"} ${entry.surface === "codemode-twin" ? "twin" : "native"} ${parts.join("; ") || "help"}`,
        );
    }
    const prompt = buildAcPrompt({
        taskPrompt: readText(join(caseDir, "prompt.md")),
        standingPermission: readText(
            join(base, "fixtures", caseId, "work/AGENTS.md"),
        ),
        scenarioTruth: truth[caseId],
        beforeDocs,
        afterDocs,
        changedPaths: writes
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "" && line !== "none")
            .map((line) =>
                line
                    .replace(/^[a-z]+: /, "")
                    .replace(/ \((file|dir|symlink|mode)\)$/, ""),
            ),
        primary: {
            status: primary?.status ?? "missing",
            exit: primary?.exit ?? null,
            stdout: String(primary?.stdout ?? "").slice(0, 8000),
            stderr: String(primary?.stderr ?? "").slice(0, 4000),
        },
        docsOperations: operations,
        answer: readText(join(caseDir, "final.md")),
    });
    return { caseDir, prompt, state };
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
    const launcher = need(args, "--launcher");
    const attemptDir = join(base, "results", stamp, caseId, "ac", "attempt-001");
    if (existsSync(join(attemptDir, "judgement.json"))) return 0;
    const { prompt, state } = packetFor(base, stamp, caseId, truth);
    const leaks = labelLeaks(prompt);
    if (leaks.length > 0) {
        console.error(`refusing a packet with label leaks: ${leaks.join(", ")}`);
        return 3;
    }
    const runDir = join(need(args, "--workdir"), `${stamp}-${caseId}`);
    mkdirSync(join(runDir, "work"), { recursive: true });
    writeFileSync(join(runDir, "prompt.md"), prompt, "utf8");
    const started = Date.now();
    const result = spawnSync(
        launcher,
        [
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
        ],
        {
            cwd: join(runDir, "work"),
            encoding: "utf8",
            timeout: Number(args.get("--timeout") ?? 240000),
            maxBuffer: 32 * 1024 * 1024,
            env: { ...process.env, AC_RUN_DIR: runDir, AC_MODEL: model },
        },
    );
    const answer = [...(result.stdout ?? "").split("\n")]
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return undefined;
            }
        })
        .filter((event) => event?.part?.type === "text")
        .map((event) => event.part.text)
        .pop() ?? "";
    const ok =
        result.error === undefined &&
        result.signal === null &&
        result.status === 0 &&
        answer.trim() !== "";
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(join(attemptDir, "prompt.md"), prompt, "utf8");
    writeFileSync(join(attemptDir, "output.jsonl"), result.stdout ?? "", "utf8");
    writeJson(join(attemptDir, "meta.json"), {
        stamp,
        caseId,
        judgeModel: model,
        durationMs: Date.now() - started,
        exit: result.status,
        state,
        promptHash: sha256(prompt),
    });
    if (!ok) {
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
            : { status: "invalid-verdict", problems, parsed: parsed.value ?? null },
    );
    return problems.length === 0 ? 0 : 1;
}

/**
 * Resolve answers whose only defect was trailing prose after a complete JSON
 * object. Original judgements are preserved; the resolution is a separate
 * record.
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
            if (entry.name !== "judgement.json" || !path.includes("/ac/attempt-")) {
                continue;
            }
            const attemptDir = path.slice(0, -"judgement.json".length);
            const judgement = JSON.parse(readFileSync(path, "utf8"));
            if (judgement.status !== "invalid-verdict") continue;
            if (!judgement.problems?.includes("verdict is not valid JSON")) {
                refused += 1;
                continue;
            }
            if (existsSync(join(attemptDir, "resolution.json"))) continue;
            const output = readText(join(attemptDir, "output.jsonl"));
            const answer = [...output.split("\n")]
                .map((line) => {
                    try {
                        return JSON.parse(line);
                    } catch {
                        return undefined;
                    }
                })
                .filter((event) => event?.part?.type === "text")
                .map((event) => event.part.text)
                .pop() ?? "";
            const meta = JSON.parse(readFileSync(join(attemptDir, "meta.json"), "utf8"));
            const extracted = firstBalancedObject(answer);
            let record = { status: "unresolved", method: "first-balanced-object" };
            if (extracted !== undefined) {
                try {
                    const parsed = JSON.parse(extracted);
                    const problems = validateAcJudgement(parsed, meta.state);
                    record =
                        problems.length === 0
                            ? { status: "judged", method: "first-balanced-object", parsed }
                            : { status: "unresolved", method: "first-balanced-object", problems };
                } catch (error) {
                    record.reason = String(error);
                }
            }
            writeJson(join(attemptDir, "resolution.json"), {
                ...record,
                originalOutputSha256: sha256(output),
                originalJudgement: judgement,
            });
            if (record.status !== "judged") refused += 1;
        }
    };
    visit(join(base, "results"));
    return refused === 0 ? 0 : 1;
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
    const finalist = finalistAt ? JSON.parse(readFileSync(finalistAt, "utf8")) : null;
    const slots = schedule[stage] ?? [];
    const baseOf = (arm) =>
        stage === "confirmation"
            ? join(root, "gen", arm.toLowerCase(), "holdout")
            : join(root, "gen", arm.toLowerCase());
    const armOf = (slot) =>
        slot.role === "F" ? finalist?.arm ?? "?" : slot.role === "A" ? finalist?.control ?? "A" : slot.arm;
    const trials = [];
    for (const slot of slots) {
        const arm = armOf(slot);
        const dir = join(baseOf(arm), "results", slot.stamp, slot.scenario);
        const meta = readJson(join(dir, "meta.json"));
        const gateAt = readJson(join(dir, "gate.json"));
        const primary = readJson(join(dir, "primary-check.json"));
        const raw = readJson(join(dir, "ac/attempt-001/judgement.json"));
        const resolution = readJson(join(dir, "ac/attempt-001/resolution.json"));
        const judgement =
            resolution?.status === "judged"
                ? { status: "judged", ...resolution.parsed }
                : raw;
        const acMeta = readJson(join(dir, "ac/attempt-001/meta.json"));
        trials.push({
            stage,
            slot: slot.slot,
            stamp: slot.stamp,
            arm,
            role: slot.role ?? null,
            scenario: slot.scenario,
            repetition: slot.repetition,
            attempted: existsSync(dir),
            usable:
                meta !== null &&
                meta.exit === 0 &&
                meta.signal === null &&
                meta.timedOut !== true &&
                meta.outputOverflow !== true &&
                meta.answerValid === true,
            assessmentStatus: judgement?.status ?? (existsSync(dir) ? "unassessed" : "not-run"),
            outcome: judgement?.status === "judged" ? judgement.documentationOutcome : undefined,
            primary:
                primary?.status === "pass"
                    ? "pass"
                    : primary?.status === "fail"
                      ? "fail"
                      : "unknown",
            guardrailBreach:
                (meta?.policyViolations?.length ?? 0) > 0 ||
                /preserved .* was (added|modified|removed)/.test(gateAt?.reason ?? ""),
            gateStatus: gateAt?.status ?? "missing",
            gateReason: gateAt?.reason ?? null,
            policyViolations: meta?.policyViolations ?? [],
            writes: meta?.writes ?? null,
            tokens: usageOf(join(dir, "stdout.jsonl")),
            durationMs:
                meta?.timings?.totalMs ??
                (meta?.startedAt && meta?.finishedAt
                    ? Date.parse(meta.finishedAt) - Date.parse(meta.startedAt)
                    : null),
            acDurationMs: acMeta?.durationMs ?? null,
            acTokens: acMeta?.usage ?? null,
            acReason: judgement?.documentationReason ?? null,
            acEvidence: judgement?.evidence ?? [],
            writesText: readText(join(dir, "writes.txt")),
        });
    }
    const toScored = (trial) => ({
        arm: trial.arm,
        scenario: trial.scenario,
        planned: true,
        usable: trial.usable,
        outcome: trial.outcome,
        primary: trial.primary,
        guardrailBreach: trial.guardrailBreach,
    });
    const arms = [...new Set(trials.map((trial) => trial.arm))].sort();
    const summaries = {};
    for (const arm of arms) {
        const rows = trials.filter((trial) => trial.arm === arm);
        const summary = summariseArm(rows.map(toScored));
        summary.attempted = rows.filter((trial) => trial.attempted).length;
        summary.gatePass = rows.filter((trial) => trial.gateStatus === "pass").length;
        summary.gateBlocked = rows.filter((trial) => trial.gateStatus === "blocked").length;
        summary.tokens = rows.reduce(
            (total, trial) => ({
                input: total.input + trial.tokens.input,
                output: total.output + trial.tokens.output,
                reasoning: total.reasoning + trial.tokens.reasoning,
                cacheRead: total.cacheRead + trial.tokens.cacheRead,
                judgeInput: total.judgeInput + (trial.acTokens?.input ?? 0),
                judgeOutput: total.judgeOutput + (trial.acTokens?.output ?? 0),
            }),
            { input: 0, output: 0, reasoning: 0, cacheRead: 0, judgeInput: 0, judgeOutput: 0 },
        );
        summaries[arm] = summary;
    }
    const scenarioRows = [];
    for (const arm of arms) {
        for (const scenario of [...new Set(trials.map((trial) => trial.scenario))]) {
            const rows = trials.filter(
                (trial) => trial.arm === arm && trial.scenario === scenario,
            );
            if (rows.length === 0) continue;
            const summary = summariseArm(rows.map(toScored));
            scenarioRows.push({
                arm,
                scenario,
                planned: summary.planned,
                attempted: rows.filter((row) => row.attempted).length,
                usable: summary.usable,
                assessed: summary.assessed,
                primaryPass: summary.primaryPass,
                primaryFail: summary.primaryFail,
                primaryUnknown: summary.primaryUnknown,
                gatePass: rows.filter((row) => row.gateStatus === "pass").length,
                gateBlocked: rows.filter((row) => row.gateStatus === "blocked").length,
                outcomes: summary.outcomes,
                total: summary.total,
            });
        }
    }
    const controlArm = finalist?.control ?? "A";
    const cells = sensitivity(
        Object.fromEntries(
            arms.map((arm) => [arm, trials.filter((trial) => trial.arm === arm).map(toScored)]),
        ),
        [3, 5, 8],
        [0.5, 1, 2],
    );
    const charactersAt = args.get("--characters");
    const characters = charactersAt
        ? JSON.parse(readFileSync(charactersAt, "utf8"))
        : null;
    const ranked = characters
        ? rankCandidates(
              arms
                  .filter((arm) => arm !== controlArm)
                  .map((arm) => ({
                      arm,
                      characters: characters[arm],
                      summary: summaries[arm],
                  })),
          )
        : null;
    const analysis = {
        stage,
        weights: { useful: 5, transient: -1, duplicate: -2, misleading: -5 },
        controlArm,
        arms,
        summaries,
        scenarioRows,
        trials,
        cells,
        ranked,
        qualifying: arms
            .filter((arm) => arm !== controlArm)
            .map((arm) => ({
                arm,
                verdict: finalistQualifies(summaries[controlArm], summaries[arm], 2),
            })),
    };
    mkdirSync(outDir, { recursive: true });
    writeJson(join(outDir, `ANALYSIS-${stage}.json`), analysis);
    const table = [
        `# ${stage} summary`,
        "",
        "| Arm | Total | Mean | Primary P/F | Gate pass/blocked | Create/update/transient/duplicate/misleading/none |",
        "| --- | --- | --- | --- | --- | --- |",
        ...arms.map((arm) => {
            const summary = summaries[arm];
            const outcomes = [
                "useful-create",
                "useful-update",
                "transient",
                "duplicate",
                "misleading",
                "none",
            ]
                .map((key) => summary.outcomes[key])
                .join("/");
            return `| ${arm} | ${summary.total} | ${summary.meanPerPlanned?.toFixed(2) ?? "unknown"} | ${summary.primaryPass}/${summary.primaryFail} | ${summary.gatePass}/${summary.gateBlocked} | ${outcomes} |`;
        }),
        "",
        `Documentation score is ${documentationScore("useful-create")} per useful create or update; the primary check contributes separately.`,
        "",
    ];
    writeFileSync(join(outDir, `REPORT-${stage}.md`), table.join("\n"), "utf8");
    return 0;
}

/**
 * Hash (or verify) every evidence file, excluding signing keys.
 * @param args `--root` and either `--write` or `--verify`.
 * @returns 0 when written or verified, 1 when verification fails.
 */
function manifest(args) {
    const root = need(args, "--root");
    const mode = args.get("--write") !== undefined ? "write" : "verify";
    const manifestPath = join(root, "evidence/EVIDENCE.sha256");
    const walk = (dir, files = []) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === "node_modules" || entry.name === ".git") continue;
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
    if (mode === "write") {
        writeFileSync(manifestPath, rows.join("\n") + "\n", "utf8");
        return 0;
    }
    const recorded = new Map(
        readText(manifestPath)
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => {
                const [hash, ...rest] = line.split("  ");
                return [rest.join("  "), hash];
            }),
    );
    const problems = rows.filter((line) => {
        const [hash, ...rest] = line.split("  ");
        return recorded.get(rest.join("  ")) !== hash;
    });
    if (problems.length > 0 || recorded.size !== rows.length) {
        console.error(`manifest mismatch: ${problems.length} row(s)`);
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
                    generator: "mulberry32; arm order shuffled per block; scenario order rotated",
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
