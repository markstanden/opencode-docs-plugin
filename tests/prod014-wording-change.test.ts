import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const fixture = join(here, "fixtures", "placement-harness", "prod014");
const replication = join(here, "fixtures", "placement-harness", "replication");
const repo = join(here, "..");

const sha = (path: string): string =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

describe("B-only wording change", () => {
    it("needs only the candidate asset, not runner, judge or scoring code", () => {
        // Arrange
        const temp = mkdtempSync(join(tmpdir(), "pd-wording-"));
        try {
            const source = join(temp, "index.ts");
            const asset = join(temp, "b.txt");
            cpSync(join(repo, "src/index.ts"), source);
            const originalAsset = readFileSync(
                join(fixture, "assets", "b-prod014.txt"),
                "utf8",
            );
            writeFileSync(asset, `${originalAsset}\nOne extra sentence.`, "utf8");
            const code = [
                "analysis/measures.ts",
                "analysis/decision.ts",
                "analysis/analyse.mts",
                "prod014/campaign/scripts.json",
            ].map((path) =>
                sha(join(here, "fixtures", "placement-harness", path)),
            );

            // Act
            execFileSync(
                process.execPath,
                [join(replication, "patch.mjs"), source, asset, "b"],
                { encoding: "utf8" },
            );

            // Assert: the arm source carries the new wording, and no decision
            // code was touched by the change.
            assert.notEqual(sha(source), sha(join(repo, "src/index.ts")));
            assert.deepEqual(
                [
                    "analysis/measures.ts",
                    "analysis/decision.ts",
                    "analysis/analyse.mts",
                    "prod014/campaign/scripts.json",
                ].map((path) =>
                    sha(join(here, "fixtures", "placement-harness", path)),
                ),
                code,
            );
        } finally {
            rmSync(temp, { recursive: true, force: true });
        }
    });
});
