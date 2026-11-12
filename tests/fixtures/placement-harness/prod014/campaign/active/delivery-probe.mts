// Delivery probe: capture the exact provider request body one trial-shaped
// session sends, so the registered tool payload can be compared with the
// description bytes the arm registered. Readiness only; the provider is a
// local fake and no real model is called.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [capturePath, armDir, model, prompt, portArg] = process.argv.slice(2);
if (
    capturePath === undefined ||
    armDir === undefined ||
    model === undefined ||
    prompt === undefined
) {
    console.error(
        "usage: delivery-probe.mts <capture> <arm> <model> <prompt> [port]",
    );
    process.exit(2);
}
const port = Number(portArg ?? 8799);
let captured = 0;

const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
        raw += chunk;
    });
    request.on("end", () => {
        captured += 1;
        writeFileSync(
            join(dirname(capturePath), `request-${captured}.json`),
            raw,
            "utf8",
        );
        let body: Record<string, unknown> = {};
        try {
            const parsed: unknown = JSON.parse(raw);
            if (
                typeof parsed === "object" &&
                parsed !== null &&
                !Array.isArray(parsed)
            ) {
                body = parsed as Record<string, unknown>;
            }
        } catch {
            /* keep the raw capture */
        }
        const servedModel = typeof body.model === "string" ? body.model : model;
        const text = "Hello.";
        if (body.stream === true || body.stream_options !== undefined) {
            response.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            const chunk = {
                id: "chatcmpl-probe",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: servedModel,
                choices: [
                    {
                        index: 0,
                        delta: { role: "assistant", content: text },
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
            response.write("data: [DONE]\n\n");
            response.end();
            return;
        }
        const payload = {
            id: "chatcmpl-probe",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: servedModel,
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: text },
                    finish_reason: "stop",
                },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
    });
});

server.listen(port, "127.0.0.1", async () => {
    const configHome = join(dirname(capturePath), "config-home");
    mkdirSync(join(configHome, "opencode"), { recursive: true });
    writeFileSync(
        join(configHome, "opencode", "opencode.json"),
        JSON.stringify(
            {
                $schema: "https://opencode.ai/config.json",
                model,
                plugins: [{ package: "/repo", options: { lakes: [] } }],
                permissions: [
                    { action: "shell", resource: "*", effect: "deny" },
                    { action: "edit", resource: "*", effect: "deny" },
                ],
            },
            null,
            2,
        ) + "\n",
        "utf8",
    );
    const work = join(dirname(capturePath), "work");
    mkdirSync(work, { recursive: true });
    const overlay = JSON.stringify({
        providers: {
            "opencode-go": {
                settings: { baseURL: `http://127.0.0.1:${port}/v1` },
            },
        },
    });
    const child = spawn(
        "podman",
        [
            "run",
            "--rm",
            "--network",
            "host",
            "--userns=keep-id",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,nosuid,size=512m",
            "-v",
            `${dirname(capturePath)}:${dirname(capturePath)}:rw`,
            "-v",
            `${armDir}:/repo:ro`,
            "-w",
            work,
            "-e",
            `PWD=${work}`,
            "-e",
            `XDG_CONFIG_HOME=${configHome}`,
            "-e",
            "XDG_DATA_HOME=/tmp/agent-home/.local/share",
            "-e",
            "XDG_CACHE_HOME=/tmp/agent-home/.cache",
            "-e",
            "HOME=/tmp/agent-home",
            "-e",
            `OPENCODE_CONFIG_CONTENT=${overlay}`,
            "localhost/opencode-placement-trials",
            "opencode",
            "run",
            "--standalone",
            "--auto",
            "--archived",
            "--title",
            "delivery-probe",
            "--model",
            model,
            "--format",
            "json",
            prompt,
        ],
        { stdio: ["ignore", "pipe", "pipe"] as const },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    const status = await new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
        child.on("error", () => resolve(null));
    });
    clearTimeout(timer);
    writeFileSync(
        join(dirname(capturePath), "probe-stdout.jsonl"),
        stdout,
        "utf8",
    );
    writeFileSync(
        join(dirname(capturePath), "probe-stderr.log"),
        stderr,
        "utf8",
    );
    console.log(`exit ${status}; captured ${captured} request(s)`);
    server.close();
    process.exit(captured > 0 ? 0 : 1);
});
