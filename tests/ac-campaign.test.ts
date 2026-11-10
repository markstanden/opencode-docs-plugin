import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    ARMS,
    HELD_OUT,
    NOTE_CASES,
    armDir,
    buildSchedule,
    docChanges,
    firstBalancedObject,
    labelLeaks,
    type LakeDocument,
} from "./fixtures/placement-harness/ac/campaign.mts";

const schedule = buildSchedule();

describe("schedule", () => {
    it("is reproducible from its seed", () => {
        // Arrange
        const seed = 20261110;

        // Act
        const first = buildSchedule(seed);
        const second = buildSchedule(seed);

        // Assert
        assert.deepEqual(first, second);
    });

    it("plans 48 screening and 40 confirmation slots", () => {
        // Act
        const counts = {
            screening: schedule.screening.length,
            confirmation: schedule.confirmation.length,
        };

        // Assert
        assert.deepEqual(counts, { screening: 48, confirmation: 40 });
    });

    it("runs every arm exactly once inside every screening block", () => {
        // Arrange
        const blocks = new Map();

        // Act
        for (const slot of schedule.screening) {
            const seen = blocks.get(slot.block) ?? [];
            seen.push(slot.arm);
            blocks.set(slot.block, seen);
        }

        // Assert
        assert.equal(blocks.size, 8);
        for (const [block, arms] of blocks) {
            assert.deepEqual([...arms].sort(), [...ARMS].sort(), block);
        }
    });

    it("rotates the screening scenario order across repetitions", () => {
        // Arrange
        const order = (repetition: number) =>
            [...new Set(
                schedule.screening
                    .filter((slot) => slot.repetition === repetition)
                    .map((slot) => slot.scenario),
            )];

        // Act
        const first = order(1);
        const second = order(2);

        // Assert
        assert.deepEqual(first, NOTE_CASES);
        assert.deepEqual(second, [...NOTE_CASES.slice(1), NOTE_CASES[0]]);
    });

    it("alternates the confirmation pair order on scenario plus repetition", () => {
        // Arrange
        const firstRole = (repetition: number, scenario: string) =>
            schedule.confirmation.find(
                (slot) =>
                    slot.repetition === repetition && slot.scenario === scenario,
            )?.role;

        // Act
        const pairs: Array<[string, number, string]> = [
            ["H01", 0, "F"],
            ["H01", 1, "A"],
            ["H02", 0, "A"],
            ["H02", 1, "F"],
            ["H03", 2, "F"],
        ];

        // Assert
        for (const [scenario, repetition, expected] of pairs) {
            assert.equal(
                firstRole(repetition, scenario),
                expected,
                `${scenario} r${repetition}`,
            );
        }
    });

    it("keeps slot order strictly increasing so execution order is the schedule", () => {
        // Act
        const slots = [...schedule.screening, ...schedule.confirmation].map(
            (slot) => slot.slot,
        );

        // Assert
        assert.deepEqual(
            slots,
            slots.map((_, index) => index + 1),
        );
    });

    it("gives every slot a unique stamp", () => {
        // Act
        const stamps = [...schedule.screening, ...schedule.confirmation].map(
            (slot) => slot.stamp,
        );

        // Assert
        assert.equal(new Set(stamps).size, stamps.length);
    });

    it("plans five repetitions of each held-out scenario per role", () => {
        // Arrange
        const counts = new Map();

        // Act
        for (const slot of schedule.confirmation) {
            const key = `${slot.scenario}/${slot.role}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        // Assert
        assert.equal(counts.size, HELD_OUT.length * 2);
        assert.deepEqual([...counts.values()], Array(8).fill(5));
    });
});

describe("armDir", () => {
    it("resolves every arm to its lower-case worktree", () => {
        // Act
        const dirs = ARMS.map((arm) => armDir("/campaign", arm));

        // Assert
        assert.deepEqual(dirs, [
            "/campaign/arms/a",
            "/campaign/arms/b",
            "/campaign/arms/c",
            "/campaign/arms/d",
            "/campaign/arms/e",
            "/campaign/arms/f",
        ]);
    });

    it("accepts an upper-case letter without producing an upper-case path", () => {
        // Act
        const dir = armDir("/campaign", "B");

        // Assert
        assert.equal(dir, "/campaign/arms/b");
    });

    it("refuses an unknown arm instead of inventing a path", () => {
        // Act + Assert
        assert.throws(() => armDir("/campaign", "G"), /unknown arm/);
        assert.throws(() => armDir("/campaign", "../a"), /unknown arm/);
    });
});

describe("docChanges", () => {
    const before: LakeDocument[] = [
        { path: "cache/keys.md", contents: "old" },
        { path: "ops/on-call.md", contents: "on call" },
        { path: "gone.md", contents: "bye" },
    ];
    const onCall = before[1] as LakeDocument;
    const gone = before[2] as LakeDocument;

    it("classifies a created document", () => {
        // Act
        const state = docChanges(before, [
            ...before,
            { path: "new/note.md", contents: "new" },
        ]);

        // Assert
        assert.equal(state.documentsChanged, true);
        assert.deepEqual(state.createdPaths, ["new/note.md"]);
        assert.deepEqual(state.modifiedPaths, []);
    });

    it("classifies a modified document", () => {
        // Act
        const state = docChanges(before, [
            { path: "cache/keys.md", contents: "new" },
            onCall,
            gone,
        ]);

        // Assert
        assert.deepEqual(state.modifiedPaths, ["cache/keys.md"]);
        assert.deepEqual(state.createdPaths, []);
    });

    it("classifies a removed document", () => {
        // Act
        const state = docChanges(before, before.slice(0, 2));

        // Assert
        assert.deepEqual(state.removedPaths, ["gone.md"]);
        assert.equal(state.documentsChanged, true);
    });

    it("reports no change for an identical snapshot", () => {
        // Act
        const state = docChanges(before, [...before]);

        // Assert
        assert.equal(state.documentsChanged, false);
    });
});

describe("labelLeaks", () => {
    it("refuses a packet naming a host path", () => {
        // Act
        const leaks = labelLeaks("see /home/mark/evidence/report for detail");

        // Assert
        assert.ok(leaks.length > 0);
    });

    it("refuses a packet naming an arm or a stamp", () => {
        // Act + Assert
        assert.ok(labelLeaks("this is arm B's trial").length > 0);
        assert.ok(labelLeaks("fr-B-s1-NOTE-01 judged it").length > 0);
        assert.ok(labelLeaks("compare against the candidate").length > 0);
    });

    it("accepts an arm-blind packet", () => {
        // Arrange
        const packet = "SCENARIO TRUTH: no durable finding exists.";

        // Act
        const leaks = labelLeaks(packet);

        // Assert
        assert.deepEqual(leaks, []);
    });
});

describe("firstBalancedObject", () => {
    it("ignores trailing prose that contains braces", () => {
        // Arrange
        const text = '{"a":1}\n\nBeing thorough: ${ answerText }';

        // Act
        const extracted = firstBalancedObject(text);

        // Assert
        assert.deepEqual(JSON.parse(extracted as string), { a: 1 });
    });

    it("handles nested objects", () => {
        // Arrange
        const text = 'prefix {"a":{"b":2}} suffix }';

        // Act
        const extracted = firstBalancedObject(text);

        // Assert
        assert.deepEqual(JSON.parse(extracted as string), { a: { b: 2 } });
    });

    it("keeps braces inside strings intact", () => {
        // Arrange
        const text = '{"a":"escaped \\" quote }"}';

        // Act
        const extracted = firstBalancedObject(text);

        // Assert
        assert.equal(JSON.parse(extracted as string).a, 'escaped " quote }');
    });

    it("returns undefined when there is no object", () => {
        // Act
        const extracted = firstBalancedObject("no object here");

        // Assert
        assert.equal(extracted, undefined);
    });
});
