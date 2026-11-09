#!/usr/bin/env node
// Pristine primary check for NOTE-02: the setup command must succeed on the
// trial runtime and the three version declarations must agree on Node 24.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [liveWork] = process.argv.slice(2);
if (!liveWork) {
    console.error("usage: NOTE-02.mjs <live-work> <pristine-work>");
    process.exit(2);
}

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

const read = (path) => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        fail(`missing required file: ${path}`);
    }
};

const nvmrc = read(join(liveWork, ".nvmrc")).trim();
if (nvmrc !== "24") fail(`.nvmrc must be 24, found ${JSON.stringify(nvmrc)}`);

const packageAt = read(join(liveWork, "package.json"));
let engines = "";
try {
    engines = String(JSON.parse(packageAt).engines?.node ?? "");
} catch {
    fail("package.json is not valid JSON");
}
if (!engines.includes("24")) {
    fail(
        `package engines must state Node 24, found ${JSON.stringify(engines)}`,
    );
}

const checker = read(join(liveWork, "scripts/check-node.mjs"));
if (!checker.includes("24")) fail("check-node.mjs does not mention Node 24");
if (checker.includes("22")) fail("check-node.mjs still mentions Node 22");
if (!existsSync(join(liveWork, "scripts/check-node.mjs"))) {
    fail("scripts/check-node.mjs is missing");
}

const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const result = spawnSync("npm", ["run", "setup"], {
    cwd: liveWork,
    encoding: "utf8",
    timeout: 60000,
    env,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) fail(`setup command failed to run: ${result.error}`);
if (result.status !== 0) {
    fail(`npm run setup failed (exit ${result.status})`);
}
console.log("NOTE-02 primary check: pass");
