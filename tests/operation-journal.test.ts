/**
 * The docs plugin's opt-in operation journal: the only authenticated record
 * of a Code Mode nested call, which emits no CLI trail event of its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocsTool, OPERATION_JOURNAL_ENV } from "../src/index.ts";

/** A fresh journal path in the system temp root. */
function journalPath(): { path: string; cleanup: () => void } {
    const directory = mkdtempSync(join(tmpdir(), "docs-journal-"));
    return {
        path: join(directory, "docs-operations.jsonl"),
        cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
}

/** Run one tool call with the journal variable set, restoring it after. */
async function withJournal<T>(
    path: string | undefined,
    action: () => Promise<T>,
): Promise<T> {
    const previous = process.env[OPERATION_JOURNAL_ENV];
    if (path === undefined) delete process.env[OPERATION_JOURNAL_ENV];
    else process.env[OPERATION_JOURNAL_ENV] = path;
    try {
        return await action();
    } finally {
        if (previous === undefined) delete process.env[OPERATION_JOURNAL_ENV];
        else process.env[OPERATION_JOURNAL_ENV] = previous;
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

test("journal: a served Code Mode twin call records tool, input and result", async () => {
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
