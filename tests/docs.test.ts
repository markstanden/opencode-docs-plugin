import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as docs from "../src/index.ts";

/**
 * The plugin under test, run under Node's type-stripping exactly as OpenCode
 * loads it.
 */
const {
    checkDocs,
    collectDocs,
    createDocsCommand,
    createDocsTool,
    explainRanking,
    fallbackDates,
    FIELD_WEIGHTS,
    FRONT_MATTER_FIELDS,
    gitDates,
    matches,
    MAX_RESULTS,
    MIN_TERM_LENGTH,
    nearTwins,
    parseFrontMatter,
    prepareAdd,
    QUALITY,
    rankDocs,
    render,
    reconcileQuery,
    resolveRequest,
    resolveRoot,
    score,
    serializeDoc,
    slugify,
    titleOf,
    toEntry,
    unversionedNote,
    validateDoc,
} = docs;

/** The doc entry shape, recovered from the plugin's `toEntry`. */
type DocEntry = ReturnType<(typeof docs)["toEntry"]>;

/** A doc entry with sensible defaults, overridable per test. */
function entry(overrides: Partial<DocEntry> = {}): DocEntry {
    return {
        path: "decisions/x.md",
        area: "decisions",
        date: "2026-01-02",
        title: "X",
        summary: "A summary",
        superseded: false,
        keywords: [],
        identifiers: [],
        ...overrides,
    };
}

const cleanups: string[] = [];

/** A docs tool over fixed entries, with a throwaway in-memory write seam. */
function toolOf(entries: DocEntry[]): ReturnType<typeof createDocsTool> {
    return createDocsTool({
        collect: () => entries,
        exists: () => false,
        write: () => {},
        read: () => "",
    });
}

/** A fresh scratch directory, removed after the suite. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "docs-plugin-"));
    cleanups.push(dir);
    return dir;
}

after(() => {
    for (const dir of cleanups) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** Run git with an isolated identity so the fixture is deterministic. */
function git(
    cwd: string,
    args: string[],
    env: Record<string, string> = {},
): void {
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
            ...env,
        },
    });
}

describe("default export", () => {
    it("registers the plugin as id docs with a setup function", () => {
        // Assert
        assert.equal(docs.default.id, "docs");
        assert.equal(typeof docs.default.setup, "function");
    });
});

describe("parseFrontMatter", () => {
    it("splits flat front-matter from the body", () => {
        const { meta, body } = parseFrontMatter(
            "---\nArea: decisions\nSummary: A doc\n---\n# Title\n\nBody.\n",
        );

        assert.equal(meta.Area, "decisions");
        assert.equal(meta.Summary, "A doc");
        assert.equal(body, "# Title\n\nBody.\n");
    });

    it("returns the whole file when there is no front-matter", () => {
        const { meta, body } = parseFrontMatter("# Title\n");

        assert.deepEqual(meta, {});
        assert.equal(body, "# Title\n");
    });

    it("returns the whole file when front-matter is unterminated", () => {
        const raw = "---\nArea: decisions\n";
        const { meta, body } = parseFrontMatter(raw);

        assert.deepEqual(meta, {});
        assert.equal(body, raw);
    });
});

describe("titleOf", () => {
    it("uses the first heading", () => {
        assert.equal(
            titleOf("a.md", "# Real Title\n\n# Later\n"),
            "Real Title",
        );
    });

    it("falls back to the file name", () => {
        assert.equal(titleOf("deep/a-doc.md", "no heading\n"), "a-doc");
    });
});

describe("toEntry", () => {
    it("prefers front-matter fields and splits keywords", () => {
        const result = toEntry(
            "decisions/a.md",
            "---\nArea: runtime\nSummary: S\nKeywords: one, two ,\n---\n# T\n",
            "2026-01-01",
        );

        assert.deepEqual(result, {
            path: "decisions/a.md",
            area: "runtime",
            date: "2026-01-01",
            title: "T",
            summary: "S",
            superseded: false,
            keywords: ["one", "two"],
            identifiers: [],
        });
    });

    it("ignores a hand-maintained front-matter Date", () => {
        const result = toEntry(
            "runtime/a.md",
            "---\nDate: 2020-01-01\nSummary: S\n---\n# T\n",
            "2026-07-01",
        );

        assert.equal(result.date, "2026-07-01");
    });

    it("infers the area from the path and uses the fallback date", () => {
        const result = toEntry("runtime/a.md", "# T\n", "2026-01-01");

        assert.equal(result.area, "runtime");
        assert.equal(result.date, "2026-01-01");
        assert.equal(result.summary, "");
    });

    it("leaves the area blank for a doc directly under the root", () => {
        assert.equal(toEntry("README.md", "# T\n", "").area, "");
    });

    it("marks a superseded doc from its front-matter Status", () => {
        const result = toEntry(
            "aa/a.md",
            "---\nStatus: superseded\nSummary: S\n---\n# T\n",
            "2026-01-01",
        );

        assert.equal(result.superseded, true);
    });

    it("treats a missing or active Status as not superseded", () => {
        const missing = toEntry("aa/a.md", "# T\n", "");
        const active = toEntry(
            "aa/a.md",
            "---\nStatus: active\n---\n# T\n",
            "",
        );

        assert.equal(missing.superseded, false);
        assert.equal(active.superseded, false);
    });
});

describe("identifiers", () => {
    /** An entry built from a doc whose body is `body`. */
    function fromBody(body: string): DocEntry {
        return toEntry(
            "aa/a.md",
            `---\nArea: aa\nSummary: words\n---\n${body}`,
            "2026-01-01",
        );
    }

    const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
        ["an H2 heading", "# T\n\n## kqx7 section\n", ["kqx7 section"]],
        ["an H3 heading", "# T\n\n### kqx7 sub\n", ["kqx7 sub"]],
        ["an inline code span", "# T\n\nUse `kqx7` here.\n", ["kqx7"]],
        [
            "several spans, de-duplicated",
            "# T\n\n`one` and `two` and `one`\n",
            ["one", "two"],
        ],
        ["a heading's trailing hashes", "# T\n\n## kqx7 ##\n", ["kqx7"]],
        ["no body", "# T\n", []],
        ["a fenced block", "# T\n\n```\nkqx7\n```\n", []],
        ["body prose", "# T\n\nkqx7 in prose\n", []],
    ];

    for (const [name, body, expected] of cases) {
        it(`extracts ${name}`, () => {
            assert.deepEqual(fromBody(body).identifiers, expected);
        });
    }

    it("does not repeat the H1 as an identifier", () => {
        assert.deepEqual(fromBody("# kqx7 here\n\nprose\n").identifiers, []);
    });

    it("qualifies a term found only as an inline code span", () => {
        const result = rankDocs(
            [fromBody("# T\n\nUse `kqx7` here.\n")],
            "kqx7",
        );

        assert.equal(result.closest, false);
        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["aa/a.md"],
        );
    });

    it("finds a term that appears only in a heading", () => {
        const result = rankDocs([fromBody("# T\n\n## kqx7 section\n")], "kqx7");

        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["aa/a.md"],
        );
    });

    it("matches an identifier case-insensitively", () => {
        const result = rankDocs(
            [fromBody("# T\n\nUse `KQX7` here.\n")],
            "kqx7",
        );

        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["aa/a.md"],
        );
    });

    it("full-matches a query split across a keyword and an identifier", () => {
        const doc = toEntry(
            "aa/a.md",
            "---\nArea: aa\nSummary: words\nKeywords: alpha\n---\n# T\n\nUse `beta`.\n",
            "2026-01-01",
        );

        const result = rankDocs([doc], "alpha beta");

        assert.equal(result.closest, false);
        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["aa/a.md"],
        );
    });

    it("finds a term that only a code span carries", () => {
        const doc = toEntry(
            "README.md",
            "---\nArea: root\nSummary: The project brief.\n---\n# Project brief\n\n## Traps\n\n- `erasableSyntaxOnly` catches it.\n",
            "2026-10-10",
        );

        const result = rankDocs([doc], "erasableSyntaxOnly");

        assert.equal(result.closest, false);
        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["README.md"],
        );
    });
});

describe("minimum term length", () => {
    const below = "z".repeat(MIN_TERM_LENGTH - 1);
    const atFloor = "w".repeat(MIN_TERM_LENGTH);

    it("ignores a term below the floor when a longer term is present", () => {
        const docs = [
            entry({ path: "below.md", title: below }),
            entry({ path: "long.md", title: "kqx7" }),
        ];

        const result = rankDocs(docs, `${below} kqx7 zzz9`);

        assert.equal(result.closest, true);
        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["long.md"],
        );
    });

    it("keeps a term exactly at the floor", () => {
        const result = rankDocs(
            [entry({ path: "at.md", title: atFloor })],
            `${atFloor} zzz9`,
        );

        assert.equal(result.closest, true);
        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["at.md"],
        );
    });

    it("still searches when every term is below the floor", () => {
        const result = rankDocs(
            [entry({ path: "below.md", title: below })],
            below,
        );

        assert.equal(result.closest, false);
        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["below.md"],
        );
    });
});

describe("matches", () => {
    it("matches everything on a blank query", () => {
        assert.equal(matches(entry(), "   "), true);
    });

    it("matches a keyword case-insensitively", () => {
        assert.equal(matches(entry({ keywords: ["Serena"] }), "serena"), true);
    });

    it("misses an unrelated query", () => {
        assert.equal(matches(entry({ summary: "about docs" }), "zebra"), false);
    });

    it("requires every term of a multi-word query", () => {
        const doc = entry({
            keywords: ["serena"],
            summary: "A memory of tools",
        });

        assert.equal(matches(doc, "serena memory"), true);
        assert.equal(matches(doc, "serena missing"), false);
    });

    it("collapses repeated whitespace in the query", () => {
        assert.equal(
            matches(entry({ keywords: ["serena"] }), "  serena  "),
            true,
        );
    });
});

describe("render", () => {
    it("reports when nothing matched", () => {
        assert.equal(render([]), "No knowledge docs matched.");
    });

    it("formats the path, area, date and summary", () => {
        const text = render([
            entry({
                path: "a.md",
                area: "a",
                date: "2026-02-02",
                summary: "S",
            }),
        ]);

        assert.equal(text, "a.md — a — 2026-02-02\n  S");
    });

    it("omits empty area and date", () => {
        assert.equal(
            render([entry({ path: "a.md", area: "", date: "", summary: "" })]),
            "a.md",
        );
    });

    it("labels a closest-match fallback", () => {
        const text = render(
            [entry({ path: "a.md", area: "", date: "", summary: "" })],
            { closest: true },
        );

        assert.match(text, /Closest matches/);
        assert.match(text, /\ba\.md/);
    });
});

describe("superseded docs", () => {
    it("ranks the active doc above a superseded one at equal score", () => {
        const retired = entry({
            path: "b.md",
            title: "Serena",
            superseded: true,
        });
        const active = entry({ path: "a.md", title: "Serena" });

        const { entries } = rankDocs([retired, active], "serena");

        assert.deepEqual(
            entries.map((doc) => doc.path),
            ["a.md", "b.md"],
        );
    });

    it("keeps the active doc above a same-date superseded one in the catalogue", () => {
        const retired = entry({
            path: "b.md",
            date: "2026-02-02",
            superseded: true,
        });
        const active = entry({ path: "a.md", date: "2026-02-02" });

        const { entries } = rankDocs([retired, active], "");

        assert.deepEqual(
            entries.map((doc) => doc.path),
            ["a.md", "b.md"],
        );
    });

    it("marks a superseded doc in the rendered line", () => {
        const text = render([
            entry({
                path: "a.md",
                area: "aa",
                date: "2026-01-01",
                superseded: true,
            }),
        ]);

        assert.match(text, /— \(superseded\)/);
    });

    it("flags a Supersedes that names no doc", () => {
        const raw =
            "---\nArea: aa\nKeywords: alpha\nSummary: S.\n" +
            "Supersedes: aa/gone.md\n---\n# Alpha doc\n\n### Facts\n\n- x.\n";
        const entries = [entry({ path: "aa/a.md", title: "Alpha doc" })];

        const report = checkDocs(entries, () => raw);

        assert.match(report, /Supersedes names no doc: aa\/gone\.md/);
    });

    it("accepts a Supersedes that names a doc in the tree", () => {
        const parts = (title: string, supersedes?: string): string =>
            "---\nArea: aa\nKeywords: alpha\nSummary: S.\n" +
            (supersedes === undefined ? "" : `Supersedes: ${supersedes}\n`) +
            `---\n# ${title}\n\n### Facts\n\n- x.\n`;
        const raws: Record<string, string> = {
            "aa/a.md": parts("Alpha doc", "aa/b.md"),
            "aa/b.md": parts("Beta doc"),
        };
        const entries = [
            entry({ path: "aa/a.md", title: "Alpha doc" }),
            entry({ path: "aa/b.md", title: "Beta doc" }),
        ];

        const report = checkDocs(entries, (path) => raws[path] ?? "");

        assert.doesNotMatch(report, /Supersedes names no doc/);
    });
});

describe("collectDocs", () => {
    it("skips scratch and mirrors, orders by path, and uses the injected date", () => {
        const root = tempDir();
        mkdirSync(join(root, "decisions"), { recursive: true });
        mkdirSync(join(root, "plans"), { recursive: true });
        mkdirSync(join(root, "requirements"), { recursive: true });
        writeFileSync(
            join(root, "decisions", "a.md"),
            "---\nArea: decisions\nSummary: A doc\nKeywords: one, two\n---\n# A\n",
        );
        writeFileSync(join(root, "plans", "p.md"), "# Plan\n");
        writeFileSync(join(root, "requirements", "r.md"), "# Mirror\n");

        const entries = collectDocs(
            root,
            (paths) => new Map(paths.map((path) => [path, "2026-01-01"])),
        );

        assert.deepEqual(
            entries.map((item) => item.path),
            ["decisions/a.md"],
        );
        const first = entries[0];
        assert.ok(first);
        assert.equal(first.area, "decisions");
        assert.equal(first.summary, "A doc");
        assert.deepEqual(first.keywords, ["one", "two"]);
        assert.equal(first.date, "2026-01-01");
        assert.equal(first.title, "A");
    });

    it("returns nothing when the root is absent", () => {
        assert.deepEqual(
            collectDocs(tempDir(), () => new Map()),
            [],
        );
    });
});

describe("dates", () => {
    it("reads each path's newest commit date from git", () => {
        const root = tempDir();
        writeFileSync(join(root, "a.md"), "# A\n");
        git(root, ["init", "-q"]);
        git(root, ["add", "a.md"]);
        git(root, ["commit", "-qm", "add a"]);

        const dates = gitDates(root, ["a.md"]);
        assert.match(dates.get("a.md") ?? "", /^\d{4}-\d{2}-\d{2}$/);
    });
});

describe("batched dates", () => {
    it("resolves every date in one call over all doc paths", () => {
        // Arrange – two docs on disk, a resolver that records its calls.
        const root = tempDir();
        writeFileSync(join(root, "a.md"), "# A\n");
        writeFileSync(join(root, "b.md"), "# B\n");
        const calls: string[][] = [];

        // Act
        const docs = collectDocs(root, (paths) => {
            calls.push([...paths]);
            return new Map(paths.map((path) => [path, "2026-05-05"]));
        });

        // Assert – one batched call, every doc dated from it.
        assert.equal(calls.length, 1);
        assert.deepEqual(
            docs.map((doc) => doc.date),
            ["2026-05-05", "2026-05-05"],
        );
    });

    it("maps each path to its newest commit date in one pass", () => {
        // Arrange – a.md committed twice, b.md once, dates pinned by env.
        const root = tempDir();
        git(root, ["init", "-q"]);
        writeFileSync(join(root, "a.md"), "# A\n");
        git(root, ["add", "a.md"]);
        git(root, ["commit", "-qm", "one"], {
            GIT_AUTHOR_DATE: "2026-01-01T09:00:00",
            GIT_COMMITTER_DATE: "2026-01-01T09:00:00",
        });
        writeFileSync(join(root, "b.md"), "# B\n");
        git(root, ["add", "b.md"]);
        git(root, ["commit", "-qm", "two"], {
            GIT_AUTHOR_DATE: "2026-02-02T09:00:00",
            GIT_COMMITTER_DATE: "2026-02-02T09:00:00",
        });
        writeFileSync(join(root, "a.md"), "# A again\n");
        git(root, ["add", "a.md"]);
        git(root, ["commit", "-qm", "three"], {
            GIT_AUTHOR_DATE: "2026-03-03T09:00:00",
            GIT_COMMITTER_DATE: "2026-03-03T09:00:00",
        });

        // Act
        const dates = gitDates(root, ["a.md", "b.md"]);

        // Assert – newest wins per path.
        assert.equal(dates.get("a.md"), "2026-03-03");
        assert.equal(dates.get("b.md"), "2026-02-02");
    });

    it("falls back to mtimes outside a git repo", () => {
        // Arrange – a plain directory, no repo, one loose file.
        const root = tempDir();
        writeFileSync(join(root, "loose.md"), "# Loose\n");

        // Act
        const dates = fallbackDates(root, ["loose.md"]);

        // Assert – an ISO date, not a throw.
        assert.match(dates.get("loose.md") ?? "", /^\d{4}-\d{2}-\d{2}$/);
    });
});

describe("resolveRoot", () => {
    const location = join(tempDir(), "wherever");

    it("defaults to the location's docs directory", () => {
        assert.equal(resolveRoot(undefined, location), join(location, "docs"));
    });

    it("expands ~ and ~/… against the home directory", () => {
        assert.equal(resolveRoot("~", location), homedir());
        assert.equal(
            resolveRoot("~/notes/lake", location),
            join(homedir(), "notes/lake"),
        );
    });

    it("passes an absolute path through unchanged", () => {
        assert.equal(resolveRoot("/srv/knowledge", location), "/srv/knowledge");
    });

    it("resolves a relative path against the location", () => {
        assert.equal(
            resolveRoot("knowledge", location),
            join(location, "knowledge"),
        );
    });

    it("throws on a blank or non-string root", () => {
        for (const bad of ["   ", "", 42, {}, true]) {
            assert.throws(
                () => resolveRoot(bad, location),
                /root/,
                String(bad),
            );
        }
    });
});

describe("unversionedNote", () => {
    it("notes a root outside any git work tree", () => {
        const [note] = unversionedNote(tempDir());

        assert.match(note ?? "", /not inside a git work tree/);
    });

    it("stays quiet for a version-controlled root", () => {
        const root = tempDir();
        git(root, ["init", "-q"]);

        assert.deepEqual(unversionedNote(root), []);
    });
});

describe("score", () => {
    it("weights a title hit above a path, keyword, area or summary hit", () => {
        const term = ["serena"];
        const hit = "about serena";
        const title = score(entry({ title: hit }), term);
        const path = score(entry({ path: `${hit}.md` }), term);
        const keyword = score(entry({ keywords: [hit] }), term);
        const identifiers = score(entry({ identifiers: [hit] }), term);
        const area = score(entry({ area: hit }), term);
        const summary = score(entry({ summary: hit }), term);

        assert.ok(title > path);
        assert.ok(path > keyword);
        assert.ok(keyword > identifiers);
        assert.ok(identifiers > area);
        assert.ok(area > summary);
        assert.ok(summary > 0);
    });

    it("scores an exact hit above a prefix above a substring", () => {
        const term = ["serena"];
        const exact = score(entry({ title: "serena" }), term);
        const prefix = score(entry({ title: "serena docs" }), term);
        const substring = score(entry({ title: "about serena" }), term);

        assert.ok(exact > prefix);
        assert.ok(prefix > substring);
        assert.ok(substring > 0);
    });

    it("scores zero when a term is only a subsequence of a field", () => {
        assert.equal(score(entry({ title: "serena" }), ["srn"]), 0);
    });

    it("counts a term once, at its best field", () => {
        const doc = entry({ title: "kqx7", summary: "kqx7 too" });

        assert.equal(score(doc, ["kqx7"]), 24);
    });

    it("sums the best hit per term", () => {
        const doc = entry({ title: "alpha", summary: "beta" });

        assert.equal(score(doc, ["alpha", "beta"]), 28);
        assert.equal(score(doc, ["alpha"]), 24);
    });

    it("is zero when a term misses everywhere", () => {
        assert.equal(
            score(entry({ title: "X", summary: "docs" }), ["zebra"]),
            0,
        );
    });
});

describe("rankDocs", () => {
    const entries = [
        entry({ path: "a.md", keywords: ["serena"] }),
        entry({ path: "b.md" }),
    ];

    it("returns the catalogue unchanged for a blank query", () => {
        const result = rankDocs(entries, "   ");

        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["a.md", "b.md"],
        );
        assert.equal(result.closest, false);
    });

    it("ranks full matches by field weight", () => {
        const docs = [
            entry({
                path: "summary.md",
                title: "Z",
                summary: "serena notes",
            }),
            entry({ path: "title.md", title: "Serena", summary: "x" }),
        ];

        const result = rankDocs(docs, "serena");

        assert.equal(result.closest, false);
        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["title.md", "summary.md"],
        );
    });

    it("falls back to the closest matches when no doc has every term", () => {
        const docs = [
            entry({ path: "a.md", title: "Serena", summary: "" }),
            entry({
                path: "b.md",
                title: "Other",
                summary: "missing bits",
            }),
        ];

        const result = rankDocs(docs, "serena missing");

        assert.equal(result.closest, true);
        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["a.md", "b.md"],
        );
    });

    it("breaks ties on the path", () => {
        const docs = [
            entry({ path: "b.md", keywords: ["serena"] }),
            entry({ path: "a.md", keywords: ["serena"] }),
        ];

        assert.deepEqual(
            rankDocs(docs, "serena").entries.map((item) => item.path),
            ["a.md", "b.md"],
        );
    });

    it("does not qualify a doc whose only hit is a subsequence", () => {
        const docs = [
            entry({
                path: "sub.md",
                title: "Z",
                summary: "some quiet brown fox",
            }),
        ];

        const result = rankDocs(docs, "qbf zzz9");

        assert.deepEqual(result.entries, []);
        assert.equal(result.closest, false);
    });

    it("reports an honest no-match for a typo only a subsequence would catch", () => {
        const docs = [entry({ path: "serena.md", title: "Serena MCP" })];

        const result = rankDocs(docs, "srena");

        assert.deepEqual(result.entries, []);
        assert.equal(result.closest, false);
        assert.equal(render(result.entries), "No knowledge docs matched.");
    });

    it("returns only the substring-qualified docs from the fallback", () => {
        const docs = [
            entry({
                path: "sub.md",
                title: "Z",
                summary: "some quiet brown fox",
            }),
            entry({ path: "hit.md", title: "qbf notes", area: "aa" }),
        ];

        const result = rankDocs(docs, "qbf zzz9");

        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["hit.md"],
        );
        assert.equal(result.closest, true);
    });

    it("qualifies a substring hit in any single field", () => {
        const clean = { area: "aa", title: "T", summary: "words" };
        const cases = [
            [
                "title",
                entry({ ...clean, path: "z.md", title: "uses kqx7 here" }),
            ],
            ["path", entry({ ...clean, path: "kqx7-file.md" })],
            ["keywords", entry({ ...clean, path: "z.md", keywords: ["kqx7"] })],
            ["area", entry({ ...clean, path: "z.md", area: "kqx7" })],
            [
                "summary",
                entry({
                    ...clean,
                    path: "z.md",
                    summary: "mentions kqx7 once",
                }),
            ],
        ] as const;

        for (const [field, doc] of cases) {
            const result = rankDocs(
                [doc, entry({ ...clean, path: "decoy.md" })],
                "kqx7 zzz9",
            );

            assert.deepEqual(
                result.entries.map((item) => item.path),
                [doc.path],
                `field: ${field}`,
            );
            assert.equal(result.closest, true, `field: ${field}`);
        }
    });

    it("splits a multi-term query across docs, ranked", () => {
        const docs = [
            entry({ path: "b.md", title: "Z", summary: "beta notes" }),
            entry({ path: "a.md", title: "alpha", summary: "words" }),
        ];

        const result = rankDocs(docs, "alpha beta");

        assert.equal(result.closest, true);
        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["a.md", "b.md"],
        );
    });

    it("treats query case as irrelevant", () => {
        const docs = [entry({ path: "a.md", title: "Serena" })];

        const result = rankDocs(docs, "SERENA");

        assert.equal(result.closest, false);
        assert.deepEqual(
            result.entries.map((item) => item.path),
            ["a.md"],
        );
    });

    it("returns nothing, with no fallback, for a genuine miss", () => {
        const result = rankDocs(
            [entry({ title: "X", summary: "docs" })],
            "zebra",
        );

        assert.deepEqual(result.entries, []);
        assert.equal(result.closest, false);
    });
});

describe("ranking knobs", () => {
    it("orders field weights most significant first", () => {
        // Assert – the order is the contract; exact values stay tunable.
        assert.ok(FIELD_WEIGHTS.title > FIELD_WEIGHTS.path);
        assert.ok(FIELD_WEIGHTS.path > FIELD_WEIGHTS.keywords);
        assert.ok(FIELD_WEIGHTS.keywords > FIELD_WEIGHTS.identifiers);
        assert.ok(FIELD_WEIGHTS.identifiers > FIELD_WEIGHTS.area);
        assert.ok(FIELD_WEIGHTS.area > FIELD_WEIGHTS.summary);
    });

    it("orders hit qualities exact above prefix above substring", () => {
        // Assert
        assert.ok(QUALITY.exact > QUALITY.prefix);
        assert.ok(QUALITY.prefix > QUALITY.substring);
        assert.ok(QUALITY.substring > QUALITY.miss);
    });

    it("multiplies weight by quality, so an exact keyword beats a substring title", () => {
        // Arrange – keyword 4×4=16 against title 6×2=12.
        const exactKeyword = entry({
            keywords: ["serena"],
            title: "X",
            summary: "",
        });
        const substringTitle = entry({
            title: "about serena",
            keywords: [],
            summary: "",
        });

        // Act
        const keywordScore = score(exactKeyword, ["serena"]);
        const titleScore = score(substringTitle, ["serena"]);

        // Assert – quality can outrank field weight.
        assert.ok(keywordScore > titleScore);
    });

    it("states the cap from MAX_RESULTS in the tool and command descriptions", () => {
        const tool = createDocsTool({
            collect: () => [],
            exists: () => false,
            write: () => {},
            read: () => "",
        });
        const command = createDocsCommand({
            collect: () => [],
            read: () => "",
            prompt: async () => {},
        });

        assert.ok(tool.description.includes(String(MAX_RESULTS)));
        assert.ok(String(command.description).includes(String(MAX_RESULTS)));
    });
});

describe("result cap", () => {
    it("caps a closest-match fallback at MAX_RESULTS and reports the rest", async () => {
        // Arrange – two docs too many, all partial matches.
        const docs = Array.from({ length: MAX_RESULTS + 2 }, (_, i) =>
            entry({ path: `n${i}.md`, summary: "serena note" }),
        );

        // Act
        const result = rankDocs(docs, "serena zzz9");

        // Assert
        assert.equal(result.closest, true);
        assert.equal(result.entries.length, MAX_RESULTS);
        assert.equal(result.omitted, 2);
    });

    it("keeps the best scorers even when the cut docs are the newest", async () => {
        // Arrange – a full cap of strong old docs, two weak brand-new ones.
        const strong = Array.from({ length: MAX_RESULTS }, (_, i) =>
            entry({
                path: `s${i}.md`,
                date: "2026-01-01",
                title: "Serena",
            }),
        );
        const weak = Array.from({ length: 2 }, (_, i) =>
            entry({
                path: `w${i}.md`,
                date: "2026-09-09",
                summary: "serena note",
            }),
        );

        // Act
        const result = rankDocs([...strong, ...weak], "serena zzz9");

        // Assert – the cut is by score, not recency.
        assert.equal(result.entries.length, MAX_RESULTS);
        assert.ok(result.entries.every((doc) => doc.title === "Serena"));
        assert.equal(result.omitted, 2);
    });

    it("breaks score ties most-recent-first", () => {
        // Arrange – equal scores; the older doc also sorts first by path.
        const docs = [
            entry({
                path: "a.md",
                date: "2026-01-01",
                summary: "serena note",
            }),
            entry({
                path: "z.md",
                date: "2026-03-03",
                summary: "serena note",
            }),
        ];

        // Act
        const { entries } = rankDocs(docs, "serena zzz9");

        // Assert – newer edit first.
        assert.deepEqual(
            entries.map((doc) => doc.path),
            ["z.md", "a.md"],
        );
    });

    it("caps the blank catalogue to the most recently changed", async () => {
        // Arrange – more docs than the cap; the oldest two must be the cut.
        const docs = Array.from({ length: MAX_RESULTS }, (_, i) =>
            entry({ path: `new${i}.md`, date: "2026-06-01" }),
        );
        docs.push(
            entry({ path: "old0.md", date: "2026-01-01" }),
            entry({ path: "old1.md", date: "2026-02-02" }),
        );

        // Act
        const result = rankDocs(docs, "");

        // Assert – the newest survive; the count reports the rest.
        assert.equal(result.closest, false);
        assert.equal(result.entries.length, MAX_RESULTS);
        assert.ok(result.entries.every((doc) => doc.date === "2026-06-01"));
        assert.equal(result.omitted, 2);
    });

    it("orders the blank catalogue most-recent-first", () => {
        // Arrange – path order opposes date order.
        const docs = [
            entry({ path: "a.md", date: "2026-01-01" }),
            entry({ path: "z.md", date: "2026-05-05" }),
        ];

        // Act
        const { entries } = rankDocs(docs, "");

        // Assert – newest edit first, even though "a" sorts first by path.
        assert.deepEqual(
            entries.map((doc) => doc.path),
            ["z.md", "a.md"],
        );
    });

    it("notes omitted docs under the fallback header", () => {
        // Arrange – one shown doc, five cut by the cap.
        const docs = [entry({ path: "a.md", summary: "serena note" })];

        // Act
        const text = render(docs, { closest: true, omitted: 5 });

        // Assert
        assert.match(text, /Closest matches/);
        assert.match(text, /… and 5 more not shown\./);
    });

    it("carries the cap note through the tool", async () => {
        // Arrange – a tool whose fallback overflows the cap.
        const docs = Array.from({ length: MAX_RESULTS + 2 }, (_, i) =>
            entry({ path: `t${i}.md`, summary: "serena note" }),
        );
        const tool = toolOf(docs);

        // Act
        const result = await tool.execute(
            { search: "serena zzz9" },
            {} as never,
        );

        // Assert
        assert.match(String(result.content), /… and 2 more not shown\./);
    });
});

describe("createDocsTool", () => {
    const docs = [
        entry({ path: "decisions/serena.md", keywords: ["serena"] }),
        entry({ path: "runtime/other.md", summary: "unrelated" }),
    ];

    it("names the tool docs and searches the catalogue", async () => {
        const tool = toolOf(docs);

        const result = await tool.execute({ search: "serena" }, {} as never);

        assert.equal(tool.name, "docs");
        assert.equal(result.metadata?.count, 1);
        assert.match(String(result.content), /\bdecisions\/serena\.md/);
    });

    it("lists every doc on a blank query", async () => {
        const tool = toolOf(docs);

        const result = await tool.execute({}, {} as never);

        assert.equal(result.metadata?.count, 2);
    });

    it("renders the fallback header and count from the tool itself", async () => {
        const tool = toolOf([
            entry({
                path: "a.md",
                area: "",
                date: "",
                title: "kqx7",
                summary: "",
            }),
        ]);

        const result = await tool.execute({ search: "kqx7 zzz9" }, {} as never);

        assert.equal(result.metadata?.count, 1);
        assert.match(String(result.content), /Closest matches/);
    });

    it("is registered for direct use, not Code Mode", () => {
        const tool = toolOf([]);

        assert.equal(tool.options?.codemode, false);
    });
});

describe("createDocsCommand", () => {
    const docs = [
        entry({ path: "decisions/serena.md", keywords: ["serena"] }),
        entry({ path: "runtime/other.md", summary: "unrelated" }),
    ];

    /** A command wired to capture what it sends to the session. */
    function harness(read: (path: string) => string = () => ""): {
        command: ReturnType<typeof createDocsCommand>;
        sent: string[];
    } {
        const sent: string[] = [];
        const command = createDocsCommand({
            collect: () => docs,
            read,
            prompt: async (_sessionID, text) => {
                sent.push(text);
            },
        });
        return { command, sent };
    }

    it("names the command docs and prompts the filtered catalogue", async () => {
        const { command, sent } = harness();

        await command.execute({
            sessionID: "ses_test",
            prompt: { text: "serena" },
        } as never);

        assert.equal(command.name, "docs");
        assert.equal(sent.length, 1);
        assert.match(sent[0] ?? "", /\bdecisions\/serena\.md/);
    });

    it("lists every doc when the query is blank", async () => {
        const { command, sent } = harness();

        await command.execute({
            sessionID: "ses_test",
            prompt: { text: "   " },
        } as never);

        assert.match(sent[0] ?? "", /\bruntime\/other\.md/);
    });

    it("searches the text after the `search` verb", async () => {
        const { command, sent } = harness();

        await command.execute({
            sessionID: "ses_test",
            prompt: { text: "search serena" },
        } as never);

        assert.match(sent[0] ?? "", /\bdecisions\/serena\.md/);
        assert.doesNotMatch(sent[0] ?? "", /\bruntime\/other\.md/);
    });

    it("labels the closest matches when no doc has every term", async () => {
        const { command, sent } = harness();

        await command.execute({
            sessionID: "ses_test",
            prompt: { text: "serena elsewhere" },
        } as never);

        assert.match(sent[0] ?? "", /Closest matches/);
    });

    it("prompts a typed-add request for the text after the add verb", async () => {
        const { command, sent } = harness();

        await command.execute({
            sessionID: "ses_test",
            prompt: { text: "add this important bit of information" },
        } as never);

        assert.equal(sent.length, 1);
        assert.match(sent[0] ?? "", /this important bit of information/);
        assert.match(sent[0] ?? "", /`add`/);
        assert.doesNotMatch(sent[0] ?? "", /\bdecisions\/serena\.md/);
    });

    it("asks for text when `add` carries none", async () => {
        const { command, sent } = harness();

        await command.execute({
            sessionID: "ses_test",
            prompt: { text: "add" },
        } as never);

        assert.match(sent[0] ?? "", /needs the text/i);
    });
});

describe("help", () => {
    it("explains the ranking in plain text", () => {
        // Assert – weights and qualities, in words.
        assert.match(explainRanking(), /exact/);
        assert.match(explainRanking(), /substring/);
    });

    it("serves help from the tool", async () => {
        // Arrange
        const tool = toolOf([entry()]);

        // Act
        const result = await tool.execute({ search: "help" }, {} as never);

        // Assert
        assert.match(String(result.content), /substring/);
    });

    it("serves help from the /docs command", async () => {
        // Arrange
        const sent: string[] = [];
        const command = createDocsCommand({
            collect: () => [entry()],
            read: () => "",
            prompt: async (_sessionID, text) => {
                sent.push(text);
            },
        });

        // Act
        await command.execute({
            sessionID: "ses_test",
            prompt: { text: "help" },
        } as never);

        // Assert
        assert.match(sent[0] ?? "", /substring/);
    });
});

describe("ranking stability", () => {
    it("ranks identically on repeated queries", () => {
        // Arrange – equal scores, so the tie-breaks do the ordering.
        const docs = [
            entry({ path: "a.md", summary: "serena note" }),
            entry({ path: "z.md", summary: "serena note" }),
        ];

        // Act
        const first = rankDocs(docs, "serena zzz9");
        const second = rankDocs(docs, "serena zzz9");

        // Assert
        assert.deepEqual(first, second);
    });
});

/** A well-formed `add` DTO, overridden per test. */
function addRequest(overrides: Record<string, unknown> = {}): {
    metadata: {
        Area: string;
        Keywords: string[];
        Summary: string;
        Status?: "active" | "superseded";
        Supersedes?: string;
    };
    body: string;
    path?: string;
} {
    return {
        metadata: { Area: "aa", Keywords: ["alpha"], Summary: "A fresh doc." },
        body: "# Fresh\n\nFacts.\n",
        ...overrides,
    };
}

describe("resolveRequest", () => {
    const add = addRequest();

    it("gives add precedence over search", async () => {
        const request = resolveRequest({ search: "x", add });

        assert.equal(request.verb, "add");
    });

    it("wraps a blank search as the catalogue request", async () => {
        assert.deepEqual(resolveRequest({}), { verb: "search", search: "" });
    });

    it("answers help from a lone help search", async () => {
        assert.equal(resolveRequest({ search: "Help" }).verb, "help");
    });
});

describe("FRONT_MATTER_FIELDS", () => {
    it("puts the required fields first, the optionals last, in canonical order", async () => {
        assert.deepEqual(
            FRONT_MATTER_FIELDS.map((field) => [field.name, field.required]),
            [
                ["Area", true],
                ["Keywords", true],
                ["Summary", true],
                ["Status", false],
                ["Supersedes", false],
            ],
        );
    });
});

describe("serializeDoc", () => {
    it("serialises required metadata in canonical order above the body", async () => {
        const raw = serializeDoc(
            { Area: "aa", Keywords: ["one", "two"], Summary: "S" },
            "# T\n",
        );

        assert.equal(
            raw,
            "---\nArea: aa\nKeywords: one, two\nSummary: S\n---\n\n# T\n",
        );
    });

    it("serialises the optional fields when present", async () => {
        const raw = serializeDoc(
            {
                Area: "aa",
                Keywords: ["one"],
                Summary: "S",
                Status: "superseded",
                Supersedes: "aa/old.md",
            },
            "# T\n",
        );

        assert.match(raw, /\nStatus: superseded\n/);
        assert.match(raw, /\nSupersedes: aa\/old\.md\n/);
    });

    it("round-trips through parseFrontMatter", async () => {
        const raw = serializeDoc(
            { Area: "aa", Keywords: ["one"], Summary: "S" },
            "# T\n\nFacts.\n",
        );

        assert.deepEqual(parseFrontMatter(raw), {
            meta: { Area: "aa", Keywords: "one", Summary: "S" },
            body: "# T\n\nFacts.\n",
        });
    });
});

describe("slugify", () => {
    it("kebab-cases a title", async () => {
        assert.equal(
            slugify("One Git Pass For Dates"),
            "one-git-pass-for-dates",
        );
    });

    it("strips punctuation and trims dashes", async () => {
        assert.equal(
            slugify("  -- Traps: `lake/` & gates! --  "),
            "traps-lake-gates",
        );
    });

    it("collapses to nothing when no word characters remain", async () => {
        assert.equal(slugify(" -- ## -- "), "");
    });
});

describe("prepareAdd guardrails", () => {
    it("refuses blank required metadata", async () => {
        const cases = [
            [
                "Area",
                addRequest({
                    metadata: { Area: " ", Keywords: ["alpha"], Summary: "S" },
                }),
            ],
            [
                "Summary",
                addRequest({
                    metadata: { Area: "aa", Keywords: ["alpha"], Summary: "" },
                }),
            ],
            [
                "Keywords",
                addRequest({
                    metadata: { Area: "aa", Keywords: [], Summary: "S" },
                }),
            ],
            [
                "Keywords",
                addRequest({
                    metadata: { Area: "aa", Keywords: [" "], Summary: "S" },
                }),
            ],
        ] as const;

        for (const [field, request] of cases) {
            const outcome = prepareAdd(request, []);
            assert.equal(outcome.action, "refuse", field);
            assert.match(String(outcome.reason), new RegExp(field));
        }
    });

    it("refuses a body with no H1", async () => {
        const outcome = prepareAdd(addRequest({ body: "## Only an H2\n" }), []);

        assert.equal(outcome.action, "refuse");
        assert.match(String(outcome.reason), /H1/);
    });

    it("refuses a path that escapes the docs root", async () => {
        const cases = ["aa/../../secrets.md", "../outside.md", "/etc/notes.md"];

        for (const path of cases) {
            const outcome = prepareAdd(addRequest({ path }), []);
            assert.equal(outcome.action, "refuse", path);
            assert.match(String(outcome.reason), /path/i);
        }
    });

    it("refuses a target that is not .md", async () => {
        const outcome = prepareAdd(addRequest({ path: "aa/notes.txt" }), []);

        assert.equal(outcome.action, "refuse");
        assert.match(String(outcome.reason), /\.md/);
    });

    it("refuses an Area that escapes the docs tree", async () => {
        const outcome = prepareAdd(
            addRequest({
                metadata: {
                    Area: "../evil",
                    Keywords: ["alpha"],
                    Summary: "S",
                },
            }),
            [],
        );

        assert.equal(outcome.action, "refuse");
        assert.match(String(outcome.reason), /Area/);
    });

    it("refuses a title that yields no usable file name", async () => {
        const outcome = prepareAdd(addRequest({ body: "# -- ##\n" }), []);

        assert.equal(outcome.action, "refuse");
        assert.match(String(outcome.reason), /file name/i);
    });
});

describe("prepareAdd paths", () => {
    it("derives <Area>/<slug>.md when path is omitted", async () => {
        const outcome = prepareAdd(addRequest(), []);

        assert.equal(outcome.action, "write");
        assert.equal(outcome.path, "aa/fresh.md");
    });

    it("serialises the written contents from the DTO", async () => {
        const outcome = prepareAdd(addRequest(), []);
        if (outcome.action !== "write") {
            assert.fail(`expected a write, got ${outcome.action}`);
        }

        assert.match(String(outcome.contents), /^---\nArea: aa\n/);
        assert.match(String(outcome.contents), /# Fresh/);
    });

    it("trims whitespace from an explicit target", async () => {
        const outcome = prepareAdd(addRequest({ path: " aa/other.md " }), []);

        assert.equal(outcome.action, "write");
        assert.equal(outcome.path, "aa/other.md");
    });

    it("treats a leading docs/ as a literal area, not scaffolding", async () => {
        const outcome = prepareAdd(addRequest({ path: "x.md" }), []);

        assert.equal(outcome.action, "write");
        assert.equal(outcome.path, "x.md");
    });
});

describe("prepareAdd reconcile", () => {
    it("refuses a same-area near-twin when path is omitted", async () => {
        const entries = [
            entry({
                path: "aa/fresh.md",
                area: "aa",
                keywords: ["alpha"],
            }),
        ];

        const outcome = prepareAdd(addRequest(), entries);

        assert.equal(outcome.action, "refuse");
        assert.match(String(outcome.reason), /\baa\/fresh\.md/);
        assert.deepEqual(
            outcome.candidates.map((candidate) => candidate.path),
            ["aa/fresh.md"],
        );
    });

    it("does not let a different-area match block the write", async () => {
        const entries = [
            entry({
                path: "zz/fresh.md",
                area: "zz",
                keywords: ["alpha"],
            }),
        ];

        const outcome = prepareAdd(addRequest(), entries);

        assert.equal(outcome.action, "write");
    });

    it("skips reconcile when an explicit path is given", async () => {
        const entries = [
            entry({
                path: "aa/target.md",
                area: "aa",
                keywords: ["alpha"],
            }),
        ];

        const outcome = prepareAdd(
            addRequest({ path: "aa/target.md" }),
            entries,
        );

        assert.equal(outcome.action, "write");
    });

    it("reports same-area neighbours with the write", async () => {
        const entries = [
            entry({
                path: "aa/old.md",
                area: "aa",
                keywords: [],
                summary: "Something else entirely.",
            }),
        ];

        const outcome = prepareAdd(addRequest(), entries);

        assert.equal(outcome.action, "write");
        assert.deepEqual(
            outcome.neighbours.map((neighbour) => neighbour.path),
            ["aa/old.md"],
        );
    });
});

describe("tool add", () => {
    /** An in-memory write seam plus a record of what was written. */
    function memoryFs(existing: string[] = []): {
        seam: {
            exists: (path: string) => boolean;
            write: (path: string, contents: string) => void;
            read: (path: string) => string;
        };
        written: { path: string; contents: string }[];
    } {
        const written: { path: string; contents: string }[] = [];
        return {
            written,
            seam: {
                exists: (path) =>
                    existing.includes(path) ||
                    written.some((w) => w.path === path),
                write: (path, contents) =>
                    void written.push({ path, contents }),
                read: () => "",
            },
        };
    }

    it("writes a new doc and reports created", async () => {
        const { seam, written } = memoryFs();
        const tool = createDocsTool({ collect: () => [], ...seam });

        const result = await tool.execute(
            { add: addRequest() } as never,
            {} as never,
        );

        assert.match(String(result.content), /\baa\/fresh\.md — created/);
        assert.equal(written.length, 1);
        assert.match(String(written[0]?.contents), /^---\nArea: aa\n/);
        assert.equal(result.metadata?.written, true);
    });

    it("reports updated when the target exists", async () => {
        const { seam, written } = memoryFs(["aa/fresh.md"]);
        const tool = createDocsTool({ collect: () => [], ...seam });

        const result = await tool.execute(
            { add: addRequest() } as never,
            {} as never,
        );

        assert.match(String(result.content), /\baa\/fresh\.md — updated/);
        assert.equal(written.length, 1);
    });

    it("refuses a near-twin without writing", async () => {
        const { seam, written } = memoryFs();
        const entries = [
            entry({
                path: "aa/fresh.md",
                area: "aa",
                keywords: ["alpha"],
            }),
        ];
        const tool = createDocsTool({ collect: () => entries, ...seam });

        const result = await tool.execute(
            { add: addRequest() } as never,
            {} as never,
        );

        assert.equal(written.length, 0);
        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /\baa\/fresh\.md/);
    });

    it("lists same-area neighbours with a successful write", async () => {
        const { seam } = memoryFs();
        const entries = [
            entry({
                path: "aa/old.md",
                area: "aa",
                keywords: [],
                summary: "Something else entirely.",
            }),
        ];
        const tool = createDocsTool({ collect: () => entries, ...seam });

        const result = await tool.execute(
            { add: addRequest() } as never,
            {} as never,
        );

        assert.match(String(result.content), /\baa\/old\.md/);
    });
});

/** A well-formed doc body+front-matter: the shape `check` should pass. */
const goodRaw =
    "---\nArea: aa\nKeywords: alpha, beta\nSummary: A good doc.\n---\n" +
    "# Title\n\n### Facts\n\n- Something verified.\n";

/** A raw doc with one claim section of the given heading text. */
function rawWithClaim(section: string): string {
    return (
        "---\nArea: aa\nKeywords: alpha\nSummary: S.\n---\n" +
        `# Title\n\n### ${section}\n\n- Something.\n`
    );
}

describe("validateDoc", () => {
    it("passes a well-formed doc with no findings", () => {
        const findings = validateDoc("aa/good.md", goodRaw);

        assert.deepEqual(findings, []);
    });

    it("flags a body with no H1", () => {
        const raw = goodRaw.replace("# Title\n\n", "");

        const findings = validateDoc("aa/x.md", raw);

        assert.equal(findings.length, 1);
        assert.match(String(findings[0]), /H1/);
    });

    it("flags each blank required front-matter field by name", () => {
        const cases = [
            ["Area", goodRaw.replace("Area: aa\n", "")],
            ["Keywords", goodRaw.replace("Keywords: alpha, beta\n", "")],
            ["Summary", goodRaw.replace("Summary: A good doc.\n", "")],
        ] as const;

        for (const [field, raw] of cases) {
            const findings = validateDoc("aa/x.md", raw);

            assert.equal(findings.length, 1, field);
            assert.match(String(findings[0]), new RegExp(field), field);
        }
    });

    it("flags a hand-maintained Date", () => {
        const raw = goodRaw.replace("---\n", "---\nDate: 2020-01-01\n");

        const findings = validateDoc("aa/x.md", raw);

        assert.equal(findings.length, 1);
        assert.match(String(findings[0]), /Date/);
    });

    it("flags a body with no claim section", () => {
        const raw =
            "---\nArea: aa\nKeywords: alpha\nSummary: S.\n---\n" +
            "# Title\n\nJust prose.\n";

        const findings = validateDoc("aa/x.md", raw);

        assert.equal(findings.length, 1);
        assert.match(String(findings[0]), /Facts/);
    });

    it("accepts any single claim section as an H2 or H3", () => {
        const cases = [
            "Facts",
            "Inferred",
            "Tested",
            "Open questions",
        ] as const;

        for (const section of cases) {
            assert.deepEqual(
                validateDoc("aa/x.md", rawWithClaim(section)),
                [],
                section,
            );
            assert.deepEqual(
                validateDoc(
                    "aa/x.md",
                    rawWithClaim(section).replace("###", "##"),
                ),
                [],
                `H2 ${section}`,
            );
        }
    });

    it("flags an H1 and Keywords that carry no term at MIN_TERM_LENGTH or longer", () => {
        const raw =
            "---\nArea: aa\nKeywords: go\nSummary: S.\n---\n" +
            "# Go\n\n### Facts\n\n- Something.\n";

        const findings = validateDoc("aa/x.md", raw);

        assert.equal(findings.length, 1);
        assert.match(String(findings[0]), /MIN_TERM_LENGTH/);
    });

    it("flags Keywords that are only punctuation", () => {
        const raw = goodRaw.replace(
            "Keywords: alpha, beta\n",
            "Keywords: , ,\n",
        );

        const findings = validateDoc("aa/x.md", raw);

        assert.equal(findings.length, 1);
        assert.match(String(findings[0]), /Keywords/);
    });

    it("does not accept a claim section that is only an inline code span", () => {
        const raw =
            "---\nArea: aa\nKeywords: alpha\nSummary: S.\n---\n" +
            "# Title\n\nMentions `Facts` inline.\n";

        const findings = validateDoc("aa/x.md", raw);

        assert.equal(findings.length, 1);
        assert.match(String(findings[0]), /claim section/);
    });

    it("does not accept a claim section inside a fenced block", () => {
        const raw =
            "---\nArea: aa\nKeywords: alpha\nSummary: S.\n---\n" +
            "# Title\n\n```\n### Facts\n```\n";

        const findings = validateDoc("aa/x.md", raw);

        assert.equal(findings.length, 1);
        assert.match(String(findings[0]), /claim section/);
    });

    it("reports every finding for an empty doc", () => {
        const findings = validateDoc("x.md", "");

        assert.deepEqual(findings, [
            "no H1 (`# Title`).",
            "Area is required and must not be blank.",
            "Keywords is required and must not be blank.",
            "Summary is required and must not be blank.",
            "no claim section (Facts / Inferred / Tested / Open questions).",
            "the H1 and Keywords carry no term of MIN_TERM_LENGTH (3) or longer.",
        ]);
    });
});

describe("nearTwins", () => {
    it("returns same-area docs matching every identity term", () => {
        const twin = entry({
            path: "aa/fresh.md",
            area: "aa",
            keywords: ["alpha"],
        });

        const twins = nearTwins("Fresh alpha", "aa", [twin]);

        assert.deepEqual(
            twins.map((candidate) => candidate.path),
            ["aa/fresh.md"],
        );
    });

    it("ignores docs outside the area", () => {
        const other = entry({
            path: "zz/fresh.md",
            area: "zz",
            keywords: ["alpha"],
        });

        assert.deepEqual(nearTwins("Fresh alpha", "aa", [other]), []);
    });
});

describe("checkDocs", () => {
    /** A read seam over a raw-doc map, with the good doc preloaded. */
    function rawsOf(extra: Record<string, string> = {}) {
        return new Map<string, string>([
            ["aa/good.md", goodRaw],
            ...Object.entries(extra),
        ]);
    }

    it("reports compliance when nothing is found", () => {
        const entries = [toEntry("aa/good.md", goodRaw, "2026-01-01")];

        const report = checkDocs(entries, (path) => rawsOf().get(path) ?? "");

        assert.match(report, /comply/);
    });

    it("reports compliance for an empty tree", () => {
        assert.equal(
            checkDocs([], () => ""),
            "All 0 docs comply.",
        );
    });

    it("reports per-doc findings with the doc's path", () => {
        const bad =
            "---\nArea: aa\nKeywords: alpha\nSummary: S.\n---\nJust prose.\n";
        const entries = [toEntry("aa/bad.md", bad, "2026-01-01")];

        const report = checkDocs(
            entries,
            (path) => rawsOf({ "aa/bad.md": bad }).get(path) ?? "",
        );

        assert.match(report, /\baa\/bad\.md/);
        assert.match(report, /H1/);
    });

    it("reports a near-twin pair once, naming both docs", () => {
        const entries = [
            entry({
                path: "aa/a.md",
                area: "aa",
                title: "Alpha page",
                keywords: ["alpha"],
            }),
            entry({
                path: "aa/b.md",
                area: "aa",
                title: "Alpha page",
                keywords: ["alpha"],
            }),
        ];

        const report = checkDocs(entries, (path) => rawsOf().get(path) ?? "");

        assert.match(report, /\baa\/a\.md/);
        assert.match(report, /\baa\/b\.md/);
        assert.equal(report.match(/near-twin/g)?.length, 1);
    });

    it("reports a pair that only one direction of the rule fires on", () => {
        const entries = [
            entry({
                path: "aa/wide.md",
                area: "aa",
                title: "Alpha page",
                keywords: ["alpha"],
            }),
            entry({
                path: "aa/narrow.md",
                area: "aa",
                title: "Alpha",
                keywords: [],
            }),
        ];

        const report = checkDocs(entries, (path) => rawsOf().get(path) ?? "");

        assert.match(report, /\baa\/wide\.md/);
        assert.match(report, /\baa\/narrow\.md/);
        assert.equal(report.match(/near-twin/g)?.length, 1);
    });

    it("appends environment notes to the report", () => {
        const entries = [toEntry("aa/good.md", goodRaw, "2026-01-01")];

        const report = checkDocs(entries, (path) => rawsOf().get(path) ?? "", [
            "note: unversioned root",
        ]);

        assert.match(report, /note: unversioned root/);
        assert.doesNotMatch(report, /comply/);
    });

    it("reports a note even for an empty tree", () => {
        assert.equal(
            checkDocs([], () => "", ["note: only"]),
            "note: only",
        );
    });
});

describe("resolveRequest check", () => {
    it("resolves check over search", () => {
        assert.equal(
            resolveRequest({ search: "x", check: true }).verb,
            "check",
        );
    });

    it("gives add precedence over check", () => {
        assert.equal(
            resolveRequest({ add: addRequest(), check: true }).verb,
            "add",
        );
    });
});

describe("tool check", () => {
    it("serves the check report and the checked count", async () => {
        const raws = new Map([["aa/good.md", goodRaw]]);
        const tool = createDocsTool({
            collect: () => [toEntry("aa/good.md", goodRaw, "2026-01-01")],
            exists: () => false,
            write: () => {},
            read: (path) => raws.get(path) ?? "",
        });

        const result = await tool.execute({ check: true }, {} as never);

        assert.match(String(result.content), /comply/);
        assert.equal(result.metadata?.checked, 1);
    });

    it("carries the environment notes through the tool's check", async () => {
        const tool = createDocsTool({
            collect: () => [],
            exists: () => false,
            write: () => {},
            read: () => "",
            notes: ["note: unversioned root"],
        });

        const result = await tool.execute({ check: true }, {} as never);

        assert.match(String(result.content), /note: unversioned root/);
    });
});

describe("command check", () => {
    it("prompts the check report for the check verb", async () => {
        const sent: string[] = [];
        const raws = new Map([["aa/good.md", goodRaw]]);
        const command = createDocsCommand({
            collect: () => [toEntry("aa/good.md", goodRaw, "2026-01-01")],
            read: (path) => raws.get(path) ?? "",
            prompt: async (_sessionID, text) => {
                sent.push(text);
            },
        });

        await command.execute({
            sessionID: "ses_test",
            prompt: { text: "check" },
        } as never);

        assert.equal(sent.length, 1);
        assert.match(sent[0] ?? "", /comply/);
    });
});

describe("prepareAdd short identity", () => {
    it("refuses an H1 and Keywords that are all below MIN_TERM_LENGTH", () => {
        const outcome = prepareAdd(
            addRequest({
                metadata: { Area: "aa", Keywords: ["go"], Summary: "S" },
                body: "# Go\n\nFacts.\n",
            }),
            [],
        );

        assert.equal(outcome.action, "refuse");
        assert.match(String(outcome.reason), /MIN_TERM_LENGTH/);
    });

    it("writes when either the H1 or a keyword reaches the floor", () => {
        const outcome = prepareAdd(
            addRequest({
                metadata: { Area: "aa", Keywords: ["go"], Summary: "S" },
                body: "# Go language\n\nFacts.\n",
            }),
            [],
        );

        assert.equal(outcome.action, "write");
    });
});

/**
 * A hand-authored synthetic corpus — invented paths, summaries and
 * identifiers, never a real tree — so the ranking harness can pin behaviour
 * without shipping anyone's docs. Edit it directly when a new shape is needed.
 */
const corpus: DocEntry[] = JSON.parse(
    readFileSync(
        join(import.meta.dirname, "fixtures/docs-corpus.json"),
        "utf8",
    ),
);

describe("reconcileQuery", () => {
    it("joins the H1 and the Keywords, not the Summary", () => {
        const query = reconcileQuery({
            metadata: {
                Area: "aa",
                Keywords: ["alpha", "beta"],
                Summary: "S words",
            },
            body: "# Title here\n",
        });

        assert.equal(query, "Title here alpha beta");
    });
});

describe("reconcile harness (fixture corpus)", () => {
    /** A realistic add DTO, overridable per scenario. */
    function dto(
        overrides: {
            path?: string;
            Area?: string;
            Keywords?: string[];
            Summary?: string;
            title?: string;
        } = {},
    ): {
        path?: string;
        metadata: { Area: string; Keywords: string[]; Summary: string };
        body: string;
    } {
        const {
            path,
            Area: area = "guides",
            Keywords: keywords = ["kwqx9probe"],
            Summary: summary = "Probe doc for the harness.",
            title = "Probe doc",
        } = overrides;
        const request: {
            path?: string;
            metadata: { Area: string; Keywords: string[]; Summary: string };
            body: string;
        } = {
            metadata: { Area: area, Keywords: keywords, Summary: summary },
            body: `# ${title}\n\nFacts: harness fixture.\n`,
        };
        if (path !== undefined) {
            request.path = path;
        }
        return request;
    }

    interface Scenario {
        name: string;
        request: ReturnType<typeof dto>;
        expect: "write" | "refuse";
        /** When refusing: a path that must appear among the candidates. */
        candidate?: string;
        /** When refusing: the path that must rank first. */
        topCandidate?: string;
    }

    const scenarios: Scenario[] = [
        {
            name: "a genuine duplicate refuses with its twin ranked first",
            request: dto({
                Keywords: ["widget", "install"],
                Summary: "The widget install guide again.",
                title: "Widget install",
            }),
            expect: "refuse",
            candidate: "guides/widget-setup.md",
            topCandidate: "guides/widget-install.md",
        },
        {
            name: "a keyword twin in another area refuses with its floor doc first",
            request: dto({
                Area: "meta",
                Keywords: ["naming", "convention"],
                Summary: "The house naming convention.",
                title: "Naming rules",
            }),
            expect: "refuse",
            candidate: "meta/naming.md",
            topCandidate: "meta/naming.md",
        },
        {
            name: "a brand-new area always writes",
            request: dto({
                Area: "experiments",
                Summary: "An experiment in a brand-new area.",
                title: "Experiment probe",
            }),
            expect: "write",
        },
        {
            name: "an explicit path skips reconcile and writes at the target",
            request: dto({
                Keywords: ["widget"],
                Summary: "The widget install guide.",
                title: "Widget install",
                path: "guides/widget-install.md",
            }),
            expect: "write",
        },
        {
            name: "filler-only wording in a busy area does not block the write",
            request: dto({
                Area: "notes",
                Keywords: ["zqx9filler"],
                Summary: "The doc for the config of the tool.",
                title: "Filler probe",
            }),
            expect: "write",
        },
        {
            name: "a unique topic in a busy area writes without a retry",
            request: dto({
                Area: "ops",
                Keywords: ["kwqx9probe"],
                Summary: "Probe doc kwqx9probe for the writer playtest.",
                title: "Kwqx9probe probe doc",
            }),
            expect: "write",
        },
        {
            name: "naming your own area in the summary does not block",
            request: dto({
                Area: "notes",
                Keywords: ["gamma"],
                Summary: "Gamma note probes for the notes lane.",
                title: "Gamma probes",
            }),
            expect: "write",
        },
    ];

    for (const scenario of scenarios) {
        it(scenario.name, () => {
            const outcome = prepareAdd(scenario.request, corpus);
            const detail = (): string =>
                JSON.stringify(
                    {
                        query: reconcileQuery(scenario.request),
                        action: outcome.action,
                        path:
                            outcome.action === "write"
                                ? outcome.path
                                : undefined,
                        candidates:
                            outcome.action === "refuse"
                                ? outcome.candidates.map((c) => c.path)
                                : undefined,
                    },
                    null,
                    2,
                );

            if (outcome.action !== scenario.expect) {
                assert.fail(detail());
            }
            if (outcome.action === "refuse") {
                assert.match(
                    outcome.reason,
                    new RegExp(scenario.request.metadata.Area),
                );
                const paths = outcome.candidates.map(
                    (candidate) => candidate.path,
                );
                if (scenario.candidate !== undefined) {
                    assert.ok(paths.includes(scenario.candidate), detail());
                }
                if (scenario.topCandidate !== undefined) {
                    assert.equal(paths[0], scenario.topCandidate, detail());
                }
            }
            if (outcome.action === "write") {
                assert.match(outcome.path, /^[^/]+\/[^/]+\.md$/);
            }
        });
    }
});

describe("search harness (fixture corpus)", () => {
    const pins: ReadonlyArray<readonly [query: string, expected: string]> = [
        ["widget install", "guides/widget-install.md"],
        ["alpha memo", "notes/alpha-note.md"],
        ["naming rules", "meta/naming.md"],
        ["backup restore", "ops/backup.md"],
        ["monitoring alerts", "ops/monitoring.md"],
    ];

    for (const [query, expected] of pins) {
        it(`ranks "${query}" first`, () => {
            const { entries } = rankDocs(corpus, query);

            assert.equal(entries[0]?.path, expected);
        });
    }

    it("keeps the shared-phrase duplicate in the top three for its phrase", () => {
        // "Widget setup" shares every term with the exact-title doc, which
        // ranks first; the twin is pinned within-three, not first.
        const { entries } = rankDocs(corpus, "widget install");

        assert.ok(
            entries
                .slice(0, 3)
                .map((top) => top.path)
                .includes("guides/widget-setup.md"),
            entries.map((top) => top.path).join("\n"),
        );
    });

    it("returns nothing for a subsequence typo", () => {
        assert.deepEqual(rankDocs(corpus, "wdiget").entries, []);
    });

    it("caps the blank catalogue at MAX_RESULTS with the rest counted", () => {
        const result = rankDocs(corpus, "");

        assert.equal(result.entries.length, MAX_RESULTS);
        assert.equal(result.omitted, corpus.length - MAX_RESULTS);
        assert.equal(result.closest, false);
    });
});
