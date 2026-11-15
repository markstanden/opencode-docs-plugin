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

/** Manifest keys whose string values are provenance, not repository paths. */
const PROVENANCE_KEYS = new Set([
    "repository",
    "sourceSha",
    "bundleId",
    "description",
    "pinnedSha",
    "resumableByOtc",
]);

test("every manifest path member resolves inside the checkout", () => {
    // Arrange: traverse every string in the manifest, so a new path-bearing
    // member cannot escape the check by not being in a hand-kept key list.
    const paths: string[] = [];
    const visit = (value: unknown, key: string): void => {
        if (typeof value === "string") {
            if (!PROVENANCE_KEYS.has(key)) paths.push(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) visit(item, key);
            return;
        }
        if (typeof value === "object" && value !== null) {
            for (const [childKey, child] of Object.entries(value)) {
                visit(child, childKey);
            }
        }
    };
    visit(manifest, "");

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

test("the manifest points at the suite and campaign the checks read", () => {
    // Arrange
    const expected = {
        otcSuite: "evaluations/docs-placement/suite.json",
        otcCampaign: "evaluations/docs-placement/campaign.json",
    };

    // Act
    const observed = {
        otcSuite: manifest.otcSuite,
        otcCampaign: manifest.otcCampaign,
    };

    // Assert
    assert.deepEqual(observed, expected);
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

test("the campaign schedules every suite case in an explicit slot", () => {
    // Arrange
    const cases = new Set(
        (suite.cases as Array<{ caseId: string }>).map((item) => item.caseId),
    );
    const schedule = campaign.schedule as {
        kind: string;
        slots: Array<{ caseId: string; armId: string }>;
    };

    // Act
    const scheduled = new Set(schedule.slots.map((slot) => slot.caseId));
    const unknown = [...scheduled].filter((caseId) => !cases.has(caseId));
    const unscheduled = [...cases].filter((caseId) => !scheduled.has(caseId));

    // Assert
    assert.equal(schedule.kind, "explicit");
    assert.deepEqual(
        { unknown, unscheduled },
        { unknown: [], unscheduled: [] },
    );
});

test("the campaign stages the shipped product on its single plugin arm", () => {
    // Arrange
    const schedule = campaign.schedule as {
        slots: Array<{ armId: string }>;
    };
    const subjects = campaign.subjects as Array<{
        armId: string;
        plugins: Array<{ path: string; include: string[] }>;
    }>;

    // Act: read the single declared arm and the plugin members it stages.
    const [subject] = subjects;

    // Assert
    assert.equal(subjects.length, 1);
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
