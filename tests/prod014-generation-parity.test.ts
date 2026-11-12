import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const fixture = join(here, "fixtures", "placement-harness", "prod014");
const replication = join(here, "fixtures", "placement-harness", "replication");

const read = <T>(path: string): T =>
    JSON.parse(readFileSync(path, "utf8")) as T;

interface Measurement {
    campaign: string;
    recordingOpportunities: string[];
    retrievalOpportunities: string[];
    scenarios: Record<
        string,
        {
            retrieval?: { note: string; lake: string; detail: string };
            preservation?: {
                facts: Array<{ id: string; obsolete?: boolean }>;
            };
        }
    >;
}

describe("prod014 generation parity", () => {
    it("regenerates the canonical cases, truth and measurement values", () => {
        // Arrange
        const temp = mkdtempSync(join(tmpdir(), "pd-generate-"));
        try {
            cpSync(fixture, join(temp, "prod014"), { recursive: true });
            cpSync(replication, join(temp, "replication"), { recursive: true });

            // Act
            execFileSync(process.execPath, [join(temp, "prod014/build.mjs")], {
                encoding: "utf8",
            });

            // Assert: parsed output is authoritative; formatting may differ.
            for (const name of [
                "cases.json",
                "truth.json",
                "measurement.json",
            ]) {
                assert.deepEqual(
                    read(join(temp, "prod014", name)),
                    read(join(fixture, name)),
                    `${name} differs from the checked-in fixture`,
                );
            }
        } finally {
            rmSync(temp, { recursive: true, force: true });
        }
    });

    it("keeps the checked-in fixtures the authoritative campaign inputs", () => {
        // Act
        const measurement = read<Measurement>(
            join(fixture, "measurement.json"),
        );

        // Assert: the generator writes these same files, so there is no second
        // live source; materialise and freeze read the checked-in copies.
        assert.deepEqual(measurement.recordingOpportunities, [
            "R01",
            "R02",
            "S05",
            "S07",
        ]);
        assert.equal(typeof measurement.campaign, "string");
    });
});

describe("independently specified preservation facts", () => {
    it("keeps the R02 pool, timeout and startup-migration facts", () => {
        // Act
        const measurement = read<Measurement>(
            join(fixture, "measurement.json"),
        );

        // Assert
        assert.deepEqual(
            (measurement.scenarios.R02?.preservation?.facts ?? []).map(
                (fact) => fact.id,
            ),
            [
                "poolSize",
                "acquireTimeout",
                "startupMigrations",
                "obsoleteTlsClaim",
            ],
        );
        assert.equal(measurement.scenarios.R02?.retrieval?.lake, "docs");
    });

    it("keeps the S07 snapshot, rollback and obsolete legacy condition", () => {
        // Act
        const measurement = read<Measurement>(
            join(fixture, "measurement.json"),
        );

        // Assert
        assert.deepEqual(
            (measurement.scenarios.S07?.preservation?.facts ?? []).map(
                (fact) => fact.id,
            ),
            ["snapshot", "rollback", "legacyCondition"],
        );
        assert.equal(
            measurement.scenarios.S07?.preservation?.facts.find(
                (fact) => fact.id === "legacyCondition",
            )?.obsolete,
            true,
        );
        assert.equal(measurement.scenarios.S07?.retrieval?.lake, "docs");
    });
});
