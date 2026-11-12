#!/usr/bin/env node
// Pristine primary check for S05: the repaired Bruno assertion accepts the valid
// response and rejects both failing examples, with the runner, fixtures and
// tests restored from the pristine tree.
import {
    finish,
    requireFiles,
    runRestoredSuite,
} from "./_replication-shared.mts";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: S05.mts <live-work> <pristine-work>");
    process.exit(2);
}

requireFiles(liveWork, pristineWork, [
    "bruno/orders/create-order.bru",
    "scripts/run-bru-assertion.mjs",
    "test/assertion.test.ts",
    "fixtures/responses/ok.json",
    "fixtures/responses/fail-1.json",
    "fixtures/responses/fail-2.json",
]);

const { root, status } = runRestoredSuite(liveWork, pristineWork, "s05", [
    "test",
    "package.json",
    "scripts",
    "fixtures",
]);
finish("S05", root, status);
