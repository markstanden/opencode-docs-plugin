import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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

    it("keeps those folders in a wiki lake", () => {
        const root = tempDir();
        for (const dir of ["requirements", "wiki", ".git"]) {
            mkdirSync(join(root, dir), { recursive: true });
            writeFileSync(join(root, dir, "a.md"), "# A\n");
        }

        assert.deepEqual(collectDocPaths(root, { profile: "wiki" }), [
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
        assert.match(String(result.content), /wiki lakes are read-only/);
        assert.equal(result.metadata?.checked, 1);
    });

    it("lists the configured lakes in help", async () => {
        const tool = toolOf();

        const result = await tool.execute({ search: "help" }, {} as never);

        assert.match(
            String(result.content),
            /repo \(repo, writable, checked\)/,
        );
        assert.match(
            String(result.content),
            /wiki \(wiki, read-only, not checked\)/,
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
        assert.match(String(wikiCheck.content), /read-only reference/);
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
