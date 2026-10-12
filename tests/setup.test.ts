import { after, describe, it } from "node:test";
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
import { join } from "node:path";
import plugin from "../src/index.ts";

const cleanups: string[] = [];

after(() => {
    for (const dir of cleanups) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh scratch directory, removed after the suite. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "docs-plugin-setup-"));
    cleanups.push(dir);
    return dir;
}

/** What `setup` registered, plus the prompts the command sent. */
interface Harness {
    tools: unknown[];
    commands: unknown[];
    skills: unknown[];
    sent: string[];
}

/**
 * Run the plugin's `setup` against a minimal fake context rooted at
 * `directory`: each domain's `transform` runs its callback against an editor
 * that records every `add`, and `session.prompt` records what the command sent.
 */
async function setup(
    directory: string,
    options: Record<string, unknown> = {},
): Promise<Harness> {
    const added: Harness = { tools: [], commands: [], skills: [], sent: [] };
    const domain = (bucket: unknown[]) => ({
        transform: async (callback: (editor: unknown) => void) => {
            callback({
                add: (definition: unknown) => void bucket.push(definition),
            });
        },
    });
    const ctx = {
        options,
        location: { directory },
        tool: domain(added.tools),
        command: domain(added.commands),
        skill: domain(added.skills),
        session: {
            prompt: async (input: { text: string }) =>
                void added.sent.push(input.text),
        },
    };

    await plugin.setup(ctx as never);

    return added;
}

describe("setup", () => {
    it("registers the docs tool, command and skill", async () => {
        const added = await setup(tempDir());

        assert.equal(added.tools.length, 1);
        assert.equal(added.commands.length, 1);
        assert.equal(added.skills.length, 1);
    });

    it("names the tool and command docs", async () => {
        const added = await setup(tempDir());

        assert.equal((added.tools[0] as { name: string }).name, "docs");
        assert.equal((added.commands[0] as { name: string }).name, "docs");
    });

    it("registers the skill with the shipped doctrine as its content", async () => {
        const added = await setup(tempDir());
        const skill = added.skills[0] as { id: string; content: string };

        assert.equal(skill.id, "docs");
        assert.match(skill.content, /Open questions/);
        assert.match(skill.content, /reachable from the `execute`/);
    });

    it("writes a doc through the tool the setup registered", async () => {
        const dir = tempDir();
        const added = await setup(dir);
        const tool = added.tools[0] as {
            execute: (
                input: unknown,
                context: unknown,
            ) => Promise<{ content: unknown }>;
        };

        await tool.execute(
            {
                add: {
                    metadata: {
                        Area: "aa",
                        Keywords: ["alpha"],
                        Summary: "A fresh doc.",
                    },
                    body: "# Fresh\n\n### Facts\n\n- Something verified.\n",
                },
            },
            {} as never,
        );

        const written = readFileSync(join(dir, "docs/aa/fresh.md"), "utf8");
        assert.match(written, /^---\nArea: aa\n/);
        assert.match(written, /# Fresh/);
    });

    it("checks a doc through the command the setup registered", async () => {
        const dir = tempDir();
        mkdirSync(join(dir, "docs/aa"), { recursive: true });
        writeFileSync(
            join(dir, "docs/aa/bad.md"),
            "---\nArea: aa\nKeywords: alpha\nSummary: S.\n---\nJust prose.\n",
        );
        const added = await setup(dir);
        const command = added.commands[0] as {
            execute: (input: unknown) => Promise<void>;
        };

        await command.execute({
            sessionID: "ses_test",
            prompt: { text: "check" },
        } as never);

        assert.match(added.sent[0] ?? "", /aa\/bad\.md/);
    });

    it("appends the unversioned-root note to the command's check", async () => {
        const dir = tempDir();
        mkdirSync(join(dir, "docs/aa"), { recursive: true });
        writeFileSync(
            join(dir, "docs/aa/bad.md"),
            "---\nArea: aa\nKeywords: alpha\nSummary: S.\n---\nJust prose.\n",
        );
        const added = await setup(dir);
        const command = added.commands[0] as {
            execute: (input: unknown) => Promise<void>;
        };

        await command.execute({
            sessionID: "ses_test",
            prompt: { text: "check" },
        } as never);

        assert.match(added.sent[0] ?? "", /not inside a git work tree/);
    });

    it("roots the tool at the configured root option", async () => {
        const lake = tempDir();
        const added = await setup(tempDir(), { root: lake });
        const tool = added.tools[0] as {
            execute: (
                input: unknown,
                context: unknown,
            ) => Promise<{ content: unknown; metadata?: unknown }>;
        };

        await tool.execute(
            {
                add: {
                    metadata: {
                        Area: "aa",
                        Keywords: ["alpha"],
                        Summary: "A fresh doc.",
                    },
                    body: "# Fresh\n\n### Facts\n\n- Something verified.\n",
                },
            },
            {} as never,
        );

        // The doc lands in the lake, not the session location's docs/.
        const written = readFileSync(join(lake, "aa/fresh.md"), "utf8");
        assert.match(written, /^---\nArea: aa\n/);
        assert.equal(existsSync(join(lake, "docs/aa/fresh.md")), false);
    });
});
