import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    deliveredToolDescription,
    freezeExperiment,
    sha256Text,
    spendFreezeProblem,
    verifyFreeze,
    writeFreeze,
    type FreezeInput,
    type FreezeRecord,
    type FrozenArm,
} from "./fixtures/placement-harness/analysis/freeze.ts";

const DESCRIPTIONS = {
    A: "Record durable findings with the docs tool.",
    B: "Record durable findings with the docs tool. Prefer a note when a command taught you something reusable.",
};

/** One arm whose registration and delivery agree. */
function arm(id: keyof typeof DESCRIPTIONS): FrozenArm {
    const description = DESCRIPTIONS[id];
    return {
        id,
        commit: `commit-${id}`,
        tree: `tree-${id}`,
        clean: true,
        descriptionChars: [...description].length,
        descriptionHash: sha256Text(description),
        deliveredChars: [...description].length,
        deliveredHash: sha256Text(description),
        annotationChars: 10,
        annotationHash: sha256Text("annotation"),
    };
}

const files = [
    { path: "schedule.json", sha256: sha256Text("schedule") },
    { path: "cases.json", sha256: sha256Text("cases") },
    { path: "truth.json", sha256: sha256Text("truth") },
    { path: "prompts/P01.md", sha256: sha256Text("prompt") },
    { path: "measurement.json", sha256: sha256Text("measurement") },
];

const inventories = [
    {
        path: "rubrics",
        files: [
            {
                path: "rubrics/P01/rubric.md",
                sha256: sha256Text("rubric"),
            },
        ],
    },
];

/** A complete, not-yet-started freeze input. */
function input(overrides: Partial<FreezeInput> = {}): FreezeInput {
    return {
        campaign: "pd-test",
        sourceRevision: "abc123",
        sourceTree: "tree123",
        imageId: "sha256:image",
        containerCli: "opencode 2.2.7",
        measurementSha256: sha256Text("measurement"),
        arms: [arm("A"), arm("B")],
        files,
        inventories,
        stoppingRules: ["stop on first unusable assessment"],
        ceilings: { trial: 16, judge: 16 },
        started: false,
        frozen: false,
        ...overrides,
    };
}

describe("delivery probe extraction", () => {
    it("reads the served description from the real request body", () => {
        // Arrange
        const body = {
            model: "opencode-go/deepseek-v4.1-flash",
            tools: [
                {
                    type: "function",
                    function: {
                        name: "docs",
                        description: DESCRIPTIONS.B,
                    },
                },
            ],
        };

        // Act
        const result = deliveredToolDescription(body);

        // Assert
        assert.equal(result.delivered?.description, DESCRIPTIONS.B);
        assert.equal(result.delivered?.sha256, sha256Text(DESCRIPTIONS.B));
    });

    it("refuses a body that does not serve the tool", () => {
        // Act
        const result = deliveredToolDescription({ tools: [] });

        // Assert
        assert.match(result.problem ?? "", /does not serve tool docs/);
    });

    it("refuses a delivery body that is not an object", () => {
        // Act
        const result = deliveredToolDescription("not a body");

        // Assert
        assert.match(result.problem ?? "", /is not an object/);
        assert.equal(result.delivered, undefined);
    });

    it("refuses a delivery body without a tools array", () => {
        // Act
        const result = deliveredToolDescription({ tools: "docs" });

        // Assert
        assert.match(result.problem ?? "", /has no tools array/);
    });

    it("refuses a served tool with a blank description", () => {
        // Act
        const result = deliveredToolDescription({
            tools: [{ function: { name: "docs", description: "   " } }],
        });

        // Assert
        assert.match(result.problem ?? "", /no nonblank description/);
    });

    it("skips malformed entries before the served tool", () => {
        // Arrange – nulls, a missing function block and a different tool all
        // come first; only the named entry may be read.
        const body = {
            tools: [
                null,
                { function: null },
                { function: { name: "other", description: DESCRIPTIONS.A } },
                { function: { name: "docs", description: DESCRIPTIONS.B } },
            ],
        };

        // Act
        const result = deliveredToolDescription(body);

        // Assert
        assert.equal(result.delivered?.description, DESCRIPTIONS.B);
    });

    it("counts a description in characters, not UTF-16 units", () => {
        // Arrange – one emoji is one character but two code units.
        const description = `a${"\u{1F600}"}`;

        // Act
        const result = deliveredToolDescription({
            tools: [{ function: { name: "docs", description } }],
        });

        // Assert
        assert.equal(result.delivered?.chars, 2);
    });
});

describe("experiment freeze", () => {
    it("freezes a clean, unstarted experiment with sorted inputs", () => {
        // Act
        const outcome = freezeExperiment(input());

        // Assert
        assert.equal(outcome.ok, true);
        const record = (outcome as { record: { files: { path: string }[] } })
            .record;
        assert.deepEqual(
            record.files.map((file) => file.path),
            [...files.map((file) => file.path)].sort(),
        );
    });

    it("refuses to freeze after a launch or recorded result", () => {
        // Act
        const outcome = freezeExperiment(input({ started: true }));

        // Assert
        assert.equal(outcome.ok, false);
        assert.match(
            (outcome as { problems: string[] }).problems.join("; "),
            /refusing to freeze after/,
        );
    });

    it("refuses a second freeze", () => {
        // Act
        const outcome = freezeExperiment(input({ frozen: true }));

        // Assert
        assert.equal(outcome.ok, false);
        assert.match(
            (outcome as { problems: string[] }).problems.join("; "),
            /existing freeze/,
        );
    });

    it("refuses a dirty arm", () => {
        // Arrange
        const dirty = { ...arm("B"), clean: false };

        // Act
        const outcome = freezeExperiment(input({ arms: [arm("A"), dirty] }));

        // Assert
        assert.equal(outcome.ok, false);
        assert.match(
            (outcome as { problems: string[] }).problems.join("; "),
            /arm B worktree is dirty/,
        );
    });

    it("refuses a missing or wrong delivery", () => {
        // Arrange
        const wrong = {
            ...arm("B"),
            deliveredHash: sha256Text("a hand-extracted copy"),
        };

        // Act
        const outcome = freezeExperiment(input({ arms: [arm("A"), wrong] }));

        // Assert
        assert.equal(outcome.ok, false);
        assert.match(
            (outcome as { problems: string[] }).problems.join("; "),
            /delivered description differs/,
        );
    });

    it("refuses swapped arm descriptions", () => {
        // Arrange: B registers A's bytes.
        const swapped = {
            ...arm("B"),
            descriptionHash: sha256Text(DESCRIPTIONS.A),
            descriptionChars: [...DESCRIPTIONS.A].length,
            deliveredHash: sha256Text(DESCRIPTIONS.A),
            deliveredChars: [...DESCRIPTIONS.A].length,
        };

        // Act
        const outcome = freezeExperiment(input({ arms: [arm("A"), swapped] }));

        // Assert
        assert.equal(outcome.ok, false);
        assert.match(
            (outcome as { problems: string[] }).problems.join("; "),
            /identical description/,
        );
    });

    it("writes a freeze exclusively and refuses the second write", () => {
        // Arrange
        const dir = mkdtempSync(join(tmpdir(), "pd-freeze-"));
        const path = join(dir, "FROZEN.json");
        const outcome = freezeExperiment(input());
        assert.equal(outcome.ok, true);

        try {
            // Act
            const record = (outcome as { ok: true; record: FreezeRecord })
                .record;
            const first = writeFreeze(path, record);
            const second = writeFreeze(path, record);

            // Assert
            assert.equal(first.ok, true);
            assert.equal(second.ok, false);
            assert.equal(
                JSON.parse(readFileSync(path, "utf8")).campaign,
                "pd-test",
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("freeze verification", () => {
    const record = (
        freezeExperiment(input()) as { ok: true; record: FreezeRecord }
    ).record;

    it("accepts an unchanged premise", () => {
        // Act
        const problems = verifyFreeze(record, {
            files,
            inventories,
            imageId: record.imageId,
            containerCli: record.containerCli,
            sourceRevision: record.sourceRevision,
        });

        // Assert
        assert.deepEqual(problems, []);
    });

    it("reports a modified rubric, fixture or script", () => {
        // Act
        const problems = verifyFreeze(record, {
            files,
            inventories: [
                {
                    path: "rubrics",
                    files: [
                        {
                            path: "rubrics/P01/rubric.md",
                            sha256: sha256Text("edited rubric"),
                        },
                    ],
                },
            ],
            imageId: record.imageId,
            containerCli: record.containerCli,
            sourceRevision: record.sourceRevision,
        });

        // Assert
        assert.match(problems.join("; "), /rubrics\/P01\/rubric\.md/);
    });

    it("reports a rebuilt image or changed CLI", () => {
        // Act
        const rebuilt = verifyFreeze(record, {
            files,
            inventories,
            imageId: "sha256:rebuilt",
            containerCli: "opencode 2.3.0",
            sourceRevision: record.sourceRevision,
        });

        // Assert
        assert.match(rebuilt.join("; "), /container image changed/);
        assert.match(rebuilt.join("; "), /container CLI changed/);
    });

    it("reports an input added after the freeze", () => {
        // Act
        const problems = verifyFreeze(record, {
            files,
            inventories: [
                {
                    path: "rubrics",
                    files: [
                        {
                            path: "rubrics/P01/rubric.md",
                            sha256: sha256Text("rubric"),
                        },
                        {
                            path: "rubrics/P02/rubric.md",
                            sha256: sha256Text("added"),
                        },
                    ],
                },
            ],
            imageId: record.imageId,
            containerCli: record.containerCli,
            sourceRevision: record.sourceRevision,
        });

        // Assert
        assert.match(problems.join("; "), /immutable input changed/);
        assert.match(problems.join("; "), /rubrics\/P02\/rubric\.md/);
    });

    it("treats a legacy freeze as read-only for spend", () => {
        // Arrange
        const legacy = { ...record, schemaVersion: 1 };

        // Act
        const problem = spendFreezeProblem(legacy);

        // Assert
        assert.match(String(problem), /legacy and read-only/);
    });
});
