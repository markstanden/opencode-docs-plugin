// Frozen eight-pair schedule for the 0.14.0 productivity screen.
//
// Pairs are executed in the declared order; within each pair the arm order
// alternates AB/BA. Both slots of a pair are adjacent, so a pair completes
// before the next. The order is execution order, not a preferred outcome.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const ROOT = process.env.CAMPAIGN_ROOT;
if (!ROOT) throw new Error("CAMPAIGN_ROOT is required");

// Each fresh materialisation gets its own identity; a replay of the historical
// 2026-11-11 campaign keeps `pd-20261111` from its frozen snapshot.
const CAMPAIGN =
    process.env.CAMPAIGN_ID ??
    `pd-fresh-${new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\..*$/, "Z")}`;
const PAIRS = [
    { scenario: "R01", order: ["A", "B"] },
    { scenario: "S02", order: ["B", "A"] },
    { scenario: "R02", order: ["A", "B"] },
    { scenario: "R03", order: ["B", "A"] },
    { scenario: "S05", order: ["A", "B"] },
    { scenario: "S06", order: ["B", "A"] },
    { scenario: "S07", order: ["A", "B"] },
    { scenario: "R04", order: ["B", "A"] },
];

const slots = [];
let slot = 1;
for (const [index, pair] of PAIRS.entries()) {
    const pairId = `P${String(index + 1).padStart(2, "0")}`;
    for (const arm of pair.order) {
        slots.push({
            slot,
            pairId,
            repetition: 0,
            scenario: pair.scenario,
            arm,
            stamp: `pd-${arm}-r0-${pair.scenario}`,
        });
        slot += 1;
    }
}

const problems = [];
if (slots.length !== 16) problems.push(`expected 16 slots, found ${slots.length}`);
for (let index = 0; index < slots.length; index += 2) {
    const [first, second] = [slots[index], slots[index + 1]];
    if (!first || !second) {
        problems.push(`unpaired slot at index ${index}`);
        continue;
    }
    if (first.pairId !== second.pairId)
        problems.push(`pair split at ${first.slot}/${second.slot}`);
    if (first.arm === second.arm)
        problems.push(`pair ${first.pairId} repeats arm ${first.arm}`);
    if (first.scenario !== second.scenario)
        problems.push(`pair ${first.pairId} mixes scenarios`);
    const expected = PAIRS[Number(first.pairId.slice(1)) - 1].order;
    if (first.arm !== expected[0] || second.arm !== expected[1])
        problems.push(
            `pair ${first.pairId} order ${first.arm}/${second.arm}, expected ${expected.join("/")}`,
        );
}
for (const arm of ["A", "B"]) {
    const armSlots = slots.filter((one) => one.arm === arm);
    if (armSlots.length !== 8)
        problems.push(`arm ${arm} has ${armSlots.length} slots`);
}
const stamps = new Set(slots.map((one) => one.stamp));
if (stamps.size !== slots.length) problems.push("duplicate stamp");
if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
}

const schedule = {
    campaign: CAMPAIGN,
    generator: "declared pair order; AB/BA alternating; adjacent pair slots",
    slots,
};
writeFileSync(
    `${ROOT}/evidence/schedule.json`,
    `${JSON.stringify(schedule, null, 2)}\n`,
);
console.log(
    `wrote ${slots.length} slots, 8 pairs, sha256 ${createHash("sha256")
        .update(JSON.stringify(slots), "utf8")
        .digest("hex")}`,
);
