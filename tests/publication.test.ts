import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
    createLakes,
    createDocsTool,
    MAX_TEMP_ATTEMPTS,
    revisionOf,
    serializeDoc,
    targetLockPath,
    writeFullBytes,
    type LakeSpec,
    type PublicationSeams,
} from "../src/index.ts";

/**
 * Publication safety: one physical target, one publication lock; exclusive
 * temp creation; symlink containment — and the regressions the reviewed
 * implementation shipped (route-dependent lock placement, symlink-following
 * temp publication, depth-based destination guessing), which were written
 * first and confirmed red before the fix.
 */

const cleanups: string[] = [];

/** A seq injected factories bump to keep names unique across collisions. */
let retrySeq = 0;

/** A seq injected factories bump to keep names unique across collisions. */
/**
 * Cross-process publication. Two child processes register the tool over two
 * different configured roots that reach one physical tree — the loser knows
 * only its own lake. Coordination happens *at the critical section*, not at
 * process start: the outer-route child acquires the lock and pauses after its
 * bytes were verified (the exact state where the reviewed implementation let
 * the winner in), the inner-route child's replacement attempts while the lock
 * is live, and only then does the outer child resume and publish. A watchdog
 * and bounded waits terminate every child on test failure.
 */
const CHILD_SCRIPT = `
import { writeFileSync, existsSync } from "node:fs";
// With -e, argv is [execPath, moduleUrl, configJson, payloadJson].
const [moduleUrl, configJson, payloadJson] = process.argv.slice(1);
const { createLakes, createDocsTool } = await import(moduleUrl);
const config = JSON.parse(configJson);
const seams = config.pauseAt === undefined ? {} : {
    onStage: (stage) => {
        if (stage !== config.pauseAt) return;
        writeFileSync(config.pausePath, "v");
        const deadline = Date.now() + 30000;
        while (!existsSync(config.resumePath)) {
            if (Date.now() > deadline) process.exit(3);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
    },
};
const lakes = createLakes(config.lakes, { seams });
const tool = createDocsTool({ lakes });
writeFileSync(config.readyPath, "r");
const goDeadline = Date.now() + 30000;
while (!existsSync(config.goPath)) {
    if (Date.now() > goDeadline) process.exit(4);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}
const result = await tool.execute(JSON.parse(payloadJson), {});
console.log(JSON.stringify({ content: result.content, metadata: result.metadata }));
`;

interface ChildResult {
    content: string;
    metadata?: { written?: boolean; revision?: string; reason?: string };
}

/** Run one child with its config and payload, parsing its final JSON line. */
function runChild(
    config: Record<string, unknown>,
    payload: unknown,
): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                CHILD_SCRIPT,
                "--",
                new URL("../src/index.ts", import.meta.url).href,
                JSON.stringify(config),
                JSON.stringify(payload),
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        const watchdog = setTimeout(() => child.kill("SIGKILL"), 30000);
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
            } catch (error) {
                reject(
                    new Error(
                        `child exited ${code}: ${stderr || stdout || String(error)}`,
                    ),
                );
            }
        });
        child.on("error", (error) => {
            clearTimeout(watchdog);
            reject(error);
        });
    });
}

/** Bounded wait for a file to appear. */
async function awaitFile(path: string, what: string): Promise<void> {
    const deadline = Date.now() + 30000;
    for (;;) {
        if (existsSync(path)) return;
        if (Date.now() > deadline) throw new Error(`${what} never appeared`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe("cross-process publication", () => {
    it("loses the racer to a live held lock, not a lost update (L02)", async () => {
        // Arrange – one physical doc, bytes A. Two children: the outer child
        // knows only the outer root; the inner child knows only the inner
        // root. Both hold revision A; each submits a different whole body.
        const outer = tempDir();
        const inner = join(outer, "nested");
        const raw = seed(inner, "aa/doc.md", "A body.");
        const run = tempDir();
        const pausePath = join(run, "pause");
        const resumePath = join(run, "resume");
        const outerChild = {
            lakes: [lakeSpec(outer, "outer")],
            readyPath: join(run, "ready-a"),
            goPath: join(run, "go-a"),
            pauseAt: "verified",
            pausePath,
            resumePath,
        };
        const innerChild = {
            lakes: [lakeSpec(inner, "inner")],
            readyPath: join(run, "ready-b"),
            goPath: join(run, "go-b"),
        };
        const outerPayload = replaceAdd(
            "nested/aa/doc.md",
            revisionOf(raw),
            "- Outer version.\n",
        );
        const innerPayload = replaceAdd(
            "aa/doc.md",
            revisionOf(raw),
            "- Inner version.\n",
        );

        // Act – the outer child runs to its verified pause, holding the lock.
        const holder = runChild(outerChild, outerPayload);
        await awaitFile(join(run, "ready-a"), "ready-a");
        writeFileSync(join(run, "go-a"), "g");
        await awaitFile(pausePath, "the verified pause");
        // The contender now races the live lock.
        const contender = runChild(innerChild, innerPayload);
        await awaitFile(join(run, "ready-b"), "ready-b");
        writeFileSync(join(run, "go-b"), "g");
        const raced = await contender;
        // Only then does the winner publish.
        writeFileSync(resumePath, "g");
        const winner = await holder;

        // Assert – exactly one replacement succeeded; the contender refused
        // busy on the shared lock; the stored bytes are one complete version.
        assert.equal(raced.metadata?.written, false);
        assert.match(String(raced.content), /holds the target lock/);
        assert.equal(winner.metadata?.written, true);
        assert.match(
            readFileSync(join(inner, "aa/doc.md"), "utf8"),
            /- Outer version\.\n$/,
            "the stored bytes are one complete submitted version",
        );
        assert.doesNotMatch(
            readFileSync(join(inner, "aa/doc.md"), "utf8"),
            /- Inner version\./,
        );
        assertClean(inner);
    });

    it("gives one cross-config create the target, the other a conflict (L05)", async () => {
        // Arrange – inner root exists, its `aa` directory does not: two
        // differently routed creations reach the same initially absent doc.
        const outer = tempDir();
        const inner = join(outer, "nested");
        mkdirSync(inner, { recursive: true });
        const run = tempDir();
        const a = {
            lakes: [lakeSpec(outer, "outer")],
            readyPath: join(run, "ready-a"),
            goPath: join(run, "go"),
        };
        const b = {
            lakes: [lakeSpec(inner, "inner")],
            readyPath: join(run, "ready-b"),
            goPath: join(run, "go"),
        };
        const payload = (createAdd("Raced") as { add: object }).add;
        const outerPayload = {
            add: {
                ...(payload as Record<string, unknown>),
                path: "nested/aa/raced.md",
            },
        };
        const innerPayload = { add: payload };

        // Act – both children start together; whoever loses the exclusive
        // create or the lock refuses with the winner's bytes standing.
        const first = runChild(a, outerPayload);
        const second = runChild(b, innerPayload);
        await awaitFile(join(run, "ready-a"), "ready-a");
        await awaitFile(join(run, "ready-b"), "ready-b");
        writeFileSync(join(run, "go"), "g");
        const results = await Promise.all([first, second]);

        // Assert – at most one written; the winner's bytes complete; the
        // outer-routed loser did not leave its own copy behind.
        const winners = results.filter((r) => r.metadata?.written === true);
        assert.equal(winners.length, 1);
        assert.match(
            readFileSync(join(inner, "aa/raced.md"), "utf8"),
            /Seeded fact\.\n$/,
        );
        assert.equal(existsSync(join(outer, "aa/raced.md")), false);
        assertClean(inner);
    });

    it("shows a create before its bytes, then only complete bytes (C-vis)", async () => {
        // Arrange – a create over a child that pauses at `targetOpen`, the
        // exclusive open's still-empty file. A create's promise is exclusive
        // naming plus eventually-complete bytes: readers may observe the file
        // inside that window; the all-or-nothing swap belongs to replacement
        // alone. This pins the intended behaviour, not a race accident.
        const root = tempDir();
        const run = tempDir();
        const pausePath = join(run, "pause");
        const resumePath = join(run, "resume");
        const target = join(root, "aa/fresh.md");
        const child = {
            lakes: [lakeSpec(root, "docs")],
            readyPath: join(run, "ready"),
            goPath: join(run, "go"),
            pauseAt: "targetOpen",
            pausePath,
            resumePath,
        };
        const serialized = serializeDoc(
            { Area: "aa", Keywords: ["Fresh"], Summary: "Fresh." },
            "# Fresh\n\n### Facts\n\n- Seeded fact.\n",
        );

        // Act – the create opens the target and pauses before writing.
        const creator = runChild(child, createAdd("Fresh"));
        await awaitFile(join(run, "ready"), "ready");
        writeFileSync(join(run, "go"), "g");
        await awaitFile(pausePath, "the targetOpen pause");

        // At the pause the file exists and is observable, and is not yet the
        // complete document — a reader here sees the open, not the bytes.
        assert.ok(existsSync(target));
        const observational = lstatSync(target);
        assert.ok(observational.isFile());
        assert.equal(
            readFileSync(target, "utf8"),
            "",
            "the creating file is empty at targetOpen",
        );

        // Completeness arrives with the writer; the sequence describes the
        // shown state no longer.
        writeFileSync(resumePath, "g");
        const creatorResult = await creator;
        assert.equal(
            creatorResult.metadata?.written,
            true,
            String(creatorResult.content),
        );
        assert.equal(
            readFileSync(target, "utf8"),
            serialized,
            "the create lands whole once the writer finishes",
        );
        assertClean(root);
    });
});

after(() => {
    for (const dir of cleanups) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh scratch directory, removed after the suite. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "docs-publication-"));
    cleanups.push(dir);
    return dir;
}

/** A compliant knowledge doc seeded at a real path under `root`. */
function seed(root: string, path: string, body: string): string {
    const raw =
        `---\nArea: ${path.split("/")[0]}\nKeywords: seed\nSummary: Seeded.\n` +
        `---\n\n# Seed\n\n### Facts\n\n- ${body}\n`;
    mkdirSync(join(root, path.split("/").slice(0, -1).join("/")), {
        recursive: true,
    });
    writeFileSync(join(root, path), raw);
    return raw;
}

/** A writable repo lake spec pointing at `root`. */
function lakeSpec(
    root: string,
    name = "docs",
    toggle: { writable?: boolean; lakeClass?: LakeSpec["class"] } = {},
): LakeSpec {
    return {
        name,
        class: toggle.lakeClass ?? "repo",
        root,
        profile: (toggle.lakeClass ?? "repo") === "wiki" ? "wiki" : "knowledge",
        writable: toggle.writable ?? true,
    };
}

/** A valid replace payload over `path` claiming `revision`. */
function replaceAdd(
    path: string,
    revision: string,
    body = "- Sent.\n",
): unknown {
    return {
        add: {
            mode: "replace",
            path,
            expectedRevision: revision,
            metadata: { Area: "aa", Keywords: ["Padlock"], Summary: "P." },
            body: `# Padlock\n\n### Facts\n\n${body}`,
        },
    };
}

/** A valid create payload. */
function createAdd(title: string): unknown {
    return {
        add: {
            mode: "create",
            metadata: { Area: "aa", Keywords: [title], Summary: `${title}.` },
            body: `# ${title}\n\n### Facts\n\n- Seeded fact.\n`,
        },
    };
}

/** The independently computed revision, by the external sha256sum tool. */
function externalRevision(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("sha256sum", [path]);
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += String(chunk);
        });
        child.on("error", reject);
        child.on("exit", () => {
            resolve((stdout.trim().split(/\s+/)[0] ?? "").slice(0, 64));
        });
    });
}

/** Every surviving lock dir is empty; every .tmp is gone. */
function assertClean(root: string): void {
    const walk = (dir: string): void => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, item.name);
            if (item.isDirectory()) {
                if (item.name === ".docs-lock") {
                    assert.deepEqual(
                        readdirSync(path),
                        [],
                        `lock files left behind in ${path}`,
                    );
                } else {
                    walk(path);
                }
                continue;
            }
            assert.ok(!item.name.endsWith(".tmp"), `stray temp at ${path}`);
        }
    };
    if (existsSync(root)) {
        walk(root);
    }
}

/**
 * Manual lock hold, at the physical location the protocol computes for
 * `routeTarget` — the same file every route to that target consults. This
 * stands in for "a writer holds the lock mid-publication" when the holder and
 * the contender share a process (in-process fs work is synchronous and cannot
 * interleave); the true mid-publication interleave is proven cross-process in
 * the L02 suite.
 */
function holdLock(routeTarget: string): string {
    const lockPath = targetLockPath(routeTarget);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999, acquiredAt: "manual-hold" }),
    );
    return lockPath;
}

describe("regressions against the reviewed implementation", () => {
    it("keys both routes of one physical target to the same lock file (L01)", () => {
        // Arrange – outer and inner configured roots reach the same file, one
        // of them through a permitted symlinked configured root.
        const outer = tempDir();
        const inner = join(outer, "nested");
        seed(inner, "aa/doc.md", "A body.");
        const alias = tempDir();
        symlinkSync(inner, join(alias, "link"), "dir");

        // Act – the lock each route would consult, straight from the real
        // protocol: one path, independent of the configured root used to
        // reach the target.
        const routes = [
            join(outer, "nested/aa/doc.md"),
            join(inner, "aa/doc.md"),
            join(alias, "link", "aa/doc.md"),
        ].map((target) => targetLockPath(target));

        // Assert – every route names the same single lock location.
        assert.equal(new Set(routes).size, 1);
        assert.equal(routes[0], targetLockPath(join(inner, "aa/doc.md")));
    });

    it("cannot publish through a pre-existing symlinked temp name (S01)", async () => {
        // Arrange – the first temp pathname the protocol picks is a symlink
        // to an external fixture, seeded before the call is made.
        const root = tempDir();
        const outside = tempDir();
        const raw = seed(root, "aa/doc.md", "A body.");
        const target = join(root, "aa/doc.md");
        for (const candidate of [0, 1, 2]) {
            symlinkSync(
                join(outside, "mine.md"),
                `${target}.${process.pid}.${candidate}.tmp`,
            );
        }
        writeFileSync(join(outside, "mine.md"), "# precious external bytes\n");
        const tool = createDocsTool({ lakes: createLakes([lakeSpec(root)]) });

        // Act – a valid replacement crosses the poisoned temp names.
        const result = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );

        // Assert – the external fixture and the symlinks survive untouched;
        // the operation either refused or landed on a fresh exclusive temp;
        // in both cases the target never became a symlink.
        assert.equal(
            readFileSync(join(outside, "mine.md"), "utf8"),
            "# precious external bytes\n",
            "external fixture overwritten",
        );
        assert.ok(lstatSync(`${target}.${process.pid}.0.tmp`).isSymbolicLink());
        if (result.metadata?.written === true) {
            const stored = lstatSync(target);
            assert.ok(stored.isFile() && !stored.isSymbolicLink());
            assert.match(readFileSync(target, "utf8"), /- Sent\./);
        } else {
            assert.match(readFileSync(target, "utf8"), /- A body\./);
        }
    });

    it("refuses an omitted selector while several writable lakes exist (D01)", async () => {
        // Arrange – nested writable repo lakes plus one unrelated writable
        // personal lake; no explicit lake selector on the create.
        const outer = tempDir();
        const inner = join(outer, "nested");
        const personal = tempDir();
        mkdirSync(inner, { recursive: true });
        const tool = createDocsTool({
            lakes: createLakes([
                lakeSpec(outer, "outer"),
                lakeSpec(inner, "inner"),
                lakeSpec(personal, "personal", {
                    lakeClass: "machine",
                }),
            ]),
        });

        const result = await tool.execute(
            createAdd("Destined") as never,
            {} as never,
        );

        // Assert – refused with every writable candidate named; nothing was
        // written anywhere and no content directories were created.
        assert.equal(result.metadata?.written, false, "must not silently pick");
        assert.equal(existsSync(join(inner, "aa", "destined.md")), false);
        assert.equal(existsSync(join(outer, "aa", "destined.md")), false);
        assert.equal(existsSync(join(personal, "aa", "destined.md")), false);
        for (const name of ["outer", "inner", "personal"]) {
            assert.match(String(result.content), new RegExp(`\\b${name}\\b`));
        }
    });
});

describe("route-independent exclusion", () => {
    it("holds the outer-route lock against an inner-route replace (L03)", async () => {
        // Arrange – one physical doc; two tool instances, one per configured
        // root. In-process publication is synchronous, so the holder's lock
        // stands in at the exact file the winner's mid-publication state
        // would occupy; the cross-process L02 proves the live interleave.
        const outer = tempDir();
        const inner = join(outer, "nested");
        const raw = seed(inner, "aa/doc.md", "A body.");
        const innerTool = createDocsTool({
            lakes: createLakes([lakeSpec(inner, "inner")]),
        });
        const held = holdLock(join(outer, "nested/aa/doc.md"));

        const contender = await innerTool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );

        // Assert – busy refusal naming the held lock; the lock is untouched;
        // the document bytes are unchanged.
        assert.equal(contender.metadata?.written, false);
        assert.match(String(contender.content), /holds the target lock/);
        assert.match(String(contender.content), /manual-hold/);
        assert.equal(existsSync(held), true);
        assert.equal(readFileSync(join(inner, "aa/doc.md"), "utf8"), raw);
        // Release: the ordinary recovery, then the inner route proceeds.
        unlinkSync(held);
        const retry = await innerTool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw), "- After hold.") as never,
            {} as never,
        );
        assert.equal(retry.metadata?.written, true);
        assertClean(inner);
    });

    it("shares exclusion through a symlinked configured root (L04)", async () => {
        // Arrange – the alias configuration resolves the same physical tree;
        // its lock identity is identical to the real-root configuration's.
        const real = tempDir();
        const alias = tempDir();
        const raw = seed(real, "aa/doc.md", "A body.");
        symlinkSync(real, join(alias, "link"), "dir");
        const realTool = createDocsTool({
            lakes: createLakes([lakeSpec(real, "real")]),
        });
        const held = holdLock(join(alias, "link/aa/doc.md"));
        assert.equal(
            realpathSync(join(alias, "link/aa/doc.md")),
            join(real, "aa/doc.md"),
        );

        const contender = await realTool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );

        // Assert – no root-relative symlink bypass: the alias's lock is the
        // one the real-root route consults.
        assert.equal(contender.metadata?.written, false);
        assert.match(String(contender.content), /holds the target lock/);
        assert.equal(existsSync(held), true);
        assert.equal(readFileSync(join(real, "aa/doc.md"), "utf8"), raw);
        unlinkSync(held);
        assertClean(real);
    });

    it("proceeds independently on genuinely different targets (L06)", async () => {
        const root = tempDir();
        const tool = createDocsTool({ lakes: createLakes([lakeSpec(root)]) });
        const locked = holdLock(join(root, "aa/first.md"));
        // A different physical target does not share the held lock.
        const second = await tool.execute(
            createAdd("Unrelated") as never,
            {} as never,
        );
        assert.equal(second.metadata?.written, true);
        assert.match(
            readFileSync(join(root, "aa/unrelated.md"), "utf8"),
            /# Unrelated/,
        );
        assert.equal(existsSync(locked), true);
        assert.notEqual(
            targetLockPath(join(root, "aa/first.md")),
            targetLockPath(join(root, "aa/unrelated.md")),
        );
        unlinkSync(locked);
        assertClean(root);
    });

    it("refuses a stale retry after the winner finished (L07)", async () => {
        const root = tempDir();
        const raw = seed(root, "aa/doc.md", "A body.");
        const tool = createDocsTool({ lakes: createLakes([lakeSpec(root)]) });
        // The winner replaced the doc while the loser held revision A.
        writeFileSync(
            join(root, "aa/doc.md"),
            raw.replace("A body.", "Winner got here."),
        );
        const held = holdLock(join(root, "aa/doc.md"));

        const during = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );
        unlinkSync(held);
        const afterRelease = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );

        // Assert – bounded refusal while held; a stale refusal after; the
        // winner's bytes survive every attempt.
        assert.match(String(during.content), /holds the target lock/);
        assert.match(String(afterRelease.content), /changed since you read it/);
        assert.match(
            readFileSync(join(root, "aa/doc.md"), "utf8"),
            /Winner got here\./,
        );
        assertClean(root);
    });

    it("releases the lock and the target stays whole on ordinary failure (L08)", async () => {
        const root = tempDir();
        const raw = seed(root, "aa/doc.md", "A body.");
        // An injected write failure after the lock is held: ordinary failure
        // path, refusal reported, nothing left behind.
        const tool = createDocsTool({
            lakes: createLakes([lakeSpec(root)], {
                seams: {
                    writeFull: () => {
                        const error = new Error("injected write failure");
                        (error as NodeJS.ErrnoException).code = "EPERM";
                        throw error;
                    },
                },
            }),
        });

        const failed = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );

        assert.equal(failed.metadata?.written, false);
        assert.match(String(failed.content), /could not publish/);
        assert.equal(readFileSync(join(root, "aa/doc.md"), "utf8"), raw);
        assertClean(root);

        // A subsequent valid operation proceeds: nothing was poisoned.
        const recovered = createDocsTool({
            lakes: createLakes([lakeSpec(root)]),
        });
        const retry = await recovered.execute(
            replaceAdd("aa/doc.md", revisionOf(raw), "- Recovered.") as never,
            {} as never,
        );
        assert.equal(retry.metadata?.written, true);
        assertClean(root);
    });

    it("refuses an outer-address write that physically reaches a nested lake (L09)", async () => {
        // Arrange – writable outer, read-only nested documentation owner.
        const outer = tempDir();
        const inner = join(outer, "inner");
        seed(inner, "aa/doc.md", "Inner content.");
        const tool = createDocsTool({
            lakes: createLakes([
                lakeSpec(outer, "outer"),
                lakeSpec(inner, "inner", { writable: false }),
            ]),
        });
        const before = readFileSync(join(inner, "aa/doc.md"), "utf8");

        const bypass = await tool.execute(
            {
                lake: "outer",
                add: {
                    mode: "replace",
                    path: "inner/new.md",
                    expectedRevision: "0".repeat(64),
                    metadata: {
                        Area: "aa",
                        Keywords: ["Padlock"],
                        Summary: "P.",
                    },
                    body: "# Padlock\n\n### Facts\n\n- Sent.\n",
                },
            } as never,
            {} as never,
        );

        // Assert – refused with the correct owner named: an outer address
        // never mutates content the read-only inner lake owns.
        assert.equal(bypass.metadata?.written, false);
        const content = String(bypass.content);
        assert.match(content, /physically resolves inside lake 'inner'/);
        assert.match(content, /read-only/);
        assert.equal(existsSync(join(inner, "new.md")), false);
        assert.equal(readFileSync(join(inner, "aa/doc.md"), "utf8"), before);
    });

    it("names the writable owner when the outer route aliases a writable nested lake (L09)", async () => {
        const outer = tempDir();
        const inner = join(outer, "inner");
        mkdirSync(inner, { recursive: true });
        const tool = createDocsTool({
            lakes: createLakes([
                lakeSpec(outer, "outer"),
                lakeSpec(inner, "inner"),
            ]),
        });

        const result = await tool.execute(
            {
                lake: "outer",
                add: {
                    mode: "create",
                    path: "inner/mixed.md",
                    metadata: {
                        Area: "aa",
                        Keywords: ["Mixed"],
                        Summary: "Mixed.",
                    },
                    body: "# Mixed\n\n### Facts\n\n- Seeded fact.\n",
                },
            } as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, false);
        const content = String(result.content);
        // The path is expressed for the caller to re-address.
        assert.match(content, /physically resolves inside lake 'inner'/);
        assert.match(content, /lake:'inner'/);
        assert.equal(existsSync(join(inner, "mixed.md")), false);
        assert.equal(existsSync(join(outer, "inner")), true); // Root pre-existed.
    });
});

describe("exclusive temp publication", () => {
    it("publishes a valid replacement as its own regular file (S06)", async () => {
        const root = tempDir();
        const raw = seed(root, "aa/doc.md", "A body.");
        const target = join(root, "aa/doc.md");
        const tool = createDocsTool({ lakes: createLakes([lakeSpec(root)]) });

        const result = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );

        // Assert – a regular file holds exactly the submitted bytes, and an
        // independently computed SHA-256 matches the returned revision.
        assert.equal(result.metadata?.written, true, String(result.content));
        const metadata = result.metadata as {
            revision?: string;
            lake?: string;
            path?: string;
        };
        assert.ok(lstatSync(target).isFile());
        assert.ok(!lstatSync(target).isSymbolicLink());
        const stored = readFileSync(target, "utf8");
        assert.equal(
            stored,
            serializeDoc(
                { Area: "aa", Keywords: ["Padlock"], Summary: "P." },
                "# Padlock\n\n### Facts\n\n- Sent.\n",
            ),
        );
        assert.equal(
            metadata.revision,
            await externalRevision(target),
            "revision equals the external SHA-256 of the stored bytes",
        );
        assert.equal(metadata.lake, "docs");
        assert.equal(metadata.path, "aa/doc.md");
        assertClean(root);
    });

    it("leaves a regular-file temp collision untouched (S02)", async () => {
        const root = tempDir();
        const raw = seed(root, "aa/doc.md", "A body.");
        const target = join(root, "aa/doc.md");
        const foreign = `${target}.foreign.0.tmp`;
        writeFileSync(foreign, "# someone else's data\n");

        // The injected selection deterministically hits the foreign name
        // first, then falls through to a fresh exclusive name — mirroring
        // what the production default selection does on any collision.
        let attempted = false;
        const seams: PublicationSeams = {
            temp: (candidate) => {
                if (attempted) {
                    const path = `${candidate}.${process.pid}.retry.${retrySeq++}.tmp`;
                    const fd = openSync(path, "wx");
                    return { fd, path };
                }
                attempted = true;
                const fd = openSync(foreign, "wx"); // EEXIST; never follows
                return { fd, path: foreign };
            },
        };
        const tool = createDocsTool({
            lakes: createLakes([lakeSpec(root)], { seams }),
        });

        const result = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );

        // Assert – the foreign file is not truncated, followed or removed;
        // the publication lands on the fallback temp name and the target
        // holds the submitted version. The foreign `.tmp` file is a seeded
        // fixture, not an artifact: only fallback temp files must be gone.
        assert.equal(result.metadata?.written, true);
        assert.equal(readFileSync(foreign, "utf8"), "# someone else's data\n");
        assert.ok(lstatSync(target).isFile());
        assert.match(readFileSync(target, "utf8"), /- Sent\./);
        for (const item of readdirSync(join(root, "aa"))) {
            if (item.endsWith(".tmp")) {
                assert.equal(item, "doc.md.foreign.0.tmp");
            }
        }
    });

    it("never touches a dead writer's owned temp at the same candidate name (S05)", async () => {
        // Arrange – an abandoned (or crashing) writer left its exclusive temp
        // regular file beside the target. The next writer's selection must
        // refuse the occupied candidate and land on a fresh name, leaving the
        // foreign artifact intact for a human to confirm and clear.
        const root = tempDir();
        const raw = seed(root, "aa/doc.md", "A body.");
        const target = join(root, "aa/doc.md");
        const stale = `${target}.${process.pid}.0.tmp`;
        writeFileSync(stale, "a dead writer's bytes\n");
        void stale;
        const tool = createDocsTool({ lakes: createLakes([lakeSpec(root)]) });

        const result = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, true, String(result.content));
        assert.equal(readFileSync(stale, "utf8"), "a dead writer's bytes\n");
        assert.ok(lstatSync(stale).isFile());
        // The published file is the winner's own fresh temp, never the stale
        // artefact reviewed by pathname: the only surviving `.tmp` is the
        // abandoned artifact, whose recovery stays manual (never auto-erased).
        const temps = readdirSync(join(root, "aa")).filter((name) =>
            name.endsWith(".tmp"),
        );
        assert.deepEqual(temps, [`${basename(target)}.${process.pid}.0.tmp`]);
    });

    it("refuses a symlinked lock directory without touching the outside (S03)", async () => {
        const root = tempDir();
        const outside = tempDir();
        const raw = seed(root, "aa/doc.md", "A body.");
        writeFileSync(join(outside, "ledger.txt"), "external bytes\n");
        // The protocol creates the lock directory beside the target's own
        // directory; seed the collision there.
        symlinkSync(outside, join(root, "aa/.docs-lock"), "dir");
        const tool = createDocsTool({ lakes: createLakes([lakeSpec(root)]) });

        const result = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );

        // Assert – refusal before any outside write: the outside dir keeps
        // its own bytes and nothing new appeared there.
        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /occupied by a symlink/);
        assert.deepEqual(readdirSync(outside), ["ledger.txt"]);
        assert.equal(
            readFileSync(join(outside, "ledger.txt"), "utf8"),
            "external bytes\n",
        );
        assert.equal(readFileSync(join(root, "aa/doc.md"), "utf8"), raw);
        assert.equal(existsSync(join(root, ".docs-lock")), false);
    });

    it("declines a lock pathname held by a symlink, file or directory (S04)", async () => {
        const root = tempDir();
        const raw = seed(root, "aa/doc.md", "A body.");
        const tool = createDocsTool({ lakes: createLakes([lakeSpec(root)]) });
        const outside = tempDir();
        const lockPath = targetLockPath(join(root, "aa/doc.md"));
        mkdirSync(dirname(lockPath), { recursive: true });

        // A symlinked lock pathname never follows.
        symlinkSync(join(outside, "victim.md"), lockPath);
        writeFileSync(join(outside, "victim.md"), "outside bytes\n");
        const symlinked = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );
        assert.equal(symlinked.metadata?.written, false);
        assert.match(String(symlinked.content), /holds the target lock/);
        assert.equal(
            readFileSync(join(outside, "victim.md"), "utf8"),
            "outside bytes\n",
        );
        unlinkSync(lockPath);

        // A foreign regular file owns the lock name.
        writeFileSync(lockPath, "not a lock\n");
        const foreign = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );
        assert.equal(foreign.metadata?.written, false);
        assert.equal(readFileSync(lockPath, "utf8"), "not a lock\n");
        unlinkSync(lockPath);

        // A directory owns the lock name.
        mkdirSync(lockPath);
        const directory = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );
        assert.equal(directory.metadata?.written, false);
        assert.ok(lstatSync(lockPath).isDirectory());
        rmSync(lockPath, { recursive: true });
        assertClean(root);
    });

    it("fails honestly mid-write and cleans only its own artifacts (S07)", async () => {
        const root = tempDir();
        const raw = seed(root, "aa/doc.md", "A body.");
        const target = join(root, "aa/doc.md");
        // A foreign-sounding next-candidate file that cleanup must never touch.
        const foreign = `${target}.next.0.tmp`;
        writeFileSync(foreign, "foreign holder\n");
        let calls = 0;
        const tool = createDocsTool({
            lakes: createLakes([lakeSpec(root)], {
                seams: {
                    writeFull: (fd, contents) => {
                        calls += 1;
                        if (calls === 1) {
                            // First (racing) writer: write half, then fail
                            // with an ordinary I/O refusal.
                            const buffer = Buffer.from("# partial", "utf8");
                            writeSync(fd, buffer, 0, buffer.length);
                            const error = new Error("injected mid-write");
                            (error as NodeJS.ErrnoException).code = "EPERM";
                            throw error;
                        }
                        writeFullBytes(fd, contents);
                    },
                },
            }),
        });

        const failed = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw), "- Fresh bytes.") as never,
            {} as never,
        );

        // Assert – failure reported; original doc whole; the owned partial
        // temp and the lock cleaned; the foreign file untouched.
        assert.equal(failed.metadata?.written, false);
        assert.match(String(failed.content), /could not publish/);
        assert.equal(readFileSync(target, "utf8"), raw);
        assert.equal(readFileSync(foreign, "utf8"), "foreign holder\n");
        for (const item of readdirSync(join(root, "aa"))) {
            if (item.endsWith(".tmp")) {
                assert.equal(item, "doc.md.next.0.tmp");
            }
        }

        // The published file is always the operation's own full version.
        const retry = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw), "- Fresh bytes.") as never,
            {} as never,
        );
        assert.equal(retry.metadata?.written, true);
        assert.match(readFileSync(target, "utf8"), /# Padlock/);
        for (const item of readdirSync(join(root, "aa"))) {
            if (item.endsWith(".tmp")) {
                assert.equal(item, "doc.md.next.0.tmp");
            }
        }
    });

    it("reports a rename failure and leaves the document complete (S08)", async () => {
        const root = tempDir();
        const raw = seed(root, "aa/doc.md", "A body.");
        const target = join(root, "aa/doc.md");
        const tool = createDocsTool({
            lakes: createLakes([lakeSpec(root)], {
                seams: {
                    rename: () => {
                        const error = new Error("injected rename failure");
                        (error as NodeJS.ErrnoException).code = "EPERM";
                        throw error;
                    },
                },
            }),
        });

        const result = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, false);
        assert.match(String(result.content), /could not publish/);
        assert.equal(readFileSync(target, "utf8"), raw);
        assertClean(root);
    });

    it("keeps lock and temp artifacts out of search and check (S11)", async () => {
        const root = tempDir();
        seed(root, "aa/doc.md", "A body.");
        const tool = createDocsTool({ lakes: createLakes([lakeSpec(root)]) });
        mkdirSync(join(root, "aa/.docs-lock"), { recursive: true });
        writeFileSync(
            join(root, "aa/.docs-lock/decoy.md"),
            "---\nArea: aa\nKeywords: quorum\nSummary: Decoy.\n---\n# Decoy\n\n### Facts\n\n- x.\n",
        );
        writeFileSync(
            join(root, "aa/doc.md.operand.1.tmp"),
            "# operand stub\n",
        );

        const search = await tool.execute({ search: "quorum" }, {} as never);
        const found = await tool.execute({ search: "operand" }, {} as never);
        const checked = await tool.execute({ check: true }, {} as never);

        assert.match(String(search.content), /No knowledge docs matched/);
        assert.match(String(found.content), /No knowledge docs matched/);
        assert.match(String(checked.content), /All 1 docs comply\./);
        // The fixtures were never consumed as knowledge; remove them, then
        // prove the suite leaves nothing extra behind.
        const seeded = [
            join(root, "aa/.docs-lock"),
            join(root, "aa/doc.md.operand.1.tmp"),
        ];
        for (const path of seeded) {
            rmSync(path, { recursive: true, force: true });
        }
        assertClean(root);
    });

    it("writes a safe, complete doc through a symlinked configured root (S09)", async () => {
        const real = tempDir();
        const alias = tempDir();
        symlinkSync(real, join(alias, "link"), "dir");
        const tool = createDocsTool({
            lakes: createLakes([{ ...lakeSpec(join(alias, "link"), "docs") }]),
        });

        const result = await tool.execute(
            createAdd("Aliased") as never,
            {} as never,
        );

        assert.equal(result.metadata?.written, true, String(result.content));
        const raw = readFileSync(join(real, "aa/aliased.md"), "utf8");
        assert.match(raw, /^---\nArea: aa\n/);
        // The published doc is a regular file at the physical root.
        assert.ok(lstatSync(join(real, "aa/aliased.md")).isFile());
        assertClean(real);
    });

    it("refuses a symlinked doc and a symlinked ancestor (S10)", async () => {
        const root = tempDir();
        const outside = tempDir();
        writeFileSync(join(outside, "elsewhere.md"), "# elsewhere\n");
        const raw = seed(root, "aa/doc.md", "A body.");
        symlinkSync(join(outside, "elsewhere.md"), join(root, "aa/link.md"));
        mkdirSync(join(root, "aa/realdir"), { recursive: true });
        symlinkSync(join(root, "aa/realdir"), join(root, "aa/jump"));
        const tool = createDocsTool({ lakes: createLakes([lakeSpec(root)]) });

        const docLink = await tool.execute(
            replaceAdd("aa/link.md", revisionOf(raw)) as never,
            {} as never,
        );
        const readLink = await tool.execute(
            { read: "aa/link.md" },
            {} as never,
        );
        const ancestor = await tool.execute(
            replaceAdd("aa/jump/dive.md", revisionOf(raw)) as never,
            {} as never,
        );

        assert.equal(docLink.metadata?.written, false);
        assert.equal((readLink.metadata as { read?: string }).read, null);
        assert.equal(ancestor.metadata?.written, false);
        assert.match(
            String(docLink.content),
            /crosses a symlink|not end in .md|no doc at/,
        );
        assert.equal(
            readFileSync(join(outside, "elsewhere.md"), "utf8"),
            "# elsewhere\n",
        );
        assertClean(root);
    });

    it("loops a short write until the whole sequence is stored (S12)", async () => {
        const root = tempDir();
        const fd = openSync(join(root, "partial.bin"), "wx");
        // A capped writer: never more than 5 bytes per call, exactly the
        // short-write behaviour the loop must survive.
        const cappedWrite = (
            target: number,
            buffer: Uint8Array,
            offset: number,
            length: number,
        ): number =>
            writeSync(target, buffer as Buffer, offset, Math.min(length, 5));
        const contents = "x".repeat(37);

        writeFullBytes(fd, contents, cappedWrite as typeof writeSync);
        closeSync(fd);

        assert.equal(readFileSync(join(root, "partial.bin"), "utf8"), contents);
    });

    it("fails honestly when a write stalls at zero (S12)", async () => {
        const root = tempDir();
        const fd = openSync(join(root, "stalled.bin"), "wx");
        let offset = 0;
        // Writes 2 bytes at a time, then stalls at 0: the loop must throw
        // rather than pretend the rest landed.
        const stallingWrite = (
            target: number,
            buffer: Uint8Array,
            at: number,
            length: number,
        ): number => {
            if (offset >= 4) {
                return 0;
            }
            const count = Math.min(2, length);
            offset += count;
            writeSync(target, buffer as Buffer, at, count);
            return count;
        };

        assert.throws(
            () =>
                writeFullBytes(
                    fd,
                    "y".repeat(8),
                    stallingWrite as typeof writeSync,
                ),
            /stalled after 4/,
        );
        closeSync(fd);
        // No false success: two 2-byte writes stored; the stall at zero
        // throws so no caller can mistake a truncated file for a publication.
        assert.equal(readFileSync(join(root, "stalled.bin"), "utf8"), "yyyy");
    });
});

describe("create failure recovery", () => {
    it("removes its own partial file when a create fails mid-write", async () => {
        // Arrange – a create whose write stores half the bytes, then fails
        // with an ordinary I/O refusal.
        const root = tempDir();
        const tool = createDocsTool({
            lakes: createLakes([lakeSpec(root)], {
                seams: {
                    writeFull: (fd) => {
                        writeSync(fd, Buffer.from("# partial", "utf8"));
                        const error = new Error("injected mid-write");
                        (error as NodeJS.ErrnoException).code = "EPERM";
                        throw error;
                    },
                },
            }),
        });

        // Act
        const failed = await tool.execute(
            createAdd("Crash") as never,
            {} as never,
        );

        // Assert – refused, the operation's own partial doc removed, no lock
        // or temp left, and the path stays free for a deliberate retry.
        assert.equal(failed.metadata?.written, false);
        assert.match(String(failed.content), /could not publish/);
        assert.equal(existsSync(join(root, "aa/crash.md")), false);
        assertClean(root);
        const retry = await createDocsTool({
            lakes: createLakes([lakeSpec(root)]),
        }).execute(createAdd("Crash") as never, {} as never);
        assert.equal(retry.metadata?.written, true);
    });

    it("propagates an unmapped publication error instead of refusing", async () => {
        // Arrange – an I/O error no refusal mapping covers.
        const root = tempDir();
        const tool = createDocsTool({
            lakes: createLakes([lakeSpec(root)], {
                seams: {
                    writeFull: (fd) => {
                        writeSync(fd, Buffer.from("# partial", "utf8"));
                        const error = new Error("injected mid-write");
                        (error as NodeJS.ErrnoException).code = "EIO";
                        throw error;
                    },
                },
            }),
        });

        // Act / Assert – the failure is the caller's, not a refusal, and its
        // own partial doc is still removed.
        await assert.rejects(
            tool.execute(createAdd("Crash") as never, {} as never),
            /injected mid-write/,
        );
        assert.equal(existsSync(join(root, "aa/crash.md")), false);
        assertClean(root);
    });

    it("gives up after MAX_TEMP_ATTEMPTS occupied temp names", async () => {
        // Arrange – every candidate temp name is already occupied by a
        // foreign object this operation does not own.
        const root = tempDir();
        const raw = seed(root, "aa/doc.md", "A body.");
        let attempts = 0;
        const tool = createDocsTool({
            lakes: createLakes([lakeSpec(root)], {
                seams: {
                    temp: () => {
                        attempts += 1;
                        const error = new Error("occupied");
                        (error as NodeJS.ErrnoException).code = "EEXIST";
                        throw error;
                    },
                },
            }),
        });

        // Act
        const result = await tool.execute(
            replaceAdd("aa/doc.md", revisionOf(raw)) as never,
            {} as never,
        );

        // Assert – the bound is the contract, the document is untouched, and
        // nothing was published under a name the operation did not own.
        assert.equal(result.metadata?.written, false);
        assert.match(
            String(result.content),
            /every candidate temp name was occupied/,
        );
        assert.equal(attempts, MAX_TEMP_ATTEMPTS);
        assert.equal(readFileSync(join(root, "aa/doc.md"), "utf8"), raw);
        assertClean(root);
    });
});
