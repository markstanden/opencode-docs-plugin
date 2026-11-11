import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CampaignManifest } from "./fixtures/placement-harness/analysis/model.ts";

const here = import.meta.dirname;
const manifests = join(here, "fixtures", "analysis", "manifests");
const assets = join(here, "..", "docs", "testing", "assets");

const manifestOf = (name: string): CampaignManifest =>
    JSON.parse(
        readFileSync(join(manifests, `${name}.json`), "utf8"),
    ) as CampaignManifest;

interface LedgerSlot {
    slot: number;
    pair: number;
    repetition: number;
    scenario: string;
    arm: string;
    stamp: string;
    trial: { status: string };
}

interface Ledger {
    slots: LedgerSlot[];
}

describe("historical replay manifests", () => {
    it("keeps the replication manifest consistent with the published attempt ledger", () => {
        // Arrange
        const ledger = JSON.parse(
            readFileSync(
                join(
                    assets,
                    "description-recording-prose-fresh-replication-attempts-2026-11-10.json",
                ),
                "utf8",
            ),
        ) as Ledger;
        const manifest = manifestOf("replication");

        // Act
        const slots = manifest.schedule.slots;
        const dispositions = new Map(
            slots.map((slot) => [
                slot.stamp,
                slot.disposition ?? "first-attempt",
            ]),
        );
        const expectedDisposition = (status: string): string =>
            status === "replacement"
                ? "replacement"
                : status === "invalid-r04-premise"
                  ? "excluded"
                  : "first-attempt";

        // Assert
        assert.equal(ledger.slots.length, 40);
        assert.equal(slots.length, 40);
        for (const ledgerSlot of ledger.slots) {
            const slot = slots.find((one) => one.stamp === ledgerSlot.stamp);
            assert.ok(slot, `manifest is missing ${ledgerSlot.stamp}`);
            assert.equal(
                dispositions.get(ledgerSlot.stamp),
                expectedDisposition(ledgerSlot.trial.status),
                ledgerSlot.stamp,
            );
            assert.equal(
                slot.pairId,
                `P${String(ledgerSlot.pair).padStart(2, "0")}`,
            );
            assert.equal(slot.scenario, ledgerSlot.scenario);
            assert.equal(slot.arm, ledgerSlot.arm);
            assert.equal(slot.repetition, ledgerSlot.repetition);
        }
        const counts = { "first-attempt": 0, replacement: 0, excluded: 0 };
        for (const disposition of dispositions.values()) {
            counts[disposition as keyof typeof counts] += 1;
        }
        assert.deepEqual(counts, {
            "first-attempt": 36,
            replacement: 2,
            excluded: 2,
        });
    });

    it("declares the confirmation schedule, arms, inventory and frozen policy", () => {
        // Arrange
        const manifest = manifestOf("confirmation");

        // Act
        const slots = manifest.schedule.slots;
        const pairIds = new Set(slots.map((slot) => slot.pairId));
        const r02 = manifest.scenarios.find(
            (scenario) => scenario.id === "R02",
        );
        const selection = manifest.policy.selection;

        // Assert
        assert.equal(slots.length, 40);
        assert.equal(pairIds.size, 20);
        assert.deepEqual(
            manifest.arms.map((arm) => arm.id),
            ["A", "B"],
        );
        assert.deepEqual(
            r02?.preservationInventory?.facts.map((fact) => fact.id),
            [
                "poolSize",
                "acquireTimeout",
                "startupMigrations",
                "obsoleteTlsClaim",
            ],
        );
        assert.deepEqual(manifest.policy.weights, {
            useful: 5,
            transient: -1,
            duplicate: -2,
            misleading: -5,
            taskFailure: -5,
        });
        assert.equal(selection?.threshold, 5);
        assert.equal(selection?.requireCompleteCoverage, true);
        assert.deepEqual(manifest.policy.sensitivity, {
            usefulWeights: [3, 5, 8],
            transientPenalties: [0.5, 1, 2],
        });
        assert.equal(manifest.evidence.layout, "ac-v1");
    });

    it("declares the six-arm screening population without inventing a selection rule", () => {
        // Arrange
        const manifest = manifestOf("screening");

        // Act
        const slots = manifest.schedule.slots;
        const arms = manifest.arms.map((arm) => arm.id).sort();

        // Assert
        assert.deepEqual(arms, ["A", "B", "C", "D", "E", "F"]);
        assert.equal(slots.length, 48);
        assert.ok(
            manifest.scenarios.every((scenario) =>
                scenario.id.startsWith("NOTE-"),
            ),
        );
        assert.equal(manifest.policy.selection, undefined);
        assert.equal(
            slots.some((slot) => slot.pairId !== undefined),
            false,
        );
    });
});
