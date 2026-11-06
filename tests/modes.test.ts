import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import {
    createDocsTool,
    createLakes,
    DOCS_INPUT,
    type DocsInput,
    type LakeSpec,
} from "../src/index.ts";

const cleanups: string[] = [];

after(() => {
    for (const dir of cleanups) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh scratch directory, removed after the suite. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "docs-modes-"));
    cleanups.push(dir);
    return dir;
}

/** A lake spec over a real root, created unless `missing`. */
function spec(
    name: string,
    lakeClass: LakeSpec["class"],
    options: { missing?: boolean; writable?: boolean } = {},
): LakeSpec {
    const root =
        options.missing === true ? join(tempDir(), "absent", name) : tempDir();
    return {
        name,
        class: lakeClass,
        root,
        profile: lakeClass === "wiki" ? "wiki" : "knowledge",
        writable: options.writable ?? lakeClass !== "wiki",
    };
}

/** The docs tool over real lakes. */
function toolOf(specs: readonly LakeSpec[]): ReturnType<typeof createDocsTool> {
    return createDocsTool({ lakes: createLakes(specs) });
}

/** A create DTO for the given title, overridable per test. */
function createPayload(
    title = "Fresh",
    overrides: Record<string, unknown> = {},
): DocsInput["add"] {
    return {
        mode: "create",
        metadata: { Area: "aa", Keywords: [title], Summary: `${title} doc.` },
        body: `# ${title}\n\n### Facts\n\n- ${title} fact.\n`,
        ...overrides,
    };
}

/** A replace DTO targeting `path`. */
function replacePayload(
    path: string,
    title = "Fresh",
    overrides: Record<string, unknown> = {},
): DocsInput["add"] {
    return {
        mode: "replace",
        path,
        metadata: { Area: "aa", Keywords: [title], Summary: `${title} doc.` },
        body: `# ${title}\n\n### Facts\n\n- ${title} fact.\n`,
        ...overrides,
    };
}

/** Seed a compliant doc at `path` under `root` and return its bytes. */
function seed(root: string, path: string, title = "Existing"): string {
    const raw =
        `---\nArea: ${path.split("/")[0]}\nKeywords: seed\nSummary: Seeded.\n` +
        `---\n\n# ${title}\n\n### Facts\n\n- Original body.\n`;
    mkdirSync(join(root, path.split("/").slice(0, -1).join("/")), {
        recursive: true,
    });
    writeFileSync(join(root, path), raw);
    return raw;
}

/** Every file under a root, by absolute path — for byte-identical asserts. */
function snapshot(root: string): Map<string, string> {
    const files = new Map<string, string>();
    if (!existsSync(root)) {
        return files;
    }
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else {
                files.set(path, readFileSync(path, "utf8"));
            }
        }
    };
    walk(root);
    return files;
}

describe("create and replace contracts", () => {
    it("creates at the derived path with serialised contents (C01)", async () => {
        const lake = spec("docs", "repo");
        const tool = toolOf([lake]);

        const result = await tool.execute(
            { add: createPayload("Fresh note") } as never,
            {} as never,
        );

        // Assert – exactly one new file, correctly serialised.
        assert.equal(result.metadata?.written, true);
        assert.match(String(result.content), /^aa\/fresh-note\.md — created/);
        const written = readFileSync(
            join(lake.root, "aa/fresh-note.md"),
            "utf8",
        );
        assert.equal(
            written,
            "---\nArea: aa\nKeywords: Fresh note\nSummary: Fresh note doc.\n" +
                "---\n\n# Fresh note\n\n### Facts\n\n- Fresh note fact.\n",
        );
    });

    it("creates at an explicit new path under the full checks (C02)", async () => {
        const lake = spec("docs", "repo");
        const tool = toolOf([lake]);

        const result = await tool.execute(
            {
                add: createPayload("Fresh note", { path: "aa/own.md" }),
            } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, true);
        assert.match(String(result.content), /^aa\/own\.md — created/);
        assert.ok(existsSync(join(lake.root, "aa/own.md")));
    });

    it("refuses an explicit-path create on a near-twin identity (C03)", async () => {
        // Arrange – the lake holds a near-twin; the create names a NEW path.
        // This is the case the old explicit-path bypass let through.
        const lake = spec("docs", "repo");
        const twin = seed(lake.root, "aa/target.md", "Fresh");
        const tool = toolOf([lake]);

        const result = await tool.execute(
            {
                add: createPayload("Fresh", { path: "aa/distinct.md" }),
            } as never,
            {} as never,
        );

        // Assert – refused, the twin byte-identical, the target absent.
        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /near-twin/);
        assert.equal(
            readFileSync(join(lake.root, "aa/target.md"), "utf8"),
            twin,
        );
        assert.equal(existsSync(join(lake.root, "aa/distinct.md")), false);
    });

    it("refuses the same twin on a derived path with candidates (C04)", async () => {
        const lake = spec("docs", "repo");
        seed(lake.root, "aa/target.md", "Fresh");
        const tool = toolOf([lake]);

        const result = await tool.execute(
            { add: createPayload("Fresh") } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /aa\/target\.md/);
        // The refusal explains both deliberate ways forward.
        assert.match(String(result.content), /mode:"replace"/);
        assert.match(String(result.content), /allowNearTwinReason/);
    });

    it("never overwrites through create, override reason or not (C05)", async () => {
        const lake = spec("docs", "repo");
        const existing = seed(lake.root, "aa/fresh.md", "Fresh");
        const tool = toolOf([lake]);

        // Without a reason the near-twin guard refuses first; with one, the
        // publication-boundary existence check refuses. Either way: no write.
        const twin = await tool.execute(
            { add: createPayload("Fresh") } as never,
            {} as never,
        );
        assert.equal(twin.metadata?.written, false);
        assert.match(String(twin.content), /near-twin/);

        const override = await tool.execute(
            {
                add: createPayload("Fresh", {
                    allowNearTwinReason: "Deliberately distinct.",
                }),
            } as never,
            {} as never,
        );
        assert.equal(override.metadata?.written, false);
        assert.match(String(override.content), /already exists/);

        assert.equal(
            readFileSync(join(lake.root, "aa/fresh.md"), "utf8"),
            existing,
        );
    });

    it("replaces precisely the named doc through mode:replace (C06)", async () => {
        const lake = spec("docs", "repo");
        seed(lake.root, "aa/fresh.md", "Old");
        seed(lake.root, "aa/other.md", "Other");
        const tool = toolOf([lake]);

        const result = await tool.execute(
            { add: replacePayload("aa/fresh.md", "Fresh") } as never,
            {} as never,
        );

        // Assert – the named file replaced wholesale; its neighbour untouched.
        assert.equal(result.metadata?.written, true);
        assert.match(String(result.content), /^aa\/fresh\.md — replaced/);
        const replaced = readFileSync(join(lake.root, "aa/fresh.md"), "utf8");
        assert.match(replaced, /# Fresh/);
        assert.doesNotMatch(replaced, /Original body/);
        assert.match(
            readFileSync(join(lake.root, "aa/other.md"), "utf8"),
            /# Other/,
        );
    });

    it("refuses replace on a missing target or an omitted path (C07)", async () => {
        const lake = spec("docs", "repo");
        const tool = toolOf([lake]);
        const before = snapshot(lake.root);

        const missing = await tool.execute(
            { add: replacePayload("aa/absent.md", "Fresh") } as never,
            {} as never,
        );
        const noPath = await tool.execute(
            {
                add: {
                    mode: "replace",
                    metadata: {
                        Area: "aa",
                        Keywords: ["Fresh"],
                        Summary: "Fresh doc.",
                    },
                    body: "# Fresh\n\n### Facts\n\n- x.\n",
                },
            } as never,
            {} as never,
        );

        assert.equal(missing.metadata?.written, false);
        assert.match(String(missing.content), /no doc at/);
        assert.match(String(missing.content), /mode:"create"/);
        assert.equal(noPath.metadata?.written, false);
        assert.match(String(noPath.content), /replace requires the path/);
        assert.deepEqual(snapshot(lake.root), before);
    });

    it("rejects missing and unknown modes with no writes (C08)", async () => {
        const lake = spec("docs", "repo");
        const tool = toolOf([lake]);
        const before = snapshot(lake.root);

        const noMode: Record<string, unknown> = {
            ...createPayload("Fresh")!,
        };
        delete noMode.mode;
        const missing = await tool.execute(
            { add: noMode } as never,
            {} as never,
        );
        const unknown = await tool.execute(
            { add: { ...createPayload("Fresh"), mode: "update" } } as never,
            {} as never,
        );

        assert.equal(missing.metadata?.written, false);
        assert.match(
            String(missing.content),
            /mode is required and must be "create"/,
        );
        assert.equal(unknown.metadata?.written, false);
        assert.match(String(unknown.content), /mode is required/);
        assert.deepEqual(snapshot(lake.root), before);
    });

    it("marks the registered schema as requiring mode (C08)", () => {
        // The host derives its validation from this document; `mode` must be
        // required there, not only in the runtime guard.
        const document = Schema.toJsonSchemaDocument(
            DOCS_INPUT as never,
        ) as unknown as {
            schema: {
                properties: {
                    add: { anyOf: Array<{ required?: string[] }> };
                };
            };
        };
        const add = document.schema.properties.add.anyOf.find((branch) =>
            Array.isArray(branch.required),
        );
        assert.ok(add?.required?.includes("mode"));
    });

    it("creates past a near-twin with a meaningful override reason (C09)", async () => {
        const lake = spec("docs", "repo");
        const twin = seed(lake.root, "aa/target.md", "Fresh");
        const tool = toolOf([lake]);

        const result = await tool.execute(
            {
                add: createPayload("Fresh", {
                    path: "aa/distinct.md",
                    allowNearTwinReason:
                        "Operator workflow, not the design rationale.",
                }),
            } as never,
            {} as never,
        );

        // Assert – created, reported compactly, the twin untouched, and no
        // override field persisted into the front-matter.
        assert.equal(result.metadata?.written, true);
        assert.match(
            String(result.content),
            /— created\. near-twin overridden\./,
        );
        assert.equal(
            readFileSync(join(lake.root, "aa/target.md"), "utf8"),
            twin,
        );
        const written = readFileSync(join(lake.root, "aa/distinct.md"), "utf8");
        assert.doesNotMatch(written, /allowNearTwinReason|override/);
    });

    it("rejects blank, whitespace and non-string override reasons (C10)", async () => {
        const lake = spec("docs", "repo");
        seed(lake.root, "aa/target.md", "Fresh");
        const tool = toolOf([lake]);
        const before = snapshot(lake.root);
        const cases = [
            { allowNearTwinReason: "" },
            { allowNearTwinReason: "   \n\t " },
            { allowNearTwinReason: 42 },
        ];

        for (const overrides of cases) {
            const result = await tool.execute(
                { add: createPayload("Fresh", overrides) } as never,
                {} as never,
            );
            assert.equal(
                result.metadata?.written,
                false,
                JSON.stringify(overrides),
            );
            assert.match(
                String(result.content),
                /allowNearTwinReason must be a non-blank explanation/,
            );
        }

        const onReplace = await tool.execute(
            {
                add: replacePayload("aa/target.md", "Fresh", {
                    allowNearTwinReason: "Not applicable in replace.",
                }),
            } as never,
            {} as never,
        );
        assert.equal(onReplace.metadata?.written, false);
        assert.match(
            String(onReplace.content),
            /allowNearTwinReason is create-only/,
        );
        assert.deepEqual(snapshot(lake.root), before);
    });

    it("lets no guard be bypassed by the override (C11)", async () => {
        const lake = spec("docs", "repo");
        const outside = tempDir();
        writeFileSync(join(outside, "evil.md"), "# outside\n");
        seed(lake.root, "aa/target.md", "Fresh");
        symlinkSync(join(outside, "evil.md"), join(lake.root, "aa/link.md"));
        const tool = toolOf([lake]);
        const reason = { allowNearTwinReason: "Deliberately distinct." };
        const before = snapshot(lake.root);
        const cases: Array<[string, DocsInput["add"]]> = [
            [
                "blank metadata",
                createPayload("Fresh", {
                    ...reason,
                    metadata: { Area: "aa", Keywords: ["Fresh"], Summary: "" },
                }),
            ],
            [
                "no claim section",
                createPayload("Fresh", {
                    ...reason,
                    body: "# Fresh\n\nJust prose, no claims.\n",
                }),
            ],
            [
                "path traversal",
                createPayload("Fresh", { ...reason, path: "../outside.md" }),
            ],
            [
                "non-.md target",
                createPayload("Fresh", { ...reason, path: "aa/x.txt" }),
            ],
            [
                "symlinked target",
                createPayload("Fresh", { ...reason, path: "aa/link.md" }),
            ],
        ];

        for (const [name, payload] of cases) {
            const result = await tool.execute(
                { add: payload } as never,
                {} as never,
            );
            assert.equal(result.metadata?.written, false, name);
        }
        assert.deepEqual(snapshot(lake.root), before);
        // The symlink's outside target is untouched too.
        assert.equal(
            readFileSync(join(outside, "evil.md"), "utf8"),
            "# outside\n",
        );
    });

    it("keeps the same identity in two lakes legitimate (C12)", async () => {
        const a = spec("alpha", "machine");
        const b = spec("beta", "machine");
        const tool = toolOf([a, b]);

        const first = await tool.execute(
            { lake: "alpha", add: createPayload("Fresh") } as never,
            {} as never,
        );
        const second = await tool.execute(
            { lake: "beta", add: createPayload("Fresh") } as never,
            {} as never,
        );

        assert.equal(first.metadata?.written, true);
        assert.equal(second.metadata?.written, true);
        assert.match(String(first.content), /^alpha:aa\/fresh\.md — created/);
        assert.match(String(second.content), /^beta:aa\/fresh\.md — created/);
    });

    it("keeps one winner when two creates race the same path (C13)", async () => {
        // Arrange – a seam lake whose collect() is a frozen snapshot, so the
        // second caller prepares against stale entries, but whose exists()
        // sees the live map at the publication boundary.
        const lake = spec("docs", "repo");
        const live = new Map<string, string>();
        let frozen: string[] = [];
        const lakeSeam = {
            ...lake,
            linkCheck: false,
            collect: () =>
                frozen.map((path) => ({
                    path,
                    lake: lake.name,
                    class: lake.class,
                    area: path.split("/")[0] ?? "",
                    date: "",
                    title: "Seeded",
                    summary: "Seeded.",
                    keywords: ["seed"],
                    identifiers: [],
                    text: "",
                })),
            exists: (path: string) => live.has(path),
            read: (path: string) => live.get(path) ?? "",
            write: (path: string, contents: string) => {
                live.set(path, contents);
            },
        };
        const tool = createDocsTool({ lakes: [lakeSeam] });

        // Act – the first create wins; the second prepared from the same
        // frozen view races for the same derived path.
        const first = await tool.execute(
            { add: createPayload("Fresh note") } as never,
            {} as never,
        );
        const second = await tool.execute(
            {
                add: createPayload("Fresh note", {
                    metadata: {
                        Area: "aa",
                        Keywords: ["Fresh note", "other"],
                        Summary: "Racer.",
                    },
                }),
            } as never,
            {} as never,
        );

        // Assert – one winner, one conflict, the winner's bytes whole.
        assert.equal(first.metadata?.written, true);
        assert.equal(second.metadata?.written, false);
        assert.match(String(second.content), /already exists/);
        const stored = live.get("aa/fresh-note.md") ?? "";
        assert.match(stored, /^---\nArea: aa\n/);
        assert.match(stored, /Fresh note fact\./);
        frozen = [...live.keys()];
    });

    it("refuses when the target appears between preparation and publication (C14)", async () => {
        // Arrange – a seam lake whose collect() freezes the view the add
        // prepares against; the real file system is its publication target.
        const lake = spec("docs", "repo");
        const seamLake = {
            name: lake.name,
            class: lake.class,
            root: lake.root,
            profile: lake.profile,
            writable: true,
            linkCheck: false,
            collect: () => [],
            exists: (path: string) => existsSync(join(lake.root, path)),
            read: (path: string) => readFileSync(join(lake.root, path), "utf8"),
            write: (path: string, contents: string) => {
                mkdirSync(
                    join(lake.root, path.split("/").slice(0, -1).join("/")),
                    {
                        recursive: true,
                    },
                );
                writeFileSync(join(lake.root, path), contents);
            },
        };
        const racingTool = createDocsTool({ lakes: [seamLake] });
        // The racer lands on disk after the (empty) snapshot was taken.
        const racer = seed(lake.root, "aa/fresh.md", "Fresh");

        // Act – a create for the same derived path, prepared against the
        // stale view, published against the live lake.
        const result = await racingTool.execute(
            { add: createPayload("Fresh") } as never,
            {} as never,
        );

        // Assert – refused; the racer's bytes are untouched.
        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /already exists/);
        assert.equal(
            readFileSync(join(lake.root, "aa/fresh.md"), "utf8"),
            racer,
        );
    });

    it("routes the Code Mode twin through the same contracts (P10)", async () => {
        const lake = spec("docs", "repo");
        seed(lake.root, "aa/target.md", "Fresh");
        const lakes = createLakes([lake]);
        const native = createDocsTool({ lakes });
        const twin = createDocsTool(
            { lakes },
            { name: "docs_search", codemode: true },
        );

        // The near-twin create refuses identically on both registrations...
        const nativeRefusal = await native.execute(
            {
                add: createPayload("Fresh", { path: "aa/distinct.md" }),
            } as never,
            {} as never,
        );
        const twinRefusal = await twin.execute(
            {
                add: createPayload("Fresh", { path: "aa/distinct.md" }),
            } as never,
            {} as never,
        );
        assert.equal(
            String(nativeRefusal.content),
            String(twinRefusal.content),
        );
        assert.equal(twinRefusal.metadata?.written, false);

        // ...and an override create writes on both.
        const nativeWrite = await native.execute(
            {
                add: createPayload("Fresh", {
                    path: "aa/distinct.md",
                    allowNearTwinReason: "Distinct on purpose.",
                }),
            } as never,
            {} as never,
        );
        const twinWrite = await twin.execute(
            {
                add: createPayload("Fresh", {
                    path: "aa/second.md",
                    allowNearTwinReason: "Distinct on purpose.",
                }),
            } as never,
            {} as never,
        );
        assert.equal(nativeWrite.metadata?.written, true);
        assert.equal(twinWrite.metadata?.written, true);
    });
});
