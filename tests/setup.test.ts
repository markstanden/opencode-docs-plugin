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

    it("searches nested READMEs from the project location", async () => {
        // Arrange – a lake elsewhere, a README nested in the project.
        const dir = tempDir();
        const lake = tempDir();
        mkdirSync(join(dir, "packages/api"), { recursive: true });
        writeFileSync(
            join(dir, "packages/api/README.md"),
            "# Widget API\n\n## Endpoints\n\n- `widget.create`\n",
        );
        const added = await setup(dir, { root: lake });
        const tool = added.tools[0] as {
            execute: (
                input: unknown,
                context: unknown,
            ) => Promise<{ content: unknown }>;
        };

        // Act
        const result = await tool.execute({ search: "widget" }, {} as never);

        // Assert
        assert.match(String(result.content), /\bpackages\/api\/README\.md/);
    });

    it("keeps local READMEs out of the convention check", async () => {
        // Arrange – a README that would fail the knowledge-doc convention.
        const dir = tempDir();
        mkdirSync(join(dir, "packages/api"), { recursive: true });
        writeFileSync(
            join(dir, "packages/api/README.md"),
            "# Widget API\n\nJust prose, no front-matter.\n",
        );
        const added = await setup(dir, { root: tempDir() });
        const command = added.commands[0] as {
            execute: (input: unknown) => Promise<void>;
        };

        // Act
        await command.execute({
            sessionID: "ses_test",
            prompt: { text: "check" },
        } as never);

        // Assert – the report is about the lake only, never the README.
        assert.doesNotMatch(added.sent[0] ?? "", /README\.md/);
    });
});
