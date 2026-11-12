// Freeze every identity the screen depends on before any scored session.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    deliveredToolDescription,
    freezeExperiment,
} from "../runner/freeze.ts";

const ROOT = process.env.CAMPAIGN_ROOT;
if (!ROOT) throw new Error("CAMPAIGN_ROOT is required");
const MAIN = process.env.CAMPAIGN_SOURCE_REPO ?? process.cwd();
const EVIDENCE = join(ROOT, "evidence");
const MODEL = "opencode-go/deepseek-v4.1-flash";
const STOPPING_RULES = [
    "stop on the first unusable assessment",
    "stop on a broken premise or changed immutable input",
    "stop at the frozen trial and judge ceilings",
];

const hash = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
const hashText = (text) =>
    createHash("sha256").update(text, "utf8").digest("hex");
const git = (repo, ...args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const text = (path) => readFileSync(path, "utf8");

/** Every file under a directory, recursively, sorted. */
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

/** Hash one absolute path as a root-relative immutable input. */
const frozenFile = (path) => ({
    path: path.slice(ROOT.length + 1),
    sha256: hash(path),
});

/** One immutable directory and its complete file inventory. */
const frozenInventory = (dir) => ({
    path: dir.slice(ROOT.length + 1),
    files: filesUnder(dir).map(frozenFile),
});

/**
 * Build (or resolve) the image before freezing, then keep its immutable id.
 * A tag rebuilt between freeze and dispatch can no longer change what runs.
 */
const resolveImage = () => {
    try {
        const id = execFileSync(
            join(
                ROOT,
                "arms/a/tests/fixtures/placement-harness/container-run.sh",
            ),
            ["build-image"],
            { encoding: "utf8", env: { ...process.env } },
        ).trim();
        if (id === "") return "unavailable: image build returned no id";
        return id;
    } catch (error) {
        return `unavailable: ${String(error)}`;
    }
};
const capture = (command, args) => {
    try {
        return execFileSync(command, args, { encoding: "utf8" }).trim();
    } catch (error) {
        return `unavailable: ${String(error)}`;
    }
};

const schedule = json(join(ROOT, "evidence/schedule.json"));
const scenarios = ["R01", "S02", "R02", "R03", "S05", "S06", "S07", "R04"];

const arm = (letter) => {
    const repo = join(ROOT, "arms", letter);
    const surfaces = json(join(ROOT, `evidence/surfaces-${letter}.json`));
    // The provider request the delivery probe actually received. No
    // hand-extracted copy: the served description is read from the payload.
    const probe = json(
        join(ROOT, `evidence/delivery-${letter}/request-1.json`),
    );
    const served = deliveredToolDescription(probe);
    if (served.delivered === undefined) {
        throw new Error(
            `delivery ${letter}: ${served.problem ?? "no served description"}`,
        );
    }
    const delivery = {
        model: probe.model ?? null,
        nativeChars: served.delivered.chars,
        nativeHash: served.delivered.sha256,
    };
    const generations = Object.fromEntries(
        scenarios.map((id) => {
            const record = json(
                join(ROOT, `gen/${letter}/fixtures/${id}/generation.json`),
            );
            return [
                id,
                {
                    pluginHash: record.pluginHash,
                    inputsHash: record.inputsHash,
                    promptHash: record.outputs?.promptHash ?? null,
                },
            ];
        }),
    );
    return {
        repo,
        commit: git(repo, "rev-parse", "HEAD"),
        tree: git(repo, "rev-parse", "HEAD^{tree}"),
        clean: git(repo, "status", "--porcelain") === "",
        srcIndexSha256: hash(join(repo, "src/index.ts")),
        surfaces,
        delivery,
        generations,
    };
};

const prompts = Object.fromEntries(
    scenarios.map((id) => [
        id,
        {
            a: hash(join(ROOT, "gen/a/prompts", `${id}.md`)),
            b: hash(join(ROOT, "gen/b/prompts", `${id}.md`)),
        },
    ]),
);

const identities = {
    campaign: schedule.campaign,
    frozenAt: new Date().toISOString(),
    base: {
        repo: MAIN,
        branch: git(MAIN, "rev-parse", "--abbrev-ref", "HEAD"),
        commit: git(MAIN, "rev-parse", "HEAD"),
        tree: git(MAIN, "rev-parse", "HEAD^{tree}"),
        clean: git(MAIN, "status", "--porcelain") === "",
    },
    arms: { A: arm("a"), B: arm("b") },
    measurement: {
        repo: join(ROOT, "measurement"),
        commit: git(join(ROOT, "measurement"), "rev-parse", "HEAD"),
        tree: git(join(ROOT, "measurement"), "rev-parse", "HEAD^{tree}"),
        clean: git(join(ROOT, "measurement"), "status", "--porcelain") === "",
        files: {
            acScoring: hash(
                join(
                    ROOT,
                    "measurement/tests/fixtures/placement-harness/ac-scoring.mts",
                ),
            ),
            acRunner: hash(
                join(
                    ROOT,
                    "measurement/tests/fixtures/placement-harness/ac/run.mjs",
                ),
            ),
            judgeLauncher: hash(
                join(
                    ROOT,
                    "measurement/tests/fixtures/placement-harness/ac/judge-launcher.sh",
                ),
            ),
            analyser: hash(
                join(
                    ROOT,
                    "measurement/tests/fixtures/placement-harness/analysis/analyse.mts",
                ),
            ),
            driver: hash(join(ROOT, "prepare/run.mjs")),
            manifest: hash(join(ROOT, "prepare/manifest.json")),
        },
    },
    corpus: {
        path: join(
            ROOT,
            "arms/a/tests/fixtures/placement-harness/prod014/cases.json",
        ),
        sha256: hash(
            join(
                ROOT,
                "arms/a/tests/fixtures/placement-harness/prod014/cases.json",
            ),
        ),
        bSha256: hash(
            join(
                ROOT,
                "arms/b/tests/fixtures/placement-harness/prod014/cases.json",
            ),
        ),
    },
    truth: {
        sha256: hash(
            join(
                ROOT,
                "arms/a/tests/fixtures/placement-harness/prod014/truth.json",
            ),
        ),
    },
    measurementSpec: {
        path: join(ROOT, "evidence/measurement-spec.json"),
        sha256: hash(join(ROOT, "evidence/measurement-spec.json")),
    },
    schedule: {
        path: join(ROOT, "evidence/schedule.json"),
        slotsSha256: hashText(JSON.stringify(schedule.slots)),
        fileSha256: hash(join(ROOT, "evidence/schedule.json")),
        slots: schedule.slots.length,
        pairs: new Set(schedule.slots.map((slot) => slot.pairId)).size,
    },
    prompts,
    primaryChecks: Object.fromEntries(
        ["R01", "S02", "R02", "R03", "S05", "S06", "S07", "R04"].map((id) => {
            const found = json(
                join(
                    ROOT,
                    "arms/a/tests/fixtures/placement-harness/prod014/cases.json",
                ),
            ).find((entry) => entry.id === id);
            return [
                id,
                hash(
                    join(
                        ROOT,
                        "arms/a/tests/fixtures/placement-harness/primary-checks",
                        found.primaryCheck.script,
                    ),
                ),
            ];
        }),
    ),
    models: {
        trial: "opencode-go/deepseek-v4.1-flash",
        trialName: "DeepSeek V4.1 Flash 1017 (catalogue)",
        trialVariant: "none selected; catalogue variants low/high/max",
        judge: "zai-coding-plan/glm-5.3-flash",
    },
    runtime: {
        hostOpencode: capture("opencode", ["--version"]),
        node: process.version,
        image: "localhost/opencode-placement-trials",
        imageId: resolveImage(),
        containerCli: capture("podman", ["--version"]),
    },
    budget: {
        plannedTrials: 16,
        plannedJudgeAttempts: 16,
        trialTimeoutMs: 600000,
        judgeTimeoutMs: 600000,
        workers: 1,
    },
};

const problems = [];
for (const [id, pair] of Object.entries(prompts)) {
    if (pair.a !== pair.b) problems.push(`prompt differs between arms: ${id}`);
}
if (identities.corpus.sha256 !== identities.corpus.bSha256)
    problems.push("corpus differs between arms");
if (
    identities.arms.A.surfaces.nativeHash ===
    identities.arms.B.surfaces.nativeHash
)
    problems.push("A and B descriptions are identical");
if (
    identities.arms.A.delivery.model !== MODEL ||
    identities.arms.B.delivery.model !== MODEL
) {
    problems.push("a delivery probe served a different model");
}
if (
    identities.arms.A.delivery.nativeHash !==
    identities.arms.A.surfaces.nativeHash
)
    problems.push("A delivered description differs from the registered one");
if (
    identities.arms.B.delivery.nativeHash !==
    identities.arms.B.surfaces.nativeHash
)
    problems.push("B delivered description differs from the registered one");
if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
}

const armFreeze = (letter) => ({
    id: letter.toUpperCase(),
    commit: identities.arms[letter.toUpperCase()].commit,
    tree: identities.arms[letter.toUpperCase()].tree,
    clean: identities.arms[letter.toUpperCase()].clean,
    descriptionChars:
        identities.arms[letter.toUpperCase()].surfaces.nativeChars,
    descriptionHash: identities.arms[letter.toUpperCase()].surfaces.nativeHash,
    deliveredChars: identities.arms[letter.toUpperCase()].delivery.nativeChars,
    deliveredHash: identities.arms[letter.toUpperCase()].delivery.nativeHash,
    annotationChars:
        identities.arms[letter.toUpperCase()].surfaces.annotationChars,
    annotationHash:
        identities.arms[letter.toUpperCase()].surfaces.annotationHash,
});

const inventoryDirs = [
    join(ROOT, "gen/a/prompts"),
    join(ROOT, "gen/b/prompts"),
    join(ROOT, "gen/a/fixtures"),
    join(ROOT, "gen/b/fixtures"),
    join(ROOT, "gen/a/rubrics"),
    join(ROOT, "gen/b/rubrics"),
    join(ROOT, "arms/a/src"),
    join(ROOT, "arms/b/src"),
    join(ROOT, "arms/a/tests/fixtures/placement-harness/primary-checks"),
    join(ROOT, "measurement/tests/fixtures/placement-harness/analysis"),
    join(ROOT, "measurement/tests/fixtures/placement-harness/ac"),
];

const immutable = [
    ...filesUnder(join(ROOT, "prepare")),
    ...filesUnder(join(ROOT, "runner")),
    ...["a", "b"].flatMap((letter) => [
        join(
            ROOT,
            `arms/${letter}/tests/fixtures/placement-harness/container-run.sh`,
        ),
        join(
            ROOT,
            `arms/${letter}/tests/fixtures/placement-harness/harness.mts`,
        ),
        join(
            ROOT,
            `arms/${letter}/tests/fixtures/placement-harness/scenario-names.mts`,
        ),
        join(ROOT, `arms/${letter}/package.json`),
        join(ROOT, `arms/${letter}/package-lock.json`),
        join(ROOT, `evidence/surfaces-${letter}.json`),
        join(ROOT, `evidence/delivery-${letter}/request-1.json`),
    ]),
    join(EVIDENCE, "schedule.json"),
    join(EVIDENCE, "measurement-spec.json"),
    join(ROOT, "arms/a/tests/fixtures/placement-harness/prod014/cases.json"),
    join(ROOT, "arms/a/tests/fixtures/placement-harness/prod014/truth.json"),
    join(ROOT, "measurement/tests/fixtures/placement-harness/ac-scoring.mts"),
    join(ROOT, "measurement/tests/fixtures/placement-harness/harness.mts"),
    join(
        ROOT,
        "measurement/tests/fixtures/placement-harness/analysis/analyse.mts",
    ),
];
const inventories = inventoryDirs.map(frozenInventory);

const started =
    ["a", "b"].some((letter) => {
        const dir = join(ROOT, `gen/${letter}/results`);
        return existsSync(dir) && readdirSync(dir).length > 0;
    }) ||
    (existsSync(join(EVIDENCE, "ATTEMPTS.jsonl")) &&
        text(join(EVIDENCE, "ATTEMPTS.jsonl")).trim() !== "");

const decision = freezeExperiment({
    campaign: identities.campaign,
    sourceRevision: identities.base.commit,
    sourceTree: identities.base.tree,
    imageId: identities.runtime.imageId,
    containerCli: identities.runtime.containerCli,
    measurementSha256: identities.measurementSpec.sha256,
    arms: [armFreeze("a"), armFreeze("b")],
    files: immutable.map(frozenFile),
    inventories,
    stoppingRules: STOPPING_RULES,
    ceilings: {
        trial: identities.budget.plannedTrials,
        judge: identities.budget.plannedJudgeAttempts,
    },
    started,
    frozen:
        existsSync(join(EVIDENCE, "FROZEN.json")) ||
        existsSync(join(EVIDENCE, "frozen-identities.json")),
});

if (!decision.ok) {
    console.error(decision.problems.join("\n"));
    process.exit(1);
}

writeFileSync(
    join(ROOT, "evidence/frozen-identities.json"),
    `${JSON.stringify(identities, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
);
writeFileSync(
    join(ROOT, "evidence/FROZEN.json"),
    `${JSON.stringify(
        {
            campaign: identities.campaign,
            frozenAt: identities.frozenAt,
            baseCommit: identities.base.commit,
            armA: identities.arms.A.commit,
            armB: identities.arms.B.commit,
            measurement: identities.measurement.commit,
            scheduleSha256: identities.schedule.slotsSha256,
            corpusSha256: identities.corpus.sha256,
            promptsIdentical: true,
            trialModel: identities.models.trial,
            judgeModel: identities.models.judge,
            imageId: identities.runtime.imageId,
            budget: identities.budget,
            freeze: decision.record,
        },
        null,
        2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
);
console.log(
    `frozen: A ${identities.arms.A.surfaces.nativeChars} ${identities.arms.A.surfaces.nativeHash}; B ${identities.arms.B.surfaces.nativeChars} ${identities.arms.B.surfaces.nativeHash}; ${identities.schedule.slots} slots`,
);
