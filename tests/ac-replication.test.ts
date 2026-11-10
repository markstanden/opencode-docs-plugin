import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const replication = join(
    here,
    "fixtures",
    "placement-harness",
    "replication",
);
const hash = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");

interface Slot {
    slot: number;
    pair: number;
    repetition: number;
    scenario: string;
    arm: string;
    stamp: string;
}

const schedule = (): Slot[] => {
    const root = mkdtempSync(join(tmpdir(), "replication-schedule-"));
    try {
        const out = join(root, "schedule.json");
        const result = spawnSync(
            process.execPath,
            [join(replication, "schedule.mjs"), "--write", out],
            { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(readFileSync(out, "utf8")) as Slot[];
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

test("the replication schedule is 40 paired slots, 20 per arm", () => {
    // Arrange / Act
    const slots = schedule();

    // Assert
    assert.equal(slots.length, 40);
    assert.equal(slots.filter((one) => one.arm === "A").length, 20);
    assert.equal(slots.filter((one) => one.arm === "B").length, 20);
    for (let index = 0; index < slots.length; index += 2) {
        assert.equal(slots[index]?.pair, slots[index + 1]?.pair);
        assert.notEqual(slots[index]?.arm, slots[index + 1]?.arm);
    }
});

test("each scenario runs five times per arm and every pair is adjacent", () => {
    // Arrange
    const slots = schedule();
    const counts = new Map<string, number>();

    // Act
    for (const slot of slots) {
        const key = `${slot.arm}/${slot.scenario}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    // Assert
    for (const arm of ["A", "B"]) {
        for (const scenario of ["R01", "R02", "R03", "R04"]) {
            assert.equal(counts.get(`${arm}/${scenario}`), 5);
        }
    }
});

test("pair order follows (scenario index + repetition) parity", () => {
    // Arrange
    const slots = schedule();
    const indices = new Map([
        ["R01", 0],
        ["R02", 1],
        ["R03", 2],
        ["R04", 3],
    ]);

    // Act / Assert
    for (const first of slots.filter((one) => one.slot % 2 === 1)) {
        const second = slots.find((one) => one.slot === first.slot + 1);
        const expected =
            ((indices.get(first.scenario) ?? 0) + first.repetition) % 2 === 0
                ? ["A", "B"]
                : ["B", "A"];
        assert.deepEqual([first.arm, second?.arm], expected);
    }
});

test("the frozen A and B assets are the exact historical bytes", () => {
    // Arrange / Act
    const a = readFileSync(join(replication, "assets", "a.txt"), "utf8");
    const b = readFileSync(join(replication, "assets", "b.txt"), "utf8");

    // Assert
    assert.equal([...a].length, 415);
    assert.equal(
        hash(a),
        "c3903c7d56ab617a4ae9b585daf7634f623585ce9509236b4f17dc177eec1c7c",
    );
    assert.equal([...b].length, 429);
    assert.equal(
        hash(b),
        "09c9cebd09aebf2717802c66aa18def0f9ebeabff079016afe874a9579330d4e",
    );
});

test("the new fixtures pass every pristine and counterexample check", () => {
    // Arrange / Act
    const result = spawnSync(
        process.execPath,
        [join(replication, "verify.mjs")],
        { encoding: "utf8", timeout: 300000 },
    );

    // Assert
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /15\/15 checks passed/);
});

test("R02 preservation accepts paraphrase and rejects valid-fact loss", () => {
    // Arrange
    const script = `
        import { preservationVerdict } from ${JSON.stringify(join(replication, "preservation.mjs"))};
        const base = "# Pool\\n\\n### Facts\\n\\n";
        const out = {
          paraphrase: preservationVerdict(base + "- The pool is capped at ten connections.\\n- A caller waits five seconds.\\n- Schema migrations run at start-up.\\n- TLS is required.\\n").accepted,
          loss: preservationVerdict(base + "- TLS is required.\\n").accepted,
        };
        process.stdout.write(JSON.stringify(out));
    `;

    // Act
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
    });

    // Assert
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        paraphrase: true,
        loss: false,
    });
});
