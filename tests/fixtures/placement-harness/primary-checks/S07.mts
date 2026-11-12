#!/usr/bin/env node
// Pristine primary check for S07: the corrected upgrade check validates a 4.x
// upgrade without the legacy migration, still requires it for 3.x, and keeps
// the snapshot and rollback requirements.
import { finish, requireFiles, runSuite } from "./_replication-shared.mts";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: S07.mts <live-work> <pristine-work>");
    process.exit(2);
}

requireFiles(liveWork, pristineWork, [
    "scripts/check-upgrade.mjs",
    "test/upgrade.test.ts",
    "package.json",
]);

const { root, status } = runSuite(liveWork, pristineWork, "s07");
finish("S07", root, status);
