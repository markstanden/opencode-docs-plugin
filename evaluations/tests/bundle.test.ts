/**
 * Bundle integrity: every asset `manifest.json` declares exists, the OTC suite
 * and campaign agree with each other, and the installed pinned `otc` accepts
 * the campaign from a directory that is not this checkout.
 *
 * This is a product-side checker, not a runner: OTC schedules, dispatches and
 * assesses the trials; this suite only proves the bundle it is handed is
 * complete and internally consistent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = import.meta.dirname;
const EVALUATIONS = dirname(HERE);
const REPO = dirname(EVALUATIONS);

/** Read and parse one JSON document from the repository. */
function readJson(relativePath: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(REPO, relativePath), "utf8")) as Record<
        string,
        unknown
    >;
}

const manifest = readJson("evaluations/docs-placement/manifest.json");
const suite = readJson("evaluations/docs-placement/suite.json");
const campaign = readJson("evaluations/docs-placement/campaign.json");

test("every manifest asset resolves inside the checkout", () => {
    // Arrange: the manifest is the index a fresh evaluator reads first. Only
    // its path-bearing members are checked; provenance fields are data.
    const paths: string[] = [];
    for (const key of [
        "corpora",
        "seeds",
        "truth",
        "primaryChecks",
        "measurement",
        "candidateAssets",
        "otcSuite",
        "otcCampaign",
    ] as const) {
        const value = manifest[key];
        if (typeof value === "string") {
            paths.push(value);
        } else if (typeof value === "object" && value !== null) {
            for (const child of Object.values(value)) {
                if (typeof child === "string") paths.push(child);
            }
        }
    }
    const legacy = manifest.legacyRoute as { path: string };
    paths.push(legacy.path);

    // Act
    const observed = paths.map((relativePath) => ({
        relativePath,
        exists: existsSync(join(REPO, relativePath)),
    }));

    // Assert
    assert.ok(observed.length > 0);
    for (const { relativePath, exists } of observed) {
        assert.ok(exists, `${relativePath} exists`);
    }
});

test("every OTC case declares a prompt and an existing seed", () => {
    // Arrange
    const cases = suite.cases as Array<{
        caseId: string;
        prompt: string;
        fixture: string;
    }>;

    // Act
    const observed = cases.map((item) => ({
        caseId: item.caseId,
        prompt: item.prompt,
        seedExists: existsSync(
            join(EVALUATIONS, "docs-placement", item.fixture),
        ),
    }));

    // Assert
    assert.equal(manifest.otcSuite, "evaluations/docs-placement/suite.json");
    assert.ok(observed.length >= 2);
    for (const item of observed) {
        assert.equal(typeof item.caseId, "string");
        assert.equal(typeof item.prompt, "string");
        assert.ok(item.prompt.length > 20);
        assert.ok(item.seedExists, `${item.caseId} seed exists`);
    }
});

test("every OTC case declares its expected outcome", () => {
    // Arrange
    const cases = suite.cases as Array<{
        caseId: string;
        expectedDocs: unknown;
    }>;

    // Act
    const missing = cases
        .filter((item) => typeof item.expectedDocs !== "object")
        .map((item) => item.caseId);

    // Assert
    assert.ok(cases.length >= 2);
    assert.deepEqual(missing, []);
});

test("the campaign schedules exactly the suite's cases on the plugin arm", () => {
    // Arrange
    const cases = new Set(
        (suite.cases as Array<{ caseId: string }>).map((item) => item.caseId),
    );
    const schedule = campaign.schedule as {
        kind: string;
        slots: Array<{ caseId: string; armId: string }>;
    };
    const subjects = campaign.subjects as Array<{
        armId: string;
        plugins: Array<{ path: string; include: string[] }>;
    }>;

    // Act
    const missing = schedule.slots
        .map((slot) => slot.caseId)
        .filter((caseId) => !cases.has(caseId));

    // Assert
    assert.equal(schedule.kind, "explicit");
    assert.deepEqual(missing, []);
    assert.equal(subjects.length, 1);
    const subject = subjects[0];
    assert.ok(subject);
    assert.ok(schedule.slots.every((slot) => slot.armId === subject.armId));
    assert.equal(subject.plugins.length, 1);
    const plugin = subject.plugins[0];
    assert.ok(plugin);
    assert.equal(join(EVALUATIONS, "docs-placement", plugin.path), REPO);
    for (const member of plugin.include) {
        assert.ok(existsSync(join(REPO, member)), `${member} is staged`);
    }
});

test("the installed pinned otc validates the campaign from an unrelated directory", () => {
    // Arrange: the proof is the installed binary, not this checkout's code.
    const binary = join(EVALUATIONS, "node_modules", ".bin", "otc");
    assert.ok(existsSync(binary), "the pinned OTC artifact is installed");

    // Act
    const result = spawnSync(
        binary,
        [
            "validate",
            "--campaign",
            join(EVALUATIONS, "docs-placement", "campaign.json"),
        ],
        { cwd: EVALUATIONS, encoding: "utf8" },
    );

    // Assert
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^valid: docs-placement-recording-local/m);
});
