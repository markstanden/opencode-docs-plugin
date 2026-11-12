import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    blindingFindings,
    packetFindings,
    trialEnvFindings,
} from "./fixtures/placement-harness/analysis/blinding.ts";
import { buildAcPrompt } from "./fixtures/placement-harness/ac-scoring.mts";

const here = import.meta.dirname;

/** A realistic, arm-blind judge packet input. */
const packetInput = () => ({
    taskPrompt: "Fix the staging deploy order.\n",
    standingPermission: "You may record durable findings.\n",
    scenarioTruth: "The smoke check runs after the switch.",
    beforeDocs: [{ path: "ops/deploy.md", contents: "smoke after switch\n" }],
    afterDocs: [{ path: "ops/deploy.md", contents: "smoke after switch\n" }],
    changedPaths: ["lakes/docs/ops/deploy.md"],
    primary: { status: "pass", exit: 0, stdout: "", stderr: "" },
    docsOperations: ["completed native read ops/deploy.md"],
    answer: "The note already covers the order.\n",
    retrievalSpec: { note: "ops/deploy.md", lake: "docs", detail: "smoke" },
});

describe("trial-child blinding", () => {
    it("allows the arm-neutral image and fixture identities", () => {
        // Act
        const findings = trialEnvFindings({
            PLACEMENT_IMAGE: "localhost/opencode-placement-trials",
            PLACEMENT_IMAGE_ID: "sha256:image",
            PLACEMENT_FIXTURE_HASH: "abc",
        });

        // Assert
        assert.deepEqual(findings, []);
    });

    it("rejects arm-specific provenance variables", () => {
        // Act
        const findings = trialEnvFindings({
            PLACEMENT_PLUGIN_COMMIT: "commit-b",
            PLACEMENT_PLUGIN_DIRTY: "1",
        });

        // Assert
        assert.deepEqual(
            findings.map((finding) => finding.field),
            ["PLACEMENT_PLUGIN_COMMIT", "PLACEMENT_PLUGIN_DIRTY"],
        );
        assert.ok(
            findings.every(
                (finding) => finding.fragment === "arm-specific provenance",
            ),
        );
    });

    it("detects a revealing stamp in a mount or result path", () => {
        // Act
        const findings = blindingFindings("mount", "/results/pd-A-r0-S02/R01");

        // Assert
        assert.equal(findings.length, 1);
        assert.match(findings[0]?.fragment ?? "", /stamp:pd-A-r0/);
    });

    it("keeps the trial container environment free of provenance fields", () => {
        // Arrange
        const script = readFileSync(
            join(here, "fixtures", "placement-harness", "container-run.sh"),
            "utf8",
        );
        const envBlock = /CONTAINER_ENV=\(([\s\S]*?)\n {4}\)/.exec(script)?.[1];

        // Assert
        assert.ok(envBlock !== undefined);
        assert.ok(!envBlock.includes("PLACEMENT_PLUGIN_COMMIT"));
        assert.ok(!envBlock.includes("PLACEMENT_PLUGIN_DIRTY"));
        assert.ok(script.includes("/results/slot/$id"));
        assert.ok(script.includes("--stamp slot"));
    });
});

describe("judge-packet blinding", () => {
    it("builds a packet with no arm label, arm path or stamp", () => {
        // Act
        const prompt = buildAcPrompt(packetInput());
        const findings = blindingFindings("prompt", prompt);

        // Assert
        assert.deepEqual(findings, []);
    });

    it("keeps the declared lake, path and application evidence", () => {
        // Act
        const prompt = buildAcPrompt(packetInput());

        // Assert
        assert.match(prompt, /docs\/ops\/deploy\.md/);
        assert.match(prompt, /smoke after switch/);
        assert.match(prompt, /RETRIEVAL ASSESSMENT/);
    });

    it("detects a nested stamp in packet metadata", () => {
        // Arrange
        const packet = {
            case: "R01",
            evidence: [{ reference: "ac/pd-B-r0-R01/attempt-002" }],
        };

        // Act
        const findings = packetFindings(packet);

        // Assert
        assert.equal(findings.length, 1);
        assert.match(findings[0]?.field ?? "", /evidence\[0\]\.reference/);
    });
});
