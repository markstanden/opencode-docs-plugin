#!/usr/bin/env node
// Pristine primary check for H02: two tenants holding the same record id must
// not overwrite each other, with the visible test replaced by the pristine copy.
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: H02.mjs <live-work> <pristine-work>");
    process.exit(2);
}

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

for (const path of [
    join(liveWork, "src/cache.ts"),
    join(pristineWork, "test/cache.test.ts"),
    join(pristineWork, "package.json"),
]) {
    if (!existsSync(path)) fail(`missing required file: ${path}`);
}

const root = mkdtempSync(join(tmpdir(), "h02-check-"));
try {
    cpSync(join(liveWork, "src"), join(root, "src"), { recursive: true });
    cpSync(join(pristineWork, "test"), join(root, "test"), { recursive: true });
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
        fail(`pristine tenant-isolation test failed (exit ${result.status})`);
    }
    console.log("H02 primary check: pass");
} finally {
    rmSync(root, { recursive: true, force: true });
}
