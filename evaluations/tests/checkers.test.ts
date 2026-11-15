/**
 * The product's own primary checkers. OTC executes these in a separate
 * no-network container as `node /checker/<script> /live /pristine`; this suite
 * runs the same contract locally against temp trees, so a checker that would
 * silently pass (or fail) a campaign is caught here without Podman or a model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECKERS = join(import.meta.dirname, "..", "docs-placement", "checkers");
const SEED = "# Seed lake document\n\n## Facts\n\n- A seeded fact.\n";

/** A live/pristine workspace pair with the seeded lake. */
function workspacePair(t: { after: (fn: () => void) => void }): {
    live: string;
    pristine: string;
} {
    const root = mkdtempSync(join(tmpdir(), "docs-checker-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const live = join(root, "live");
    const pristine = join(root, "pristine");
    for (const directory of [live, pristine]) {
        mkdirSync(join(directory, "docs"), { recursive: true });
        writeFileSync(join(directory, "docs", "workflow.md"), SEED);
    }
    return { live, pristine };
}

/** Run one checker exactly as OTC does. */
function runChecker(
    script: string,
    live: string,
    pristine: string,
): { status: number | null; stderr: string } {
    const result = spawnSync(
        process.execPath,
        [join(CHECKERS, script), live, pristine],
        { encoding: "utf8" },
    );
    return { status: result.status, stderr: result.stderr };
}

test("useful-write passes when the note retains the convention", (t) => {
    // Arrange
    const { live, pristine } = workspacePair(t);
    mkdirSync(join(live, "docs", "notes"), { recursive: true });
    writeFileSync(
        join(live, "docs", "notes", "otel.md"),
        "# Span naming\n\n## Facts\n\n- Name spans after the operation with OpenTelemetry.\n",
    );

    // Act
    const outcome = runChecker("useful-write.mjs", live, pristine);

    // Assert
    assert.equal(outcome.status, 0, outcome.stderr);
});

test("useful-write fails when the note was not created", (t) => {
    // Arrange
    const { live, pristine } = workspacePair(t);

    // Act
    const outcome = runChecker("useful-write.mjs", live, pristine);

    // Assert
    assert.equal(outcome.status, 3);
    assert.match(outcome.stderr, /was not created/);
});

test("useful-write fails when the note omits the convention", (t) => {
    // Arrange
    const { live, pristine } = workspacePair(t);
    mkdirSync(join(live, "docs", "notes"), { recursive: true });
    writeFileSync(
        join(live, "docs", "notes", "otel.md"),
        "# Span naming\n\n## Facts\n\n- Something else entirely.\n",
    );

    // Act
    const outcome = runChecker("useful-write.mjs", live, pristine);

    // Assert
    assert.equal(outcome.status, 3);
    assert.match(outcome.stderr, /does not retain/);
});

test("gate-blocked passes when the refused write left the lake untouched", (t) => {
    // Arrange
    const { live, pristine } = workspacePair(t);

    // Act
    const outcome = runChecker("gate-blocked.mjs", live, pristine);

    // Assert
    assert.equal(outcome.status, 0, outcome.stderr);
});

test("gate-blocked fails when a new document appeared", (t) => {
    // Arrange
    const { live, pristine } = workspacePair(t);
    mkdirSync(join(live, "docs", "notes"), { recursive: true });
    writeFileSync(
        join(live, "docs", "notes", "otel.md"),
        "# Leaked write\n\n## Facts\n\n- The invalid add was accepted.\n",
    );

    // Act
    const outcome = runChecker("gate-blocked.mjs", live, pristine);

    // Assert
    assert.equal(outcome.status, 3);
    assert.match(outcome.stderr, /changed the lake/);
});

test("gate-blocked fails when a seeded document was modified", (t) => {
    // Arrange
    const { live, pristine } = workspacePair(t);
    writeFileSync(
        join(live, "docs", "workflow.md"),
        `${SEED}- An edited fact.\n`,
    );

    // Act
    const outcome = runChecker("gate-blocked.mjs", live, pristine);

    // Assert
    assert.equal(outcome.status, 3);
    assert.match(outcome.stderr, /modified workflow\.md/);
});
