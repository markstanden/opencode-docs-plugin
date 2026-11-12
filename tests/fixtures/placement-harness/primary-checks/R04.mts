#!/usr/bin/env node
// Pristine primary check for R04: the suite passes and the generated migration
// and lint script are byte-identical to the seed.
import {
    assertUnchanged,
    finish,
    requireFiles,
    runSuite,
} from "./_replication-shared.mts";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: R04.mts <live-work> <pristine-work>");
    process.exit(2);
}

requireFiles(liveWork, pristineWork, [
    "migrations/002_add_index.sql",
    "scripts/lint-migrations.mjs",
    "test/migrations.test.ts",
    "package.json",
]);

const { root, status } = runSuite(liveWork, pristineWork, "r04");
finish("R04", root, status, (copied: string) => {
    assertUnchanged(copied, pristineWork, [
        "migrations/002_add_index.sql",
        "scripts/lint-migrations.mjs",
    ]);
});
