import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures", "placement-harness", "prod014");
const checksDir = join(here, "fixtures", "placement-harness", "primary-checks");
const readJson = <T>(name: string): T =>
    JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as T;

interface CaseEntry {
    id: string;
    primaryCheck?: { script?: string };
    seeds?: Array<{ surface: string; path: string }>;
    expectedDocs?: { target?: string; preserve?: string[] };
}

interface Measurement {
    recordingOpportunities: string[];
    retrievalOpportunities: string[];
    scenarios: Record<
        string,
        {
            retrieval?: { note?: string; detail?: string };
            preservation?: {
                facts?: Array<{ id: string; obsolete?: boolean }>;
            };
        }
    >;
}

const cases = readJson<CaseEntry[]>("cases.json");
const truth = readJson<Record<string, string>>("truth.json");
const measurement = readJson<Measurement>("measurement.json");

describe("0.14.0 productivity-trial fixtures", () => {
    it("carries one case per scheduled pair, in pair order", () => {
        // Arrange
        const expected = [
            "R01",
            "S02",
            "R02",
            "R03",
            "S05",
            "S06",
            "S07",
            "R04",
        ];

        // Act
        const ids = cases.map((entry) => entry.id);

        // Assert
        assert.deepEqual(ids, expected);
        assert.equal(new Set(ids).size, expected.length);
    });

    it("gives every case a runnable primary check and a truth entry", () => {
        // Act
        const missing = cases.filter(
            (entry) =>
                !existsSync(
                    join(checksDir, entry.primaryCheck?.script ?? ""),
                ) || typeof truth[entry.id] !== "string",
        );

        // Assert
        assert.deepEqual(
            missing.map((entry) => entry.id),
            [],
        );
    });

    it("keeps every seeded expectation on a declared seed path", () => {
        // Act
        const problems = [];
        for (const entry of cases) {
            const seeded = new Set(
                (entry.seeds ?? []).map(
                    (seed) => `${seed.surface}/${seed.path}`,
                ),
            );
            const expectedDocs = entry.expectedDocs ?? {};
            const paths = [
                expectedDocs.target,
                ...(expectedDocs.preserve ?? []),
            ].filter((path) => typeof path === "string");
            for (const path of paths) {
                if (!seeded.has(path) && !seeded.has(`work/${path}`)) {
                    problems.push(`${entry.id}: ${path}`);
                }
            }
        }

        // Assert
        assert.deepEqual(problems, []);
    });

    it("declares the planned recording and retrieval opportunities", () => {
        // Assert
        assert.deepEqual(measurement.recordingOpportunities, [
            "R01",
            "R02",
            "S05",
            "S07",
        ]);
        assert.deepEqual(measurement.retrievalOpportunities, [
            "S02",
            "R02",
            "S06",
            "S07",
            "R04",
        ]);
    });

    it("carries a retrieval finding for every retrieval opportunity", () => {
        // Act
        const missing = measurement.retrievalOpportunities.filter(
            (id) =>
                typeof measurement.scenarios[id]?.retrieval?.note !==
                    "string" ||
                typeof measurement.scenarios[id]?.retrieval?.detail !==
                    "string",
        );

        // Assert
        assert.deepEqual(missing, []);
    });

    it("declares the correction inventory for the upgrade scenario", () => {
        // Act
        const facts = measurement.scenarios.S07?.preservation?.facts ?? [];

        // Assert
        assert.deepEqual(
            facts.map((fact) => fact.id),
            ["snapshot", "rollback", "legacyCondition"],
        );
        assert.equal(
            facts.find((fact) => fact.id === "legacyCondition")?.obsolete,
            true,
        );
    });
});

describe("frozen campaign snapshot", () => {
    const snapshot = readJson<{
        files: Record<string, string>;
        hashes: Record<string, string>;
    }>("campaign/scripts.json");

    it("hashes every frozen script", () => {
        // Act
        const mismatches = Object.entries(snapshot.files).filter(
            ([name, body]) =>
                createHash("sha256").update(body, "utf8").digest("hex") !==
                snapshot.hashes[name],
        );

        // Assert
        assert.deepEqual(
            mismatches.map(([name]) => name),
            [],
        );
    });

    it("carries no personal path or credential file name", () => {
        // Act
        const leaks = Object.entries(snapshot.files)
            .filter(([, body]) =>
                /\/home\/mark\/|zai-api-key-docs-plugin-testing/.test(body),
            )
            .map(([name]) => name);

        // Assert
        assert.deepEqual(leaks, []);
    });
});

describe("materialised campaign runner", () => {
    it("marks the shell scripts executable", () => {
        // Arrange
        const target = mkdtempSync(join(tmpdir(), "pd-materialise-"));

        try {
            // Act
            execFileSync(
                process.execPath,
                [join(fixtureDir, "campaign", "materialise.mts"), target],
                { encoding: "utf8" },
            );
            const modes = ["prepare/generate.sh", "prepare/shim/podman"].map(
                (path) => statSync(join(target, path)).mode & 0o777,
            );

            // Assert
            assert.deepEqual(modes, [0o755, 0o755]);
        } finally {
            rmSync(target, { recursive: true, force: true });
        }
    });
});

describe("fresh and historical materialisation", () => {
    it("selects attempt-001 fresh and keeps attempt-002 historical", () => {
        // Arrange
        const fresh = mkdtempSync(join(tmpdir(), "pd-fresh-"));
        const historical = mkdtempSync(join(tmpdir(), "pd-hist-"));
        try {
            // Act
            execFileSync(
                process.execPath,
                [join(fixtureDir, "campaign", "materialise.mts"), fresh],
                { encoding: "utf8" },
            );
            execFileSync(
                process.execPath,
                [
                    join(fixtureDir, "campaign", "materialise.mts"),
                    historical,
                    "--historical",
                ],
                { encoding: "utf8" },
            );
            const freshAttempt = JSON.parse(
                readFileSync(join(fresh, "prepare/manifest.json"), "utf8"),
            ).assessment.attemptId;
            const historicalAttempt = JSON.parse(
                readFileSync(join(historical, "prepare/manifest.json"), "utf8"),
            ).assessment.attemptId;

            // Assert
            assert.equal(freshAttempt, "attempt-001");
            assert.equal(historicalAttempt, "attempt-002");
        } finally {
            rmSync(fresh, { recursive: true, force: true });
            rmSync(historical, { recursive: true, force: true });
        }
    });

    it("refuses to overwrite a materialised or frozen campaign", () => {
        // Arrange
        const target = mkdtempSync(join(tmpdir(), "pd-refuse-"));
        try {
            execFileSync(
                process.execPath,
                [join(fixtureDir, "campaign", "materialise.mts"), target],
                { encoding: "utf8" },
            );

            // Act
            const second = spawnSync(
                process.execPath,
                [join(fixtureDir, "campaign", "materialise.mts"), target],
                { encoding: "utf8" },
            );

            // Assert
            assert.notEqual(second.status, 0);
            assert.match(String(second.stderr), /refusing to overwrite/);

            // Arrange a frozen marker and a fresh target.
            const frozen = mkdtempSync(join(tmpdir(), "pd-frozen-"));
            try {
                mkdirSync(join(frozen, "evidence"), { recursive: true });
                writeFileSync(join(frozen, "evidence/FROZEN.json"), "{}\n");
                // Act
                const refused = spawnSync(
                    process.execPath,
                    [join(fixtureDir, "campaign", "materialise.mts"), frozen],
                    { encoding: "utf8" },
                );
                // Assert
                assert.notEqual(refused.status, 0);
                assert.match(String(refused.stderr), /frozen campaign/);
            } finally {
                rmSync(frozen, { recursive: true, force: true });
            }
        } finally {
            rmSync(target, { recursive: true, force: true });
        }
    });
});
