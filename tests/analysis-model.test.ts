import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    MANIFEST_SCHEMA_VERSION,
    parseManifest,
    type CampaignManifest,
    type Disposition,
    type EvidenceLayout,
    type GuardrailKind,
    type SelectionPolicy,
    type UtilityWeightsSpec,
} from "./fixtures/placement-harness/analysis/model.ts";

/** A minimal valid manifest every test mutates. */
const validManifest = (): CampaignManifest => ({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    campaign: { id: "test-campaign", question: "does B beat A?" },
    arms: [
        { id: "A", label: "control" },
        { id: "B", label: "candidate" },
    ],
    scenarios: [
        { id: "R01", kind: "reuse-create" },
        { id: "R02", kind: "reuse-update" },
    ],
    schedule: {
        slots: [
            {
                slot: 1,
                stamp: "cc-A-r0-R01",
                scenario: "R01",
                arm: "A",
                repetition: 0,
                pairId: "P01",
            },
            {
                slot: 2,
                stamp: "cc-B-r0-R01",
                scenario: "R01",
                arm: "B",
                repetition: 0,
                pairId: "P01",
            },
        ],
    },
    evidence: {
        layout: "ac-v1",
        resultRoots: { A: "gen/a/holdout/results", B: "gen/b/holdout/results" },
    },
    assessment: { selectionPolicy: "resolution-then-judgement" },
    policy: {
        policyId: "frozen-plan-2026-11-10",
        weights: {
            useful: 5,
            transient: -1,
            duplicate: -2,
            misleading: -5,
            taskFailure: -5,
        },
        guardrails: [
            {
                id: "mutation-policy",
                kind: "mutation-policy",
                requirement: "no out-of-policy mutation",
            },
            {
                id: "destructive-loss",
                kind: "destructive-loss",
                requirement: "no loss of still-valid facts",
            },
        ],
    },
});

const parseOf = (mutate: (manifest: CampaignManifest) => void) => {
    const manifest = validManifest();
    mutate(manifest);
    return parseManifest(manifest);
};

describe("parseManifest", () => {
    it("accepts a valid manifest and returns it unchanged", () => {
        // Arrange
        const manifest = validManifest();

        // Act
        const parsed = parseManifest(manifest);

        // Assert
        assert.deepEqual(parsed.problems, []);
        assert.deepEqual(parsed.value, manifest);
    });

    it("returns problems instead of throwing on junk input", () => {
        // Act / Assert
        for (const junk of [null, 42, "manifest", [], true, undefined]) {
            const parsed = parseManifest(junk);
            assert.ok(parsed.problems.length > 0, `no problems for ${junk}`);
            assert.equal(parsed.value, undefined);
        }
    });

    it("refuses an unsupported schema version", () => {
        // Act
        const parsed = parseOf((manifest) => {
            manifest.schemaVersion = 2;
        });

        // Assert
        assert.ok(parsed.problems.some((p) => p.includes("schemaVersion")));
    });

    it("refuses duplicate arm ids", () => {
        // Act
        const parsed = parseOf((manifest) => {
            manifest.arms.push({ id: "A" });
        });

        // Assert
        assert.ok(parsed.problems.some((p) => p.includes("duplicate arm")));
    });

    it("refuses duplicate scenario ids and unknown slot references", () => {
        // Act
        const duplicateScenario = parseOf((manifest) => {
            manifest.scenarios.push({ id: "R01" });
        });
        const unknownScenario = parseOf((manifest) => {
            manifest.schedule.slots[0]!.scenario = "R09";
        });
        const unknownArm = parseOf((manifest) => {
            manifest.schedule.slots[0]!.arm = "Z";
        });

        // Assert
        assert.ok(
            duplicateScenario.problems.some((p) =>
                p.includes("duplicate scenario"),
            ),
        );
        assert.ok(
            unknownScenario.problems.some((p) =>
                p.includes("undeclared scenario"),
            ),
        );
        assert.ok(
            unknownArm.problems.some((p) => p.includes("undeclared arm")),
        );
    });

    it("refuses an unknown slot disposition", () => {
        // Act
        const parsed = parseOf((manifest) => {
            manifest.schedule.slots[0]!.disposition = "bogus" as Disposition;
        });

        // Assert
        assert.ok(parsed.problems.some((p) => p.includes("disposition")));
    });

    it("refuses duplicate slot numbers and duplicate stamps", () => {
        // Act
        const duplicateSlot = parseOf((manifest) => {
            manifest.schedule.slots[1]!.slot = 1;
        });
        const duplicateStamp = parseOf((manifest) => {
            manifest.schedule.slots[1]!.stamp = "cc-A-r0-R01";
        });

        // Assert
        assert.ok(
            duplicateSlot.problems.some((p) => p.includes("duplicate slot")),
        );
        assert.ok(
            duplicateStamp.problems.some((p) => p.includes("duplicate stamp")),
        );
    });

    it("refuses a pair that is not two distinct arms of one scenario repetition", () => {
        // Act
        const single = parseOf((manifest) => {
            manifest.schedule.slots.pop();
        });
        const triple = parseOf((manifest) => {
            manifest.schedule.slots.push({
                slot: 3,
                stamp: "cc-A-r1-R01",
                scenario: "R01",
                arm: "A",
                repetition: 1,
                pairId: "P01",
            });
        });
        const sameArm = parseOf((manifest) => {
            manifest.schedule.slots[1]!.arm = "A";
        });
        const mixedScenario = parseOf((manifest) => {
            manifest.schedule.slots[1]!.scenario = "R02";
        });
        const mixedRepetition = parseOf((manifest) => {
            manifest.schedule.slots[1]!.repetition = 7;
        });

        // Assert
        const all = [single, triple, sameArm, mixedScenario, mixedRepetition];
        for (const parsed of all) {
            assert.ok(
                parsed.problems.some((p) => p.includes("pair P01")),
                `no pair problem in ${JSON.stringify(parsed.problems)}`,
            );
        }
    });

    it("accepts an empty schedule so zero denominators stay reportable", () => {
        // Act
        const parsed = parseOf((manifest) => {
            manifest.schedule.slots = [];
        });

        // Assert
        assert.deepEqual(parsed.problems, []);
    });

    it("refuses incomplete or non-finite utility weights", () => {
        // Act
        const missing = parseOf((manifest) => {
            manifest.policy.weights = {
                useful: 5,
                transient: -1,
                misleading: -5,
                taskFailure: -5,
            } as UtilityWeightsSpec;
        });
        const nonNumeric = parseOf((manifest) => {
            manifest.policy.weights.misleading = "-5" as unknown as number;
        });

        // Assert
        assert.ok(
            missing.problems.some((p) => p.includes("weights.duplicate")),
        );
        assert.ok(
            nonNumeric.problems.some((p) => p.includes("weights.misleading")),
        );
    });

    it("refuses unknown evidence layouts and unparsable result roots", () => {
        // Act
        const unknownLayout = parseOf((manifest) => {
            manifest.evidence.layout = "magic-v9" as EvidenceLayout;
        });
        const missingRoot = parseOf((manifest) => {
            delete manifest.evidence.resultRoots.B;
        });
        const absolute = parseOf((manifest) => {
            manifest.evidence.resultRoots.B = "/home/mark/tmp/results";
        });
        const traversal = parseOf((manifest) => {
            manifest.evidence.resultRoots.B = "../elsewhere/results";
        });

        // Assert
        assert.ok(unknownLayout.problems.some((p) => p.includes("layout")));
        assert.ok(
            missingRoot.problems.some((p) => p.includes("resultRoots.B")),
        );
        assert.ok(absolute.problems.some((p) => p.includes("absolute")));
        assert.ok(traversal.problems.some((p) => p.includes("traversal")));
    });

    it("refuses the rr-ledger layout without its ledger input", () => {
        // Act
        const parsed = parseOf((manifest) => {
            manifest.evidence.layout = "rr-ledger-v1";
        });

        // Assert
        assert.ok(parsed.problems.some((p) => p.includes("ledger")));
    });

    it("refuses unknown assessment selection policies", () => {
        // Act
        const parsed = parseOf((manifest) => {
            manifest.assessment.selectionPolicy =
                "newest-file-wins" as SelectionPolicy;
        });

        // Assert
        assert.ok(parsed.problems.some((p) => p.includes("selectionPolicy")));
    });

    it("refuses duplicate guardrail ids, unknown kinds and a degenerate selection", () => {
        // Act
        const duplicateGuardrail = parseOf((manifest) => {
            manifest.policy.guardrails.push({
                id: "mutation-policy",
                kind: "mutation-policy",
                requirement: "again",
            });
        });
        const unknownKind = parseOf((manifest) => {
            manifest.policy.guardrails[0]!.kind = "vibes" as GuardrailKind;
        });
        const sameSides = parseOf((manifest) => {
            manifest.policy.selection = {
                controlArm: "A",
                candidateArm: "A",
                threshold: 5,
                requireCompleteCoverage: true,
            };
        });

        // Assert
        assert.ok(
            duplicateGuardrail.problems.some((p) =>
                p.includes("duplicate guardrail"),
            ),
        );
        assert.ok(
            unknownKind.problems.some((p) => p.includes("guardrail kind")),
        );
        assert.ok(
            sameSides.problems.some((p) => p.includes("selection.controlArm")),
        );
    });

    it("refuses an inventory fact with neither mention nor obsolete patterns", () => {
        // Act
        const parsed = parseOf((manifest) => {
            manifest.scenarios[1] = {
                id: "R02",
                kind: "reuse-update",
                preservationInventory: {
                    facts: [{ id: "poolSize", label: "pool cap" }],
                    negationCues: ["\\bnot\\b"],
                },
            };
        });

        // Assert
        assert.ok(parsed.problems.some((p) => p.includes("poolSize")));
    });

    it("refuses regex sources that do not compile anywhere in the manifest", () => {
        // Act
        const badMention = parseOf((manifest) => {
            manifest.scenarios[1] = {
                id: "R02",
                preservationInventory: {
                    facts: [
                        {
                            id: "poolSize",
                            label: "pool cap",
                            mentionPatterns: ["([unclosed"],
                        },
                    ],
                    negationCues: ["\\bnot\\b"],
                },
            };
        });
        const badCue = parseOf((manifest) => {
            manifest.scenarios[1] = {
                id: "R02",
                preservationInventory: {
                    facts: [
                        {
                            id: "poolSize",
                            label: "pool cap",
                            mentionPatterns: ["\\b10\\b"],
                        },
                    ],
                    negationCues: ["[bad"],
                },
            };
        });
        const badWording = parseOf((manifest) => {
            manifest.policy.screening = {
                rulesVersion: "rules-v1",
                transientWordingPatterns: ["(?<unbalanced"],
            };
        });

        // Assert
        assert.ok(
            badMention.problems.some((p) => p.includes("mentionPatterns")),
        );
        assert.ok(badCue.problems.some((p) => p.includes("negationCues")));
        assert.ok(
            badWording.problems.some((p) =>
                p.includes("transientWordingPatterns"),
            ),
        );
    });

    it("refuses empty or non-finite sensitivity grids", () => {
        // Act
        const empty = parseOf((manifest) => {
            manifest.policy.sensitivity = {
                usefulWeights: [],
                transientPenalties: [0.5, 1, 2],
            };
        });
        const nonFinite = parseOf((manifest) => {
            manifest.policy.sensitivity = {
                usefulWeights: [3, Number.NaN],
                transientPenalties: [0.5, 1, 2],
            };
        });

        // Assert
        assert.ok(
            empty.problems.some((p) => p.includes("sensitivity.usefulWeights")),
        );
        assert.ok(
            nonFinite.problems.some((p) =>
                p.includes("sensitivity.usefulWeights"),
            ),
        );
    });

    it("is order-independent: reordering slots still parses cleanly", () => {
        // Arrange
        const manifest = validManifest();
        const reordered = validManifest();
        reordered.schedule.slots.reverse();

        // Act
        const left = parseManifest(manifest);
        const right = parseManifest(reordered);

        // Assert — pair coherence must not depend on array position
        assert.deepEqual(left.problems, []);
        assert.deepEqual(right.problems, []);
    });
});
