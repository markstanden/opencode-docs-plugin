// Credential containment at the launch boundary.
//
// The real materialised shim and the real judge launcher run against a fake
// podman, the last external boundary. A dummy key, overlay and prompt canary
// must reach that boundary, while every persisted campaign log stays clean.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(HERE, "fixtures/placement-harness");
const CAMPAIGN = join(HARNESS, "prod014/campaign");
const LAUNCHER = join(HARNESS, "ac/judge-launcher.sh");
const KEY = "canary-key-7f3a";
const OVERLAY = "canary-overlay-91b2";
const PROMPT = "canary-prompt-4d6e";

/** A fresh materialised campaign root with the real shim. */
function campaign() {
    const root = mkdtempSync(join(tmpdir(), "pd-credentials-"));
    execFileSync(process.execPath, [join(CAMPAIGN, "materialise.mjs"), root], {
        stdio: "ignore",
    });
    return root;
}

/** A fake podman that records what the boundary actually received. */
function fakePodman(root) {
    const capture = join(root, "podman-capture.json");
    const binary = join(root, "fake-podman.mjs");
    writeFileSync(
        binary,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PODMAN_CAPTURE, JSON.stringify({
    argv: process.argv.slice(2),
    key: process.env.ZAI_API_KEY ?? null,
    overlay: process.env.OPENCODE_CONFIG_CONTENT ?? null,
}));
`,
        "utf8",
    );
    chmodSync(binary, 0o755);
    return { capture, binary };
}

describe("credential containment", () => {
    it("keeps key, overlay and prompt out of the container log", () => {
        // Arrange
        const root = campaign();
        const { capture, binary } = fakePodman(root);
        const log = join(root, "logs/containers/judge.log");
        mkdirSync(dirname(log), { recursive: true });
        const runDir = join(root, "judge-run");
        const env = {
            ...process.env,
            PATH: `${join(root, "prepare/shim")}:${process.env.PATH ?? ""}`,
            CONTAINER_LOG: log,
            PODMAN_BIN: binary,
            PODMAN_CAPTURE: capture,
            AC_RUN_DIR: runDir,
            AC_MODEL: "zai-coding-plan/test",
            ZAI_API_KEY: KEY,
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { canary: OVERLAY } }),
        };

        // Act
        const result = spawnSync(
            LAUNCHER,
            ["run", "--standalone", "--model", "test", PROMPT],
            { env, encoding: "utf8" },
        );

        // Assert
        assert.equal(result.status, 0, result.stderr);
        const received = JSON.parse(readFileSync(capture, "utf8"));
        assert.equal(received.key, KEY);
        assert.ok(received.argv.includes(PROMPT));
        assert.ok(received.argv.includes("ZAI_API_KEY"));
        assert.ok(!received.argv.includes(`ZAI_API_KEY=${KEY}`));
        assert.ok(!received.argv.includes(OVERLAY));
        assert.ok(!received.overlay.includes(OVERLAY));
        const logText = readFileSync(log, "utf8");
        assert.equal(logText, "podman run\n");
        for (const canary of [KEY, OVERLAY, PROMPT]) {
            assert.ok(!logText.includes(canary), `log leaked ${canary}`);
        }
    });

    it("records only the container subcommand for a trial launch", () => {
        // Arrange
        const root = campaign();
        const log = join(root, "logs/containers/trial.log");
        mkdirSync(dirname(log), { recursive: true });
        const { binary, capture } = fakePodman(root);
        const env = {
            ...process.env,
            CONTAINER_LOG: log,
            PODMAN_BIN: binary,
            PODMAN_CAPTURE: capture,
        };

        // Act
        const result = spawnSync(
            join(root, "prepare/shim/podman"),
            ["run", "--rm", "image", "opencode", PROMPT],
            { env, encoding: "utf8" },
        );

        // Assert
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(log, "utf8"), "podman run\n");
    });

    it("refuses a credential file readable beyond its owner", () => {
        // Arrange
        const root = campaign();
        const envPath = join(root, ".env");
        writeFileSync(envPath, "ZAI_API_KEY=secret\n", { mode: 0o600 });
        const env = { ...process.env };
        delete env.ZAI_API_KEY;
        delete env.ZAI_API_KEY_FILE;

        // Act
        const safe = spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import { credentialFileProblem } from ${JSON.stringify(
                    join(root, "prepare/env.mjs"),
                )};
process.stdout.write(String(credentialFileProblem(process.env.ROOT)));`,
            ],
            { env: { ...env, ROOT: root }, encoding: "utf8" },
        );
        chmodSync(envPath, 0o644);
        const unsafe = spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import { credentialFileProblem } from ${JSON.stringify(
                    join(root, "prepare/env.mjs"),
                )};
process.stdout.write(String(credentialFileProblem(process.env.ROOT)));`,
            ],
            { env: { ...env, ROOT: root }, encoding: "utf8" },
        );

        // Assert
        assert.equal(safe.stdout, "null");
        assert.match(unsafe.stdout, /readable beyond its owner/);
    });
});
