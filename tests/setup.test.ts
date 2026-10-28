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
    /** The tool hook callbacks the plugin registered, by hook name. */
    toolHooks: Record<string, (event: never) => unknown>;
    /** The session hook callbacks the plugin registered, by hook name. */
    sessionHooks: Record<string, (input: never) => unknown>;
}

/**
 * Run the plugin's `setup` against a minimal fake context rooted at
 * `directory`: each domain's `transform` runs its callback against an editor
 * that records every `add`, each `hook` records its callback, and
 * `session.prompt` records what the command sent.
 */
async function setup(
    directory: string,
    options: Record<string, unknown> = {},
): Promise<Harness> {
    const added: Harness = {
        tools: [],
        commands: [],
        skills: [],
        sent: [],
        toolHooks: {},
        sessionHooks: {},
    };
    const hookOf = (store: Record<string, unknown>) => ({
        hook: async (name: string, callback: (input: never) => unknown) => {
            store[name] = callback;
            return { dispose: async () => {} };
        },
    });
    const domain = (bucket: unknown[], hooks: Record<string, unknown>) => ({
        ...hookOf(hooks),
        transform: async (callback: (editor: unknown) => void) => {
            callback({
                add: (definition: unknown) => void bucket.push(definition),
            });
        },
    });
    const ctx = {
        options,
        location: { directory },
        tool: domain(added.tools, added.toolHooks),
        command: domain(added.commands, {}),
        skill: domain(added.skills, {}),
        session: {
            ...hookOf(added.sessionHooks),
            prompt: async (input: { text: string }) =>
                void added.sent.push(input.text),
        },
    };

    await plugin.setup(ctx as never);

    return added;
}

describe("setup", () => {
    it("registers the docs tools, command and skill", async () => {
        const added = await setup(tempDir());

        assert.equal(added.tools.length, 2);
        assert.equal(added.commands.length, 1);
        assert.equal(added.skills.length, 1);
    });

    it("names the native tool docs and the Code Mode twin docs_search", async () => {
        const added = await setup(tempDir());

        assert.equal((added.tools[0] as { name: string }).name, "docs");
        assert.equal((added.tools[1] as { name: string }).name, "docs_search");
        assert.equal((added.commands[0] as { name: string }).name, "docs");
    });

    it("registers the twin for Code Mode under the docs namespace", async () => {
        const added = await setup(tempDir());

        assert.deepEqual((added.tools[0] as { options: unknown }).options, {
            codemode: false,
        });
        assert.deepEqual((added.tools[1] as { options: unknown }).options, {
            namespace: "docs",
            codemode: true,
        });
    });

    it("registers the skill with the shipped doctrine as its content", async () => {
        const added = await setup(tempDir());
        const skill = added.skills[0] as { id: string; content: string };

        assert.equal(skill.id, "docs");
        assert.match(skill.content, /Open questions/);
        assert.match(skill.content, /`tools\.docs\.docs_search/);
    });

    it("writes a doc through the tool the setup registered", async () => {
        const dir = tempDir();
        mkdirSync(join(dir, "docs"), { recursive: true });
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
        assert.match(
            String(result.content),
            /\binstructions:packages\/api\/README\.md/,
        );
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

    it("adds repo lakes from .opencode/docs-lakes.json", async () => {
        // Arrange – the repo keeps its docs in documentation/, not docs/.
        const dir = tempDir();
        mkdirSync(join(dir, ".opencode"), { recursive: true });
        mkdirSync(join(dir, "documentation"), { recursive: true });
        writeFileSync(
            join(dir, ".opencode/docs-lakes.json"),
            JSON.stringify({
                lakes: [{ root: "documentation", name: "docs" }],
            }),
        );
        writeFileSync(
            join(dir, "documentation/landmine.md"),
            "---\nArea: landmine\nKeywords: gateway\nSummary: A trap.\n---\n" +
                "# Gateway landmine\n\n### Facts\n\n- x.\n",
        );
        const added = await setup(dir);
        const tool = added.tools[0] as {
            execute: (
                input: unknown,
                context: unknown,
            ) => Promise<{ content: unknown }>;
        };

        // Act
        const result = await tool.execute({ search: "gateway" }, {} as never);

        // Assert – the repo file supplied the lake, so no implicit docs/ lake
        // was created, and the doc is searchable.
        assert.match(String(result.content), /landmine\.md/);
        assert.equal(existsSync(join(dir, "docs")), false);
    });

    it("appends the miss nudge to content parts", async () => {
        const added = await setup(tempDir());
        const hook = added.toolHooks["execute.after"] as (
            event: never,
        ) => unknown;
        const event = {
            tool: "grep",
            status: "completed",
            sessionID: "ses_parts",
            input: { pattern: "queue" },
            result: {
                content: [{ type: "text", text: "No matches found" }],
            },
        };

        await hook(event as never);

        const content = (event.result as { content: unknown }).content;
        assert.ok(Array.isArray(content));
        assert.match(
            String((content as Array<{ text: string }>).at(-1)?.text),
            /`docs search`/,
        );
    });

    it("stays quiet when the hook event is malformed", async () => {
        const added = await setup(tempDir());
        const hook = added.toolHooks["execute.after"] as (
            event: never,
        ) => unknown;

        await assert.doesNotReject(async () => {
            await hook({
                tool: "grep",
                status: "completed",
                sessionID: "ses_bad",
                input: {},
                result: undefined,
            } as never);
        });
    });

    it("reads base lakes from lakesFile and keeps the wiki read-only", async () => {
        const dir = tempDir();
        const wiki = tempDir();
        writeFileSync(
            join(wiki, "page.md"),
            "# Page\n\nA unique wiki phrase zqx9.\n",
        );
        const base = join(tempDir(), "lakes.json");
        writeFileSync(
            base,
            JSON.stringify({
                lakes: [{ class: "wiki", root: wiki, name: "wiki" }],
            }),
        );
        const added = await setup(dir, { lakesFile: base });
        const tool = added.tools[0] as {
            execute: (
                input: unknown,
                context: unknown,
            ) => Promise<{
                content: unknown;
                metadata?: { written?: boolean };
            }>;
        };

        const found = await tool.execute({ search: "zqx9" }, {} as never);
        const addedToWiki = await tool.execute(
            {
                lake: "wiki",
                add: {
                    metadata: {
                        Area: "aa",
                        Keywords: ["alpha"],
                        Summary: "S.",
                    },
                    body: "# T\n\n### Facts\n\n- x.\n",
                },
            },
            {} as never,
        );

        assert.match(String(found.content), /wiki:page\.md/);
        assert.equal(addedToWiki.metadata?.written, false);
        assert.match(String(addedToWiki.content), /read-only/);
    });

    it("nudges a grep miss once per session through the tool hook", async () => {
        const added = await setup(tempDir());
        const hook = added.toolHooks["execute.after"] as (
            event: never,
        ) => unknown;
        const event = {
            tool: "grep",
            status: "completed",
            sessionID: "ses_nudge",
            input: { pattern: "queue backend" },
            result: { content: "No matches found" },
        };

        await hook(event as never);
        await hook(event as never);

        const content = String((event.result as { content: unknown }).content);
        assert.match(content, /`docs search`/);
        assert.match(content, /queue backend/);
        assert.equal(content.match(/`docs search`/g)?.length, 1);
    });

    it("stays quiet once the session has used the docs tool", async () => {
        const added = await setup(tempDir());
        const hook = added.toolHooks["execute.after"] as (
            event: never,
        ) => unknown;

        await hook({
            tool: "docs",
            status: "completed",
            sessionID: "ses_used",
            input: {},
            result: { content: "ok" },
        } as never);
        const miss = {
            tool: "grep",
            status: "completed",
            sessionID: "ses_used",
            input: {},
            result: { content: "No matches found" },
        };
        await hook(miss as never);

        assert.equal(miss.result.content, "No matches found");
    });

    it("counts a /docs command use as consulting the lake", async () => {
        const dir = tempDir();
        const added = await setup(dir);
        const command = added.commands[0] as {
            execute: (input: unknown) => Promise<void>;
        };

        await command.execute({
            sessionID: "ses_cmd",
            prompt: { text: "check" },
        } as never);
        const miss = {
            tool: "grep",
            status: "completed",
            sessionID: "ses_cmd",
            input: {},
            result: { content: "No matches found" },
        };
        const hook = added.toolHooks["execute.after"] as (
            event: never,
        ) => unknown;
        await hook(miss as never);

        assert.equal(miss.result.content, "No matches found");
    });

    it("injects the record nudge into compaction requests", async () => {
        const added = await setup(tempDir());
        const hook = added.sessionHooks["compaction"] as (
            input: never,
        ) => unknown;
        const compaction = { system: [] as unknown[] };

        await hook(compaction as never);

        assert.equal(compaction.system.length, 1);
        assert.match(
            String((compaction.system[0] as { text: string })?.text ?? ""),
            /Record with docs add/,
        );
    });

    it("registers no hooks when nudge is false", async () => {
        const added = await setup(tempDir(), { nudge: false });

        assert.deepEqual(Object.keys(added.toolHooks), []);
        assert.deepEqual(Object.keys(added.sessionHooks), []);
    });

    it("throws at setup on a non-boolean nudge", async () => {
        await assert.rejects(
            setup(tempDir(), { nudge: "off" }),
            /must be a boolean/,
        );
    });
});
