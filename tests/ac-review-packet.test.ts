import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchedule } from "./fixtures/placement-harness/ac/campaign.mts";
import {
    documentationScore,
    type DocumentationOutcome,
} from "./fixtures/placement-harness/ac-scoring.mts";

const HERE = import.meta.dirname;
const ASSETS = join(HERE, "..", "docs", "testing", "assets");

/** One row of the committed trial table. */
interface TrialRow {
    stage: string;
    slot: string;
    stamp: string;
    arm: string;
    scenario: string;
    repetition: string;
    attempted: string;
    usable: string;
    assessment: string;
    outcome: string;
    primary: string;
    gate_status: string;
    gate_reason: string;
    guardrail: string;
    policy_violations: string;
    executed_at: string;
    reason: string;
}

/** The committed identity map. */
interface Provenance {
    arms: Record<
        string,
        { commit: string; tree: string; pluginContentHash: string }
    >;
    confirmation: { lead: number; threshold: number };
    selection: { arm: string; control: string };
}

/** The committed candidate asset. */
interface CandidateAsset {
    arms: Record<
        string,
        { text: string; chars: number; combinedChars: number; sha256: string }
    >;
    measured: {
        productionBudget: { native: number; combined: number };
        experimentalBudget: { native: number; combined: number };
    };
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, embedded commas. */
function parseCsv(text: string): TrialRow[] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index] as string;
        if (quoted) {
            if (char === '"' && text[index + 1] === '"') {
                field += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                field += char;
            }
            continue;
        }
        if (char === '"') quoted = true;
        else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (char !== "\r") {
            field += char;
        }
    }
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    const header = rows[0] ?? [];
    return rows.slice(1).map((values) => {
        const entry: Record<string, string> = {};
        for (const [index, name] of header.entries()) {
            entry[name] = values[index] ?? "";
        }
        return entry as unknown as TrialRow;
    });
}

const trials = parseCsv(
    readFileSync(
        join(ASSETS, "description-recording-prose-fresh-trials-2026-11-10.csv"),
        "utf8",
    ),
);
const provenance = JSON.parse(
    readFileSync(
        join(
            ASSETS,
            "description-recording-prose-fresh-provenance-2026-11-10.json",
        ),
        "utf8",
    ),
) as Provenance;
const candidates = JSON.parse(
    readFileSync(
        join(ASSETS, "native-description-candidates-2026-11-10.json"),
        "utf8",
    ),
) as CandidateAsset;

/** Utility of one published trial row. */
const utilityOf = (row: TrialRow): number => {
    const documentation = documentationScore(
        row.outcome as DocumentationOutcome,
    );
    const task = row.primary === "fail" ? -5 : 0;
    return documentation + task;
};

/** Totals per arm for one stage. */
const totalsFor = (stage: string): Record<string, number> =>
    Object.fromEntries(
        ["A", "B", "C", "D", "E", "F"].map((arm) => [
            arm,
            trials
                .filter((row) => row.stage === stage && row.arm === arm)
                .reduce((total, row) => total + utilityOf(row), 0),
        ]),
    );

describe("review packet: shape", () => {
    it("carries 88 planned trials with 48 screening and 40 confirmation", () => {
        // Act
        const counts = {
            all: trials.length,
            screening: trials.filter((row) => row.stage === "screening").length,
            confirmation: trials.filter((row) => row.stage === "confirmation")
                .length,
        };

        // Assert
        assert.deepEqual(counts, { all: 88, screening: 48, confirmation: 40 });
    });

    it("gives every trial a unique stamp and a slot", () => {
        // Act
        const stamps = trials.map((row) => row.stamp);

        // Assert
        assert.equal(new Set(stamps).size, 88);
        assert.ok(trials.every((row) => /^\d+$/.test(row.slot)));
    });

    it("lists the schedule's stamps in the frozen execution order", () => {
        // Arrange
        const schedule = buildSchedule();

        // Act
        const screening = trials
            .filter((row) => row.stage === "screening")
            .map((row) => row.stamp);
        const confirmation = trials
            .filter((row) => row.stage === "confirmation")
            .map((row) => row.stamp);

        // Assert
        assert.deepEqual(
            screening,
            schedule.screening.map((slot) => slot.stamp),
        );
        assert.deepEqual(
            confirmation,
            schedule.confirmation.map((slot) => slot.stamp),
        );
    });

    it("has every trial usable and assessed", () => {
        // Act
        const unusable = trials.filter(
            (row) => row.usable !== "true" || row.assessment !== "judged",
        );

        // Assert
        assert.deepEqual(unusable, []);
    });
});

describe("review packet: published totals", () => {
    it("reproduces the screening totals", () => {
        // Act
        const totals = totalsFor("screening");

        // Assert
        assert.deepEqual(totals, { A: 9, B: 15, C: -1, D: -1, E: -2, F: 4 });
    });

    it("reproduces the confirmation totals and the 23-point lead", () => {
        // Act
        const totals = totalsFor("confirmation");

        // Assert
        assert.equal(totals.A, -11);
        assert.equal(totals.B, 12);
        assert.equal((totals.B ?? 0) - (totals.A ?? 0), 23);
        assert.equal(provenance.confirmation.lead, 23);
    });

    it("reproduces the published per-arm outcome mix", () => {
        // Arrange
        const outcomesFor = (
            stage: string,
            arm: string,
        ): Record<string, number> =>
            Object.fromEntries(
                [
                    "useful-create",
                    "useful-update",
                    "transient",
                    "duplicate",
                    "misleading",
                    "none",
                ].map((outcome) => [
                    outcome,
                    trials.filter(
                        (row) =>
                            row.stage === stage &&
                            row.arm === arm &&
                            row.outcome === outcome,
                    ).length,
                ]),
            );

        // Act
        const screeningB = outcomesFor("screening", "B");
        const confirmationB = outcomesFor("confirmation", "B");
        const confirmationA = outcomesFor("confirmation", "A");

        // Assert
        assert.deepEqual(screeningB, {
            "useful-create": 1,
            "useful-update": 2,
            transient: 0,
            duplicate: 0,
            misleading: 0,
            none: 5,
        });
        assert.deepEqual(confirmationB, {
            "useful-create": 3,
            "useful-update": 1,
            transient: 3,
            duplicate: 0,
            misleading: 1,
            none: 12,
        });
        assert.deepEqual(confirmationA, {
            "useful-create": 1,
            "useful-update": 0,
            transient: 1,
            duplicate: 0,
            misleading: 2,
            none: 16,
        });
    });
});

describe("review packet: identities", () => {
    it("records full arm commits and plugin hashes", () => {
        // Act
        const arms = Object.entries(provenance.arms);

        // Assert
        assert.equal(arms.length, 6);
        for (const [, value] of arms) {
            assert.match(value.commit, /^[0-9a-f]{40}$/);
            assert.match(value.tree, /^[0-9a-f]{40}$/);
            assert.match(value.pluginContentHash, /^[0-9a-f]{64}$/);
        }
    });

    it("recomputes every published description hash and length", () => {
        // Act + Assert
        for (const [arm, value] of Object.entries(candidates.arms)) {
            const digest = createHash("sha256")
                .update(value.text, "utf8")
                .digest("hex");
            assert.equal(digest, value.sha256, `${arm} hash`);
            assert.equal([...value.text].length, value.chars, `${arm} chars`);
        }
    });

    it("keeps the control at the production description length", () => {
        // Act
        const control = candidates.arms.A;

        // Assert
        assert.equal(control?.chars, 415);
        assert.equal(control?.combinedChars, 2073);
    });

    it("records the production budget unchanged and the experimental budget apart", () => {
        // Act
        const budgets = candidates.measured;

        // Assert
        assert.deepEqual(budgets.productionBudget, {
            native: 600,
            combined: 2100,
        });
        assert.deepEqual(budgets.experimentalBudget, {
            native: 1400,
            combined: 3100,
        });
    });
});

describe("review packet: sanitisation", () => {
    const committed: Array<[string, string]> = [
        "description-recording-prose-fresh-trials-2026-11-10.csv",
        "description-recording-prose-fresh-provenance-2026-11-10.json",
        "native-description-candidates-2026-11-10.json",
    ].map((name) => [name, readFileSync(join(ASSETS, name), "utf8")]);

    it("contains no host path", () => {
        // Act
        const offenders = committed.filter(([, text]) => /\/home\//.test(text));

        // Assert
        assert.deepEqual(
            offenders.map(([name]) => name),
            [],
        );
    });

    it("contains no signing key or credential reference", () => {
        // Act
        const offenders = committed.filter(([, text]) =>
            /docs-operations\.key|OPENCODE_API_KEY|BEGIN [A-Z ]*PRIVATE KEY/.test(
                text,
            ),
        );

        // Assert
        assert.deepEqual(
            offenders.map(([name]) => name),
            [],
        );
    });

    it("does not publish raw judge prompts or full answers", () => {
        // Act
        const reasons = trials.map((row) => row.reason ?? "");

        // Assert
        for (const reason of reasons) {
            assert.ok(reason.length <= 320, "reason is truncated to a bound");
        }
    });
});
