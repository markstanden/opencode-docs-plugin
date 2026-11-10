// Frozen 40-slot paired schedule for the R01–R04 replication.
//
// Two arms (A control, B finalist) x four scenarios x five repetitions.
// Scenario order rotates by repetition. For the fixed scenario index s and
// repetition r, A runs first when (s + r) is even, otherwise B runs first.
// Both slots of a pair are adjacent so a pair completes before the next.
import { createHash } from "node:crypto";

/** The four newly authored scenarios, in fixed index order. */
export const SCENARIOS = ["R01", "R02", "R03", "R04"];

/** The two arms, in fixed identity order. */
export const ARMS = ["A", "B"];

/** Five repetitions per arm and scenario. */
export const REPETITIONS = 5;

const rotate = (values, by) => [
    ...values.slice(by % values.length),
    ...values.slice(0, by % values.length),
];

/**
 * Build the complete 40-slot schedule.
 * @returns Every slot with its pair, repetition, scenario, arm and stamp.
 */
export function buildSchedule() {
    const slots = [];
    let slot = 1;
    for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
        for (const scenario of rotate(SCENARIOS, repetition)) {
            const index = SCENARIOS.indexOf(scenario);
            const order =
                (index + repetition) % 2 === 0 ? ["A", "B"] : ["B", "A"];
            const pair = slot;
            for (const arm of order) {
                slots.push({
                    slot,
                    pair,
                    repetition,
                    scenario,
                    arm,
                    stamp: `rr-${arm}-r${repetition}-${scenario}`,
                });
                slot += 1;
            }
        }
    }
    return slots;
}

const pairProblem = (first, second) => {
    if (!first || !second) return "unpaired final slot";
    if (first.pair !== second.pair)
        return `pair split at slots ${first.slot}/${second.slot}`;
    if (first.arm === second.arm)
        return `pair ${first.pair} repeats arm ${first.arm}`;
    const expected =
        (SCENARIOS.indexOf(first.scenario) + first.repetition) % 2 === 0
            ? ["A", "B"]
            : ["B", "A"];
    return first.arm === expected[0] && second.arm === expected[1]
        ? null
        : `pair ${first.pair} order ${first.arm}/${second.arm}, expected ${expected.join("/")}`;
};

const armProblems = (slots, arm) => {
    const armSlots = slots.filter((one) => one.arm === arm);
    if (armSlots.length !== 20)
        return [`arm ${arm} has ${armSlots.length} slots`];
    return SCENARIOS.filter(
        (scenario) =>
            armSlots.filter((one) => one.scenario === scenario).length !==
            REPETITIONS,
    ).map((scenario) => `${arm}/${scenario} does not have five slots`);
};

/** Verify the invariants the replication depends on. */
export function verifySchedule(slots) {
    const problems = [];
    if (slots.length !== ARMS.length * SCENARIOS.length * REPETITIONS)
        problems.push(`expected 40 slots, found ${slots.length}`);
    for (let index = 0; index < slots.length; index += 2) {
        const problem = pairProblem(slots[index], slots[index + 1]);
        if (problem) problems.push(problem);
    }
    for (const arm of ARMS) problems.push(...armProblems(slots, arm));
    return problems;
}

/** The SHA-256 of a schedule's canonical JSON. */
export function scheduleHash(slots) {
    return createHash("sha256")
        .update(JSON.stringify(slots), "utf8")
        .digest("hex");
}

const invokedDirectly =
    process.argv[1] &&
    import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
    const slots = buildSchedule();
    const problems = verifySchedule(slots);
    if (problems.length) {
        console.error(problems.join("\n"));
        process.exit(1);
    }
    const writeIndex = process.argv.indexOf("--write");
    if (writeIndex >= 0) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
            process.argv[writeIndex + 1],
            JSON.stringify(slots, null, 2) + "\n",
        );
        console.log(
            `wrote ${slots.length} slots, sha256 ${scheduleHash(slots)}`,
        );
    } else {
        console.log(
            `verified ${slots.length} slots, sha256 ${scheduleHash(slots)}`,
        );
    }
}
