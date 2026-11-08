import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    existsSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    createDocsTool,
    createLakes,
    revisionOf,
    serializeDoc,
    type LakeSpec,
} from "../src/index.ts";

/**
 * Revision visibility through the real host paths. Host evidence at opencode
 * v2.2.5: a plugin tool's model-facing payload is its `content` only —
 * `packages/core/src/session/runner/to-llm-message.ts → toolResult()`
 * serialises `content`, the `Session.Tool.Success` event stores `metadata` as
 * optional UI data, and the Code Mode twin's `resultValue()` in
 * `packages/core/src/codemode/tool.ts` returns the joined text for tools
 * without an output schema. So these tests take every token from the surfaced
 * `content` text — the channel both surfaces forward — never from metadata,
 * never from the file, and never by computing a hash themselves.
 */

const cleanups: string[] = [];

after(() => {
    for (const dir of cleanups) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "docs-visibility-"));
    cleanups.push(dir);
    return dir;
}

function knowledgeSpec(name = "docs"): LakeSpec {
    return {
        name,
        class: "repo",
        root: tempDir(),
        profile: "knowledge",
        writable: true,
    };
}

/**
 * The token exactly as the model or the Code Mode caller sees it: the
 * **trailing** `docs: revision` envelope — a document body may itself quote a
 * fake envelope (this plugin's own knowledge docs do), so a first-match parse
 * would hand back the decoy. The appended envelope is always last.
 */
function tokenFrom(content: string): string {
    const matches = [...content.matchAll(/docs: revision ([0-9a-f]{64}) —/g)];
    assert.ok(
        matches.length > 0,
        `no revision line in the surfaced result: ${JSON.stringify(content)}`,
    );
    const value = matches[matches.length - 1]?.[1];
    assert.ok(value !== undefined, "the trailing match carries no token");
    return value;
}

const RAW =
    "---\nArea: aa\nKeywords: seed\nSummary: Seeded.\n---\n\n" +
    "# Seed\n\n### Facts\n\n- Original body.\n";

describe("revision visibility through the host channels", () => {
    it("a native read surfaces a usable token (V01)", async () => {
        // Arrange – the doc on disk; the tool the host delivers natively.
        const spec = knowledgeSpec();
        mkdirSync(join(spec.root, "aa"), { recursive: true });
        writeFileSync(join(spec.root, "aa/doc.md"), RAW);
        const tool = createDocsTool({ lakes: createLakes([spec]) });

        const read = await tool.execute(
            { read: "aa/doc.md" } as never,
            {} as never,
        );
        // The model-facing payload is the text; the token must be in it.
        const token = tokenFrom(String(read.content));
        // The document body stays verbatim before the envelope.
        assert.ok(String(read.content).includes(RAW));

        const replace = await tool.execute(
            {
                add: {
                    mode: "replace",
                    path: "aa/doc.md",
                    expectedRevision: token,
                    metadata: { Area: "aa", Keywords: ["seed"], Summary: "S." },
                    body: "# Seed\n\n### Facts\n\n- Replaced body.\n",
                },
            } as never,
            {} as never,
        );

        assert.equal(replace.metadata?.written, true);
    });

    it("the Code Mode twin's surfaced value carries a usable token (V02)", async () => {
        // Arrange – the twin shares the native core; what JavaScript receives
        // from `tools.docs.docs_search(…)` is the joined content text (host
        // resultValue conversion), so the token rides the same text.
        const spec = knowledgeSpec();
        mkdirSync(join(spec.root, "aa"), { recursive: true });
        writeFileSync(join(spec.root, "aa/doc.md"), RAW);
        const lakes = createLakes([spec]);
        const twin = createDocsTool(
            { lakes },
            { name: "docs_search", codemode: true },
        );

        const read = await twin.execute(
            { read: "aa/doc.md" } as never,
            {} as never,
        );
        // What the execute runtime hands to JavaScript: one text value made
        // of the result's text content — never the metadata object.
        const javascriptValue = String(read.content);
        const token = tokenFrom(javascriptValue);

        const replace = await twin.execute(
            {
                add: {
                    mode: "replace",
                    path: "aa/doc.md",
                    expectedRevision: token,
                    metadata: { Area: "aa", Keywords: ["seed"], Summary: "S." },
                    body: "# Seed\n\n### Facts\n\n- Replaced by JS.\n",
                },
            } as never,
            {} as never,
        );

        assert.equal(replace.metadata?.written, true);
        assert.match(
            readFileSync(join(spec.root, "aa/doc.md"), "utf8"),
            /Replaced by JS\./,
        );
    });

    it("an external edit stales the surfaced token on both surfaces (V03)", async () => {
        const spec = knowledgeSpec();
        mkdirSync(join(spec.root, "aa"), { recursive: true });
        writeFileSync(join(spec.root, "aa/doc.md"), RAW);
        const lakes = createLakes([spec]);
        const native = createDocsTool({ lakes });
        const twin = createDocsTool(
            { lakes },
            { name: "docs_search", codemode: true },
        );

        // The reader takes the token from the surfaced result first.
        const read = String(
            (await native.execute({ read: "aa/doc.md" } as never, {} as never))
                .content,
        );
        const stale = tokenFrom(read);

        // Then an external writer changes the stored bytes.
        const external =
            "---\nArea: aa\nKeywords: seed\nSummary: Seeded.\n---\n\n" +
            "# Seed\n\n### Facts\n\n- Externally edited.\n";
        writeFileSync(join(spec.root, "aa/doc.md"), external);

        // The twin reads the edited bytes: a fresh surfaced token, different
        // from the one taken before the edit.
        const twinRead = String(
            (await twin.execute({ read: "aa/doc.md" } as never, {} as never))
                .content,
        );
        assert.notEqual(stale, tokenFrom(twinRead));

        const refuses = await twin.execute(
            {
                add: {
                    mode: "replace",
                    path: "aa/doc.md",
                    expectedRevision: stale,
                    metadata: { Area: "aa", Keywords: ["seed"], Summary: "S." },
                    body: "# Seed\n\n### Facts\n\n- Should not land.\n",
                },
            } as never,
            {} as never,
        );

        assert.equal(refuses.metadata?.written, false);
        assert.match(String(refuses.content), /changed since you read it/);
        assert.equal(
            readFileSync(join(spec.root, "aa/doc.md"), "utf8"),
            external,
            "the new bytes survive",
        );
    });

    it("a successful create and replace surface their new tokens (V04)", async () => {
        const spec = knowledgeSpec();
        const tool = createDocsTool({ lakes: createLakes([spec]) });

        const create = await tool.execute(
            {
                add: {
                    mode: "create",
                    metadata: {
                        Area: "aa",
                        Keywords: ["fresh"],
                        Summary: "F.",
                    },
                    body: "# Fresh\n\n### Facts\n\n- First version.\n",
                },
            } as never,
            {} as never,
        );
        assert.equal(create.metadata?.written, true);
        const created = tokenFrom(String(create.content));

        const replace = await tool.execute(
            {
                add: {
                    mode: "replace",
                    path: "aa/fresh.md",
                    expectedRevision: created,
                    metadata: {
                        Area: "aa",
                        Keywords: ["fresh"],
                        Summary: "F.",
                    },
                    body: "# Fresh\n\n### Facts\n\n- Second version.\n",
                },
            } as never,
            {} as never,
        );
        assert.equal(replace.metadata?.written, true);
        const replaced = tokenFrom(String(replace.content));
        assert.notEqual(created, replaced);

        // The chain holds: the replacement's token re-replaces against the
        // exact bytes it acknowledged.
        const again = await tool.execute(
            {
                add: {
                    mode: "replace",
                    path: "aa/fresh.md",
                    expectedRevision: replaced,
                    metadata: {
                        Area: "aa",
                        Keywords: ["fresh"],
                        Summary: "F.",
                    },
                    body: "# Fresh\n\n### Facts\n\n- Third version.\n",
                },
            } as never,
            {} as never,
        );
        assert.equal(again.metadata?.written, true);
    });

    it("keeps wiki and raw-read behaviour free of the envelope (V05)", async () => {
        mkdirSync(join(tempDir(), "wiki"), { recursive: true });
        const wiki: LakeSpec = {
            name: "wiki",
            class: "wiki",
            root: tempDir(),
            profile: "wiki",
            writable: false,
        };
        const knowledge = knowledgeSpec("docs");
        writeFileSync(join(wiki.root, "page.md"), "# Page\n\nProse.\n");
        mkdirSync(join(knowledge.root, "aa"), { recursive: true });
        writeFileSync(join(knowledge.root, "aa/raw-read.md"), RAW);
        const tool = createDocsTool({ lakes: createLakes([wiki, knowledge]) });

        const wikiRead = await tool.execute(
            { read: "wiki:page.md" } as never,
            {} as never,
        );
        const knowledgeRead = await tool.execute(
            { read: "docs:aa/raw-read.md" } as never,
            {} as never,
        );

        // Wiki pages promise no revision workflow: no envelope, verbatim body.
        assert.ok(!String(wikiRead.content).includes("docs: revision"));
        assert.equal(
            String(wikiRead.content),
            "wiki:page.md — Page\n\n# Page\n\nProse.\n",
        );
        // Knowledge reads keep the verbatim raw document before the envelope.
        assert.ok(String(knowledgeRead.content).includes(RAW));
    });

    it("selects the trailing envelope when the document quotes a fake one (V06)", async () => {
        // Arrange – a document ABOUT this plugin quotes an envelope line of
        // its own, with a well-formed but wrong token. A first-match parse
        // would adopt the decoy; callers must take the trailing envelope.
        const decoy = "9".repeat(64);
        const raw =
            "---\nArea: aa\nKeywords: seed\nSummary: Seeded.\n---\n\n" +
            "# Seed\n\n### Facts\n\n- Original body.\n\n" +
            `docs: revision ${decoy} — internal example line.\n`;
        const spec = knowledgeSpec();
        mkdirSync(join(spec.root, "aa"), { recursive: true });
        writeFileSync(join(spec.root, "aa/doc.md"), raw);
        const tool = createDocsTool({ lakes: createLakes([spec]) });

        const read = await tool.execute(
            { read: "aa/doc.md" } as never,
            {} as never,
        );
        const token = tokenFrom(String(read.content));

        // Assert – the selected token is the trailing envelope's, equal to
        // the stored bytes' independent hash, never the decoy.
        assert.notEqual(token, decoy);
        assert.equal(token, revisionOf(raw));

        // A replacement whose body copies the read (decoy line included):
        const copiedBody =
            `# Seed\n\n### Facts\n\n- Copied body.\n\n` +
            `docs: revision ${decoy} — internal example line.\n`;
        const replace = await tool.execute(
            {
                add: {
                    mode: "replace",
                    path: "aa/doc.md",
                    expectedRevision: token,
                    metadata: { Area: "aa", Keywords: ["seed"], Summary: "S." },
                    body: copiedBody,
                },
            } as never,
            {} as never,
        );
        assert.equal(replace.metadata?.written, true, String(replace.content));

        // The stored file holds exactly the submitted contents: the read's
        // envelope never persisted as document content — the decoy line is
        // there only because the caller's body carried it, and the real
        // token the READ surfaced does not appear on disk.
        const stored = readFileSync(join(spec.root, "aa/doc.md"), "utf8");
        assert.equal(
            stored,
            serializeDoc(
                { Area: "aa", Keywords: ["seed"], Summary: "S." },
                copiedBody,
            ),
        );
        assert.ok(!stored.includes(token), "the read envelope leaked to disk");
        assert.ok(
            String(replace.content).includes("the newly published bytes"),
        );

        // The write's own trailing envelope is the fresh bytes' hash and is
        // immediately usable for a further replace.
        const fresh = tokenFrom(String(replace.content));
        const again = await tool.execute(
            {
                add: {
                    mode: "replace",
                    path: "aa/doc.md",
                    expectedRevision: fresh,
                    metadata: { Area: "aa", Keywords: ["seed"], Summary: "S." },
                    body: "# Seed\n\n### Facts\n\n- Third body.\n",
                },
            } as never,
            {} as never,
        );
        assert.equal(again.metadata?.written, true, String(again.content));
    });
});
/* ------------------------------------------------------------------ *
 * F09: accepted knowledge writes are collectable; invisible paths refuse
 * ------------------------------------------------------------------ */

import { collectDocPaths, uncollectedSegment } from "../src/index.ts";
import type { LakeProfile } from "../src/index.ts";

/** A valid create request; tests override Area or path as needed. */
const addRequest = (overrides: Record<string, unknown> = {}) => ({
    mode: "create",
    metadata: {
        Area: "kk",
        Keywords: ["quark", "flow", "knowledge"],
        Summary: "Fresh quark-flow knowledge.",
    },
    body: "# Fresh Quark Flow\n\n### Facts\n\n- The quark flow is documented.\n",
    ...overrides,
});

const lakeTool = () => {
    const spec = knowledgeSpec();
    return { spec, tool: createDocsTool({ lakes: createLakes([spec]) }) };
};

describe("F09: writes invisible to collection refuse at the boundary", () => {
    it("a derived create whose Area is a scratch area refuses (F09)", async () => {
        const { spec, tool } = lakeTool();
        const result = await tool.execute(
            { add: addRequest({ metadata: { ...addRequest().metadata, Area: "plans" } }) } as never,
            {} as never,
        );
        const content = String(result.content);
        assert.match(content, /never collected/);
        assert.match(content, /plans/);
        assert.ok(!existsSync(join(spec.root, "plans")), "no file written");
    });

    it("a hidden or dependency directory refuses, top level or nested (F09)", async () => {
        const { spec, tool } = lakeTool();
        for (const [path, segment] of [
            [".hidden/x.md", ".hidden"],
            ["node_modules/x.md", "node_modules"],
            ["aa/.b/c.md", ".b"],
        ] as Array<[string, string]>) {
            const result = await tool.execute(
                {
                    add: addRequest({
                        metadata: { ...addRequest().metadata, Area: "kk" },
                        path,
                    }),
                } as never,
                {} as never,
            );
            assert.match(String(result.content), /never collected/, path);
            assert.match(String(result.content), new RegExp(segment), path);
        }
        assert.deepEqual(collectDocPaths(spec.root, { profile: "knowledge" }), []);
    });

    it("an accepted write is then genuinely findable and readable (F09)", async () => {
        const { spec, tool } = lakeTool();
        const written = await tool.execute(
            { add: addRequest({ path: "kk/flow-note.md" }) } as never,
            {} as never,
        );
        assert.match(String(written.content), /docs: revision/);
        assert.ok(existsSync(join(spec.root, "kk/flow-note.md")));
        // Collected and searchable, not merely written.
        const found = await tool.execute(
            { search: "quark flow" } as never,
            {} as never,
        );
        assert.match(String(found.content), /kk\/flow-note\.md/);
        const read = await tool.execute(
            { read: "kk/flow-note.md" } as never,
            {} as never,
        );
        assert.match(String(read.content), /# Fresh Quark Flow/);
    });

    it("a replace targeting an invisible doc refuses (F09)", async () => {
        const { spec, tool } = lakeTool();
        mkdirSync(join(spec.root, "plans"), { recursive: true });
        const raw =
            "---\nArea: kk\nKeywords: quark-flow\nSummary: Hidden doc.\n---\n\n" +
            "### Facts\n\n# Invisible\n\n- Body.\n";
        writeFileSync(join(spec.root, "plans", "old.md"), raw);
        // The doc exists on disk but collection never sees it; replace must
        // refuse rather than succeed invisibly.
        const result = await tool.execute(
            {
                add: {
                    mode: "replace",
                    path: "plans/old.md",
                    metadata: addRequest().metadata,
                    body: "# Fresh Quark Flow\n\n### Facts\n\n- Replacement.\n",
                    expectedRevision: revisionOf(raw),
                },
            } as never,
            {} as never,
        );
        assert.match(String(result.content), /never collected/);
        assert.match(String(result.content), /plans/);
    });

    it("the shared rule drives both collection and the write validation (F09)", () => {
        const cases: Array<[string, "knowledge" | "wiki", string | null]> = [
            ["plans/x.md", "knowledge", "plans"],
            ["plans/x.md", "wiki", null],
            ["wiki/w.md", "knowledge", "wiki"],
            ["wiki/w.md", "wiki", null],
            [".h/x.md", "knowledge", ".h"],
            ["node_modules/x.md", "knowledge", "node_modules"],
            ["aa/.b/x.md", "knowledge", ".b"],
            ["aa/x.md", "knowledge", null],
            ["zz.md", "knowledge", null],
        ];
        for (const [path, profile, expected] of cases) {
            assert.equal(
                uncollectedSegment(path, profile as LakeProfile),
                expected,
                `${path} (${profile})`,
            );
        }
        // The walk agrees with the predicate on a real tree: an excluded
        // top-level Area, a dot dir, node_modules and a nested hidden dir all
        // drop; ordinary paths stay.
        const { spec: tree } = lakeTool();
        for (const relative of [
            "plans/x.md",
            "aa/x.md",
            "aa/.b/x.md",
            ".h/x.md",
            "node_modules/x.md",
            "zz.md",
        ]) {
            const target = join(tree.root, relative);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, "# x\n\n### Facts\n\n- x\n");
        }
        assert.deepEqual(
            collectDocPaths(tree.root, { profile: "knowledge" }),
            ["aa/x.md", "zz.md"],
        );
    });
});
