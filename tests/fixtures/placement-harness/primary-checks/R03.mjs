#!/usr/bin/env node
// Pristine primary check for R03: the suite is green once the stale socket is
// removed, with the visible test replaced by the pristine copy.
import {
    finish,
    requireFiles,
    runSuite,
} from "./_replication-shared.mjs";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: R03.mjs <live-work> <pristine-work>");
    process.exit(2);
}

requireFiles(liveWork, pristineWork, [
    "src/server.ts",
    "test/server.test.ts",
    "package.json",
]);

const { root, status } = runSuite(liveWork, pristineWork, "r03");
finish("R03", root, status);
