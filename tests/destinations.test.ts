import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CLASS_LABELS,
    classGuidance,
    createDocsCommand,
    createDocsTool,
    createLakes,
    resolveLakes,
    type LakeSpec,
} from "../src/index.ts";
import placementCases from "./fixtures/placement-cases.json" with { type: "json" };

const cleanups: string[] = [];

after(() => {
    for (const dir of cleanups) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh scratch directory, removed after the suite. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "docs-destinations-"));
    cleanups.push(dir);
    return dir;
}

/** A lake spec over a real (created unless `missing`) root. */
function spec(
    name: string,
    lakeClass: LakeSpec["class"],
    options: {
        description?: string;
        missing?: boolean;
        writable?: boolean;
    } = {},
): LakeSpec {
    const root =
        options.missing === true ? join(tempDir(), "absent", name) : tempDir();
    return {
        name,
        class: lakeClass,
        root,
        profile: lakeClass === "wiki" ? "wiki" : "knowledge",
        writable: options.writable ?? lakeClass !== "wiki",
        ...(options.description !== undefined
            ? { description: options.description }
            : {}),
    };
}

/** The docs tool over real lakes. */
function toolOf(specs: readonly LakeSpec[]): ReturnType<typeof createDocsTool> {
    return createDocsTool({ lakes: createLakes(specs) });
}

/** A valid create payload; the identity is distinctive and unused elsewhere. */
function addPayload(title: string): {
    mode: "create";
    metadata: { Area: string; Keywords: string[]; Summary: string };
    body: string;
} {
    return {
        mode: "create",
        metadata: {
            Area: "aa",
            Keywords: [title],
            Summary: `${title} summary.`,
        },
        body: `# ${title}\n\n### Facts\n\n- ${title} fact.\n`,
    };
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

describe("class labels", () => {
    it("pairs every configured class with its display label", () => {
        assert.deepEqual(CLASS_LABELS, {
            repo: "Repository",
            machine: "Personal",
            global: "Organisation",
            wiki: "Wiki",
        });
    });

    it("gives every class default guidance", () => {
        for (const lakeClass of [
            "repo",
            "machine",
            "global",
            "wiki",
        ] as const) {
            assert.match(classGuidance(lakeClass), /\w/);
        }
    });
});

describe("lake descriptions", () => {
    it("loads existing four-class configs unchanged (P01)", () => {
        // Arrange – the shape every existing config uses: three classes in a
        // base file, no repo lake, so the implicit one is appended.
        const location = tempDir();
        const base = join(tempDir(), "lakes.json");
        const machine = spec("doclake", "machine").root;
        const global = spec("global", "global").root;
        const wiki = spec("wiki", "wiki").root;
        writeFileSync(
            base,
            JSON.stringify({
                lakes: [
                    { class: "machine", root: machine, name: "doclake" },
                    { class: "global", root: global, name: "global" },
                    { class: "wiki", root: wiki, name: "wiki" },
                ],
            }),
        );

        // Act
        const specs = resolveLakes({ lakesFile: base }, location);

        // Assert – classes, names, roots, profiles and capabilities keep their
        // meaning; the implicit repo lake closes the list.
        assert.deepEqual(
            specs.map((s) => [s.name, s.class, s.profile, s.writable]),
            [
                ["doclake", "machine", "knowledge", true],
                ["global", "global", "knowledge", true],
                ["wiki", "wiki", "wiki", false],
                ["docs", "repo", "knowledge", true],
            ],
        );
        assert.equal(specs[0]?.root, machine);
    });

    it("carries descriptions from every configuration source (P02)", () => {
        // Arrange – bare-array base file, inline lakes, and the repo file.
        const location = tempDir();
        mkdirSync(join(location, ".opencode"), { recursive: true });
        const base = join(tempDir(), "lakes.json");
        const machine = spec("doclake", "machine").root;
        writeFileSync(
            base,
            JSON.stringify([
                {
                    class: "machine",
                    root: machine,
                    name: "doclake",
                    description: "Personal devices and tooling preferences.",
                },
            ]),
        );
        writeFileSync(
            join(location, ".opencode/docs-lakes.json"),
            JSON.stringify([
                {
                    root: "documentation",
                    name: "docs",
                    description: "This repository's decisions and traps.",
                },
            ]),
        );

        // Act – inline adds a global lake beside the file sources.
        const specs = resolveLakes(
            {
                lakesFile: base,
                lakes: [
                    {
                        class: "global",
                        root: spec("global", "global").root,
                        name: "global",
                        description: " Organisation-wide standards. ",
                    },
                ],
            },
            location,
        );

        // Assert – descriptions survive the merge, trimmed, in discovery.
        const byName = new Map(specs.map((s) => [s.name, s]));
        assert.equal(
            byName.get("doclake")?.description,
            "Personal devices and tooling preferences.",
        );
        assert.equal(
            byName.get("global")?.description,
            "Organisation-wide standards.",
        );
        assert.equal(
            byName.get("docs")?.description,
            "This repository's decisions and traps.",
        );
        assert.equal(byName.get("docs")?.root, join(location, "documentation"));
    });

    it("carries the root-sugar description option (P02)", () => {
        const location = tempDir();
        const root = spec("docs", "repo").root;

        const specs = resolveLakes(
            { root, name: "docs", description: "Repository decisions." },
            location,
        );

        assert.equal(specs[0]?.description, "Repository decisions.");
    });

    it("rejects description without root, like name (P02)", () => {
        assert.throws(
            () => resolveLakes({ description: "x" }, tempDir()),
            /'description' describes the 'root' lake/,
        );
    });

    it("treats omitted, empty and whitespace-only descriptions as absent (P03)", () => {
        const location = tempDir();
        const roots = [tempDir(), tempDir(), tempDir()];

        const specs = resolveLakes(
            {
                lakes: [
                    { root: roots[0], name: "a", description: "" },
                    { root: roots[1], name: "b", description: "   \n\t " },
                    { root: roots[2], name: "c" },
                ],
            },
            location,
        );

        for (const s of specs) {
            assert.equal(s.description, undefined);
        }
    });

    it("throws clearly on a non-string description (P03)", () => {
        const location = tempDir();
        assert.throws(
            () =>
                resolveLakes(
                    { lakes: [{ root: tempDir(), description: 42 }] },
                    location,
                ),
            /description must be a string, got 42/,
        );
    });

    it("falls back to class guidance in help when undescribed (P03)", async () => {
        const tool = toolOf([
            spec("doclake", "machine", {
                description: "Personal devices and tooling.",
            }),
            spec("docs", "repo"),
        ]);
        const result = await tool.execute({ search: "help" }, {} as never);
        const content = String(result.content);

        assert.match(
            content,
            /Personal \[machine\][^\n]*\n {2}Personal devices/,
        );
        assert.match(
            content,
            /Repository \[repo\][^\n]*\n {2}knowledge needed to understand or maintain this repository/,
        );
    });
});

describe("write destination selection", () => {
    it("writes to the sole writable lake when lake is omitted (P04)", async () => {
        // Arrange – one writable machine lake beside read-only company.
        const personal = spec("doclake", "machine", {
            description: "Personal devices and tooling.",
        });
        const archive = spec("archive", "repo", { writable: false });
        const wiki = spec("wiki", "wiki");
        const tool = toolOf([personal, archive, wiki]);

        // Act
        const result = await tool.execute(
            { add: addPayload("Alpha note") } as never,
            {} as never,
        );

        // Assert – the only writable knowledge lake takes it; nothing else.
        assert.equal(result.metadata?.written, true);
        assert.match(
            String(result.content),
            /^doclake:aa\/alpha-note\.md — created/,
        );
        assert.match(
            readFileSync(join(personal.root, "aa/alpha-note.md"), "utf8"),
            /^---\nArea: aa/,
        );
        assert.equal(existsSync(join(archive.root, "aa")), false);
    });

    it("refuses two writable lakes with candidates and no mutation (P05)", async () => {
        // Arrange – two same-class writable lakes; snapshot every byte.
        const a = spec("alpha", "machine", {
            description: "Workstation setup.",
        });
        const b = spec("beta", "machine", {
            description: "Household devices.",
        });
        const tool = toolOf([a, b]);
        const before = [snapshot(a.root), snapshot(b.root)];

        // Act
        const result = await tool.execute(
            { add: addPayload("Alpha note") } as never,
            {} as never,
        );

        // Assert – refusal names both candidates; not one byte moved; no new
        // doc or area directory anywhere.
        assert.equal(result.metadata?.written, false);
        const content = String(result.content);
        assert.match(content, /pass lake/);
        assert.match(
            content,
            /alpha \(Personal \[machine\]\).*— Workstation setup\./,
        );
        assert.match(
            content,
            /beta \(Personal \[machine\]\).*— Household devices\./,
        );
        assert.deepEqual(snapshot(a.root), before[0]);
        assert.deepEqual(snapshot(b.root), before[1]);
        assert.equal(existsSync(join(a.root, "aa")), false);
        assert.equal(existsSync(join(b.root, "aa")), false);
    });

    it("refuses two writable lakes of different classes the same way (P05)", async () => {
        const a = spec("docs", "repo");
        const b = spec("doclake", "machine");
        const tool = toolOf([a, b]);

        const result = await tool.execute(
            { add: addPayload("Alpha note") } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /pass lake/);
    });

    it("counts a missing-root lake in the ambiguity refusal (P06)", async () => {
        // Arrange – one healthy, one dormant writable lake.
        const here = spec("here", "machine", { description: "Present." });
        const gone = spec("gone", "machine", { missing: true });
        const tool = toolOf([here, gone]);
        const before = snapshot(here.root);

        // Act
        const result = await tool.execute(
            { add: addPayload("Alpha note") } as never,
            {} as never,
        );

        // Assert – the available lake is not silently selected; the missing
        // root is not created.
        assert.equal(result.metadata?.written, false);
        const content = String(result.content);
        assert.match(content, /here \(Personal \[machine\]\).*— Present\./);
        assert.match(content, /gone \(Personal \[machine\]\).*— missing root/);
        assert.deepEqual(snapshot(here.root), before);
        assert.equal(existsSync(gone.root), false);
    });

    it("writes only the explicitly selected lake in an ambiguous config (P07)", async () => {
        const a = spec("alpha", "machine");
        const b = spec("beta", "machine");
        const tool = toolOf([a, b]);
        const beforeA = snapshot(a.root);

        const result = await tool.execute(
            { lake: "beta", add: addPayload("Alpha note") } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, true);
        assert.match(
            String(result.content),
            /^beta:aa\/alpha-note\.md — created/,
        );
        assert.deepEqual(snapshot(a.root), beforeA);
        assert.ok(existsSync(join(b.root, "aa/alpha-note.md")));
    });

    it("never falls back from an unknown, read-only or missing-root lake (P08)", async () => {
        // Arrange – a writable lake exists, but each explicit choice is unusable.
        const personal = spec("doclake", "machine");
        const archive = spec("archive", "repo", { writable: false });
        const wiki = spec("wiki", "wiki");
        const gone = spec("ghost", "machine", { missing: true });
        const tool = toolOf([personal, archive, wiki, gone]);
        const before = [
            snapshot(personal.root),
            snapshot(archive.root),
            snapshot(wiki.root),
        ];
        const add = addPayload("Alpha note");

        // Act
        const unknown = await tool.execute(
            { lake: "nope", add } as never,
            {} as never,
        );
        const readOnly = await tool.execute(
            { lake: "archive", add } as never,
            {} as never,
        );
        const wikiLake = await tool.execute(
            { lake: "wiki", add } as never,
            {} as never,
        );
        const missingRoot = await tool.execute(
            { lake: "ghost", add } as never,
            {} as never,
        );

        // Assert – four refusals, zero bytes moved anywhere.
        for (const result of [unknown, readOnly, wikiLake, missingRoot]) {
            assert.equal(result.metadata?.written, false);
        }
        assert.match(String(unknown.content), /no lake named 'nope'/);
        assert.match(String(readOnly.content), /read-only/);
        assert.match(String(wikiLake.content), /read-only/);
        assert.match(String(missingRoot.content), /does not exist/);
        assert.deepEqual(snapshot(personal.root), before[0]);
        assert.deepEqual(snapshot(archive.root), before[1]);
        assert.deepEqual(snapshot(wiki.root), before[2]);
    });

    it("refuses with no mutation when nothing is writable (P09)", async () => {
        const archive = spec("archive", "repo", { writable: false });
        const wiki = spec("wiki", "wiki");
        const tool = toolOf([archive, wiki]);
        const before = [snapshot(archive.root), snapshot(wiki.root)];

        const result = await tool.execute(
            { add: addPayload("Alpha note") } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, false);
        assert.match(
            String(result.content),
            /no writable knowledge lake is configured/,
        );
        assert.deepEqual(snapshot(archive.root), before[0]);
        assert.deepEqual(snapshot(wiki.root), before[1]);
    });

    it("routes the Code Mode twin and command through the same core (P10)", async () => {
        // Arrange – one ambiguous config, three registrations of one core.
        const a = spec("alpha", "machine");
        const b = spec("beta", "machine");
        const lakes = createLakes([a, b]);
        const native = createDocsTool({ lakes });
        const twin = createDocsTool(
            { lakes },
            { name: "docs_search", codemode: true },
        );
        const sent: string[] = [];
        const command = createDocsCommand({
            lakes,
            prompt: async (_sessionID: string, text: string) => {
                sent.push(text);
            },
        });

        // Act – the same omitted-lake write through native and twin.
        const nativeResult = await native.execute(
            { add: addPayload("Alpha note") } as never,
            {} as never,
        );
        const twinResult = await twin.execute(
            { add: addPayload("Alpha note") } as never,
            {} as never,
        );
        await command.execute({
            sessionID: "ses_x",
            prompt: { text: "check" },
        } as never);

        // Assert – identical routing outcome; the command shares the runtime.
        assert.equal(nativeResult.metadata?.written, false);
        assert.equal(twinResult.metadata?.written, false);
        assert.equal(String(nativeResult.content), String(twinResult.content));
        assert.match(String(nativeResult.content), /pass lake/);
        assert.match(sent[0] ?? "", /alpha|beta/);
    });

    it("keeps search, read and check untouched by descriptions (P11)", async () => {
        // Arrange – a wiki whose description carries a unique nonsense term.
        const wikiRoot = tempDir();
        writeFileSync(
            join(wikiRoot, "gateway.md"),
            "# Gateway\n\nGateway routing zqx elsewhere.\n",
        );
        const wiki = spec("wiki", "wiki", {
            description: "Human narrative about quantum flux zqx9.",
        });
        wiki.root = wikiRoot;
        const repo = spec("docs", "repo");
        const withDescription = toolOf([wiki, repo]);
        const bare = spec("wiki", "wiki");
        bare.root = wikiRoot;
        const withoutDescription = toolOf([bare, repo]);

        // Act
        const described = await withDescription.execute(
            { search: "gateway" },
            {} as never,
        );
        const undescribed = await withoutDescription.execute(
            { search: "gateway" },
            {} as never,
        );
        const contamination = await withDescription.execute(
            { search: "zqx9" },
            {} as never,
        );
        const read = await withDescription.execute(
            { read: "wiki:gateway.md" },
            {} as never,
        );

        // Assert – relevance is unchanged by the description, which is not
        // indexed; reads stay verbatim.
        assert.equal(String(described.content), String(undescribed.content));
        assert.match(String(described.content), /gateway\.md/);
        assert.match(
            String(contamination.content),
            /No knowledge docs matched/,
        );
        assert.match(String(read.content), /Gateway routing/);
    });

    it("keeps refusals and explicit writes stable across lake reordering (P12)", async () => {
        const a = spec("alpha", "machine");
        const b = spec("beta", "machine");

        const reordered = toolOf([b, a]);
        const refused = await reordered.execute(
            { add: addPayload("Alpha note") } as never,
            {} as never,
        );
        const explicit = await reordered.execute(
            { lake: "alpha", add: addPayload("Beta note") } as never,
            {} as never,
        );

        assert.equal(refused.metadata?.written, false);
        assert.match(String(refused.content), /alpha/);
        assert.match(String(refused.content), /beta/);
        assert.equal(explicit.metadata?.written, true);
        assert.match(
            String(explicit.content),
            /^alpha:aa\/beta-note\.md — created/,
        );
    });
});

describe("placement evaluation fixture", () => {
    const EXPECTED = new Set([
        "Repository",
        "Personal",
        "Organisation",
        "Instructions",
        "Wiki",
        "linked: Organisation + Repository",
        "clarify",
    ]);

    it("carries every case with claim, destinations, expectation and trap", () => {
        assert.ok(Array.isArray(placementCases) && placementCases.length >= 16);
        const ids = new Set<string>();
        for (const testCase of placementCases) {
            assert.ok(testCase.id, "every case names an id");
            assert.ok(
                !ids.has(testCase.id),
                `duplicate case id ${testCase.id}`,
            );
            ids.add(testCase.id);
            assert.ok(
                testCase.claim.length > 10,
                `${testCase.id} states a claim`,
            );
            assert.ok(
                Array.isArray(testCase.destinations) &&
                    testCase.destinations.length > 0,
                `${testCase.id} lists destinations`,
            );
            for (const destination of testCase.destinations) {
                assert.ok(
                    ["repo", "machine", "global", "wiki"].includes(
                        destination.class,
                    ),
                    `${testCase.id} has a valid destination class`,
                );
            }
            assert.ok(
                EXPECTED.has(testCase.expected),
                `${testCase.id} expects a known choice: ${testCase.expected}`,
            );
            assert.ok(
                testCase.temptingWrong.length > 0,
                `${testCase.id} names the tempting wrong answer`,
            );
        }
        for (const id of ["E01", "E02", "E07", "E11", "E14", "E16"]) {
            assert.ok(ids.has(id), `the fixture lacks required case ${id}`);
        }
    });
});
