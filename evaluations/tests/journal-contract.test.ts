/**
 * Cross-project contract: the docs plugin's signed journal is accepted by the
 * pinned OTC evaluator's checked evidence boundary. Development tooling only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createDocsTool,
    OPERATION_JOURNAL_ENV,
    OPERATION_JOURNAL_KEY_ENV,
} from "../../src/index.ts";
import { verifyOperationsJournal } from "@markstanden/opencode-test-container";

const KEY = "cross-project-key";

test("packed plugin journal emission is credited by the pinned OTC evaluator", async () => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), "docs-otc-contract-"));
    const journal = join(directory, "docs-operations.jsonl");
    process.env[OPERATION_JOURNAL_ENV] = journal;
    process.env[OPERATION_JOURNAL_KEY_ENV] = KEY;
    try {
        const twin = createDocsTool(
            { lakes: [] },
            { name: "docs_search", codemode: true },
        );
        await twin.execute({ search: "help" }, {
            sessionID: "ses_contract",
            messageID: "msg_contract",
            id: "call_exec",
        } as never);
        const lines = readFileSync(journal, "utf8").split("\n");

        // Act
        const verified = verifyOperationsJournal({
            lines,
            key: KEY,
            identity: {
                sessions: new Set(["ses_contract"]),
                messages: new Set(["msg_contract"]),
            },
            callIds: new Set(["call_exec"]),
            dispatches: [
                {
                    tool: "docs_search",
                    status: "completed",
                    input: { search: "help" },
                    callId: "call_exec",
                },
            ],
        });

        // Assert
        assert.equal(verified.state, "verified");
        assert.equal(verified.credited.length, 1);
        assert.equal(verified.rejected.length, 0);
        assert.equal(
            (
                verified.credited[0]?.record.result as {
                    metadata: { count: number };
                }
            ).metadata.count,
            0,
        );
    } finally {
        delete process.env[OPERATION_JOURNAL_ENV];
        delete process.env[OPERATION_JOURNAL_KEY_ENV];
        rmSync(directory, { recursive: true, force: true });
    }
});
