#!/usr/bin/env node
/**
 * Behavioural trial harness for tests/fixtures/placement-cases.json.
 *
 * `generate` materialises the reusable harness on disk:
 *   - one prompt per case under ~/tmp/docs-placement/prompts/
 *   - one fixture tree per case under ~/test-dir/docs-placement/
 *
 * `run` copies a pristine fixture into a results directory, runs one headless
 * OpenCode session there, and records the answer, tool calls and any writes.
 * The container mount is the enforced boundary; permission rules requesting
 * no shell, edits or reads outside the workspace are defence in depth. The
 * sandbox never contains the rubric: trials judge placement from the supplied
 * finding.
 * `judge` scores each recorded answer against the case rubric with a second,
 * plugin-free model call — `--judge-model` names a stronger judge than the
 * workhorse. `summary` renders the results table. `export` bundles a sweep
 * into one dossier for deep review by an external model.
 *
 * The repository, the user's OpenCode config and the fixture trees are never
 * modified by a run: each session works on its own copy.
 */
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = resolve(HERE, "..", "placement-cases.json");
const DEFAULT_PLUGIN = resolve(HERE, "..", "..", "..");
const HOME = homedir();
const COMMANDS = ["generate", "run", "judge", "summary", "export", "all"];

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** A positive per-call timeout; a malformed env value falls back loudly. */
function timeoutFromEnv() {
    const value = Number(process.env.TRIAL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

const DEFAULTS = {
    prompts: join(HOME, "tmp", "docs-placement", "prompts"),
    fixtures: join(HOME, "test-dir", "docs-placement"),
    rubrics: join(HOME, "tmp", "docs-placement", "rubrics"),
    results: join(HOME, "tmp", "docs-placement", "results"),
    model: process.env.TRIAL_MODEL || "opencode-go/deepseek-v4.1-flash",
    judgeModel: process.env.TRIAL_JUDGE_MODEL || "",
    opencode: process.env.OPENCODE_BIN || "opencode",
    fixture: DEFAULT_FIXTURE,
    plugin: DEFAULT_PLUGIN,
    timeoutMs: timeoutFromEnv(),
};

const SWITCHES = {
    "--force": "force",
    "--no-judge": "noJudge",
    "--allow-writes": "allowWrites",
    "--discovery": "discovery",
    "--help": "help",
    "-h": "help",
};
const VALUE_FLAGS = {
    "--model": { key: "model" },
    "--judge-model": { key: "judgeModel" },
    "--stamp": { key: "stamp" },
    "--opencode": { key: "opencode" },
    "--prompts": { key: "prompts", path: true },
    "--fixtures": { key: "fixtures", path: true },
    "--rubrics": { key: "rubrics", path: true },
    "--results": { key: "results", path: true },
    "--plugin": { key: "plugin", path: true },
    "--fixture": { key: "fixture", path: true },
};

function stampNow() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return (
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    );
}

function latestStamp(resultsRoot) {
    if (!existsSync(resultsRoot)) return undefined;
    return readdirSync(resultsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .at(-1);
}

function usage(message) {
    if (message) console.error(message);
    console.error(`usage:
  harness.mjs generate [E01 ...] [--force]
  harness.mjs run      [E01 ...]
  harness.mjs judge    [E01 ...]
  harness.mjs summary  [--stamp NAME]
  harness.mjs export   [--stamp NAME]
  harness.mjs all

common options:
  --model provider/model   workhorse model for trials (default ${DEFAULTS.model})
  --judge-model MODEL      model for local judging; defaults to --model. Use a
                           stronger model here, or skip judging and run
                           'export' to deep-scan a sweep with an external model
  --prompts DIR            prompt output (default ${DEFAULTS.prompts})
  --fixtures DIR           fixture root (default ${DEFAULTS.fixtures})
  --rubrics DIR            rubric/case output, kept out of the run sandbox
                           (default ${DEFAULTS.rubrics})
  --results DIR            result root (default ${DEFAULTS.results})
  --stamp NAME             result stamp (default: current time)
  --opencode BIN           OpenCode binary (default ${DEFAULTS.opencode})
  --allow-writes           judge runs that changed files (execution trials;
                           decision-only trials must leave writes: none)
  --discovery              omit destinations from prompts; the lakes are then
                           discoverable only through 'docs help', which the
                           prompt mentions without requiring

  TRIAL_TIMEOUT_MS         per-session timeout (default ${DEFAULTS.timeoutMs} ms)`);
    process.exit(2);
}

/** Apply one CLI flag; false when the argument is not a flag. */
function applyFlag(options, arg, argv) {
    const flag = SWITCHES[arg];
    if (flag === "help") usage();
    if (flag) {
        options[flag] = true;
        return true;
    }
    const spec = VALUE_FLAGS[arg];
    if (!spec) return false;
    if (argv.length === 0) usage(`${arg} needs a value`);
    const raw = argv.shift();
    options[spec.key] = spec.path ? resolve(raw) : raw;
    return true;
}

function parseArgs(argv) {
    const command = argv.shift();
    const options = {
        ...DEFAULTS,
        force: false,
        noJudge: false,
        allowWrites: false,
        discovery: false,
        ids: [],
    };
    while (argv.length > 0) {
        const arg = argv.shift();
        if (!applyFlag(options, arg, argv)) options.ids.push(arg);
    }
    if (!command || command === "help") usage();
    if (!COMMANDS.includes(command)) usage(`unknown command ${command}`);
    return { command, options };
}

function loadCases(fixturePath) {
    return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function select(options) {
    const cases = loadCases(options.fixture);
    if (options.ids.length === 0) return cases;
    const unknown = options.ids.filter(
        (id) => !cases.some((entry) => entry.id === id),
    );
    if (unknown.length > 0) usage(`unknown case(s): ${unknown.join(", ")}`);
    return cases.filter((entry) => options.ids.includes(entry.id));
}

const write = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = (path) => sha256(readFileSync(path));

const listFiles = (root) => {
    const found = [];
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile()) found.push(path);
        }
    };
    if (existsSync(root)) walk(root);
    return found.sort();
};

const promptFor = (testCase, options) => {
    // Discovery variant: the prompt names no destination and no tool — the
    // lakes are reachable only through the session's normal tool inventory
    // (the docs tool's own description points at `help`).
    const destinations = options.discovery
        ? ""
        : `Available documentation destinations:
${testCase.destinations
    .map(
        (destination) =>
            `- ${destination.name} (\`${destination.class}\`): ${destination.description}`,
    )
    .join("\n")}`;
    return `We have established the following finding.

Finding:
${testCase.claim}

Evidence:
${testCase.evidence}

${destinations ? `${destinations}\n\n` : ""}Use your normal documentation guidance to decide how to preserve this finding. For this trial, do not change files.

State:
- Your intended action.
- The exact destination lake, or other documentation workflow.
- Whether this needs one document or several.
- A brief reason.
- Any clarification needed before proceeding.

Treat the evidence descriptions as supplied facts for this synthetic trial.
`;
};

const rubricFor = (testCase) => `# ${testCase.id} rubric

Claim: ${testCase.claim}

Expected: ${testCase.expected}

Accepts:
${testCase.accepts.map((line) => `- ${line}`).join("\n")}

Tempting wrong answers:
${testCase.temptingWrong.map((line) => `- ${line}`).join("\n")}
`;

/**
 * The requested sandbox permission set. Trails have shown these denials are
 * not reliably enforced in every run context, so the container mount stays
 * the real boundary.
 */
const SANDBOX_PERMISSIONS = [
    { action: "shell", resource: "*", effect: "deny" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "*", effect: "deny" },
];

/**
 * Build one pristine case fixture. Paths in opencode.json are relative to the
 * work directory, so the whole fixture tree stays relocatable.
 */
function generateCase(testCase, options) {
    const caseDir = join(options.fixtures, testCase.id);
    const rubricDir = join(options.rubrics, testCase.id);
    const promptPath = join(options.prompts, `${testCase.id}.md`);
    const rubricPath = join(rubricDir, "rubric.md");
    const configPath = join(caseDir, "work", "opencode.json");

    // The run container deliberately has no rubric root; there, a prompt and
    // config are enough to keep the fixture. Generate requires the rubric.
    // A stored prompt only counts as kept when it matches the current
    // template — a variant or template change must regenerate, never reuse.
    // The run container's id-only case list cannot rebuild prompts: there the
    // kept check stays existence-based and the template is never computed.
    const promptComparable = testCase.claim !== undefined;
    const promptText = promptComparable
        ? promptFor(testCase, options)
        : undefined;
    const rubricRootMounted = existsSync(options.rubrics);
    if (
        !options.force &&
        existsSync(promptPath) &&
        (!promptComparable ||
            readFileSync(promptPath, "utf8") === promptText) &&
        existsSync(configPath) &&
        (!rubricRootMounted || existsSync(rubricPath))
    ) {
        return "kept";
    }

    if (options.force) {
        rmSync(caseDir, { recursive: true, force: true });
        rmSync(rubricDir, { recursive: true, force: true });
        rmSync(promptPath, { force: true });
    }

    buildFixtureTree(testCase, caseDir);

    write(promptPath, promptText);
    write(rubricPath, rubricFor(testCase));
    write(
        join(rubricDir, "case.json"),
        JSON.stringify(testCase, null, 2) + "\n",
    );
    write(
        configPath,
        JSON.stringify(
            {
                $schema: "https://opencode.ai/config.json",
                model: options.model,
                plugins: [
                    {
                        package: options.plugin,
                        options: { lakes: lakesFor(testCase, caseDir) },
                    },
                ],
                permissions: SANDBOX_PERMISSIONS,
            },
            null,
            2,
        ) + "\n",
    );
    return "created";
}

/** Create the case's work and lake directories, plus its code-shaped context. */
function buildFixtureTree(testCase, caseDir) {
    const work = join(caseDir, "work");
    mkdirSync(work, { recursive: true });
    mkdirSync(join(caseDir, "lakes"), { recursive: true });
    mkdirSync(join(caseDir, "config-home", "opencode"), { recursive: true });

    for (const destination of testCase.destinations) {
        mkdirSync(join(caseDir, "lakes", destination.name), {
            recursive: true,
        });
    }
    // E17 deliberately nests the repo lake "docs" inside the wider repo lake "outer".
    if (testCase.id === "E17")
        mkdirSync(join(caseDir, "lakes", "outer", "docs"), { recursive: true });

    // The plugin adds an implicit writable repo lake at <location>/docs when no
    // repo lake is configured. E13 and E16 list no repo destination, so pin a
    // read-only placeholder: it suppresses the implicit writable lake without
    // offering a destination the case does not list.
    if (
        !testCase.destinations.some(
            (destination) => destination.class === "repo",
        )
    ) {
        mkdirSync(join(work, "docs"), { recursive: true });
    }

    if (testCase.id === "E06") writeWorkFiles(work, WORK_FILES_E06);
    if (testCase.id === "E17") writeWorkFiles(work, WORK_FILES_E17);
    spawnSync("git", ["init", "-q", work], { stdio: "ignore" });
}

/** Lake specs for the trial config; roots are relative to the work directory. */
function lakesFor(testCase) {
    const listed = testCase.destinations.map((destination) => ({
        class: destination.class,
        // E17 nests the repo lake inside the wider outer repo lake.
        root:
            testCase.id === "E17" && destination.name === "docs"
                ? "../lakes/outer/docs"
                : `../lakes/${destination.name}`,
        name: destination.name,
        description: destination.description,
    }));
    if (
        testCase.destinations.some(
            (destination) => destination.class === "repo",
        )
    )
        return listed;
    return [
        ...listed,
        {
            class: "repo",
            root: "docs",
            name: "docs",
            writable: false,
            description:
                "Read-only placeholder; not a listed destination in this trial.",
        },
    ];
}

const WORK_FILES_E06 = {
    "package.json":
        JSON.stringify(
            {
                name: "trial-app",
                private: true,
                scripts: { test: "node --test", typecheck: "tsc --noEmit" },
            },
            null,
            2,
        ) + "\n",
    "README.md": "# Trial app\n\n```sh\nnpm test\nnpm run typecheck\n```\n",
};

const WORK_FILES_E17 = {
    "package.json":
        JSON.stringify(
            {
                name: "trial-app",
                private: true,
                scripts: { build: "node build.mjs" },
            },
            null,
            2,
        ) + "\n",
    "build.sh":
        "#!/usr/bin/env bash\nset -euo pipefail\n" +
        "# The trap this case is about: the flag must stay inside this repo's wrapper.\n" +
        "npm run build -- --legacy-peer-deps\n",
};

function writeWorkFiles(work, files) {
    for (const [name, contents] of Object.entries(files))
        write(join(work, name), contents);
}

function generateAll(options) {
    const selected = select(options);
    const rows = selected.map((testCase) => [
        testCase.id,
        generateCase(testCase, options),
    ]);
    const manifest = {
        generatedAt: new Date().toISOString(),
        ...provenance(options),
        model: options.model,
        prompts: options.prompts,
        fixture: options.fixture,
        plugin: options.plugin,
        cases: selected.map((testCase) => {
            const prompt = join(options.prompts, `${testCase.id}.md`);
            const fixture = join(options.fixtures, testCase.id);
            const rubric = join(options.rubrics, testCase.id, "rubric.md");
            return {
                id: testCase.id,
                prompt,
                promptHash: existsSync(prompt) ? fileHash(prompt) : "unknown",
                fixture,
                rubric,
                rubricHash: existsSync(rubric) ? fileHash(rubric) : "unknown",
                expected: testCase.expected,
            };
        }),
    };
    write(
        join(options.fixtures, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
    );
    for (const [id, action] of rows) console.log(`${id}: ${action}`);
    console.log(`prompts:  ${options.prompts}`);
    console.log(`fixtures: ${options.fixtures}`);
}

function parseLine(line) {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
}

function toolOutput(value) {
    return typeof value === "string" ? value.slice(0, 2000) : value;
}

function collectText(part, texts) {
    if (part?.type === "text" && typeof part.text === "string")
        texts.push(part.text);
}

function collectTool(part, tools) {
    if (part?.type !== "tool") return;
    tools.push({
        tool: part.tool,
        input: part.state?.input,
        status: part.state?.status,
        output: toolOutput(part.state?.output),
    });
}

/** Turn `opencode run --format json` JSONL into the final text and tool trail. */
function extract(stdout) {
    const texts = [];
    const tools = [];
    for (const line of stdout.split("\n").filter(Boolean)) {
        const event = parseLine(line);
        if (!event) continue;
        const part = event.part ?? event;
        collectText(part, texts);
        collectTool(part, tools);
    }
    return {
        text: texts.join("\n").trim() + "\n",
        tools:
            tools.map((entry) => JSON.stringify(entry)).join("\n") +
            (tools.length > 0 ? "\n" : ""),
    };
}

function childEnv(configHome) {
    const env = { ...process.env };
    for (const key of [
        "OPENCODE_SESSION_ID",
        "OPENCODE_TERMINAL",
        "OPENCODE",
        "AI_AGENT",
    ]) {
        delete env[key];
    }
    env.XDG_CONFIG_HOME = configHome;
    return env;
}

function opencodeVersion(options) {
    if (!options.cliVersion) {
        const probe = spawnSync(options.opencode, ["--version"], {
            encoding: "utf8",
        });
        options.cliVersion = (probe.stdout ?? "").trim() || "unknown";
    }
    return options.cliVersion;
}

/** One git fact, or "unknown" when the plugin is not a checkout. */
function gitFact(directory, args) {
    const probe = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    return probe.status === 0 ? (probe.stdout ?? "").trim() : "unknown";
}

/** The real fixture hash, even when a run container sees only a redacted list. */
function fixtureHashOf(options) {
    if (process.env.PLACEMENT_FIXTURE_HASH) {
        return process.env.PLACEMENT_FIXTURE_HASH;
    }
    if (existsSync(options.fixture)) return fileHash(options.fixture);
    const manifest = readJson(join(options.fixtures, "manifest.json"));
    return manifest?.fixtureHash ?? "unknown";
}

/** A stable content hash for the plugin package, even under a curated mount. */
function pluginHashOf(options) {
    const parts = ["package.json", join("src", "index.ts")].filter((name) =>
        existsSync(join(options.plugin, name)),
    );
    if (parts.length === 0) return "unknown";
    return sha256(
        parts
            .map((name) => readFileSync(join(options.plugin, name)))
            .join("\n"),
    );
}

function pluginCommitOf(options) {
    const commit = gitFact(options.plugin, ["rev-parse", "HEAD"]);
    if (commit !== "unknown") return commit;
    return process.env.PLACEMENT_PLUGIN_COMMIT || "unknown";
}

function pluginDirtyOf(options) {
    const status = gitFact(options.plugin, ["status", "--porcelain"]);
    if (status === "unknown") return process.env.PLACEMENT_PLUGIN_DIRTY === "1";
    return status !== "";
}

/** Content hashes and versions that make a result reproducible. */
function provenance(options) {
    const fixtureHash = fixtureHashOf(options);
    return {
        fixture: options.fixture,
        fixtureHash,
        fixtureVersion: `sha256:${fixtureHash.slice(0, 12)}`,
        plugin: options.plugin,
        pluginHash: pluginHashOf(options),
        pluginCommit: pluginCommitOf(options),
        pluginDirty: pluginDirtyOf(options),
        opencode: opencodeVersion(options),
        image: process.env.PLACEMENT_IMAGE ?? "",
        imageId: process.env.PLACEMENT_IMAGE_ID ?? "",
        args: process.argv.slice(2),
    };
}

function opencodeCall({ cwd, env, model, title, prompt, opencode, timeoutMs }) {
    return spawnSync(
        opencode,
        [
            "run",
            "--standalone",
            "--auto",
            "--archived",
            "--title",
            title,
            "--model",
            model,
            "--format",
            "json",
            prompt,
        ],
        {
            cwd,
            env,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            timeout: timeoutMs,
        },
    );
}

/** Copy only the sandbox surfaces; rubric.md and case.json stay out of reach. */
function copySandbox(caseFixture, live) {
    for (const surface of ["work", "lakes", "config-home"]) {
        cpSync(join(caseFixture, surface), join(live, surface), {
            recursive: true,
        });
    }
}

/**
 * Hash every trial-visible file, so an edit to an existing README or lake doc
 * is a write even when no path was added or removed. `.git` is scaffolding, not
 * trial content, so it is excluded.
 */
function snapshotLive(live) {
    const roots = [
        ["work", join(live, "work")],
        ["lakes", join(live, "lakes")],
    ];
    const files = new Map();
    for (const [prefix, root] of roots) {
        for (const path of listFiles(root)) {
            const name = relative(root, path);
            if (name.split(sep).includes(".git")) continue;
            files.set(`${prefix}/${name}`, fileHash(path));
        }
    }
    return files;
}

function snapshotDiff(before, after) {
    const added = [];
    const modified = [];
    const removed = [];
    for (const [path, hash] of after) {
        if (!before.has(path)) added.push(path);
        else if (before.get(path) !== hash) modified.push(path);
    }
    for (const path of before.keys()) {
        if (!after.has(path)) removed.push(path);
    }
    return {
        added: added.sort(),
        modified: modified.sort(),
        removed: removed.sort(),
    };
}

const writeCount = (diff) =>
    diff.added.length + diff.modified.length + diff.removed.length;

function writesReport(diff) {
    const lines = [
        ...diff.added.map((path) => `added: ${path}`),
        ...diff.modified.map((path) => `modified: ${path}`),
        ...diff.removed.map((path) => `removed: ${path}`),
    ];
    return lines.length > 0 ? lines.join("\n") + "\n" : "none\n";
}

function metaFor(
    testCase,
    options,
    promptPath,
    caseFixture,
    startedAt,
    result,
    diff,
    answerHash,
) {
    return (
        JSON.stringify(
            {
                ...provenance(options),
                case: testCase.id,
                model: options.model,
                prompt: promptPath,
                promptHash: existsSync(promptPath)
                    ? fileHash(promptPath)
                    : "unknown",
                caseFixture,
                startedAt,
                finishedAt: new Date().toISOString(),
                exit: result.status,
                signal: result.signal ?? null,
                error: result.error
                    ? (result.error.code ?? String(result.error))
                    : null,
                writes: writeCount(diff),
                writeKinds: diff,
                answerHash,
            },
            null,
            2,
        ) + "\n"
    );
}

/** Whether a recorded run already occupies this result directory. */
function resultExists(resultDir) {
    return (
        existsSync(join(resultDir, "meta.json")) ||
        existsSync(join(resultDir, "final.md"))
    );
}

/**
 * Copy the rubric and case after the answer exists, never before the run. In
 * the per-case run container the rubric root is not mounted, so this is a
 * no-op and the host copies them after the container exits.
 */
function copyCaseEvidence(options, testCase, resultDir) {
    const sourceDir = join(options.rubrics, testCase.id);
    for (const name of ["rubric.md", "case.json"]) {
        const source = join(sourceDir, name);
        if (existsSync(source)) cpSync(source, join(resultDir, name));
    }
}

function runOne(testCase, options, stamp) {
    const promptPath = join(options.prompts, `${testCase.id}.md`);
    if (!existsSync(promptPath)) generateCase(testCase, options);

    const caseFixture = join(options.fixtures, testCase.id);
    const resultDir = join(options.results, stamp, testCase.id);
    // A run is evidence, not scratch: rerunning the same stamp would mix
    // answers, tool trails and verdicts. A fresh stamp is the only way to
    // repeat a case.
    if (resultExists(resultDir)) {
        console.error(
            `${testCase.id}: result already exists at ${resultDir}; ` +
                "use a new --stamp instead of overwriting a run",
        );
        return 1;
    }

    const live = join(resultDir, "live");
    rmSync(live, { recursive: true, force: true });
    copySandbox(caseFixture, live);
    cpSync(promptPath, join(resultDir, "prompt.md"));

    const before = snapshotLive(live);
    const startedAt = new Date().toISOString();
    const result = opencodeCall({
        cwd: join(live, "work"),
        env: childEnv(join(live, "config-home")),
        model: options.model,
        title: `placement-${testCase.id}`,
        prompt: readFileSync(promptPath, "utf8"),
        opencode: options.opencode,
        timeoutMs: options.timeoutMs,
    });
    const diff = snapshotDiff(before, snapshotLive(live));
    const { text, tools } = extract(result.stdout ?? "");
    const answerHash = sha256(text);

    write(join(resultDir, "stdout.jsonl"), result.stdout ?? "");
    write(join(resultDir, "stderr.log"), result.stderr ?? "");
    write(
        join(resultDir, "exit-code"),
        `${result.status ?? `signal:${result.signal}`}\n`,
    );
    write(join(resultDir, "writes.txt"), writesReport(diff));
    write(join(resultDir, "final.md"), text);
    write(join(resultDir, "tools.jsonl"), tools);
    write(
        join(resultDir, "meta.json"),
        metaFor(
            testCase,
            options,
            promptPath,
            caseFixture,
            startedAt,
            result,
            diff,
            answerHash,
        ),
    );
    // The rubric stays out of the sandbox until the answer exists. The same
    // applies to case.json, which carries the rubric's expectations.
    copyCaseEvidence(options, testCase, resultDir);

    const writes = writeCount(diff);
    console.log(
        `${testCase.id}: exit ${result.status ?? "signal"}, writes ${writes} -> ${resultDir}`,
    );
    // The run is recorded even when the model call failed; judging gates on
    // completion and reports an invalid run instead of a placement failure.
    return 0;
}

function judgePrompt(resultDir) {
    const rubric = readFileSync(join(resultDir, "rubric.md"), "utf8");
    const answer = existsSync(join(resultDir, "final.md"))
        ? readFileSync(join(resultDir, "final.md"), "utf8")
        : "(no answer recorded)";
    const writes = existsSync(join(resultDir, "writes.txt"))
        ? readFileSync(join(resultDir, "writes.txt"), "utf8")
        : "(unknown)";
    return `Score one placement-guidance trial against its rubric. Judge only the stated intended action; a trial is not required to write a file.

Return ONE JSON object and nothing else:
{"verdict":"pass"|"fail","destination":"...","documents":"one"|"several"|"none","clarification":"yes"|"no","reason":"..."}

A pass means the destination or workflow matches Expected and Accepts, and does not rely on a tempting wrong answer. For Expected "clarify", a pass must ask a focused question and leave the destination explicitly deferred: naming a destination lake while ownership is unresolved is a guess and fails, unless the Accepts explicitly permit naming it (for example, with an independent ownership justification).

Rubric:
${rubric}

Trial answer:
${answer}

Files changed during the trial:
${writes}`;
}

function copyRubric(options, resultDir, caseId) {
    const target = join(resultDir, "rubric.md");
    if (existsSync(target)) return;
    // The rubric root is the current home; fixture-local copies keep older
    // results judgeable after the move.
    const source = [
        join(options.rubrics, caseId, "rubric.md"),
        join(options.fixtures, caseId, "rubric.md"),
    ].find((path) => existsSync(path));
    if (source !== undefined) cpSync(source, target);
}

function prepareJudgeRoot(resultDir, judgeModel) {
    const judgeRoot = join(resultDir, "judge");
    mkdirSync(join(judgeRoot, "work"), { recursive: true });
    mkdirSync(join(judgeRoot, "config-home", "opencode"), { recursive: true });
    write(
        join(judgeRoot, "config-home", "opencode", "opencode.json"),
        JSON.stringify(
            { $schema: "https://opencode.ai/config.json", model: judgeModel },
            null,
            2,
        ) + "\n",
    );
    return judgeRoot;
}

/** Pull the one JSON verdict object out of the judge's prose, if any. */
function parseVerdict(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return undefined;
    }
}

function verdictArtefact(verdict, text, judgeModel) {
    return {
        ...(verdict ?? { verdict: "unparsed", raw: text.trim() }),
        judgeModel,
    };
}

function verdictLabel(verdict) {
    const parsed = verdict ?? {};
    const destination = parsed.destination ?? "";
    return `${parsed.verdict ?? "unparsed"}${destination ? ` -> ${destination}` : ""}`;
}

/** The next judge attempt number, so rejudging never overwrites evidence. */
function nextAttempt(resultDir) {
    const root = join(resultDir, "judge");
    if (!existsSync(root)) return "001";
    const attempts = readdirSync(root, { withFileTypes: true })
        .filter(
            (entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name),
        )
        .map((entry) => Number(entry.name.slice("attempt-".length)))
        .filter(Number.isFinite);
    return String(Math.max(0, ...attempts) + 1).padStart(3, "0");
}

/** Why a recorded run is not judgeable, or null when it is complete. */
function runInvalidReason(resultDir, options) {
    if (!existsSync(join(resultDir, "final.md"))) {
        return "no final.md recorded";
    }
    const exitPath = join(resultDir, "exit-code");
    const exit = existsSync(exitPath)
        ? readFileSync(exitPath, "utf8").trim()
        : "missing";
    if (exit !== "0") {
        return `trial did not complete (exit ${exit})`;
    }
    const meta = readJson(join(resultDir, "meta.json"));
    if (!meta) {
        return "no meta.json recorded";
    }
    if (meta.writes !== 0 && !options.allowWrites) {
        return `decision-only trial changed ${meta.writes} file(s)`;
    }
    return null;
}

function writeInvalidVerdict(caseId, resultDir, reason, answerHash) {
    const verdict = {
        verdict: "invalid",
        reason,
        answerHash,
        judgeModel: "none",
    };
    write(
        join(resultDir, "verdict.json"),
        JSON.stringify(verdict, null, 2) + "\n",
    );
    console.log(`${caseId}: invalid — ${reason}`);
    return 1;
}

function recordVerdict(
    caseId,
    resultDir,
    judgeDir,
    result,
    judgeModel,
    answerHash,
    rubricHash,
    startedAt,
) {
    write(join(judgeDir, "stdout.jsonl"), result.stdout ?? "");
    write(join(judgeDir, "stderr.log"), result.stderr ?? "");
    const { text } = extract(result.stdout ?? "");
    write(join(judgeDir, "raw.md"), text);

    const verdict = parseVerdict(text);
    const attempt = relative(resultDir, judgeDir);
    const artefact = {
        ...verdictArtefact(verdict, text, judgeModel),
        answerHash,
        rubricHash,
        attempt,
    };
    write(
        join(judgeDir, "verdict.json"),
        JSON.stringify(artefact, null, 2) + "\n",
    );
    write(
        join(judgeDir, "meta.json"),
        JSON.stringify(
            {
                attempt,
                judgeModel,
                answerHash,
                rubricHash,
                startedAt,
                finishedAt: new Date().toISOString(),
                exit: result.status,
                signal: result.signal ?? null,
                error: result.error
                    ? (result.error.code ?? String(result.error))
                    : null,
            },
            null,
            2,
        ) + "\n",
    );
    // Convenience pointer for summary/export; the attempt directory is the
    // durable evidence.
    write(
        join(resultDir, "verdict.json"),
        JSON.stringify(artefact, null, 2) + "\n",
    );
    console.log(`${caseId}: ${verdictLabel(verdict)}`);
    return verdict?.verdict === "pass" ? 0 : 1;
}

function judgeOne(testCase, options, stamp) {
    const resultDir = join(options.results, stamp, testCase.id);
    if (!existsSync(resultDir)) {
        console.log(`${testCase.id}: no run recorded, skipping judge`);
        return 1;
    }
    const answerHash = existsSync(join(resultDir, "final.md"))
        ? fileHash(join(resultDir, "final.md"))
        : "unknown";
    const invalid = runInvalidReason(resultDir, options);
    if (invalid !== null) {
        return writeInvalidVerdict(testCase.id, resultDir, invalid, answerHash);
    }
    copyRubric(options, resultDir, testCase.id);
    if (!existsSync(join(resultDir, "rubric.md"))) {
        return writeInvalidVerdict(
            testCase.id,
            resultDir,
            "no rubric recorded",
            answerHash,
        );
    }
    const rubricHash = fileHash(join(resultDir, "rubric.md"));
    const judgeModel = options.judgeModel || options.model;
    const judgeRoot = prepareJudgeRoot(resultDir, judgeModel);
    const attempt = nextAttempt(resultDir);
    const judgeDir = join(resultDir, "judge", `attempt-${attempt}`);
    mkdirSync(judgeDir, { recursive: true });
    const startedAt = new Date().toISOString();
    const result = opencodeCall({
        cwd: join(judgeRoot, "work"),
        env: childEnv(join(judgeRoot, "config-home")),
        model: judgeModel,
        title: `placement-judge-${testCase.id}-${attempt}`,
        prompt: judgePrompt(resultDir),
        opencode: options.opencode,
        timeoutMs: options.timeoutMs,
    });
    return recordVerdict(
        testCase.id,
        resultDir,
        judgeDir,
        result,
        judgeModel,
        answerHash,
        rubricHash,
        startedAt,
    );
}

function readJson(path) {
    if (!existsSync(path)) return undefined;
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

function docsCallCount(resultDir) {
    const path = join(resultDir, "tools.jsonl");
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(parseLine)
        .filter((entry) => entry?.tool === "docs").length;
}

/**
 * What a tool call's input exposes beyond the prompt, most specific first.
 * Ordered so overlapping paths stay labelled: a rubric read is never mistaken
 * for the redacted case list. A `glob` that merely names a guidance file is
 * discovery, not a read, so it is labelled apart from content reads.
 */
const EXPOSURE_RULES = [
    ["rubric-case", /rubric\.md|case\.json|\/rubrics\//i],
    ["repo cases", /\/repo\/tests\/|placement-cases\.json/i],
    ["case list", /\/fixtures\/cases\.json/i],
    ["session config", /opencode\.json/i],
    ["harness surfaces", /\/fixtures\/manifest\.json|\/prompts\//i],
    ["guidance", /CONVENTION\.md|AGENTS\.md|SKILL\.md|\/\.opencode\//i],
];

/** Exposure labels for one case's tool trail, or [] when the trail is clean. */
function exposureFor(resultDir) {
    const path = join(resultDir, "tools.jsonl");
    if (!existsSync(path)) return [];
    const found = new Set();
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        const entry = parseLine(line);
        if (!entry) continue;
        const input = JSON.stringify(entry.input ?? "");
        for (const [label, pattern] of EXPOSURE_RULES) {
            if (!pattern.test(input)) continue;
            found.add(
                label === "guidance" && entry.tool === "glob"
                    ? "guidance-discovery"
                    : label,
            );
        }
        // A loaded skill is guidance-adjacent context the trail should show.
        if (entry.tool === "skill") found.add("skill load");
    }
    return [...found];
}

const isHelpQuery = (value) => value.trim().toLowerCase() === "help";

/**
 * Discovery observation for one case: total `docs` calls and how many asked
 * for help (the verb that lists the configured lakes with their names,
 * classes and descriptions). Deliberately separate from the placement
 * verdict: a trial can discover the lakes yet place badly, and in
 * discovery-variant prompts help is the only place the lakes appear.
 */
function discoveryFor(resultDir) {
    const path = join(resultDir, "tools.jsonl");
    if (!existsSync(path)) return null;
    const entries = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(parseLine)
        .filter((entry) => entry?.tool === "docs");
    return {
        calls: entries.length,
        help: entries.filter(
            (entry) =>
                typeof entry.input?.search === "string" &&
                isHelpQuery(entry.input.search),
        ).length,
    };
}

/** The Discovery column value: a help call is the observed discovery step. */
function discoveryLabel(discovery) {
    if (discovery === null) return "-";
    if (discovery.calls === 0) return "none";
    if (discovery.help === 0) return `no help (${discovery.calls})`;
    return `help×${discovery.help}`;
}

/** The Writes column value for one run's writes.txt content. */
function writesLabel(report) {
    return report === ""
        ? "-"
        : report === "none"
          ? "none"
          : `${report.split("\n").filter(Boolean).length} file(s)`;
}

function summaryRow(testCase, resultDir) {
    const verdict = readJson(join(resultDir, "verdict.json"));
    const report = existsSync(join(resultDir, "writes.txt"))
        ? readFileSync(join(resultDir, "writes.txt"), "utf8").trim()
        : "";
    const count = docsCallCount(resultDir);
    const exposure = exposureFor(resultDir);
    return {
        id: testCase.id,
        expected: testCase.expected,
        verdict:
            verdict?.verdict ??
            (existsSync(resultDir) ? "unjudged" : "not run"),
        destination: verdict?.destination ?? "",
        writes: writesLabel(report),
        docsCalls: count === null ? "-" : String(count),
        discovery: discoveryLabel(discoveryFor(resultDir)),
        exposure: exposure.length > 0 ? exposure.join(" + ") : "none",
    };
}

function renderSummary(options, stamp) {
    const stampDir = join(options.results, stamp);
    const rows = loadCases(options.fixture).map((testCase) =>
        summaryRow(testCase, join(stampDir, testCase.id)),
    );
    const lines = [
        `# Placement trial ${stamp}`,
        "",
        `Model: ${options.model}`,
        `Judge: ${options.judgeModel || options.model}`,
        `Variant: ${
            options.discovery
                ? "discovery — prompts carry no destinations; lakes only via docs help"
                : "destinations listed in prompt"
        }`,
        `Results: ${stampDir}`,
        "",
        "| Case | Expected | Verdict | Destination | Writes | Docs calls | Discovery | Exposure |",
        "| ---- | -------- | ------- | ----------- | ------ | ---------- | --------- | -------- |",
        ...rows.map(
            (row) =>
                `| ${row.id} | ${row.expected} | ${row.verdict} | ${row.destination || "-"} | ${row.writes} | ${row.docsCalls} | ${row.discovery} | ${row.exposure} |`,
        ),
        "",
        `Passed: ${rows.filter((row) => row.verdict === "pass").length}/${rows.length}`,
        `Invalid: ${rows.filter((row) => row.verdict === "invalid").length}`,
        `Discovered: ${rows.filter((row) => row.discovery.startsWith("help")).length}/${rows.length}`,
        `Exposed: ${rows.filter((row) => row.exposure !== "none").length}/${rows.length}`,
        "",
    ];
    const text = lines.join("\n");
    write(join(stampDir, "summary.md"), text);
    process.stdout.write(text);
}

/** Read a result artefact for the dossier; absent files get a visible marker. */
function readArtifact(resultDir, name) {
    const path = join(resultDir, name);
    return existsSync(path) ? readFileSync(path, "utf8").trim() : "(absent)";
}

/** One tool-trail line for the dossier, with the output trimmed for scanning. */
function trailLine(entry) {
    const input = JSON.stringify(entry.input ?? {});
    const output =
        typeof entry.output === "string"
            ? entry.output.slice(0, 160)
            : entry.output;
    return `- **${entry.tool}** input \`${input}\`${output ? ` -> \`${JSON.stringify(output)}\`` : ""}`;
}

function trailFor(resultDir) {
    const path = join(resultDir, "tools.jsonl");
    if (!existsSync(path)) return [];
    const entries = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(parseLine)
        .filter(Boolean)
        .map(trailLine);
    return entries.length > 15
        ? [
              ...entries.slice(0, 15),
              `(${entries.length - 15} more calls elided)`,
          ]
        : entries;
}

function verdictFor(resultDir) {
    const verdict = readJson(join(resultDir, "verdict.json"));
    if (!verdict) return "not judged locally";
    const destination = verdict.destination
        ? ` — destination: ${verdict.destination}`
        : "";
    const reason = verdict.reason ? ` — ${verdict.reason}` : "";
    const attempt = verdict.attempt ? `, attempt ${verdict.attempt}` : "";
    return `${verdict.verdict}${destination}${reason} (judge model: ${verdict.judgeModel ?? "unknown"}${attempt})`;
}

/** The dossier section for one case: rubric, prompt, answer, trail, verdict. */
function caseSection(testCase, resultDir) {
    const trail = trailFor(resultDir);
    const meta = readJson(join(resultDir, "meta.json")) ?? {};
    return [
        "---",
        "",
        `## ${testCase.id} — Expected: ${testCase.expected}`,
        "",
        "### Rubric",
        "",
        "````",
        readArtifact(resultDir, "rubric.md"),
        "````",
        "",
        "### Prompt given to the trial model",
        "",
        "````",
        readArtifact(resultDir, "prompt.md"),
        "````",
        "",
        "### Trial answer",
        "",
        "````",
        readArtifact(resultDir, "final.md"),
        "````",
        "",
        `### Tool trail (${trail.length} entr${trail.length === 1 ? "y" : "ies"})`,
        "",
        ...(trail.length > 0 ? trail : ["(no tool calls)"]),
        "",
        `Exposure: ${
            exposureFor(resultDir).join(" + ") || "none"
        } (classified from the tool trail; guidance exposure is expected)`,
        "",
        `Discovery: ${discoveryLabel(discoveryFor(resultDir))} (docs calls; help lists the configured lakes)`,
        "",
        "### Files changed",
        "",
        "````",
        readArtifact(resultDir, "writes.txt"),
        "````",
        "",
        "### Local judge",
        "",
        verdictFor(resultDir),
        "",
        `Run meta: exit ${meta.exit ?? "?"}, ${meta.writes ?? "?"} write(s), ` +
            `answer ${meta.answerHash ?? "?"}, started ${meta.startedAt ?? "?"}.`,
        "",
    ];
}

function dossierHeader(options, stamp) {
    const manifest = readJson(join(options.fixtures, "manifest.json"));
    const provenanceInfo = manifest ?? provenance(options);
    return [
        `# Placement-trial dossier ${stamp}`,
        "",
        `- Generated: ${new Date().toISOString()}`,
        `- Trial model: ${options.model}`,
        `- Variant: ${
            options.discovery
                ? "discovery — prompts carry no destinations; lakes only via docs help"
                : "destinations listed in prompt"
        }`,
        `- Fixture: ${provenanceInfo.fixtureVersion ?? "unknown"} (${provenanceInfo.fixtureHash ?? "unknown"})`,
        `- Plugin: ${provenanceInfo.pluginCommit ?? "unknown"} (${provenanceInfo.pluginHash ?? "unknown"})`,
        `- CLI: ${provenanceInfo.opencode ?? "unknown"}`,
        `- Image: ${provenanceInfo.image || "unknown"}${provenanceInfo.imageId ? ` (${provenanceInfo.imageId})` : ""}`,
        `- Timeout: ${options.timeoutMs} ms per model call`,
        `- Harness: opencode-docs-plugin tests/fixtures/placement-harness`,
        "- Boundary: each trial ran in its own container, whose mounts held" +
            " only that case's sandbox, its prompt, an id-only case list and" +
            " the result directory, plus a curated plugin package; the rubric" +
            " reached the result only after the container exited. Permission" +
            " rules requesting no shell, edits or reads outside the workspace" +
            " are defence in depth, not guarantees — read each case's tool" +
            " trail and Exposure line. Trials state an intended action; they" +
            " are not required to write.",
        "",
        "You are an expert reviewer scoring a behavioural trial of",
        "documentation-placement guidance. For each case, read the rubric, the",
        "prompt, the trial's answer and its tool trail. Decide pass or fail",
        "against Expected and Accepts, flag any tempting wrong answer it fell",
        "for, and note whether the docs tool was used appropriately. Finish",
        "with a markdown summary table (Case | Verdict | Destination | Notes).",
        "",
    ];
}

/**
 * Bundle one stamp into a single Markdown dossier for deep review by a
 * stronger model (a local big-brother judge, or an external frontier model).
 */
function exportDossier(options, stamp) {
    const stampDir = join(options.results, stamp);
    if (!existsSync(stampDir)) usage(`no results at ${stampDir}`);
    const parts = dossierHeader(options, stamp);
    let cases = 0;
    for (const testCase of loadCases(options.fixture)) {
        const resultDir = join(stampDir, testCase.id);
        if (!existsSync(join(resultDir, "final.md"))) continue;
        cases += 1;
        parts.push(...caseSection(testCase, resultDir));
    }
    const dossier = parts.join("\n") + "\n";
    const outPath = join(stampDir, "dossier.md");
    write(outPath, dossier);
    console.log(
        `dossier: ${outPath} (${cases} cases, ${dossier.length} bytes)`,
    );
    return 0;
}

function runSelected(options, stamp, selected) {
    generateAll(options);
    return selected.reduce(
        (worst, testCase) => Math.max(worst, runOne(testCase, options, stamp)),
        0,
    );
}

function judgeSelected(options, stamp, selected) {
    return selected.reduce(
        (worst, testCase) =>
            Math.max(worst, judgeOne(testCase, options, stamp)),
        0,
    );
}

function latestStampOrUsage(options) {
    const stamp = options.stamp || latestStamp(options.results);
    if (!stamp) usage(`no result stamps under ${options.results}`);
    return stamp;
}

/** What a sweep-style command should do, derived once. */
function planFor(command, noJudge) {
    return {
        runs: command === "run" || command === "all",
        judges: command === "judge" || (command === "all" && !noJudge),
        reports: command === "judge" || command === "all",
    };
}

function executeAndReport(options, plan, stamp, selected) {
    let worst = 0;
    if (plan.runs) worst = runSelected(options, stamp, selected);
    if (plan.judges)
        worst = Math.max(worst, judgeSelected(options, stamp, selected));
    if (plan.reports) {
        renderSummary(options, stamp);
        exportDossier(options, stamp);
    }
    return worst;
}

function main() {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === "generate") {
        generateAll(options);
        return 0;
    }
    if (command === "summary") {
        renderSummary(options, latestStampOrUsage(options));
        return 0;
    }
    if (command === "export") {
        return exportDossier(options, latestStampOrUsage(options));
    }
    return executeAndReport(
        options,
        planFor(command, options.noJudge),
        options.stamp || stampNow(),
        select(options),
    );
}

process.exit(main());
