import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    checkDocs,
    collectDocPaths,
    createDocsTool,
    createLakes,
    fallbackDates,
    gitDates,
    markdownTargets,
    MAX_RESULTS,
    MAX_CHECK_CHARS,
    missNudgeFor,
    prepareAdd,
    rankDocs,
    render,
    resolveLakes,
    resolveNonNegativeInt,
    summaryOf,
    toEntry,
    type DocEntry,
    type Lake,
} from "../src/index.ts";

const cleanups: string[] = [];

after(() => {
    for (const dir of cleanups) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh scratch directory, removed after the suite. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "docs-lakes-"));
    cleanups.push(dir);
    return dir;
}

/** Run git with an isolated identity so the fixture is deterministic. */
function git(cwd: string, args: string[]): void {
    spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "Docs Test",
            GIT_AUTHOR_EMAIL: "docs-test@example.invalid",
            GIT_COMMITTER_NAME: "Docs Test",
            GIT_COMMITTER_EMAIL: "docs-test@example.invalid",
        },
    });
}

/** A minimal entry for ranking/addressing tests. */
function entry(overrides: Partial<DocEntry> = {}): DocEntry {
    return {
        path: "a.md",
        lake: "repo",
        class: "repo",
        area: "",
        date: "2026-01-02",
        title: "X",
        summary: "A summary",
        keywords: [],
        identifiers: [],
        text: "",
        ...overrides,
    };
}

/** A well-formed knowledge doc. */
function goodRaw(): string {
    return (
        "---\nArea: aa\nKeywords: alpha\nSummary: S.\n---\n" +
        "# Title\n\n### Facts\n\n- Something.\n"
    );
}

describe("resolveLakes", () => {
    it("adds one implicit repo lake at the location's docs directory", () => {
        const location = tempDir();

        const lakes = resolveLakes({}, location);

        assert.deepEqual(
            lakes.map((lake) => [
                lake.name,
                lake.class,
                lake.root,
                lake.writable,
            ]),
            [["docs", "repo", join(location, "docs"), true]],
        );
    });

    it("treats a blank root like unset", () => {
        const location = tempDir();

        const lakes = resolveLakes({ root: "" }, location);

        assert.equal(lakes[0]?.root, join(location, "docs"));
        assert.equal(lakes[0]?.name, "docs");
    });

    it("names the root lake when the name option is set", () => {
        const location = tempDir();

        const lakes = resolveLakes(
            { root: "documentation", name: "doclake" },
            location,
        );

        assert.equal(lakes[0]?.name, "doclake");
        assert.equal(lakes[0]?.root, join(location, "documentation"));
    });

    it("names the root lake after its folder when the name is unset", () => {
        const location = tempDir();

        const lakes = resolveLakes({ root: "documentation" }, location);

        assert.equal(lakes[0]?.name, "documentation");
    });

    it("throws when name is set without root", () => {
        assert.throws(
            () => resolveLakes({ name: "doclake" }, tempDir()),
            /names the 'root' lake/,
        );
    });

    it("merges a base file, the repo file, and inline lakes", () => {
        const location = tempDir();
        const machine = tempDir();
        const global = tempDir();
        const base = join(tempDir(), "lakes.json");
        writeFileSync(
            base,
            JSON.stringify({
                lakes: [
                    { class: "machine", root: machine, name: "machine" },
                    { class: "global", root: global, name: "global" },
                ],
            }),
        );
        mkdirSync(join(location, ".opencode"), { recursive: true });
        writeFileSync(
            join(location, ".opencode/docs-lakes.json"),
            JSON.stringify({
                lakes: [{ root: "documentation", name: "docs" }],
            }),
        );
        const inline = tempDir();

        const lakes = resolveLakes(
            {
                lakesFile: base,
                lakes: [{ class: "repo", root: inline, name: "extra" }],
            },
            location,
        );

        assert.deepEqual(
            lakes.map((lake) => [lake.name, lake.class]),
            [
                ["machine", "machine"],
                ["global", "global"],
                ["docs", "repo"],
                ["extra", "repo"],
            ],
        );
        assert.equal(lakes[2]?.root, join(location, "documentation"));
    });

    it("keeps the implicit repo lake when only a base file is configured", () => {
        const location = tempDir();
        const base = join(tempDir(), "lakes.json");
        writeFileSync(
            base,
            JSON.stringify({
                lakes: [{ class: "wiki", root: tempDir(), name: "wiki" }],
            }),
        );

        const lakes = resolveLakes({ lakesFile: base }, location);

        assert.deepEqual(
            lakes.map((lake) => [lake.name, lake.class]),
            [
                ["wiki", "wiki"],
                ["docs", "repo"],
            ],
        );
        assert.equal(lakes[1]?.writable, true);
        assert.equal(lakes[0]?.writable, false);
    });

    it("accepts a lakes file whose JSON is a bare array", () => {
        // Arrange – a base file holding the bare array form.
        const wiki = tempDir();
        const base = join(tempDir(), "lakes.json");
        writeFileSync(
            base,
            JSON.stringify([{ class: "wiki", root: wiki, name: "wiki" }]),
        );

        // Act
        const lakes = resolveLakes({ lakesFile: base }, tempDir());

        // Assert – same shape as the object form, implicit repo lake kept.
        assert.deepEqual(
            lakes.map((lake) => [lake.name, lake.class, lake.writable]),
            [
                ["wiki", "wiki", false],
                ["docs", "repo", true],
            ],
        );
    });

    it("refuses non-repo classes and roots outside the location in the repo file", () => {
        const location = tempDir();
        mkdirSync(join(location, ".opencode"), { recursive: true });

        writeFileSync(
            join(location, ".opencode/docs-lakes.json"),
            JSON.stringify({ lakes: [{ class: "wiki", root: "wiki" }] }),
        );
        assert.throws(
            () => resolveLakes({}, location),
            /may only declare "repo" lakes/,
        );

        writeFileSync(
            join(location, ".opencode/docs-lakes.json"),
            JSON.stringify({ lakes: [{ root: tempDir() }] }),
        );
        assert.throws(
            () => resolveLakes({}, location),
            /must stay inside the location/,
        );
    });

    it("throws on duplicate names", () => {
        const location = tempDir();

        assert.throws(
            () =>
                resolveLakes(
                    {
                        lakes: [
                            { root: tempDir(), name: "same" },
                            { root: tempDir(), name: "same" },
                        ],
                    },
                    location,
                ),
            /declared twice/,
        );
    });

    it("throws when two lakes resolve to the same root", () => {
        const location = tempDir();
        const root = tempDir();
        const alias = join(tempDir(), "alias");
        symlinkSync(root, alias, "dir");

        assert.throws(
            () =>
                resolveLakes(
                    {
                        lakes: [
                            { root, name: "one" },
                            { root: alias, name: "two" },
                        ],
                    },
                    location,
                ),
            /share the root/,
        );
    });

    it("rejects a repo-local lake root that is a symlink outside the location", () => {
        const location = tempDir();
        const outside = tempDir();
        mkdirSync(join(location, ".opencode"), { recursive: true });
        symlinkSync(outside, join(location, "documentation"), "dir");
        writeFileSync(
            join(location, ".opencode/docs-lakes.json"),
            JSON.stringify({ lakes: [{ root: "documentation" }] }),
        );

        assert.throws(
            () => resolveLakes({}, location),
            /must stay inside the location/,
        );
    });

    it("allows a repo-local lake root that does not exist yet", () => {
        const location = tempDir();
        mkdirSync(join(location, ".opencode"), { recursive: true });
        writeFileSync(
            join(location, ".opencode/docs-lakes.json"),
            JSON.stringify({ lakes: [{ root: "documentation" }] }),
        );

        const lakes = resolveLakes({}, location);

        assert.equal(lakes[0]?.root, join(location, "documentation"));
    });

    it("throws when root and lakes are both given", () => {
        assert.throws(
            () =>
                resolveLakes(
                    { root: tempDir(), lakes: [{ root: tempDir() }] },
                    tempDir(),
                ),
            /mutually exclusive/,
        );
    });

    it("throws on a missing base file", () => {
        assert.throws(
            () =>
                resolveLakes(
                    { lakesFile: join(tempDir(), "gone.json") },
                    tempDir(),
                ),
            /not found/,
        );
    });

    it("reserves the instructions name and validates wiki writability", () => {
        const location = tempDir();

        assert.throws(
            () =>
                resolveLakes(
                    {
                        lakes: [{ root: tempDir(), name: "instructions" }],
                    },
                    location,
                ),
            /reserved/,
        );
        assert.throws(
            () =>
                resolveLakes(
                    {
                        lakes: [
                            {
                                class: "wiki",
                                root: tempDir(),
                                name: "wiki",
                                writable: true,
                            },
                        ],
                    },
                    location,
                ),
            /cannot be writable/,
        );
    });
});

describe("resolveNonNegativeInt", () => {
    it("passes zero and positive integers through", () => {
        assert.equal(resolveNonNegativeInt(0, "x", 3), 0);
        assert.equal(resolveNonNegativeInt(7, "x", 3), 7);
    });

    it("uses the fallback when unset", () => {
        assert.equal(resolveNonNegativeInt(undefined, "x", 3), 3);
    });

    it("throws on a negative, fractional or non-number value", () => {
        for (const value of [-1, 1.5, "3", null]) {
            assert.throws(
                () => resolveNonNegativeInt(value, "x", 3),
                /non-negative integer/,
            );
        }
    });
});

describe("collectDocPaths", () => {
    it("skips scratch, mirrors, dot directories and node_modules in a knowledge lake", () => {
        const root = tempDir();
        for (const dir of [
            "decisions",
            "plans",
            "requirements",
            "wiki",
            ".git",
            "node_modules/pkg",
        ]) {
            mkdirSync(join(root, dir), { recursive: true });
            writeFileSync(join(root, dir, "a.md"), "# A\n");
        }

        assert.deepEqual(collectDocPaths(root), ["decisions/a.md"]);
    });

    it("keeps named areas in a wiki lake but still skips dot-directories and dependencies", () => {
        const root = tempDir();
        for (const dir of [
            "requirements",
            "wiki",
            "plans",
            ".git",
            "node_modules/pkg",
        ]) {
            mkdirSync(join(root, dir), { recursive: true });
            writeFileSync(join(root, dir, "a.md"), "# A\n");
        }

        assert.deepEqual(collectDocPaths(root, { profile: "wiki" }), [
            "plans/a.md",
            "requirements/a.md",
            "wiki/a.md",
        ]);
    });

    it("excludes a nested lake root from the outer lake", () => {
        const root = tempDir();
        mkdirSync(join(root, "docs/aa"), { recursive: true });
        mkdirSync(join(root, "wiki"), { recursive: true });
        writeFileSync(join(root, "docs/aa/a.md"), "# A\n");
        writeFileSync(join(root, "wiki/b.md"), "# B\n");

        assert.deepEqual(
            collectDocPaths(root, { skip: [join(root, "wiki")] }),
            ["docs/aa/a.md"],
        );
    });
});

describe("wiki entries", () => {
    it("derives a summary from the first prose paragraph", () => {
        const body =
            "# Page\n\n[![badge](badge.png)](x)\n\n" +
            "First real sentence about the page.\n\n## Facts\n\n- x.\n";

        assert.equal(summaryOf(body), "First real sentence about the page.");
    });

    it("indexes prose and tables, not front-matter", () => {
        const entry = toEntry(
            "guide/regions.md",
            "---\nArea: guide\n---\n# Regions\n\n| Region | Code |\n" +
                "| --- | --- |\n| UK South | uksouth |\n",
            "2026-01-01",
            { class: "wiki", lake: "wiki", profile: "wiki" },
        );

        assert.match(entry.text, /uksouth/);
        assert.equal(entry.area, "guide");
    });
});

describe("gitDates", () => {
    it("resolves paths for a lake rooted below the repo root", () => {
        const root = tempDir();
        mkdirSync(join(root, "docs"), { recursive: true });
        writeFileSync(join(root, "docs/a.md"), "# A\n");
        git(root, ["init", "-q"]);
        git(root, ["add", "docs/a.md"]);
        git(root, ["commit", "-qm", "add a"]);

        const dates = gitDates(join(root, "docs"), ["a.md"]);

        assert.match(dates.get("a.md") ?? "", /^\d{4}-\d{2}-\d{2}$/);
    });
});

describe("per-lake reservation", () => {
    it("keeps a wiki result visible when repo docs fill the cap", () => {
        const repo = Array.from({ length: MAX_RESULTS + 2 }, (_, i) =>
            entry({ path: `r${i}.md`, lake: "repo", title: "Serena" }),
        );
        const wiki = entry({
            path: "wiki.md",
            lake: "wiki",
            class: "wiki",
            title: "Other",
            summary: "serena note",
        });

        const reserved = rankDocs([...repo, wiki], "serena");
        const unserved = rankDocs([...repo, wiki], "serena", {
            perLakeQuota: 0,
        });

        assert.ok(reserved.entries.some((doc) => doc.lake === "wiki"));
        assert.ok(!unserved.entries.some((doc) => doc.lake === "wiki"));
    });

    it("prefixes only non-primary lakes in render", () => {
        const text = render(
            [
                entry({ path: "a.md", lake: "repo" }),
                entry({ path: "b.md", lake: "wiki", class: "wiki" }),
            ],
            { primaryLake: "repo" },
        );

        assert.match(text, /^a\.md/m);
        assert.match(text, /^wiki:b\.md/m);
    });

    it("prefixes a project README even when a lake has the same path", () => {
        const text = render(
            [
                entry({ path: "README.md", lake: "repo", class: "repo" }),
                entry({
                    path: "README.md",
                    lake: "",
                    class: "instructions",
                }),
            ],
            { primaryLake: "repo" },
        );

        assert.match(text, /^README\.md/m);
        assert.match(text, /^instructions:README\.md/m);
    });
});

describe("multi-lake tool", () => {
    /** Two lakes with a doc of the same path in each. */
    function toolOf(): ReturnType<typeof createDocsTool> {
        const repoRoot = tempDir();
        const wikiRoot = tempDir();
        mkdirSync(repoRoot, { recursive: true });
        mkdirSync(wikiRoot, { recursive: true });
        writeFileSync(
            join(repoRoot, "a.md"),
            "---\nArea: aa\nKeywords: alpha\nSummary: Repo.\n---\n# Repo\n",
        );
        writeFileSync(join(wikiRoot, "a.md"), "# Wiki\n\nWiki prose.\n");
        const lakes = createLakes([
            {
                name: "repo",
                class: "repo",
                root: repoRoot,
                profile: "knowledge",
                writable: true,
            },
            {
                name: "wiki",
                class: "wiki",
                root: wikiRoot,
                profile: "wiki",
                writable: false,
            },
        ]);
        return createDocsTool({ lakes });
    }

    it("refuses an ambiguous bare read and accepts a lake prefix", async () => {
        const tool = toolOf();

        const ambiguous = await tool.execute({ read: "a.md" }, {} as never);
        const prefixed = await tool.execute({ read: "wiki:a.md" }, {} as never);
        const both = await tool.execute(
            { lake: "wiki", read: "wiki:a.md" },
            {} as never,
        );

        assert.match(String(ambiguous.content), /exists in multiple lakes/);
        assert.match(String(prefixed.content), /^wiki:a\.md — Wiki/);
        assert.match(String(both.content), /^wiki:a\.md — Wiki/);
    });

    it("adds to the repo lake by default and refuses the wiki", async () => {
        const tool = toolOf();
        const add = {
            metadata: { Area: "bb", Keywords: ["beta"], Summary: "New." },
            body: "# New\n\n### Facts\n\n- x.\n",
        };

        const repo = await tool.execute({ add } as never, {} as never);
        const wiki = await tool.execute(
            { lake: "wiki", add } as never,
            {} as never,
        );

        assert.equal(repo.metadata?.written, true);
        assert.match(String(repo.content), /^repo:bb\/new\.md — created/);
        assert.equal(wiki.metadata?.written, false);
        assert.match(String(wiki.content), /read-only/);
    });

    it("checks knowledge lakes and reports the wiki as unvalidated", async () => {
        const tool = toolOf();

        const result = await tool.execute({ check: true }, {} as never);

        assert.match(String(result.content), /repo:/);
        assert.match(
            String(result.content),
            /^wiki: wiki class, read-only, not validated\.$/m,
        );
        assert.equal(result.metadata?.checked, 1);
    });

    it("lists the configured lakes in help", async () => {
        const tool = toolOf();

        const result = await tool.execute({ search: "help" }, {} as never);

        assert.match(
            String(result.content),
            /repo \(Repository \[repo\], writable, checked\)/,
        );
        assert.match(
            String(result.content),
            /wiki \(Wiki \[wiki\], read-only, not checked\)/,
        );
    });
});

describe("check validation scope", () => {
    const compliant =
        "---\nArea: aa\nKeywords: alpha\nSummary: Good.\n---\n# Good\n\n### Facts\n\n- x.\n";
    const broken =
        "---\nArea: aa\nKeywords: alpha\nSummary: Bad.\n---\nJust prose.\n";

    /** One lake over a directory holding a compliant and a broken doc. */
    function fixture(
        writable: boolean,
        profile: "knowledge" | "wiki" = "knowledge",
    ): ReturnType<typeof createDocsTool> {
        const root = tempDir();
        writeFileSync(join(root, "good.md"), compliant);
        writeFileSync(join(root, "bad.md"), broken);
        return createDocsTool({
            lakes: createLakes([
                {
                    name: "scope",
                    class: profile === "wiki" ? "wiki" : "repo",
                    root,
                    profile,
                    writable,
                },
            ]),
        });
    }

    it("reports findings in a writable knowledge lake", async () => {
        // Arrange
        const result = await fixture(true).execute(
            { check: true },
            {} as never,
        );

        // Act
        const content = String(result.content);

        // Assert
        assert.match(content, /\bbad\.md/);
        assert.doesNotMatch(content, /\bgood\.md/);
        assert.match(content, /H1/);
        assert.equal(result.metadata?.checked, 2);
    });

    it("skips a read-only knowledge lake and names it", async () => {
        // Act
        const result = await fixture(false).execute(
            { check: true },
            {} as never,
        );
        const content = String(result.content);

        // Assert
        assert.doesNotMatch(content, /\bbad\.md/);
        assert.doesNotMatch(content, /H1/);
        assert.match(content, /^scope: read-only, not validated\.$/m);
        assert.equal(result.metadata?.checked, 0);
    });

    it("skips a read-only knowledge lake selected by name", async () => {
        // Act
        const result = await fixture(false).execute(
            { check: true, lake: "scope" },
            {} as never,
        );

        // Assert
        assert.match(
            String(result.content),
            /^scope: read-only, not validated\.$/m,
        );
        assert.equal(result.metadata?.checked, 0);
    });

    it("never validates a wiki lake", async () => {
        // Act
        const result = await fixture(false, "wiki").execute(
            { check: true },
            {} as never,
        );
        const content = String(result.content);

        // Assert
        assert.doesNotMatch(content, /\bbad\.md/);
        assert.match(
            content,
            /^scope: wiki class, read-only, not validated\.$/m,
        );
        assert.equal(result.metadata?.checked, 0);
    });

    it("marks a read-only knowledge lake not checked in help", async () => {
        // Act
        const result = await fixture(false).execute(
            { search: "help" },
            {} as never,
        );

        // Assert
        assert.match(
            String(result.content),
            /scope \(Repository \[repo\], read-only, not checked\)/,
        );
    });

    it("names every skipped lake when none are writable", async () => {
        // Arrange
        const lakes = createLakes(
            ["one", "two"].map((name) => ({
                name,
                class: "repo" as const,
                root: tempDir(),
                profile: "knowledge" as const,
                writable: false,
            })),
        );

        // Act
        const result = await createDocsTool({ lakes }).execute(
            { check: true },
            {} as never,
        );
        const content = String(result.content);

        // Assert
        assert.match(content, /^one: read-only, not validated\.$/m);
        assert.match(content, /^two: read-only, not validated\.$/m);
        assert.doesNotMatch(content, /comply/);
        assert.equal(result.metadata?.checked, 0);
    });

    it("still searches a read-only lake in full", async () => {
        // Act
        const result = await fixture(false).execute(
            { search: "bad" },
            {} as never,
        );

        // Assert
        assert.match(String(result.content), /^bad\.md/m);
    });

    it("shows findings up to the cap before the tail", async () => {
        // Arrange
        const root = tempDir();
        git(root, ["init", "-q"]);
        const count = Math.ceil(MAX_CHECK_CHARS / 40) + 20;
        for (let index = 0; index < count; index += 1) {
            writeFileSync(join(root, `bad-${index}.md`), broken);
        }
        const lakes = createLakes([
            {
                name: "scope",
                class: "repo",
                root,
                profile: "knowledge",
                writable: true,
            },
        ]);
        const tool = createDocsTool({ lakes });

        // Act
        const result = await tool.execute({ check: true }, {} as never);
        const content = String(result.content);
        const tail = content.match(/… and (\d+) more lines not shown/);
        const lake = lakes[0];

        // Assert
        assert.ok(tail !== null);
        assert.ok(lake !== undefined);
        assert.match(content, /\bbad-0\.md/);
        assert.ok(Number(tail[1]) > 0);
        assert.ok(content.length > MAX_CHECK_CHARS - 200);
        assert.ok(content.length < MAX_CHECK_CHARS + 200);
        assert.match(content, /Narrow it per lake with the `lake` selector/);

        const full = checkDocs(lake.collect(), lake.read, [], {
            exists: lake.exists,
        });
        const kept = content.split("\n\n… and ")[0]?.split("\n").length ?? 0;
        assert.equal(Number(tail[1]), full.split("\n").length - kept);
    });

    it("keeps a skipped lake visible when the writable report is capped", async () => {
        // Arrange
        const writableRoot = tempDir();
        const readOnlyRoot = tempDir();
        const count = Math.ceil(MAX_CHECK_CHARS / 40) + 20;
        for (let index = 0; index < count; index += 1) {
            writeFileSync(join(writableRoot, `bad-${index}.md`), broken);
        }
        const tool = createDocsTool({
            lakes: createLakes([
                {
                    name: "scope",
                    class: "repo",
                    root: writableRoot,
                    profile: "knowledge",
                    writable: true,
                },
                {
                    name: "readonly",
                    class: "repo",
                    root: readOnlyRoot,
                    profile: "knowledge",
                    writable: false,
                },
            ]),
        });

        // Act
        const result = await tool.execute({ check: true }, {} as never);
        const content = String(result.content);

        // Assert
        assert.match(content, /… and \d+ more lines not shown/);
        assert.match(content, /^readonly: read-only, not validated\.$/m);
    });

    it("reports when no lakes are configured", async () => {
        // Act
        const result = await createDocsTool({ lakes: [] }).execute(
            { check: true },
            {} as never,
        );

        // Assert
        assert.equal(String(result.content), "No knowledge lakes configured.");
        assert.equal(result.metadata?.checked, 0);
    });
});

describe("nested lake roots", () => {
    /**
     * A writable repo lake rooted inside a larger read-only lake, as when a
     * project's docs live inside a reference tree. The outer lake's class is a
     * parameter: the nested root is skipped whatever class it is given.
     * @param outerClass The outer lake's class; defaults to a wiki lake.
     */
    function fixture(
        outerClass: "repo" | "machine" | "global" | "wiki" = "wiki",
    ): {
        tool: ReturnType<typeof createDocsTool>;
        outerRoot: string;
        nestedRoot: string;
    } {
        const outerRoot = tempDir();
        const nestedRoot = join(outerRoot, "megacortex/knowledge");
        mkdirSync(join(nestedRoot, "machine"), { recursive: true });
        writeFileSync(
            join(outerRoot, "outer-only.md"),
            "---\nArea: reference\nKeywords: stormtrooper\nSummary: Outer page about the stormtrooper box.\n---\n# Outer page\n\n## Facts\n\n- Stormtrooper box reference.\n",
        );
        writeFileSync(
            join(nestedRoot, "machine/inner-only.md"),
            "---\nArea: machine\nKeywords: stormtrooper\nSummary: Nested doc about the stormtrooper box.\n---\n# Inner\n\n## Facts\n\n- x.\n",
        );
        const lakes = createLakes([
            {
                name: outerClass,
                class: outerClass,
                root: outerRoot,
                profile: outerClass === "wiki" ? "wiki" : "knowledge",
                writable: false,
            },
            {
                name: "doclake",
                class: "repo",
                root: nestedRoot,
                profile: "knowledge",
                writable: true,
            },
        ]);
        return { tool: createDocsTool({ lakes }), outerRoot, nestedRoot };
    }

    it("returns a nested lake's doc once, from the nested lake", async () => {
        const { tool } = fixture();

        const result = await tool.execute(
            { search: "stormtrooper" },
            {} as never,
        );
        const text = String(result.content);

        assert.equal(text.match(/inner-only\.md/g)?.length, 1);
        assert.match(text, /^machine\/inner-only\.md —/m);
        assert.equal(text.match(/outer-only\.md/g)?.length, 1);
        assert.match(text, /^wiki:outer-only\.md/m);
    });

    it("dedupes relative repo lakes split across config and the repo file", async () => {
        const location = tempDir();
        const outerRoot = join(location, "documentation");
        const nestedRoot = join(outerRoot, "knowledge-share/doc-lake");
        mkdirSync(join(nestedRoot, "machine"), { recursive: true });
        writeFileSync(
            join(outerRoot, "outer-only.md"),
            "---\nArea: guides\nKeywords: stormtrooper\nSummary: Outer doc.\n---\n# Outer\n\n## Facts\n\n- x.\n",
        );
        writeFileSync(
            join(nestedRoot, "machine/inner-only.md"),
            "---\nArea: machine\nKeywords: stormtrooper\nSummary: Nested doc.\n---\n# Inner\n\n## Facts\n\n- x.\n",
        );
        mkdirSync(join(location, ".opencode"), { recursive: true });
        writeFileSync(
            join(location, ".opencode/docs-lakes.json"),
            JSON.stringify({
                lakes: [
                    {
                        class: "repo",
                        root: "documentation/knowledge-share/doc-lake",
                        name: "doclake",
                        writable: true,
                    },
                ],
            }),
        );
        const specs = resolveLakes(
            {
                lakes: [
                    {
                        class: "repo",
                        root: "documentation",
                        name: "docs",
                        writable: false,
                    },
                ],
            },
            location,
        );
        const tool = createDocsTool({ lakes: createLakes(specs) });

        const result = await tool.execute(
            { search: "stormtrooper" },
            {} as never,
        );
        const text = String(result.content);

        assert.equal(text.match(/inner-only\.md/g)?.length, 1);
        assert.equal(text.match(/outer-only\.md/g)?.length, 1);
    });

    it("skips the nested root whatever class the outer lake has", async () => {
        for (const outerClass of [
            "repo",
            "machine",
            "global",
            "wiki",
        ] as const) {
            const { tool } = fixture(outerClass);

            const result = await tool.execute(
                { search: "stormtrooper" },
                {} as never,
            );
            const text = String(result.content);

            assert.equal(text.match(/inner-only\.md/g)?.length, 1, outerClass);
            assert.doesNotMatch(text, /megacortex\/knowledge/, outerClass);
        }
    });

    it("lists a nested lake's doc once in a blank search", async () => {
        const { tool } = fixture();

        const result = await tool.execute({ search: "" }, {} as never);
        const text = String(result.content);

        assert.equal(text.match(/inner-only\.md/g)?.length, 1);
        assert.equal(text.match(/outer-only\.md/g)?.length, 1);
    });

    it("reads a nested lake's doc without a multiple-lakes refusal", async () => {
        const { tool } = fixture();

        const result = await tool.execute(
            { read: "machine/inner-only.md" },
            {} as never,
        );

        assert.doesNotMatch(String(result.content), /multiple lakes/);
        assert.match(
            String(result.content),
            /^doclake:machine\/inner-only\.md — Inner/m,
        );
    });

    it("writes to the writable nested lake, never the read-only outer one", async () => {
        const { tool, outerRoot, nestedRoot } = fixture();
        const add = {
            metadata: {
                Area: "reference",
                Keywords: ["added"],
                Summary: "Added through the nested lake.",
            },
            body: "# Added\n\n### Facts\n\n- x.\n",
        };

        const result = await tool.execute({ add } as never, {} as never);
        const written = join(nestedRoot, "reference/added.md");

        assert.match(
            String(result.content),
            /^doclake:reference\/added\.md — created/m,
        );
        assert.equal(result.metadata?.written, true);
        assert.equal(existsSync(written), true);
        assert.equal(existsSync(join(outerRoot, "reference/added.md")), false);
    });
});

describe("missing lake roots", () => {
    /** An existing repo lake plus a machine lake whose root is absent. */
    function toolOf(): {
        tool: ReturnType<typeof createDocsTool>;
        root: string;
    } {
        const repoRoot = tempDir();
        writeFileSync(
            join(repoRoot, "a.md"),
            "---\nArea: aa\nKeywords: alpha\nSummary: Repo.\n---\n# Repo\n",
        );
        const root = join(tempDir(), "absent");
        const lakes = createLakes([
            {
                name: "repo",
                class: "repo",
                root: repoRoot,
                profile: "knowledge",
                writable: true,
            },
            {
                name: "doclake",
                class: "machine",
                root,
                profile: "knowledge",
                writable: true,
            },
        ]);
        return { tool: createDocsTool({ lakes }), root };
    }

    it("flags a missing root after search results", async () => {
        const { tool, root } = toolOf();

        const result = await tool.execute({ search: "" }, {} as never);

        assert.match(String(result.content), /Repo\./);
        assert.ok(
            String(result.content).includes(
                `lake 'doclake' root ${root} does not exist`,
            ),
        );
    });

    it("stays quiet about a missing root outside the selected lake", async () => {
        const { tool } = toolOf();

        const result = await tool.execute(
            { search: "", lake: "repo" },
            {} as never,
        );

        assert.doesNotMatch(String(result.content), /does not exist/);
    });

    it("refuses an add to a missing root without creating it", async () => {
        const { tool, root } = toolOf();

        const result = await tool.execute(
            {
                lake: "doclake",
                add: {
                    metadata: {
                        Area: "aa",
                        Keywords: ["alpha"],
                        Summary: "S.",
                    },
                    body: "# T\n\n### Facts\n\n- x.\n",
                },
            } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, false);
        assert.match(
            String(result.content),
            /Rejected: lake 'doclake' root .* does not exist/,
        );
        assert.equal(existsSync(root), false);
    });

    it("refuses a lake write when the root is missing", () => {
        const root = join(tempDir(), "absent");
        const lake = createLakes([
            {
                name: "doclake",
                class: "machine",
                root,
                profile: "knowledge",
                writable: true,
            },
        ])[0] as Lake;

        assert.throws(
            () => lake.write("aa/x.md", "x\n"),
            /does not exist; create it first/,
        );
        assert.equal(existsSync(root), false);
    });

    it("marks a missing root in help", async () => {
        const { tool } = toolOf();

        const result = await tool.execute({ search: "help" }, {} as never);

        assert.match(
            String(result.content),
            /doclake \(Personal \[machine\], writable, checked\): .* — missing/,
        );
    });
});

describe("lake path safety", () => {
    /** A writable knowledge lake rooted at `root`. */
    function lakeAt(root: string): Lake {
        return createLakes([
            {
                name: "repo",
                class: "repo",
                root,
                profile: "knowledge",
                writable: true,
            },
        ])[0] as Lake;
    }

    /** A writable lake with a symlinked doc pointing at an outside file. */
    function escapeFixture(): { outside: string; lake: Lake } {
        const root = tempDir();
        const outside = tempDir();
        writeFileSync(join(outside, "secret.md"), "outside\n");
        symlinkSync(join(outside, "secret.md"), join(root, "linked.md"));
        return { outside, lake: lakeAt(root) };
    }

    it("does not report a symlinked file as present", () => {
        const { lake } = escapeFixture();

        assert.equal(lake.exists("linked.md"), false);
    });

    it("refuses to read a symlinked file", () => {
        const { lake } = escapeFixture();

        assert.throws(
            () => lake.read("linked.md"),
            /escapes the lake root or crosses a symlink/,
        );
    });

    it("refuses to write through a symlink and leaves the target untouched", () => {
        const { lake, outside } = escapeFixture();

        assert.throws(
            () => lake.write("linked.md", "overwritten\n"),
            /crosses a symlink/,
        );
        assert.equal(
            readFileSync(join(outside, "secret.md"), "utf8"),
            "outside\n",
        );
    });

    it("refuses a path that runs through a symlinked directory", () => {
        const root = tempDir();
        const outside = tempDir();
        writeFileSync(join(outside, "page.md"), "outside\n");
        symlinkSync(outside, join(root, "linked"), "dir");

        assert.throws(
            () => lakeAt(root).read("linked/page.md"),
            /crosses a symlink/,
        );
    });

    it("refuses a symlink that points back inside the root", () => {
        const root = tempDir();
        writeFileSync(join(root, "real.md"), "# Real\n");
        symlinkSync(join(root, "real.md"), join(root, "alias.md"));

        assert.throws(() => lakeAt(root).read("alias.md"), /crosses a symlink/);
    });

    it("refuses a path that escapes the root", () => {
        const { lake } = escapeFixture();

        assert.throws(
            () => lake.write("../outside.md", "x\n"),
            /escapes the lake root/,
        );
    });

    it("refuses an add whose target is a symlink", async () => {
        const { lake, outside } = escapeFixture();
        const tool = createDocsTool({ lakes: [lake] });

        const result = await tool.execute(
            {
                add: {
                    metadata: {
                        Area: "aa",
                        Keywords: ["alpha"],
                        Summary: "S.",
                    },
                    body: "# T\n\n### Facts\n\n- x.\n",
                    path: "linked.md",
                },
            } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /Rejected:.*crosses a symlink/);
        assert.equal(
            readFileSync(join(outside, "secret.md"), "utf8"),
            "outside\n",
        );
    });
});

describe("link check", () => {
    it("flags a broken relative link and accepts a real one", () => {
        const dir = tempDir();
        mkdirSync(join(dir, "aa"), { recursive: true });
        writeFileSync(join(dir, "aa/other.md"), "# Other\n");
        const raw =
            "---\nArea: aa\nKeywords: alpha\nSummary: S.\n---\n" +
            "# Title\n\n### Facts\n\n- See [other](other.md).\n";
        const entries = [toEntry("aa/a.md", raw, "2026-01-01")];

        const good = checkDocs(entries, () => raw, [], {
            exists: (path) => path === "aa/other.md",
        });
        const bad = checkDocs(entries, () => raw, [], {
            exists: () => false,
        });

        assert.doesNotMatch(good, /broken link/);
        assert.match(bad, /broken link to other\.md/);
    });

    it("ignores URLs, anchors, images and escaping targets", () => {
        const raw =
            "---\nArea: aa\nKeywords: alpha\nSummary: S.\n---\n" +
            "# Title\n\n### Facts\n\n- [web](https://example.com/x.md)\n" +
            "- [anchor](#facts)\n- ![img](x.png)\n- [up](../../x.md)\n";
        const entries = [toEntry("aa/a.md", raw, "2026-01-01")];

        const report = checkDocs(entries, () => raw, [], {
            exists: () => false,
        });

        assert.doesNotMatch(report, /broken link/);
    });

    it("reports a malformed percent-encoding as a broken link, without throwing", () => {
        // Arrange – a link target no decoder accepts (`%zz` is invalid).
        const raw =
            "---\nArea: aa\nKeywords: alpha\nSummary: S.\n---\n" +
            "# Title\n\n### Facts\n\n- See [pct](a%zz.md).\n";
        const entries = [toEntry("aa/a.md", raw, "2026-01-01")];

        // Act
        const report = checkDocs(entries, () => raw, [], {
            exists: () => false,
        });

        // Assert – the raw target is reported; the URIError stays caught.
        assert.match(report, /broken link to a%zz\.md/);
    });
});

describe("soft length note", () => {
    it("notes an add over maxDocLines without refusing", () => {
        const outcome = prepareAdd(
            {
                metadata: { Area: "aa", Keywords: ["alpha"], Summary: "S." },
                body: "# T\n\n### Facts\n\n- one.\n- two.\n",
            },
            [],
            { maxDocLines: 3 },
        );

        assert.equal(outcome.action, "write");
        if (outcome.action === "write") {
            assert.equal(outcome.notes.length, 1);
            assert.match(outcome.notes[0] ?? "", /maxDocLines/);
        }
    });

    it("notes a long doc in check", () => {
        const raw = goodRaw() + "\n- more.\n- more.\n";
        const entries = [toEntry("aa/a.md", raw, "2026-01-01")];

        const report = checkDocs(entries, () => raw, [], { maxDocLines: 3 });

        assert.match(report, /body lines exceeds maxDocLines/);
    });

    it("disables the note when maxDocLines is zero", () => {
        const outcome = prepareAdd(
            {
                metadata: { Area: "aa", Keywords: ["alpha"], Summary: "S." },
                body: "# T\n\n### Facts\n\n- one.\n- two.\n",
            },
            [],
            { maxDocLines: 0 },
        );

        assert.equal(outcome.action, "write");
        if (outcome.action === "write") {
            assert.deepEqual(outcome.notes, []);
        }
    });
});

describe("call-time lake notes", () => {
    /** A tool over one repo lake whose root does not exist yet. */
    function lateLakeTool(): {
        tool: ReturnType<typeof createDocsTool>;
        root: string;
    } {
        const root = join(tempDir(), "late");
        const lakes = createLakes([
            {
                name: "late",
                class: "repo",
                root,
                profile: "knowledge",
                writable: true,
            },
        ]);
        return { tool: createDocsTool({ lakes }), root };
    }

    it("clears the missing-root note without a restart", async () => {
        const { tool, root } = lateLakeTool();

        const before = await tool.execute({ check: true }, {} as never);
        const searchBefore = await tool.execute(
            { search: "probe" },
            {} as never,
        );

        mkdirSync(root, { recursive: true });
        writeFileSync(
            join(root, "probe.md"),
            "---\nArea: probe\nKeywords: probe\nSummary: S.\n---\n# Probe\n\n### Facts\n\n- x.\n",
        );

        const after = await tool.execute({ check: true }, {} as never);
        const searchAfter = await tool.execute(
            { search: "probe" },
            {} as never,
        );

        assert.match(String(before.content), /does not exist/);
        assert.equal(before.metadata?.checked, 0);
        assert.match(String(searchBefore.content), /does not exist/);
        assert.doesNotMatch(String(after.content), /does not exist/);
        assert.equal(after.metadata?.checked, 1);
        assert.doesNotMatch(String(searchAfter.content), /does not exist/);
        assert.match(String(searchAfter.content), /^probe\.md/m);
    });

    it("re-emits the note when a root disappears", async () => {
        const { tool, root } = lateLakeTool();
        mkdirSync(root, { recursive: true });
        await tool.execute({ check: true }, {} as never);

        rmSync(root, { recursive: true, force: true });
        const result = await tool.execute({ check: true }, {} as never);

        assert.match(String(result.content), /does not exist/);
        assert.equal(result.metadata?.checked, 0);
    });

    it("clears the unversioned note when the root gains git", async () => {
        const { tool, root } = lateLakeTool();
        mkdirSync(root, { recursive: true });

        const before = await tool.execute({ check: true }, {} as never);
        git(root, ["init", "-q"]);
        const after = await tool.execute({ check: true }, {} as never);

        assert.match(String(before.content), /not inside a git work tree/);
        assert.doesNotMatch(
            String(after.content),
            /not inside a git work tree/,
        );
    });

    it("keeps help in agreement with check", async () => {
        const { tool, root } = lateLakeTool();

        const before = await tool.execute({ search: "help" }, {} as never);
        mkdirSync(root, { recursive: true });
        const after = await tool.execute({ search: "help" }, {} as never);

        assert.match(String(before.content), /— missing/);
        assert.doesNotMatch(String(after.content), /— missing/);
    });
});

describe("nested lakes", () => {
    /** An outer repo lake with a writable lake nested inside. */
    function nestedTool(outerWritable = false): {
        tool: ReturnType<typeof createDocsTool>;
        innerRoot: string;
    } {
        const outerRoot = tempDir();
        const innerRoot = join(outerRoot, "inner");
        writeFileSync(
            join(outerRoot, "outer.md"),
            "---\nArea: outer\nKeywords: aurora\nSummary: Outer doc.\n---\n# Outer doc\n\n### Facts\n\n- x.\n",
        );
        writeFileSync(
            join(outerRoot, "sibling.md"),
            "---\nArea: outer\nKeywords: zephyr\nSummary: Sibling doc.\n---\n# Sibling doc\n\n### Facts\n\n- x.\n",
        );
        mkdirSync(innerRoot, { recursive: true });
        writeFileSync(
            join(innerRoot, "inner.md"),
            "---\nArea: inner\nKeywords: borealis\nSummary: Inner doc.\n---\n# Inner doc\n\n### Facts\n\n- x.\n",
        );
        const lakes = createLakes([
            {
                name: "outer",
                class: "repo",
                root: outerRoot,
                profile: "knowledge",
                writable: outerWritable,
            },
            {
                name: "inner",
                class: "repo",
                root: innerRoot,
                profile: "knowledge",
                writable: true,
            },
        ]);
        return { tool: createDocsTool({ lakes }), innerRoot };
    }

    it("attributes the inner doc to the inner lake only", async () => {
        const { tool } = nestedTool(true);

        const checked = await tool.execute({ check: true }, {} as never);
        const found = await tool.execute({ search: "inner" }, {} as never);

        const content = String(checked.content);
        assert.match(content, /outer:\nAll 2 docs comply\./);
        assert.match(content, /inner:\nAll 1 docs comply\./);
        assert.doesNotMatch(content, /outer:.*inner\.md/);
        assert.equal(checked.metadata?.checked, 3);
        assert.match(String(found.content), /^inner:inner\.md/m);
        assert.doesNotMatch(String(found.content), /outer:.*inner\.md/);
    });

    it("keeps a sibling of the nested root in the outer lake", async () => {
        const { tool } = nestedTool();

        const found = await tool.execute({ search: "zephyr" }, {} as never);

        assert.match(String(found.content), /^sibling\.md/m);
        assert.doesNotMatch(String(found.content), /inner:sibling\.md/m);
    });

    it("keeps near-twin pairing inside each lake", async () => {
        const outerRoot = tempDir();
        const innerRoot = join(outerRoot, "inner");
        const twin = (name: string): string =>
            `---\nArea: trap\nKeywords: gateway\nSummary: Trap.\n---\n# Gateway trap\n\n### Facts\n\n- ${name}.\n`;
        for (const name of ["a.md", "b.md"]) {
            writeFileSync(join(outerRoot, name), twin(name));
        }
        mkdirSync(innerRoot, { recursive: true });
        writeFileSync(join(innerRoot, "twin.md"), twin("inner"));
        const lakes = createLakes([
            {
                name: "outer",
                class: "repo",
                root: outerRoot,
                profile: "knowledge",
                writable: true,
            },
            {
                name: "inner",
                class: "repo",
                root: innerRoot,
                profile: "knowledge",
                writable: true,
            },
        ]);
        const tool = createDocsTool({ lakes });

        const result = await tool.execute({ check: true }, {} as never);
        const content = String(result.content);

        assert.match(content, /outer:\n[^]*a\.md and b\.md: near-twins/);
        assert.match(content, /inner:\nAll 1 docs comply\./);
        assert.doesNotMatch(content, /inner:\n[^]*near-twins/);
    });

    it("writes to the deepest writable lake when the outer is read-only", async () => {
        const { tool, innerRoot } = nestedTool();

        const result = await tool.execute(
            {
                add: {
                    metadata: {
                        Area: "new",
                        Keywords: ["new"],
                        Summary: "New.",
                    },
                    body: "# New\n\n### Facts\n\n- x.\n",
                },
            } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, true);
        assert.match(String(result.content), /^inner:new\/new\.md — created/);
        assert.ok(existsSync(join(innerRoot, "new", "new.md")));
    });

    it("reads a bare path from the narrowest enclosing lake", async () => {
        const outerRoot = tempDir();
        const innerRoot = join(outerRoot, "inner");
        const doc = (title: string): string =>
            `---\nArea: shared\nKeywords: shared\nSummary: ${title}.\n---\n# ${title}\n`;
        writeFileSync(join(outerRoot, "shared.md"), doc("Outer shared"));
        mkdirSync(innerRoot, { recursive: true });
        writeFileSync(join(innerRoot, "shared.md"), doc("Inner shared"));
        const lakes = createLakes([
            {
                name: "outer",
                class: "repo",
                root: outerRoot,
                profile: "knowledge",
                writable: true,
            },
            {
                name: "inner",
                class: "repo",
                root: innerRoot,
                profile: "knowledge",
                writable: true,
            },
        ]);
        const tool = createDocsTool({ lakes });

        const result = await tool.execute({ read: "shared.md" }, {} as never);

        assert.match(String(result.content), /^inner:shared\.md — Inner/);
    });

    it("keeps a symlinked inner root contained on real paths", async () => {
        const outerRoot = tempDir();
        const innerReal = join(outerRoot, "inner");
        const alias = join(tempDir(), "inner-alias");
        writeFileSync(
            join(outerRoot, "outer.md"),
            "---\nArea: outer\nKeywords: outer\nSummary: Outer.\n---\n# Outer\n\n### Facts\n\n- x.\n",
        );
        mkdirSync(innerReal, { recursive: true });
        writeFileSync(
            join(innerReal, "inner.md"),
            "---\nArea: inner\nKeywords: inner\nSummary: Inner.\n---\n# Inner\n\n### Facts\n\n- x.\n",
        );
        symlinkSync(innerReal, alias, "dir");
        const lakes = createLakes([
            {
                name: "outer",
                class: "repo",
                root: outerRoot,
                profile: "knowledge",
                writable: true,
            },
            {
                name: "inner",
                class: "repo",
                root: alias,
                profile: "knowledge",
                writable: true,
            },
        ]);
        const tool = createDocsTool({ lakes });

        const checked = await tool.execute({ check: true }, {} as never);
        const found = await tool.execute({ search: "inner" }, {} as never);

        assert.match(String(checked.content), /inner:\nAll 1 docs comply\./);
        assert.equal(checked.metadata?.checked, 2);
        assert.match(String(found.content), /^inner:inner\.md/m);
        assert.doesNotMatch(String(found.content), /^outer:inner\/inner\.md/m);
    });
});
describe("config validation", () => {
    it("rejects a non-array lakes option", () => {
        assert.throws(
            () => resolveLakes({ lakes: "nope" }, tempDir()),
            /must be an array/,
        );
    });

    it("rejects a non-string lakesFile option", () => {
        assert.throws(
            () => resolveLakes({ lakesFile: 42 }, tempDir()),
            /non-empty string path/,
        );
    });

    it("rejects malformed JSON and a missing lakes array", () => {
        const location = tempDir();
        const broken = join(tempDir(), "broken.json");
        writeFileSync(broken, "{");
        assert.throws(
            () => resolveLakes({ lakesFile: broken }, location),
            /not valid JSON/,
        );

        const wrong = join(tempDir(), "wrong.json");
        writeFileSync(wrong, JSON.stringify({ notLakes: [] }));
        assert.throws(
            () => resolveLakes({ lakesFile: wrong }, location),
            /must contain a "lakes" array/,
        );
    });

    it("rejects a non-object lake entry", () => {
        assert.throws(
            () => resolveLakes({ lakes: [42] }, tempDir()),
            /must be an object/,
        );
    });

    it("rejects an unknown class", () => {
        assert.throws(
            () => resolveLakes({ lakes: [{ class: "team" }] }, tempDir()),
            /lake class must be one of/,
        );
    });

    it("rejects a non-repo lake with no root", () => {
        assert.throws(
            () => resolveLakes({ lakes: [{ class: "machine" }] }, tempDir()),
            /needs a root path/,
        );
    });

    it("rejects a non-string root", () => {
        assert.throws(
            () => resolveLakes({ lakes: [{ root: 42 }] }, tempDir()),
            /root must be a string/,
        );
    });

    it("rejects an unsafe name", () => {
        assert.throws(
            () =>
                resolveLakes(
                    { lakes: [{ root: tempDir(), name: "Bad Name" }] },
                    tempDir(),
                ),
            /lake name must match/,
        );
    });

    it("rejects a non-boolean writable", () => {
        assert.throws(
            () =>
                resolveLakes(
                    { lakes: [{ root: tempDir(), writable: "yes" }] },
                    tempDir(),
                ),
            /writable must be a boolean/,
        );
    });
});

describe("tool lake filters", () => {
    /** A tool with a repo lake, a wiki lake and a README entry. */
    function filteredTool(): ReturnType<typeof createDocsTool> {
        const repoRoot = tempDir();
        const wikiRoot = tempDir();
        writeFileSync(
            join(repoRoot, "trap.md"),
            "---\nArea: trap\nKeywords: gateway\nSummary: Trap.\n---\n" +
                "# Trap\n\n### Facts\n\n- x.\n",
        );
        writeFileSync(
            join(wikiRoot, "page.md"),
            "# Page\n\nA wiki page about gateways.\n",
        );
        const lakes = createLakes([
            {
                name: "repo",
                class: "repo",
                root: repoRoot,
                profile: "knowledge",
                writable: true,
            },
            {
                name: "wiki",
                class: "wiki",
                root: wikiRoot,
                profile: "wiki",
                writable: false,
            },
        ]);
        const readme = entry({
            path: "packages/api/README.md",
            lake: "",
            class: "instructions",
            title: "Widget",
            summary: "A README.",
            keywords: ["widget"],
        });
        return createDocsTool({
            lakes,
            search: () => [...lakes.flatMap((lake) => lake.collect()), readme],
        });
    }

    it("filters search by lake and by the instructions source", async () => {
        const tool = filteredTool();

        const wiki = await tool.execute(
            { search: "gateway", lake: "wiki" },
            {} as never,
        );
        const readme = await tool.execute(
            { search: "widget", lake: "instructions" },
            {} as never,
        );
        const missing = await tool.execute(
            { search: "gateway", lake: "nope" },
            {} as never,
        );

        assert.match(String(wiki.content), /^wiki:page\.md/m);
        assert.match(
            String(readme.content),
            /instructions:packages\/api\/README\.md/,
        );
        assert.match(String(missing.content), /No lake named 'nope'/);
    });

    it("refuses check and read for an unknown or wiki lake", async () => {
        const tool = filteredTool();

        const missingCheck = await tool.execute(
            { check: true, lake: "nope" },
            {} as never,
        );
        const wikiCheck = await tool.execute(
            { check: true, lake: "wiki" },
            {} as never,
        );
        const repoCheck = await tool.execute(
            { check: true, lake: "repo" },
            {} as never,
        );
        const missingRead = await tool.execute(
            { read: "trap.md", lake: "nope" },
            {} as never,
        );

        assert.match(String(missingCheck.content), /lake named 'nope'/i);
        assert.match(
            String(wikiCheck.content),
            /^wiki: wiki class, read-only, not validated\.$/m,
        );
        assert.match(String(repoCheck.content), /All 1 docs comply/);
        assert.match(String(missingRead.content), /lake named 'nope'/i);

        const readmeRead = await tool.execute(
            { read: "instructions:packages/api/README.md" },
            {} as never,
        );
        assert.match(String(readmeRead.content), /built-in read tool/);
    });

    it("reports a missing doc in an explicitly selected lake", async () => {
        const tool = filteredTool();

        const result = await tool.execute(
            { read: "repo:missing.md" },
            {} as never,
        );

        assert.match(String(result.content), /No doc at repo:missing\.md\./);
    });

    it("refuses add when every knowledge lake is read-only", async () => {
        const root = tempDir();
        const wikiRoot = tempDir();
        const lakes = createLakes([
            {
                name: "repo",
                class: "repo",
                root,
                profile: "knowledge",
                writable: false,
            },
            {
                name: "wiki",
                class: "wiki",
                root: wikiRoot,
                profile: "wiki",
                writable: false,
            },
        ]);
        const tool = createDocsTool({ lakes });

        const result = await tool.execute(
            {
                add: {
                    metadata: {
                        Area: "aa",
                        Keywords: ["alpha"],
                        Summary: "S.",
                    },
                    body: "# T\n\n### Facts\n\n- x.\n",
                },
            } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /no writable knowledge lake/);
    });

    it("reads a unique bare path and a lake-prefixed path", async () => {
        const tool = filteredTool();

        const unique = await tool.execute({ read: "trap.md" }, {} as never);
        const prefixed = await tool.execute(
            { read: "wiki:page.md" },
            {} as never,
        );

        assert.match(String(unique.content), /^repo:trap\.md — Trap/);
        assert.match(String(prefixed.content), /^wiki:page\.md — Page/);
    });
});

describe("summary and target edges", () => {
    it("returns no summary without an H1", () => {
        assert.equal(summaryOf("Just prose.\n"), "");
    });

    it("drops fenced blocks and list blocks from the summary", () => {
        const body =
            "# Page\n\n```\nignored\n```\n\n- [A](a.md)\n- [B](b.md)\n\n" +
            "The real summary.\n";

        assert.equal(summaryOf(body), "The real summary.");
    });

    it("keeps an inline link's text and drops its URL from the summary", () => {
        // Arrange – a wiki page whose first prose paragraph carries a link.
        const body = "# Page\n\nSee [the guide](guide.md).\n";

        // Act
        const summary = summaryOf(body);

        // Assert – the visible text stays, the destination goes.
        assert.equal(summary, "See the guide.");
    });

    it("gathers inline and reference link targets outside fences", () => {
        const body =
            "```\n[inside](inside.md)\n```\n" +
            "[inline](inline.md)\n[ref]: ref.md\n";

        assert.deepEqual(
            markdownTargets(body).filter((target) => target.endsWith(".md")),
            ["inline.md", "ref.md"],
        );
    });

    it("refuses a target with no stem and a trailing slash", () => {
        for (const path of [".md", "aa/"]) {
            const outcome = prepareAdd(
                {
                    metadata: {
                        Area: "aa",
                        Keywords: ["alpha"],
                        Summary: "S.",
                    },
                    body: "# T\n\n### Facts\n\n- x.\n",
                    path,
                },
                [],
            );
            assert.equal(outcome.action, "refuse", path);
        }
    });
});

describe("dates and collection edges", () => {
    it('falls back to mtime for an untracked file and "" for a missing one', () => {
        const root = tempDir();
        writeFileSync(join(root, "a.md"), "# A\n");

        const dates = fallbackDates(root, ["a.md", "missing.md"]);

        assert.match(dates.get("a.md") ?? "", /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(dates.get("missing.md"), "");
    });

    it("keeps a git date instead of the file mtime", () => {
        const root = tempDir();
        writeFileSync(join(root, "a.md"), "# A\n");
        git(root, ["init", "-q"]);
        git(root, ["add", "a.md"]);
        git(root, ["commit", "-qm", "add a"]);

        const dates = fallbackDates(root, ["a.md"]);

        assert.match(dates.get("a.md") ?? "", /^\d{4}-\d{2}-\d{2}$/);
    });

    it("returns nothing when the root is a file", () => {
        const file = join(tempDir(), "not-a-dir.md");
        writeFileSync(file, "# A\n");

        assert.deepEqual(collectDocPaths(file), []);
    });

    it("skips a symlinked directory and a non-Markdown file", () => {
        const root = tempDir();
        const outside = tempDir();
        writeFileSync(join(outside, "a.md"), "# A\n");
        symlinkSync(outside, join(root, "linked"), "dir");
        writeFileSync(join(root, "notes.txt"), "not a doc\n");
        writeFileSync(join(root, "real.md"), "# Real\n");

        assert.deepEqual(collectDocPaths(root), ["real.md"]);
    });

    it("treats a non-text tool result as a search miss", () => {
        const line = missNudgeFor(
            {
                tool: "grep",
                status: "completed",
                content: { unexpected: true },
                input: {},
            },
            false,
        );

        assert.match(String(line), /knowledge lakes/);
    });
});
