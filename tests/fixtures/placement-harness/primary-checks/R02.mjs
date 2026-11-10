#!/usr/bin/env node
// Pristine primary check for R02: TLS is required while the pool size,
// acquire timeout and startup migrations stay unchanged.
import {
    finish,
    requireFiles,
    runSuite,
} from "./_replication-shared.mjs";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: R02.mjs <live-work> <pristine-work>");
    process.exit(2);
}

requireFiles(liveWork, pristineWork, [
    "src/db.ts",
    "test/db.test.ts",
    "package.json",
]);

const { root, status } = runSuite(liveWork, pristineWork, "r02");
finish("R02", root, status);
