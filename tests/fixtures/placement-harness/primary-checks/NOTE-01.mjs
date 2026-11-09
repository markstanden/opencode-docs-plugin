#!/usr/bin/env node
// Pristine primary check for NOTE-01: run the seeded replay test against the
// live source in an isolated copy, so a model-edited visible test or
// package script cannot satisfy the check.
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: NOTE-01.mjs <live-work> <pristine-work>");
    process.exit(2);
}

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

for (const path of [
    "src/retry.ts",
    "src/consumer.ts",
    join(pristineWork, "test/retry.test.ts"),
    join(pristineWork, "package.json"),
]) {
    if (!existsSync(path)) fail(`missing required file: ${path}`);
}

const root = mkdtempSync(join(tmpdir(), "note-01-check-"));
try {
    cpSync(join(liveWork, "src"), join(root, "src"), { recursive: true });
    cpSync(join(pristineWork, "test"), join(root, "test"), {
        recursive: true,
    });
    cpSync(join(pristineWork, "package.json"), join(root, "package.json"));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync("npm", ["test"], {
        cwd: root,
        encoding: "utf8",
        timeout: 90000,
        env,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) fail(`pristine test runner failed: ${result.error}`);
    if (result.status !== 0) {
        fail(`pristine replay test failed (exit ${result.status})`);
    }
    console.log("NOTE-01 primary check: pass");
} finally {
    rmSync(root, { recursive: true, force: true });
}
