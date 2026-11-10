import test from "node:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    claimAttemptDir,
    clearReservation,
} from "./fixtures/placement-harness/ac/evidence-guard.mts";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "fixtures", "placement-harness", "ac", "run.mjs");
const temp = () => mkdtempSync(join(tmpdir(), "evidence-guard-"));

test("clearing a reservation removes only the lock marker", () => {
    // Arrange
    const directory = temp();
    writeFileSync(join(directory, ".reservation"), "{}\n");

    // Act
    const result = clearReservation(directory);

    // Assert
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(directory, ".reservation")), false);
    assert.equal(existsSync(directory), true);
    rmSync(directory, { recursive: true, force: true });
});

test("clearing a reservation refuses when recorded evidence exists", () => {
    // Arrange
    const directory = temp();
    writeFileSync(join(directory, ".reservation"), "{}\n");
    writeFileSync(join(directory, "meta.json"), '{"stamp":"keep"}\n');
    const before = readFileSync(join(directory, "meta.json"), "utf8");

    // Act
    const result = clearReservation(directory);

    // Assert
    assert.equal(result.ok, false);
    assert.deepEqual(result.entries, ["meta.json"]);
    assert.equal(readFileSync(join(directory, "meta.json"), "utf8"), before);
    assert.equal(existsSync(join(directory, ".reservation")), true);
    rmSync(directory, { recursive: true, force: true });
});

test("claiming an existing attempt directory never overwrites it", () => {
    // Arrange
    const parent = temp();
    const attempt = join(parent, "attempt-001");
    mkdirSync(attempt);
    writeFileSync(join(attempt, "output.jsonl"), "original\n");

    // Act
    const result = claimAttemptDir(attempt);

    // Assert
    assert.equal(result.ok, false);
    assert.equal(
        readFileSync(join(attempt, "output.jsonl"), "utf8"),
        "original\n",
    );
    rmSync(parent, { recursive: true, force: true });
});

test("claiming a new attempt directory creates it once", () => {
    // Arrange
    const parent = temp();
    const attempt = join(parent, "attempt-001");

    // Act
    const first = claimAttemptDir(attempt);
    const second = claimAttemptDir(attempt);

    // Assert
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    rmSync(parent, { recursive: true, force: true });
});

test("the clear-reservation command refuses recorded evidence", () => {
    // Arrange
    const directory = temp();
    writeFileSync(join(directory, ".reservation"), "{}\n");
    writeFileSync(join(directory, "meta.json"), "{}\n");

    // Act
    const result = spawnSync(
        process.execPath,
        [runner, "clear-reservation", "--result", directory],
        { encoding: "utf8" },
    );

    // Assert
    assert.equal(result.status, 1);
    assert.match(result.stderr, /recorded evidence/);
    assert.equal(existsSync(join(directory, "meta.json")), true);
    assert.equal(existsSync(join(directory, ".reservation")), true);
    rmSync(directory, { recursive: true, force: true });
});

test("the clear-reservation command clears a bare marker", () => {
    // Arrange
    const directory = temp();
    writeFileSync(join(directory, ".reservation"), "{}\n");

    // Act
    const result = spawnSync(
        process.execPath,
        [runner, "clear-reservation", "--result", directory],
        { encoding: "utf8" },
    );

    // Assert
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(directory, ".reservation")), false);
    rmSync(directory, { recursive: true, force: true });
});

test("judge refuses a stamp with no recorded trial result", () => {
    // Arrange
    const base = temp();
    const truth = join(base, "truth.json");
    writeFileSync(truth, "{}\n");

    // Act
    const result = spawnSync(
        process.execPath,
        [
            runner,
            "judge",
            "--base",
            base,
            "--stamp",
            "missing-stamp",
            "--case",
            "R01",
            "--truth",
            truth,
            "--launcher",
            "/bin/false",
            "--model",
            "unused/model",
            "--workdir",
            join(base, "runs"),
        ],
        { encoding: "utf8" },
    );

    // Assert
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no recorded trial result/);
    rmSync(base, { recursive: true, force: true });
});

test("judge refuses an existing attempt without a judgement", () => {
    // Arrange
    const base = temp();
    const resultDir = join(base, "results", "stamp", "R01");
    const attempt = join(resultDir, "ac", "attempt-001");
    mkdirSync(attempt, { recursive: true });
    writeFileSync(join(resultDir, "meta.json"), "{}\n");
    writeFileSync(join(attempt, "output.jsonl"), "original\n");
    const truth = join(base, "truth.json");
    writeFileSync(truth, "{}\n");

    // Act
    const result = spawnSync(
        process.execPath,
        [
            runner,
            "judge",
            "--base",
            base,
            "--stamp",
            "stamp",
            "--case",
            "R01",
            "--truth",
            truth,
            "--launcher",
            "/bin/false",
            "--model",
            "unused/model",
            "--workdir",
            join(base, "runs"),
        ],
        { encoding: "utf8" },
    );

    // Assert
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to overwrite existing attempt/);
    assert.equal(
        readFileSync(join(attempt, "output.jsonl"), "utf8"),
        "original\n",
    );
    rmSync(base, { recursive: true, force: true });
});
