// Judge-recovery rehearsal: the real judge launcher and the real OpenCode CLI
// against a loopback provider. Manual step, never part of `npm test`.
//
// It answers three questions the contract tests cannot:
// - how many provider requests one durable judge attempt costs, including the
//   adapter's own retries after a retryable error;
// - whether a configured `providers.<id>.body.response_format` reaches the
//   provider request on the pinned route;
// - whether a disposable campaign completes valid -> malformed -> recovered ->
//   continuation, stops on an exhausted recovery budget, and refuses after
//   close, with trial and judge counts that match its ledger.
//
// No real model is called: every completion is served by the loopback server.
// Usage: node judge-recovery-rehearsal.mts <work-dir>
// Environment: PLACEMENT_IMAGE (default localhost/opencode-placement-trials),
// REHEARSAL_MODEL (default zai-coding-plan/glm-5.3-flash).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, "..", "..", "..");
const AC_RUN = join(HARNESS, "ac", "run.mts");
const LAUNCHER = join(HARNESS, "ac", "judge-launcher.sh");
const MATERIALISE = join(HERE, "..", "materialise.mts");
const IMAGE =
    process.env.PLACEMENT_IMAGE ?? "localhost/opencode-placement-trials";
const MODEL = process.env.REHEARSAL_MODEL ?? "zai-coding-plan/glm-5.3-flash";
const CASE = "R01";

/** One served completion: an HTTP status and the assistant content. */
interface Served {
    status: number;
    body?: string;
    content?: string;
}

/** One captured provider request. */
interface CapturedRequest {
    method: string;
    path: string;
    body: Record<string, unknown>;
}

/** A loopback OpenAI-compatible provider with a scripted response plan. */
interface Provider {
    port: number;
    requests: CapturedRequest[];
    /** Requests to the chat-completions path. */
    chatCount(): number;
    /** Requests to any other path (readiness, model lists). */
    otherCount(): number;
    close(): Promise<void>;
}

/** A child result. */
interface ChildResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

/** One rehearsal outcome, recorded in the report. */
interface Outcome {
    scenario: string;
    ok: boolean;
    detail: Record<string, unknown>;
}

/** The policy used by the rehearsal, matching the prospective shape. */
const POLICY = {
    version: 1,
    eligibleFailureClasses: ["json-syntax"],
    requiresCompletionEvidence: true,
    maxRecoveriesPerSlot: 1,
    recoveryCeiling: 1,
    totalJudgeAttempts: 3,
    providerRequestLimit: null,
};

/** Read one request body as a JSON object. */
async function bodyOf(
    request: IncomingMessage,
): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/** Write one JSON response. */
function jsonResponse(
    response: ServerResponse,
    status: number,
    value: unknown,
): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
}

/** Stream one chat completion as server-sent events. */
function streamCompletion(
    response: ServerResponse,
    model: unknown,
    content: string,
): void {
    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
    });
    const chunk = {
        id: "chatcmpl-rehearsal",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [
            {
                index: 0,
                delta: { role: "assistant", content },
                finish_reason: null,
            },
        ],
    };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.write(
        `data: ${JSON.stringify({
            ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
}

/** Serve one non-streaming chat completion. */
function plainCompletion(
    response: ServerResponse,
    model: unknown,
    content: string,
): void {
    jsonResponse(response, 200, {
        id: "chatcmpl-rehearsal",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
            {
                index: 0,
                message: { role: "assistant", content },
                finish_reason: "stop",
            },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
}

/** Serve one scripted chat completion, or a retryable failure. */
function serveChat(
    response: ServerResponse,
    body: Record<string, unknown>,
    served: Served | undefined,
): void {
    if (served === undefined) {
        response.writeHead(500);
        response.end();
        return;
    }
    if (served.status !== 200) {
        jsonResponse(response, served.status, {
            error: {
                message: served.body ?? "retryable failure",
                type: "rate_limit_error",
            },
        });
        return;
    }
    const content = served.content ?? "";
    if (body.stream === true || body.stream_options !== undefined) {
        streamCompletion(response, body.model ?? MODEL, content);
        return;
    }
    plainCompletion(response, body.model ?? MODEL, content);
}

/** Start the loopback provider on a free port. */
async function startProvider(plan: Served[]): Promise<Provider> {
    const requests: CapturedRequest[] = [];
    const server = createServer((request, response) => {
        void bodyOf(request).then((body) => {
            requests.push({
                method: request.method ?? "GET",
                path: request.url ?? "",
                body,
            });
            if (!(request.url ?? "").includes("chat/completions")) {
                jsonResponse(response, 200, { object: "list", data: [] });
                return;
            }
            const chatRequests = requests.filter((entry) =>
                entry.path.includes("chat/completions"),
            ).length;
            serveChat(
                response,
                body,
                plan[Math.min(chatRequests - 1, plan.length - 1)],
            );
        });
    });
    const port = await new Promise<number>((resolve, reject) => {
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve(
                typeof address === "object" && address !== null
                    ? address.port
                    : 0,
            );
        });
    });
    return {
        port,
        requests,
        chatCount: () =>
            requests.filter((entry) => entry.path.includes("chat/completions"))
                .length,
        otherCount: () =>
            requests.filter((entry) => !entry.path.includes("chat/completions"))
                .length,
        close: () =>
            new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

const sha256 = (body: string | Buffer): string =>
    createHash("sha256").update(body).digest("hex");

/** The malformed judge text from the observed campaign. */
function malformedText(): string {
    const fixture = join(
        HARNESS,
        "..",
        "judge-recovery",
        "observed-output.jsonl",
    );
    const line = readFileSync(fixture, "utf8").trim().split("\n")[1]!;
    return (JSON.parse(line) as { part: { text: string } }).part.text;
}

/** The same response with the structurally valid closing sequence. */
function validText(): string {
    const text = malformedText();
    return `${text.slice(0, -3)}"]}`;
}

/** Write a file, creating parents. */
function write(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
}

/**
 * Run one child to completion with stdin ignored.
 *
 * The CLI's private stdio server waits for standard input to close; a
 * synchronous spawn propagates a pipe that never closes and hangs the judge.
 * Ignored stdin is the same boundary the campaign's own shell supplies.
 * @param command The executable.
 * @param args Its arguments.
 * @param env The child environment.
 * @param timeoutMs Kill the child after this long.
 * @returns The exit status and captured streams.
 */
function runChild(
    command: string,
    args: string[],
    env: Record<string, string | undefined>,
    timeoutMs = 600000,
): Promise<ChildResult> {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.on("error", () => {
            clearTimeout(timer);
            resolve({ status: null, stdout, stderr });
        });
        child.on("exit", (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

/** A fixture git checkout independent of this checkout. */
function sourceRepo(root: string): string {
    const dir = join(root, "source");
    write(join(dir, "README.md"), "source\n");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync(
        "git",
        [
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            "s",
        ],
        { cwd: dir },
    );
    return spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf8",
    }).stdout.trim();
}

/** The loopback overlay that redirects the judge route. */
function overlay(port: number, providerBody?: Record<string, unknown>): string {
    return JSON.stringify({
        providers: {
            "zai-coding-plan": {
                settings: { baseURL: `http://127.0.0.1:${port}/v1` },
                ...(providerBody === undefined ? {} : { body: providerBody }),
            },
        },
    });
}

/** One recorded judge attempt's judgement. */
function judgementAt(dir: string): Record<string, unknown> {
    return JSON.parse(
        readFileSync(join(dir, "judgement.json"), "utf8"),
    ) as Record<string, unknown>;
}

/** One recorded judge attempt's metadata. */
function metaAt(dir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Record<
        string,
        unknown
    >;
}

/** Whether a packet identity is a recorded SHA-256. */
function recordedPacket(meta: Record<string, unknown>): string | null {
    return typeof meta.packetSha256 === "string" &&
        /^[0-9a-f]{64}$/.test(meta.packetSha256)
        ? meta.packetSha256
        : null;
}

/** Whether the metadata proves a complete final response. */
function recordedComplete(meta: Record<string, unknown>): boolean | null {
    const completion =
        typeof meta.completion === "object" && meta.completion !== null
            ? (meta.completion as Record<string, unknown>)
            : null;
    return typeof completion?.complete === "boolean"
        ? completion.complete
        : null;
}

/** The trial stub: records one usable trial result per stamp. */
function trialStub(root: string): string {
    const stub = join(root, "trial-stub.mjs");
    write(
        stub,
        `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const caseId = argv[1];
const stamp = argv[argv.indexOf("--stamp") + 1];
const dir = join(process.env.PLACEMENT_RESULTS, stamp, caseId);
mkdirSync(dir, { recursive: true });
const answer = "The importer was fixed; no note was written.\\n";
writeFileSync(join(dir, "final.md"), answer);
writeFileSync(join(dir, "meta.json"), JSON.stringify({
    exit: 0, signal: null, timedOut: false, outputOverflow: false,
    answerValid: true, answerHash: createHash("sha256").update(answer).digest("hex"),
}));
writeFileSync(join(dir, "prompt.md"), "Fix the CSV importer.\\n");
writeFileSync(join(dir, "writes.txt"), "none\\n");
writeFileSync(join(dir, "primary-check.json"), JSON.stringify({ status: "pass", exit: 0, stdout: "", stderr: "" }));
`,
    );
    chmodSync(stub, 0o755);
    return stub;
}

/** The judge apparatus the driver dispatches from. */
function measurementTree(root: string): void {
    for (const path of [
        "ac/run.mts",
        "ac/campaign.mts",
        "ac/evidence-guard.mts",
        "ac/judge-launcher.sh",
        "ac-scoring.mts",
        "analysis/journal.ts",
        "analysis/blinding.ts",
    ]) {
        write(
            join(root, "measurement/tests/fixtures/placement-harness", path),
            readFileSync(join(HARNESS, path), "utf8"),
        );
    }
    chmodSync(
        join(
            root,
            "measurement/tests/fixtures/placement-harness/ac/judge-launcher.sh",
        ),
        0o755,
    );
}

/** The arm and generation inputs one two-slot campaign needs. */
function armInputs(root: string): void {
    for (const arm of ["a", "b"]) {
        const armRoot = join(root, "arms", arm);
        write(join(armRoot, "src/index.ts"), "export default {};\n");
        write(join(armRoot, "package-lock.json"), "{}\n");
        write(
            join(armRoot, "tests/fixtures/placement-harness/container-run.sh"),
            "#!/bin/sh\n",
        );
        write(
            join(
                armRoot,
                "tests/fixtures/placement-harness/prod014/cases.json",
            ),
            "[]\n",
        );
        write(
            join(root, "gen", arm, "prompts", `${CASE}.md`),
            "Fix the CSV importer.\n",
        );
        write(
            join(root, "gen", arm, "fixtures", CASE, "generation.json"),
            "{}\n",
        );
        mkdirSync(join(root, "gen", arm, "rubrics", CASE), { recursive: true });
    }
    write(
        join(
            root,
            "arms/a/tests/fixtures/placement-harness/prod014/truth.json",
        ),
        JSON.stringify({ [CASE]: "A durable BOM finding." }),
    );
}

/** The freeze record for one disposable campaign. */
function freezeRecord(root: string, imageId: string, source: string): void {
    const hash = (path: string): string =>
        createHash("sha256").update(readFileSync(path)).digest("hex");
    write(
        join(root, "evidence/FROZEN.json"),
        JSON.stringify({
            freeze: {
                schemaVersion: 2,
                campaign: "pd-rehearsal",
                sourceRevision: source,
                sourceTree: "tree",
                imageId,
                containerCli: spawnSync("podman", ["--version"], {
                    encoding: "utf8",
                }).stdout.trim(),
                measurementSha256: "m",
                arms: [],
                files: [
                    {
                        path: "evidence/schedule.json",
                        sha256: hash(join(root, "evidence/schedule.json")),
                    },
                ],
                inventories: [
                    {
                        path: "prepare",
                        files: readdirSync(join(root, "prepare"), {
                            recursive: true,
                            withFileTypes: true,
                        })
                            .filter((entry) => entry.isFile())
                            .map((entry) =>
                                join(entry.parentPath, entry.name).slice(
                                    root.length + 1,
                                ),
                            )
                            .sort()
                            .map((path) => ({
                                path,
                                sha256: hash(join(root, path)),
                            })),
                    },
                ],
                stoppingRules: ["stop on first unusable assessment"],
                ceilings: { trial: 2, judge: 2 },
            },
        }),
    );
}

/** A two-slot campaign root, materialised and frozen. */
function campaign(options: {
    recovery?: Record<string, unknown>;
    imageId: string;
}): { root: string; source: string; stub: string } {
    const root = mkdtempSync(join(tmpdir(), "pd-rehearsal-"));
    const materialised = spawnSync(process.execPath, [MATERIALISE, root], {
        encoding: "utf8",
    });
    if (materialised.status !== 0) {
        throw new Error(`materialise failed: ${materialised.stderr}`);
    }
    const slots = ["A", "B"].map((arm, index) => ({
        slot: index + 1,
        pairId: "P01",
        repetition: 0,
        scenario: CASE,
        arm,
        stamp: `pd-${arm}-r0-${CASE}`,
    }));
    write(
        join(root, "evidence/schedule.json"),
        JSON.stringify({ campaign: "pd-rehearsal", slots }, null, 2),
    );
    write(join(root, "evidence/ATTEMPTS.jsonl"), "");
    write(join(root, "evidence/measurement-spec.json"), "{}\n");
    write(
        join(root, "prepare/manifest.json"),
        JSON.stringify({
            assessment: {
                attemptId: "attempt-001",
                ...(options.recovery === undefined
                    ? {}
                    : { recovery: options.recovery }),
            },
        }),
    );
    const source = sourceRepo(root);
    freezeRecord(root, options.imageId, source);
    measurementTree(root);
    armInputs(root);
    return { root, source, stub: trialStub(root) };
}

/** Run the materialised driver with the loopback overlay. */
function runDriver(
    root: string,
    stub: string,
    port: number,
): Promise<ChildResult> {
    return runChild(
        process.execPath,
        [
            join(root, "prepare/run.mts"),
            "--pair-from",
            "1",
            "--pair-to",
            "1",
            "--trial-command",
            stub,
        ],
        {
            ...process.env,
            CAMPAIGN_ROOT: root,
            CAMPAIGN_SOURCE_REPO: join(root, "source"),
            PATH: `${join(root, "prepare/shim")}:${process.env.PATH ?? ""}`,
            OPENCODE_CONFIG_CONTENT: overlay(port),
            ZAI_API_KEY: "rehearsal",
        },
    );
}

/** The ledger events of one campaign. */
function ledgerOf(root: string): Array<Record<string, unknown>> {
    return readFileSync(join(root, "evidence/ATTEMPTS.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Seed one recorded trial the judge path can read. */
function seedTrial(root: string): string {
    const caseDir = join(root, "gen/a/results/pd-A-r0-R01/R01");
    mkdirSync(caseDir, { recursive: true });
    const answer = "The importer was fixed; no note was written.\n";
    write(join(caseDir, "final.md"), answer);
    write(
        join(caseDir, "meta.json"),
        JSON.stringify({
            exit: 0,
            signal: null,
            answerValid: true,
            answerHash: sha256(answer),
        }),
    );
    write(join(caseDir, "prompt.md"), "Fix the CSV importer.\n");
    write(join(caseDir, "writes.txt"), "none\n");
    write(
        join(caseDir, "primary-check.json"),
        JSON.stringify({ status: "pass", exit: 0, stdout: "", stderr: "" }),
    );
    write(
        join(root, "truth.json"),
        JSON.stringify({ R01: "A durable BOM finding." }),
    );
    return caseDir;
}

/** One launcher-level scenario. */
interface LauncherScenario {
    name: string;
    plan: Served[];
    providerBody?: Record<string, unknown>;
    expected: "judged" | "invalid-verdict" | "judge-error";
}

/** The launcher-level probes: request accounting and output controls. */
async function launcherOutcomes(containing: string): Promise<Outcome[]> {
    const scenarios: LauncherScenario[] = [
        {
            name: "launcher-valid",
            plan: [{ status: 200, content: validText() }],
            expected: "judged",
        },
        {
            name: "launcher-malformed",
            plan: [{ status: 200, content: malformedText() }],
            expected: "invalid-verdict",
        },
        {
            name: "launcher-retry-429",
            plan: [
                { status: 429, body: "rate limited" },
                { status: 200, content: validText() },
            ],
            expected: "judged",
        },
        {
            name: "launcher-response-format",
            plan: [{ status: 200, content: validText() }],
            providerBody: { response_format: { type: "json_object" } },
            expected: "judged",
        },
    ];
    const outcomes: Outcome[] = [];
    for (const scenario of scenarios) {
        outcomes.push(await launcherOutcome(containing, scenario));
    }
    return outcomes;
}

/** Run one launcher-level probe. */
async function launcherOutcome(
    containing: string,
    scenario: LauncherScenario,
): Promise<Outcome> {
    const provider = await startProvider(scenario.plan);
    const root = mkdtempSync(join(containing, `${scenario.name}-`));
    try {
        const caseDir = seedTrial(root);
        const result = await runChild(
            process.execPath,
            [
                AC_RUN,
                "judge",
                "--base",
                join(root, "gen/a"),
                "--stamp",
                "pd-A-r0-R01",
                "--case",
                "R01",
                "--truth",
                join(root, "truth.json"),
                "--launcher",
                LAUNCHER,
                "--model",
                MODEL,
                "--workdir",
                join(root, "evidence/ac-runs"),
                "--timeout",
                "300000",
            ],
            {
                ...process.env,
                OPENCODE_CONFIG_CONTENT: overlay(
                    provider.port,
                    scenario.providerBody,
                ),
                ZAI_API_KEY: "rehearsal",
            },
            360000,
        );
        const attemptDir = join(caseDir, "ac/attempt-001");
        const judgement = judgementAt(attemptDir);
        const meta = metaAt(attemptDir);
        const complete = recordedComplete(meta);
        const packetSha256 = recordedPacket(meta);
        const metaAccurate =
            complete === true &&
            packetSha256 !== null &&
            (scenario.expected === "judged" ||
                judgement.failureClass === "json-syntax");
        const chat = provider.requests.find((entry) =>
            entry.path.includes("chat/completions"),
        );
        return {
            scenario: scenario.name,
            ok:
                judgement.status === scenario.expected &&
                metaAccurate &&
                provider.chatCount() >= 1,
            detail: {
                judgementStatus: judgement.status,
                failureClass: judgement.failureClass ?? null,
                completion: complete,
                packetSha256,
                metaAccurate,
                chatRequests: provider.chatCount(),
                otherRequests: provider.otherCount(),
                exit: result.status,
                responseFormatDelivered:
                    scenario.providerBody === undefined
                        ? null
                        : JSON.stringify(chat?.body ?? {}).includes(
                              "response_format",
                          ),
            },
        };
    } finally {
        await provider.close();
        rmTree(root);
    }
}

/** Remove one disposable tree. */
function rmTree(root: string): void {
    rmSync(root, { recursive: true, force: true });
}

/** The driver scenario: valid -> malformed -> recovered -> continuation. */
async function recoveredOutcome(
    containing: string,
    imageId: string,
): Promise<Outcome> {
    const provider = await startProvider([
        { status: 200, content: malformedText() },
        { status: 200, content: validText() },
        { status: 200, content: validText() },
    ]);
    const { root, stub } = campaign({ recovery: POLICY, imageId });
    try {
        const result = await runDriver(root, stub, provider.port);
        const ledger = ledgerOf(root);
        const events = (name: string): number =>
            ledger.filter((event) => event.event === name).length;
        const acDir = join(root, "gen/a/results/pd-A-r0-R01/R01/ac");
        const selection = JSON.parse(
            readFileSync(join(acDir, "selection.json"), "utf8"),
        ) as { selectedAttemptId: string };
        const firstMeta = metaAt(join(acDir, "attempt-001"));
        const secondMeta = metaAt(join(acDir, "attempt-002"));
        const firstPacket = recordedPacket(firstMeta);
        const secondPacket = recordedPacket(secondMeta);
        const packetIdentityMatched =
            firstPacket !== null && firstPacket === secondPacket;
        const firstComplete = recordedComplete(firstMeta);
        const secondComplete = recordedComplete(secondMeta);
        const metaAccurate =
            packetIdentityMatched &&
            firstComplete === true &&
            secondComplete === true &&
            judgementAt(join(acDir, "attempt-001")).failureClass ===
                "json-syntax";
        return {
            scenario: "driver-recovered",
            ok:
                result.status === 0 &&
                metaAccurate &&
                events("recovery-launch") === 1 &&
                events("slot-complete") === 2 &&
                events("launch") === 2 &&
                selection.selectedAttemptId === "attempt-002",
            detail: {
                exit: result.status,
                trialLaunches: events("launch"),
                judgeLaunches: events("judge-launch"),
                recoveryLaunches: events("recovery-launch"),
                slotComplete: events("slot-complete"),
                selectedAttemptId: selection.selectedAttemptId,
                packetIdentityMatched,
                firstComplete,
                secondComplete,
                metaAccurate,
                chatRequests: provider.chatCount(),
                otherRequests: provider.otherCount(),
            },
        };
    } catch (error) {
        return {
            scenario: "driver-recovered",
            ok: false,
            detail: {
                error: String(error),
                chatRequests: provider.chatCount(),
            },
        };
    } finally {
        await provider.close();
        rmTree(root);
    }
}

/** The driver scenario: an exhausted recovery budget stops before dispatch. */
async function exhaustedOutcome(
    containing: string,
    imageId: string,
): Promise<Outcome> {
    const provider = await startProvider([
        { status: 200, content: malformedText() },
    ]);
    const { root, stub } = campaign({ recovery: POLICY, imageId });
    try {
        write(
            join(root, "evidence/recovery/recovery-0001.claim"),
            JSON.stringify({
                kind: "recovery",
                index: 1,
                state: "reserved",
                at: null,
                stamp: "earlier",
                attemptId: "attempt-002",
                note: null,
                key: "earlier",
            }),
        );
        const result = await runDriver(root, stub, provider.port);
        return {
            scenario: "driver-exhausted-budget",
            ok:
                result.status === 2 &&
                provider.chatCount() === 1 &&
                !existsSync(
                    join(root, "gen/a/results/pd-A-r0-R01/R01/ac/attempt-002"),
                ),
            detail: {
                exit: result.status,
                chatRequests: provider.chatCount(),
                blocked: String(result.stderr)
                    .split("\n")
                    .find((line) => line.includes("recovery ceiling")),
            },
        };
    } finally {
        await provider.close();
        rmTree(root);
    }
}

/** The driver scenario: a closed campaign dispatches nothing. */
async function closedOutcome(
    containing: string,
    imageId: string,
): Promise<Outcome> {
    const provider = await startProvider([
        { status: 200, content: validText() },
    ]);
    const { root, stub } = campaign({ recovery: POLICY, imageId });
    try {
        write(
            join(root, "evidence/ATTEMPTS.jsonl"),
            `${JSON.stringify({
                at: "2026-11-14T00:00:00.000Z",
                event: "campaign-closed",
                stoppedAt: "pd-A-r0-R01",
                scope: 1,
                reason: "closed",
            })}\n`,
        );
        const result = await runDriver(root, stub, provider.port);
        return {
            scenario: "driver-post-close",
            ok: result.status === 2 && provider.chatCount() === 0,
            detail: {
                exit: result.status,
                chatRequests: provider.chatCount(),
            },
        };
    } finally {
        await provider.close();
        rmTree(root);
    }
}

/** The rehearsal image's immutable id, or a refusal. */
function imageIdOf(): string {
    const check = spawnSync(
        "podman",
        ["image", "inspect", "--format", "{{.Id}}", IMAGE],
        { encoding: "utf8" },
    );
    if (check.status !== 0) {
        console.error(`rehearsal image is missing: ${IMAGE}`);
        process.exit(2);
    }
    return check.stdout.trim();
}

/** Write the report and print one line per outcome. */
function publish(containing: string, outcomes: Outcome[]): void {
    const report = {
        at: new Date().toISOString(),
        image: IMAGE,
        model: MODEL,
        reportKind: process.env.REHEARSAL_ORIGINAL_REPORT
            ? "regenerated"
            : "original",
        originalReport: process.env.REHEARSAL_ORIGINAL_REPORT ?? null,
        note: "Requests are counted at the loopback provider; one durable judge attempt may cost more than one HTTP request when the adapter retries. One retry was observed; the adapter's maximum was not established.",
        outcomes,
    };
    const reportPath = join(containing, "rehearsal-report.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    for (const outcome of outcomes) {
        console.log(
            `${outcome.ok ? "ok  " : "FAIL"} ${outcome.scenario} ${JSON.stringify(outcome.detail)}`,
        );
    }
    console.log(`report: ${reportPath}`);
    process.exit(outcomes.every((outcome) => outcome.ok) ? 0 : 1);
}

async function main(): Promise<void> {
    const containing =
        process.argv[2] ?? mkdtempSync(join(tmpdir(), "pd-rehearsal-work-"));
    mkdirSync(containing, { recursive: true });
    const imageId = imageIdOf();
    const outcomes = [
        ...(await launcherOutcomes(containing)),
        await recoveredOutcome(containing, imageId),
        await exhaustedOutcome(containing, imageId),
        await closedOutcome(containing, imageId),
    ];
    publish(containing, outcomes);
}

main().catch((error: unknown) => {
    console.error(String(error));
    process.exit(1);
});
