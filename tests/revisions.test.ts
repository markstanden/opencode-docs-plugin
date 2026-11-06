import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createDocsTool,
    createLakes,
    revisionOf,
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
    const dir = mkdtempSync(join(tmpdir(), "docs-revisions-"));
    cleanups.push(dir);
    return dir;
}

/** A real writable repo lake over a fresh root. */
function spec(name = "docs"): LakeSpec {
    return {
        name,
        class: "repo",
        root: tempDir(),
        profile: "knowledge",
        writable: true,
    };
}

function toolOf(lakes: readonly LakeSpec[]): ReturnType<typeof createDocsTool> {
    return createDocsTool({ lakes: createLakes(lakes) });
}

/** Seed a compliant doc and return its exact bytes. */
function seed(root: string, path: string, title = "Seed"): string {
    const raw =
        `---\nArea: ${path.split("/")[0]}\nKeywords: seed\nSummary: Seeded.\n` +
        `---\n\n# ${title}\n\n### Facts\n\n- Original body.\n`;
    mkdirSync(join(root, path.split("/").slice(0, -1).join("/")), {
        recursive: true,
    });
    writeFileSync(join(root, path), raw);
    return raw;
}

function replacePayload(
    path: string,
    revision: string,
    title = "Seed",
): Record<string, unknown> {
    return {
        mode: "replace",
        path,
        expectedRevision: revision,
        metadata: { Area: "aa", Keywords: [title], Summary: `${title} doc.` },
        body: `# ${title}\n\n### Facts\n\n- Replaced body.\n`,
    };
}

/** No lock files or temp files survive a publication attempt. */
function assertClean(root: string): void {
    const lockDir = join(root, ".docs-lock");
    if (existsSync(lockDir)) {
        assert.deepEqual(readdirSync(lockDir), [], "lock files left behind");
    }
    for (const area of readdirSync(root, { withFileTypes: true })) {
        if (!area.isDirectory() || area.name === ".docs-lock") {
            continue;
        }
        const leftovers = readdirSync(join(root, area.name)).filter((name) =>
            name.endsWith(".tmp"),
        );
        assert.deepEqual(leftovers, [], "temp files left behind");
    }
}

describe("revision tokens", () => {
    it("matches an independent SHA-256 of the stored bytes (R01)", async () => {
        // Arrange – bytes on disk; the token computed by an external tool.
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);

        const result = await tool.execute(
            { read: "aa/doc.md" } as never,
            {} as never,
        );
        const metadata = result.metadata as {
            read?: string;
            lake?: string;
            path?: string;
            revision?: string;
        };

        // Assert – the tool's token equals sha256sum over the exact bytes,
        // and the metadata carries the resolved target.
        const external = spawn("sha256sum", [join(lake.root, "aa/doc.md")]);
        let stdout = "";
        for await (const chunk of external.stdout) {
            stdout += String(chunk);
        }
        const expected = stdout.trim().split(/\s+/)[0] ?? "";

        assert.equal(metadata.revision, expected);
        assert.equal(metadata.revision, revisionOf(raw));
        assert.equal(metadata.lake, "docs");
        assert.equal(metadata.path, "aa/doc.md");
        assert.match(String(result.content), /# Seed/);
    });

    it("returns a stable token across unchanged reads (R02)", async () => {
        const lake = spec();
        seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);

        const first = await tool.execute(
            { read: "aa/doc.md" } as never,
            {} as never,
        );
        const second = await tool.execute(
            { read: "aa/doc.md" } as never,
            {} as never,
        );

        assert.equal(
            (first.metadata as { revision?: string }).revision,
            (second.metadata as { revision?: string }).revision,
        );
    });

    it("changes the token with every actual byte change (R03)", () => {
        const front =
            "---\nArea: aa\nKeywords: seed\nSummary: Seeded.\n---\n\n# Seed\n\n### Facts\n\n- Body.\n";
        const variants = [
            front.replace("Summary: Seeded.", "Summary: Changed."),
            `${front}\n`,
            front.replace(/\n/g, "\r\n"),
            front.replace("Body", "Bodży"),
        ];
        const tokens = new Set([revisionOf(front)]);
        for (const variant of variants) {
            tokens.add(revisionOf(variant));
        }
        assert.equal(tokens.size, variants.length + 1);
    });

    it("omits a revision from a wiki read", async () => {
        const wiki: LakeSpec = {
            name: "wiki",
            class: "wiki",
            root: tempDir(),
            profile: "wiki",
            writable: false,
        };
        writeFileSync(join(wiki.root, "page.md"), "# Page\n\nProse.\n");
        const tool = toolOf([wiki]);

        const result = await tool.execute(
            { read: "wiki:page.md" } as never,
            {} as never,
        );

        assert.equal(
            (result.metadata as { revision?: string }).revision,
            undefined,
        );
        assert.match(String(result.content), /# Page/);
    });
});

describe("stale-replacement protection", () => {
    it("replaces against a current token and returns the new hash (R04)", async () => {
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);

        const result = await tool.execute(
            {
                add: replacePayload("aa/doc.md", revisionOf(raw)),
            } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, true);
        const stored = readFileSync(join(lake.root, "aa/doc.md"), "utf8");
        assert.match(stored, /- Replaced body\./);
        assert.equal(result.metadata?.revision, revisionOf(stored));
        assertClean(lake.root);
    });

    it("refuses when another writer stored different bytes (R05)", async () => {
        // Arrange – the caller reads A; another writer publishes B; the caller
        // submits C against A's token.
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);
        const other = raw.replace(
            "Original body",
            "Another writer got here first",
        );
        writeFileSync(join(lake.root, "aa/doc.md"), other);

        const result = await tool.execute(
            {
                add: replacePayload("aa/doc.md", revisionOf(raw), "Rival"),
            } as never,
            {} as never,
        );

        // Assert – the stale replacement refused; B stands byte-identical.
        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /changed since you read it/);
        assert.equal(readFileSync(join(lake.root, "aa/doc.md"), "utf8"), other);
        assertClean(lake.root);
    });

    it("refuses a missing, malformed or wrongly-valued token (R06)", async () => {
        const lake = spec();
        seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);
        const before = readFileSync(join(lake.root, "aa/doc.md"), "utf8");
        const cases: Array<[string, Record<string, unknown>]> = [
            ["absent", { path: "aa/doc.md", mode: "replace" }],
            [
                "malformed",
                { path: "aa/doc.md", mode: "replace", expectedRevision: "zzz" },
            ],
            [
                "wrong value",
                {
                    path: "aa/doc.md",
                    mode: "replace",
                    expectedRevision: "ab".repeat(32),
                },
            ],
        ];

        for (const [name, add] of cases) {
            const result = await tool.execute(
                {
                    add: {
                        ...add,
                        metadata: {
                            Area: "aa",
                            Keywords: ["Seed"],
                            Summary: "Seed doc.",
                        },
                        body: "# Seed\n\n### Facts\n\n- Replaced body.\n",
                    },
                } as never,
                {} as never,
            );
            assert.equal(result.metadata?.written, false, name);
        }
        assert.equal(
            readFileSync(join(lake.root, "aa/doc.md"), "utf8"),
            before,
        );
    });

    it("refuses replace on a deleted target without recreating it (R07)", async () => {
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);
        unlinkSync(join(lake.root, "aa/doc.md"));

        const result = await tool.execute(
            {
                add: replacePayload("aa/doc.md", revisionOf(raw)),
            } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /no doc at/);
        assert.equal(existsSync(join(lake.root, "aa/doc.md")), false);
        assertClean(lake.root);
    });

    it("refuses replace at the old address after a rename (R08)", async () => {
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);
        renameSync(
            join(lake.root, "aa/doc.md"),
            join(lake.root, "aa/moved.md"),
        );

        const result = await tool.execute(
            {
                add: replacePayload("aa/doc.md", revisionOf(raw)),
            } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /no doc at/);
        assert.equal(existsSync(join(lake.root, "aa/doc.md")), false);
        assert.match(
            readFileSync(join(lake.root, "aa/moved.md"), "utf8"),
            /# Seed/,
        );
    });

    it("checks the selected lake's bytes, not another lake's (R09)", async () => {
        const alpha = spec("alpha");
        const beta = spec("beta");
        const aRaw = seed(alpha.root, "aa/doc.md", "Alpha version");
        const bRaw = seed(beta.root, "aa/doc.md", "Beta version");
        const tool = toolOf([alpha, beta]);

        const result = await tool.execute(
            {
                lake: "beta",
                add: replacePayload("aa/doc.md", revisionOf(bRaw), "Beta next"),
            } as never,
            {} as never,
        );

        // Assert – beta replaced against its own bytes; alpha untouched.
        assert.equal(result.metadata?.written, true);
        assert.equal(result.metadata?.lake, "beta");
        assert.match(
            readFileSync(join(beta.root, "aa/doc.md"), "utf8"),
            /Beta next/,
        );
        assert.equal(readFileSync(join(alpha.root, "aa/doc.md"), "utf8"), aRaw);
    });

    it("refuses when only the metadata changed since the read (R10)", async () => {
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);
        writeFileSync(
            join(lake.root, "aa/doc.md"),
            raw.replace("Summary: Seeded.", "Summary: Re-summarised."),
        );

        const result = await tool.execute(
            {
                add: replacePayload("aa/doc.md", revisionOf(raw)),
            } as never,
            {} as never,
        );

        // Whole-file hashing: a front-matter-only edit stales the token.
        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /changed since you read it/);
        assert.match(
            readFileSync(join(lake.root, "aa/doc.md"), "utf8"),
            /Re-summarised/,
        );
    });

    it("protects two instances in one process without deadlock (R12)", async () => {
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const lakes = createLakes([lake]);
        const first = createDocsTool({ lakes });
        const second = createDocsTool({ lakes });

        const result = await second.execute(
            {
                add: replacePayload("aa/doc.md", revisionOf(raw), "Second"),
            } as never,
            {} as never,
        );
        await first.execute(
            {
                add: replacePayload("aa/doc.md", revisionOf(raw), "First"),
            } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, true);
        assertClean(lake.root);
    });

    it("reports a publication failure and cleans up (R14)", async () => {
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);
        // The area directory loses its write bit: the temp write fails.
        chmodSync(join(lake.root, "aa"), 0o500);

        const result = await tool.execute(
            {
                add: replacePayload("aa/doc.md", revisionOf(raw)),
            } as never,
            {} as never,
        );

        // Assert – the failure is reported, the original document remains
        // complete, and no lock or temp artefact survives.
        assert.equal(result.metadata?.written, false);
        assert.equal(readFileSync(join(lake.root, "aa/doc.md"), "utf8"), raw);
        chmodSync(join(lake.root, "aa"), 0o755);
        assertClean(lake.root);
    });

    it("refuses an invalid DTO even with a correct token (R15)", async () => {
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);
        const payload = replacePayload("aa/doc.md", revisionOf(raw)) as {
            metadata: { Summary: string; Area: string; Keywords: string[] };
        };
        payload.metadata = {
            Area: "aa",
            Keywords: ["Seed"],
            Summary: "",
        };

        const result = await tool.execute(
            { add: payload } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /Summary is required/);
        assert.equal(readFileSync(join(lake.root, "aa/doc.md"), "utf8"), raw);
    });

    it("refuses busy when another writer holds the lock (R16)", async () => {
        // Arrange – a lock file at the exact path the protocol keys for this
        // target, owned by this (live) process.
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);
        const target = join(lake.root, "aa/doc.md");
        const key = createHash("sha256")
            .update(realpathSync(target), "utf8")
            .digest("hex");
        const lockPath = join(lake.root, ".docs-lock", `${key}.lock`);
        mkdirSync(join(lake.root, ".docs-lock"), { recursive: true });
        writeFileSync(
            lockPath,
            JSON.stringify({ pid: process.pid, acquiredAt: "now" }),
        );

        const attempt = await tool.execute(
            {
                add: replacePayload("aa/doc.md", revisionOf(raw)),
            } as never,
            {} as never,
        );

        // Assert – bounded contention refusal naming the lock; no stale write;
        // the foreign lock is not stolen.
        assert.equal(attempt.metadata?.written, false);
        assert.match(String(attempt.content), /holds the target lock/);
        assert.match(String(attempt.content), /remove/);
        assert.match(readFileSync(target, "utf8"), /# Seed/);
        assert.equal(existsSync(lockPath), true);
    });

    it("holds the symlink and traversal guards through the protocol (R18)", async () => {
        const lake = spec();
        const outside = tempDir();
        writeFileSync(join(outside, "evil.md"), "# outside\n");
        const raw = seed(lake.root, "aa/doc.md");
        symlinkSync(join(outside, "evil.md"), join(lake.root, "aa/link.md"));
        const tool = toolOf([lake]);

        const symlinked = await tool.execute(
            {
                add: replacePayload("aa/link.md", revisionOf(raw)),
            } as never,
            {} as never,
        );
        const traversal = await tool.execute(
            {
                add: replacePayload("../outside.md", revisionOf(raw)),
            } as never,
            {} as never,
        );

        assert.equal(symlinked.metadata?.written, false);
        assert.equal(traversal.metadata?.written, false);
        assert.equal(
            readFileSync(join(outside, "evil.md"), "utf8"),
            "# outside\n",
        );
        assert.ok(lstatSync(join(lake.root, "aa/link.md")).isSymbolicLink());
    });

    it("re-accepts a token when the exact bytes return (R20)", async () => {
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const tool = toolOf([lake]);

        // A: read → B: overwrite → restore the exact A bytes → replace with
        // A's token: the token represents bytes, not edit history.
        writeFileSync(
            join(lake.root, "aa/doc.md"),
            raw.replace("Original body", "Different bytes"),
        );
        writeFileSync(join(lake.root, "aa/doc.md"), raw);

        const result = await tool.execute(
            {
                add: replacePayload("aa/doc.md", revisionOf(raw)),
            } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, true);
    });
});

/**
 * Cross-process publication: real child processes register the same tool
 * over one real lake and race a single publication. Coordination is a file
 * barrier — every child signals `ready`, the parent writes `go`, and only
 * then do the children act — so no outcome depends on timing. Each child has
 * a watchdog kill so a hung barrier cannot hang the suite.
 */
const CHILD_SCRIPT = `
import { writeFileSync, existsSync } from "node:fs";
// With -e, argv is [execPath, modulePath, root, ready, go, payload].
const [modulePath, root, readyPath, goPath, payloadJson] = process.argv.slice(1);
const { createLakes, createDocsTool } = await import(modulePath);
writeFileSync(readyPath, "r");
const deadline = Date.now() + 30000;
while (!existsSync(goPath)) {
    if (Date.now() > deadline) {
        console.log(JSON.stringify({ error: "barrier timeout" }));
        process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
}
const lakes = createLakes([
    { name: "docs", class: "repo", root, profile: "knowledge", writable: true },
]);
const tool = createDocsTool({ lakes });
const result = await tool.execute(JSON.parse(payloadJson), {});
console.log(JSON.stringify({ content: result.content, metadata: result.metadata }));
`;

/** A child attempt's parsed result. */
interface ChildResult {
    content: string;
    metadata?: { written?: boolean; revision?: string };
    error?: string;
}

/**
 * Run one child to completion with a watchdog kill.
 * @param args The child's argv.
 * @returns The parsed result from stdout.
 */
function runChild(args: string[]): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", CHILD_SCRIPT, "--", ...args],
            {
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let stdout = "";
        let stderr = "";
        const watchdog = setTimeout(() => child.kill("SIGKILL"), 60000);
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += String(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += String(chunk);
        });
        child.on("exit", (code) => {
            clearTimeout(watchdog);
            try {
                const line = stdout.trim().split("\n").at(-1) ?? "";
                resolve(JSON.parse(line) as ChildResult);
            } catch {
                reject(new Error(`child exited ${code}: ${stderr || stdout}`));
            }
        });
        child.on("error", (error) => {
            clearTimeout(watchdog);
            reject(error);
        });
    });
}

/** A barrier run directory with ready/go paths for each participant. */
function barrier(participants: number): {
    run: string;
    ready: string[];
    go: string;
} {
    const run = tempDir();
    const ready = Array.from({ length: participants }, (_, index) =>
        join(run, `ready-${index}`),
    );
    return { run, ready, go: join(run, "go") };
}

/** Bounded wait for every child's ready signal, then open the barrier. */
async function openBarrier(
    run: string,
    ready: readonly string[],
): Promise<void> {
    const deadline = Date.now() + 30000;
    for (;;) {
        if (ready.every((path) => existsSync(path))) {
            break;
        }
        if (Date.now() > deadline) {
            throw new Error("children never signalled ready");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    writeFileSync(join(run, "go"), "g");
}

describe("cross-process publication", () => {
    it("lets at most one of two racing replaces succeed (R11)", async () => {
        const lake = spec();
        const raw = seed(lake.root, "aa/doc.md");
        const revision = revisionOf(raw);
        const { run, ready, go } = barrier(2);
        // Both racers hold the same token but submit different whole bodies;
        // each candidate is a complete serialized document.
        const candidates = ["Alpha racer", "Beta racer"].map((racer) => ({
            racer,
            payload: {
                add: {
                    ...replacePayload("aa/doc.md", revision),
                    body: `# Seed\n\n### Facts\n\n- ${racer} body.\n`,
                },
            },
        }));

        const children = candidates.map((candidate, index) =>
            runChild([
                new URL("../src/index.ts", import.meta.url).href,
                lake.root,
                ready[index] as string,
                go,
                JSON.stringify(candidate.payload),
            ]),
        );
        await openBarrier(run, ready);
        const results = await Promise.all(children);

        // Assert – exactly one winner; the stored bytes are one entire
        // submitted version, never a mixture; the loser refuses.
        const winners = results.filter(
            (result) => result.metadata?.written === true,
        );
        assert.equal(winners.length, 1);
        const stored = readFileSync(join(lake.root, "aa/doc.md"), "utf8");
        const holding = candidates.filter((candidate) =>
            stored.includes(`${candidate.racer} body`),
        );
        assert.equal(holding.length, 1);
        assert.equal(stored.endsWith(`${holding[0]?.racer} body.\n`), true);
        // The loser refuses bounded — staleness, an existing target, or a
        // busy lock it arrived during — and never overwrites or waits.
        const loser = results.find(
            (result) => result.metadata?.written !== true,
        );
        assert.match(
            String(loser?.content ?? ""),
            /changed since you read it|already exists|holds the target lock/,
        );
        for (const result of results) {
            assert.equal(result.error, undefined);
        }
        assertClean(lake.root);
    });

    it("gives one create the target and the other a conflict (R13)", async () => {
        const lake = spec();
        const { run, ready, go } = barrier(2);
        const payload = {
            add: {
                mode: "create",
                metadata: {
                    Area: "aa",
                    Keywords: ["Raced"],
                    Summary: "Raced doc.",
                },
                body: "# Raced\n\n### Facts\n\n- First fact.\n",
            },
        };

        const children = ready.map((readyPath) =>
            runChild([
                new URL("../src/index.ts", import.meta.url).href,
                lake.root,
                readyPath,
                go,
                JSON.stringify(payload),
            ]),
        );
        await openBarrier(run, ready);
        const results = await Promise.all(children);

        const winners = results.filter(
            (result) => result.metadata?.written === true,
        );
        assert.equal(winners.length, 1);
        const stored = readFileSync(join(lake.root, "aa/raced.md"), "utf8");
        assert.match(stored, /^---\nArea: aa\n/);
        assert.match(stored, /First fact\./);
        for (const result of results) {
            assert.equal(result.error, undefined);
        }
        assertClean(lake.root);
    });

    it("publishes different targets concurrently without interference (R17)", async () => {
        const lake = spec();
        const { run, ready, go } = barrier(2);
        const children = ready.map((readyPath, index) =>
            runChild([
                new URL("../src/index.ts", import.meta.url).href,
                lake.root,
                readyPath,
                go,
                JSON.stringify({
                    add: {
                        mode: "create",
                        metadata: {
                            Area: "aa",
                            Keywords: [`lane${index}`],
                            Summary: `Lane ${index}.`,
                        },
                        body: `# Lane ${index}\n\n### Facts\n\n- x.\n`,
                    },
                }),
            ]),
        );
        await openBarrier(run, ready);
        const results = await Promise.all(children);

        for (const [index, result] of results.entries()) {
            assert.equal(result.error, undefined);
            assert.equal(result.metadata?.written, true);
            assert.match(
                readFileSync(join(lake.root, `aa/lane-${index}.md`), "utf8"),
                new RegExp(`Lane ${index}`),
            );
        }
        assertClean(lake.root);
    });
});
