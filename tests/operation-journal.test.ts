/**
 * The docs plugin's opt-in operation journal: the only record of a Code Mode
 * nested call, signed per run and written to a harness-owned path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createDocsTool,
    OPERATION_JOURNAL_ENV,
    OPERATION_JOURNAL_KEY_ENV,
} from "../src/index.ts";

const KEY = "test-only-journal-key";

/** A temp directory plus path for the journal file. */
function journalPath(): { path: string; cleanup: () => void } {
    const directory = mkdtempSync(join(tmpdir(), "docs-journal-"));
    return {
        path: join(directory, "docs-operations.jsonl"),
        cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
}

/** Run one tool call with the journal path and key set, restoring them after. */
async function withJournal<T>(
    path: string | undefined,
    action: () => Promise<T>,
): Promise<T> {
    const previousPath = process.env[OPERATION_JOURNAL_ENV];
    const previousKey = process.env[OPERATION_JOURNAL_KEY_ENV];
    if (path === undefined) {
        delete process.env[OPERATION_JOURNAL_ENV];
        delete process.env[OPERATION_JOURNAL_KEY_ENV];
    } else {
        process.env[OPERATION_JOURNAL_ENV] = path;
        process.env[OPERATION_JOURNAL_KEY_ENV] = KEY;
    }
    try {
        return await action();
    } finally {
        if (previousPath === undefined)
            delete process.env[OPERATION_JOURNAL_ENV];
        else process.env[OPERATION_JOURNAL_ENV] = previousPath;
        if (previousKey === undefined) {
            delete process.env[OPERATION_JOURNAL_KEY_ENV];
        } else {
            process.env[OPERATION_JOURNAL_KEY_ENV] = previousKey;
        }
    }
}

test("journal: unset means silence, not an empty file", async () => {
    // Arrange
    const journal = journalPath();
    const tool = createDocsTool({ lakes: [] });
    // Act
    await withJournal(undefined, () =>
        tool.execute({ search: "help" }, {} as never),
    );
    // Assert
    assert.equal(existsSync(journal.path), false);
    journal.cleanup();
});

test("journal: a served Code Mode twin call records signed tool, input and result", async () => {
    // Arrange
    const journal = journalPath();
    const twin = createDocsTool(
        { lakes: [] },
        { name: "docs_search", codemode: true },
    );
    // Act
    const result = await withJournal(journal.path, () =>
        twin.execute({ search: "help" }, {
            sessionID: "ses_1",
            messageID: "msg_1",
            id: "call_1",
        } as never),
    );
    // Assert
    const lines = readFileSync(journal.path, "utf8")
        .split("\n")
        .filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0] ?? "{}");
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.tool, "docs_search");
    assert.equal(record.surface, "codemode-twin");
    assert.equal(record.status, "completed");
    assert.deepEqual(record.input, { search: "help" });
    assert.equal(record.sessionID, "ses_1");
    assert.equal(record.messageID, "msg_1");
    assert.equal(record.callID, "call_1");
    assert.equal(record.result.metadata.count, 0);
    assert.equal(record.result.content, result.content);
    const { mac, ...body } = record;
    assert.equal(
        mac,
        createHmac("sha256", KEY).update(JSON.stringify(body)).digest("hex"),
        "the record carries a valid per-run signature",
    );
    journal.cleanup();
});

test("journal: a thrown call is recorded as an error and rethrown", async () => {
    // Arrange: a runtime seam that fails the operation.
    const journal = journalPath();
    const tool = createDocsTool({
        lakes: [],
        search: () => {
            throw new Error("boom");
        },
    });
    // Act / Assert
    await withJournal(journal.path, async () => {
        await assert.rejects(
            tool.execute({ search: "anything" }, {} as never),
            /boom/,
        );
    });
    const record = JSON.parse(
        readFileSync(journal.path, "utf8").split("\n")[0] ?? "{}",
    );
    assert.equal(record.status, "error");
    assert.match(record.error, /boom/);
    assert.equal(record.result, undefined);
    journal.cleanup();
});

test("journal: an unwritable path never fails the tool", async () => {
    // Arrange – the configured path is a directory, so appending must fail
    // inside the plugin and stay swallowed: measurement never breaks a tool.
    const directory = mkdtempSync(join(tmpdir(), "docs-journal-dir-"));
    const tool = createDocsTool({ lakes: [] });

    try {
        // Act
        const result = await withJournal(directory, () =>
            tool.execute({ search: "help" }, {} as never),
        );

        // Assert
        assert.match(String(result.content), /Configured lakes/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
