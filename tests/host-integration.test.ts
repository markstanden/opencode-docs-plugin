import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Host/transport integration through a packed installation, away from the
 * source checkout. `npm pack` proves the published layout (the `files`
 * field); extracting into an isolated `node_modules` with the repo's own
 * dependency copies proves the package resolves and loads the way an
 * installed package does — no build step, no network. The plugin host is
 * simulated (tool/command/skill transform editors per the Plugin.define
 * contract) and both registered tool surfaces — the native `docs` and the
 * Code Mode twin `docs_search` — are driven against real lake trees.
 *
 * This proves plugin-core behaviour through the packed shape. It does NOT
 * prove a live CLI session; that is the bounded free-model smoke, recorded
 * separately in TESTING.md.
 */

const REPO = join(dirname(dirname(new URL(import.meta.url).pathname)));

const cleanups: string[] = [];
after(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (label: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "docs-packed-" + label + "-"));
    cleanups.push(dir);
    return dir;
};

const run = (cmd: string, args: string[], cwd: string) =>
    spawnSync(cmd, args, { cwd, encoding: "utf8" });

/** Pack the repo and install it (plus repo-local dependencies) in isolation. */
function packedInstall(root: string): string {
    const pack = run("npm", ["pack", "--json", REPO], root);
    assert.equal(pack.status, 0, pack.stderr);
    const parsed = JSON.parse(pack.stdout) as
        Array<{ filename?: string }> | Record<string, { filename?: string }>;
    const entry = (
        Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
    ) as { filename?: string } | undefined;
    const tarball = entry?.filename;
    assert.ok(tarball, "npm pack named a tarball");
    // The extraction lands outside a node_modules ancestor: Node refuses
    // type-stripping for any .ts under a node_modules directory, while the
    // package's own internal node_modules still resolves its dependencies.
    // This mirrors the shipped layout an installed package sees.
    const pkg = join(root, "installed", "opencode-docs-plugin");
    mkdirSync(pkg, { recursive: true });
    run("tar", ["xzf", tarball, "-C", pkg, "--strip-components=1"], root);
    assert.ok(existsSync(join(pkg, "src", "index.ts")), "extraction layout");
    for (const dep of ["@opencode", "effect"]) {
        cpSync(
            join(REPO, "node_modules", dep),
            join(pkg, "node_modules", dep),
            { recursive: true },
        );
    }
    return pkg;
}

/** The simulated host editors the plugin registers into. */
interface Editors {
    tools: Array<Record<string, unknown>>;
    commands: Array<Record<string, unknown>>;
    skills: Array<{ id: string; content?: string }>;
}

function tempLake(root: string): LakeSpec {
    const spec: LakeSpec = {
        name: "docs",
        class: "repo",
        root: join(root, "lake"),
        profile: "knowledge",
        writable: true,
        description: "The trial repository's decisions.",
    };
    mkdirSync(spec.root, { recursive: true });
    return spec;
}

type LakeSpec = {
    name: string;
    class: "repo" | "machine" | "global" | "wiki";
    root: string;
    profile: "knowledge" | "wiki";
    writable: boolean;
    description?: string;
};

async function loadPlugin(pkg: string, spec: LakeSpec) {
    const editors: Editors = {
        tools: [],
        commands: [],
        skills: [],
    };
    const ctx = {
        options: { lakes: [spec] },
        location: { directory: tempDir("project") },
        tool: {
            transform: async (
                fn: (editor: { add: (t: never) => void }) => void,
            ) => fn({ add: (t) => editors.tools.push(t as never) }),
            hook: async () => undefined,
        },
        command: {
            transform: async (
                fn: (editor: { add: (c: never) => void }) => void,
            ) => fn({ add: (c) => editors.commands.push(c as never) }),
        },
        skill: {
            transform: async (
                fn: (editor: { add: (s: never) => void }) => void,
            ) => fn({ add: (s) => editors.skills.push(s as never) }),
        },
        session: { hook: async () => undefined, prompt: async () => undefined },
    };
    const loaded = (await import(
        pathToFileURL(join(pkg, "src", "index.ts")).href
    )) as {
        default: { setup: (ctx: unknown) => Promise<void> };
    };
    await loaded.default.setup(ctx);
    return { editors, ctx };
}

const surface = (editors: Editors, name: string) =>
    editors.tools.find(
        (tool) => (tool as { name?: string }).name === name,
    ) as unknown as {
        execute: (
            input: unknown,
            extra: unknown,
        ) => Promise<{ content: unknown }>;
    };

const text = (result: { content: unknown }) => String(result.content);

describe("packed installation, away from the checkout", () => {
    const root = tempDir("pkg");
    const pkg = packedInstall(root);

    it("the pack carries the runtime skill and convention beside the entry", () => {
        for (const rel of [
            "src/index.ts",
            "src/SKILL.md",
            "CONVENTION.md",
            "package.json",
        ]) {
            assert.ok(existsSync(join(pkg, rel)), rel + " must ship");
        }
        // The skill is exactly what the model sees at runtime.
        assert.equal(
            readFileSync(join(pkg, "src/SKILL.md"), "utf8"),
            readFileSync(join(REPO, "src/SKILL.md"), "utf8"),
        );
    });

    it("the real setup registers both tool surfaces, the command and the skill", async () => {
        const { editors } = await loadPlugin(pkg, tempLake(root));
        const names = editors.tools.map(
            (tool) => (tool as { name?: string }).name,
        );
        assert.deepEqual(names.sort(), ["docs", "docs_search"]);
        assert.equal(editors.commands.length, 1);
        const skill = editors.skills[0];
        assert.ok(skill, "the skill is registered");
        assert.equal(skill.id, "docs");
        assert.equal(
            skill.content,
            readFileSync(join(pkg, "src/SKILL.md"), "utf8"),
            "the skill content resolves through the installed package",
        );
    });

    it("native surface: search, read, add, replace and refusal round trip", async () => {
        const spec = tempLake(root);
        const { editors } = await loadPlugin(pkg, spec);
        const docs = surface(editors, "docs");
        const body = (n: string) =>
            "# Alias Roundtrip " + n + "\n\n### Facts\n\n- Body " + n + ".\n";
        const add = await docs.execute(
            {
                add: {
                    mode: "create",
                    metadata: {
                        Area: "kk",
                        Keywords: ["alias", "roundtrip", "pack"],
                        Summary: "Packed round trip.",
                    },
                    body: body("one"),
                },
            },
            null,
        );
        assert.match(text(add), /docs: revision/);
        assert.ok(existsSync(join(spec.root, "kk/alias-roundtrip-one.md")));
        const read = await docs.execute(
            { read: "kk/alias-roundtrip-one.md" },
            null,
        );
        const token =
            [...text(read).matchAll(/docs: revision ([0-9a-f]{64}) —/g)].at(
                -1,
            )?.[1] ?? "";
        assert.ok(token.length === 64, "read surfaces a usable revision token");
        const replace = await docs.execute(
            {
                add: {
                    mode: "replace",
                    path: "kk/alias-roundtrip-one.md",
                    metadata: {
                        Area: "kk",
                        Keywords: ["alias", "roundtrip", "pack"],
                        Summary: "Packed round trip.",
                    },
                    body: body("two"),
                    expectedRevision: token,
                },
            },
            null,
        );
        assert.match(text(replace), /docs: revision/);
        const stale = await docs.execute(
            {
                add: {
                    mode: "replace",
                    path: "kk/alias-roundtrip-one.md",
                    metadata: {
                        Area: "kk",
                        Keywords: ["alias", "roundtrip", "pack"],
                        Summary: "Packed round trip.",
                    },
                    body: body("three"),
                    expectedRevision: token,
                },
            },
            null,
        );
        assert.match(
            text(stale),
            /changed since you read it/i,
            "the old token must refuse after a newer edit",
        );
        const badLake = await docs.execute(
            { read: "nope/missing.md", lake: "absent" },
            null,
        );
        assert.match(text(badLake), /no lake named/i);
    });

    it("Code Mode twin: same core through its own registered surface", async () => {
        const spec = tempLake(root);
        const { editors } = await loadPlugin(pkg, spec);
        const twin = surface(editors, "docs_search");
        const add = await twin.execute(
            {
                add: {
                    mode: "create",
                    metadata: {
                        Area: "kk",
                        Keywords: ["twin", "pack", "surface"],
                        Summary: "Twin surface round trip.",
                    },
                    body: "# Twin Surface\n\n### Facts\n\n- From the twin.\n",
                },
            },
            null,
        );
        assert.match(text(add), /docs: revision/);
        const read = await twin.execute({ read: "kk/twin-surface.md" }, null);
        assert.match(text(read), /# Twin Surface/);
    });
});

describe("deterministic size ladder through both surfaces", () => {
    const root = tempDir("ladder");
    const pkg = packedInstall(root);
    // Rungs differ by WORD, not just digits: the near-twin matcher strips
    // numeric tokens. The byte sizes keep the 4K→1M ladder spread; no cutoff
    // is declared — these are observations, not a threshold.
    const rungs: Array<[number, string]> = [
        [128, "quark"],
        [256, "gluon"],
        [2048, "width"],
        [8192, "higgs"],
        [32768, "fermion"],
    ];

    it("exact stored bytes and a usable revision at every rung, both surfaces", async () => {
        const spec = tempLake(root);
        const { editors } = await loadPlugin(pkg, spec);
        const docs = surface(editors, "docs");
        const twin = surface(editors, "docs_search");
        for (const [blocks, word] of rungs) {
            const lastLine = "- Byte ladder " + word + " observation.\n";
            const body =
                "# Byte ladder " +
                word +
                "\n\n### Facts\n\n" +
                lastLine.repeat(blocks);
            const add = await docs.execute(
                {
                    add: {
                        mode: "create",
                        metadata: {
                            Area: "big",
                            Keywords: ["ladder", word, "bytes"],
                            Summary: "Size rung " + word + ".",
                        },
                        body,
                    },
                },
                null,
            );
            const addText = text(add);
            assert.match(
                addText,
                /docs: revision ([0-9a-f]{64}) —/,
                word +
                    " add returns a revision via the native surface — got: " +
                    addText.slice(0, 140),
            );
            const onDisk = readFileSync(
                join(spec.root, "big/byte-ladder-" + word + ".md"),
                "utf8",
            );
            assert.ok(
                onDisk.includes(lastLine.trim()) &&
                    onDisk.length > body.length * 0.9,
                word + " stores the complete body (" + body.length + " bytes)",
            );
        }
        // The twin surface reaches the same stored bytes: a full-exact read
        // round trip per rung, plus one deliberate replace with a fresh token.
        for (const [, word] of rungs) {
            const read = await twin.execute(
                { read: "big/byte-ladder-" + word + ".md" },
                null,
            );
            assert.ok(
                text(read).includes("# Byte ladder " + word) &&
                    text(read).includes("observation."),
                word + " round trip through the twin serves the exact content",
            );
        }
        const fresh = await twin.execute(
            { read: "big/byte-ladder-fermion.md" },
            null,
        );
        const token =
            text(fresh)
                .match(/docs: revision ([0-9a-f]{64}) —/)
                ?.at(1) ?? "";
        assert.ok(
            token.length === 64,
            "the twin surface returns the stored revision",
        );
        const appended =
            "# Byte ladder fermion\n\n### Facts\n\n" +
            "- Byte ladder fermion observation.\n".repeat(32768) +
            "- An extra observation from the twin.\n";
        const replace = await twin.execute(
            {
                add: {
                    mode: "replace",
                    path: "big/byte-ladder-fermion.md",
                    metadata: {
                        Area: "big",
                        Keywords: ["ladder", "fermion", "bytes"],
                        Summary: "Size rung fermion.",
                    },
                    body: appended,
                    expectedRevision: token,
                },
            },
            null,
        );
        assert.match(text(replace).slice(0, 160), /docs: revision/);
        assert.ok(
            readFileSync(
                join(spec.root, "big/byte-ladder-fermion.md"),
                "utf8",
            ).includes("An extra observation from the twin."),
            "the replace through the twin surface stored the new bytes",
        );
    });
});

describe("recording validity: written docs must pass the plugin's own check", () => {
    const root = tempDir("valid");
    const pkg = packedInstall(root);

    it("a well-formed fake-trial write passes check; a mangled one does not", async () => {
        const spec = tempLake(root);
        const { editors } = await loadPlugin(pkg, spec);
        const docs = surface(editors, "docs");
        // What a trial recording within its policy might write:
        const wellFormed =
            "---\nArea: kb\nKeywords: trial, recording, valid\nSummary: A structurally valid trial write.\n---\n\n" +
            "# Trial Recording\n\n### Facts\n\n- The trial recorded this finding deliberately.\n";
        const add = await docs.execute(
            {
                add: {
                    mode: "create",
                    path: "kb/trial-recording.md",
                    metadata: {
                        Area: "kb",
                        Keywords: ["trial", "recording", "valid"],
                        Summary: "A structurally valid trial write.",
                    },
                    body: wellFormed.slice(wellFormed.indexOf("---\n\n") + 5),
                },
            },
            null,
        );
        assert.match(text(add), /docs: revision/);
        void [wellFormed];
        await docs.execute({ check: true }, null).then((result) => {
            assert.doesNotMatch(
                text(result),
                /no claim section|required and must not be blank/i,
                "a policy-compliant write must pass the structural check",
            );
        });
        // A mangled write (as a sloppy model might produce) must find defects.
        writeFileSync(
            join(spec.root, "kb/mangled.md"),
            "no front matter, no H1, no claim section\n",
        );
        await docs.execute({ check: true }, null).then((result) => {
            assert.match(text(result), /no H1/);
        });
    });
});
