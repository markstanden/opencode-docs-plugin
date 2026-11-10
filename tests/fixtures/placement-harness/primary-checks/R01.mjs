#!/usr/bin/env node
// Pristine primary check for R01: both the BOM sample and the plain UTF-8
// sample must parse, with the visible test replaced by the pristine copy.
import { finish, requireFiles, runSuite } from "./_replication-shared.mjs";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: R01.mjs <live-work> <pristine-work>");
    process.exit(2);
}

requireFiles(liveWork, pristineWork, [
    "src/csv.ts",
    "fixtures/orders.csv",
    "test/csv.test.ts",
    "package.json",
]);

const { root, status } = runSuite(liveWork, pristineWork, "r01");
finish("R01", root, status);
