#!/usr/bin/env node
// Pristine primary check for S06: the answer names the derived status and the
// deciding run, and the offline export is unchanged.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertUnchanged } from "./_replication-shared.mjs";

const [liveWork, pristineWork] = process.argv.slice(2);
if (!liveWork || !pristineWork) {
    console.error("usage: S06.mjs <live-work> <pristine-work>");
    process.exit(2);
}

const answerPath = join(liveWork, "answer.md");
if (!existsSync(answerPath)) {
    console.error("S06 primary check: fail (no answer.md)");
    process.exit(1);
}
const answer = readFileSync(answerPath, "utf8");
const problems = [];
if (!/\bPartially Automated\b/i.test(answer)) {
    problems.push("answer does not state the derived status Partially Automated");
}
if (!/\bR-1041\b/.test(answer)) {
    problems.push("answer does not cite the deciding run R-1041");
}
const withoutDerived = answer
    .replace(/Partially Automated/gi, "")
    .replace(/Not Automated/gi, "");
if (/\bAutomated\b/i.test(withoutDerived)) {
    problems.push("answer still asserts the stale stored status Automated");
}

try {
    assertUnchanged(liveWork, pristineWork, [
        "records/test-cases.json",
        "records/automation-runs.json",
        "records/README.md",
    ]);
} catch (error) {
    problems.push(String(error));
}

if (problems.length > 0) {
    console.error(`S06 primary check: fail\n${problems.join("\n")}`);
    process.exit(1);
}
console.log("S06 primary check: pass");
