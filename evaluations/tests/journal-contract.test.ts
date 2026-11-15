/**
 * Cross-project contract: the PLUGIN'S PACKED SHAPE writes a signed journal
 * that the installed, pinned OTC evaluator credits. Development tooling only.
 *
 * The two projects meet at one real interface: the journal line the plugin
 * emits while serving a call. The evaluator is the authority for what that
 * line proves, so this suite drives the packed plugin (not the source tree),
 * then hands the captured bytes to OTC's checked evidence boundary.
 *
 * Two host shapes are known to be lossy, and both are exercised here because
 * weakening attribution to make the split pass would defeat the boundary:
 *
 * - a native `add` may reach the host trail as the pre-decode JSON string
 *   while the plugin journals the decoded struct;
 * - the runtime discards an undeclared nested `add.lake` before `execute`, so
 *   only a declared top-level selector may corroborate the destination.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyOperationsJournal } from "@markstanden/opencode-test-container";

const REPO = join(import.meta.dirname, "..", "..");
const KEY = "cross-project-key";
const SESSION = "ses_contract";
const MESSAGE = "msg_contract";
const CALL = "call_contract";

/** The packed plugin surface this contract depends on. */
interface PackedPlugin {
    createDocsTool: (
        deps: unknown,
        options?: unknown,
    ) => {
        execute: (input: unknown, context: unknown) => Promise<unknown>;
    };
    createLakes: (specs: readonly unknown[]) => readonly unknown[];
}

/** Read one string-valued export from the packed plugin by its public name. */
function exportedName(api: PackedPlugin, name: string): string {
    const value = Reflect.get(api, name);
    assert.equal(typeof value, "string", `${name} is a string export`);
    return value as string;
}

/** One resolved lake, in the plugin's runtime shape. */
interface LakeSpec {
    name: string;
    class: "repo" | "machine" | "global" | "wiki";
    root: string;
    profile: "knowledge" | "wiki";
    writable: boolean;
    description: string;
}

const temporaryDirectories: string[] = [];
let packed: PackedPlugin;

/** A temp directory this suite owns. */
function temporary(label: string): string {
    const directory = mkdtempSync(join(tmpdir(), `docs-otc-${label}-`));
    temporaryDirectories.push(directory);
    return directory;
}

/** Pack the plugin, extract it away from the source tree, and load it. */
async function loadPackedPlugin(): Promise<PackedPlugin> {
    const workspace = temporary("pack");
    const pack = spawnSync("npm", ["pack", "--json", REPO], {
        cwd: workspace,
        encoding: "utf8",
    });
    assert.equal(pack.status, 0, pack.stderr);
    const parsed = JSON.parse(pack.stdout) as
        Array<{ filename?: string }> | Record<string, { filename?: string }>;
    const entry = (
        Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
    ) as { filename?: string } | undefined;
    const tarball = entry?.filename;
    assert.ok(tarball, "npm pack named a tarball");

    // The extraction lives outside any node_modules ancestor: Node refuses
    // type-stripping below node_modules, while the package's own copied
    // dependencies still resolve. This is the installed layout.
    const packageRoot = join(workspace, "installed", "opencode-docs-plugin");
    mkdirSync(packageRoot, { recursive: true });
    const extract = spawnSync(
        "tar",
        [
            "xzf",
            join(workspace, tarball),
            "-C",
            packageRoot,
            "--strip-components=1",
        ],
        { encoding: "utf8" },
    );
    assert.equal(extract.status, 0, extract.stderr);
    assert.ok(existsSync(join(packageRoot, "src", "index.ts")));
    for (const dependency of ["@opencode", "effect"]) {
        cpSync(
            join(REPO, "node_modules", dependency),
            join(packageRoot, "node_modules", dependency),
            { recursive: true },
        );
    }
    const loaded = (await import(
        pathToFileURL(join(packageRoot, "src", "index.ts")).href
    )) as unknown as PackedPlugin;
    return loaded;
}

/** Resolve one knowledge lake with a real, writable root. */
function lake(root: string, name: string): LakeSpec {
    mkdirSync(root, { recursive: true });
    return {
        name,
        class: "repo",
        root,
        profile: "knowledge",
        writable: true,
        description: `${name} test lake`,
    };
}

/** A valid add DTO, as the host delivers it to `execute`. */
function addInput(): Record<string, unknown> {
    return {
        mode: "create",
        metadata: {
            Area: "Notes",
            Keywords: ["queue", "retry"],
            Summary: "Queue retries cap at three attempts.",
        },
        body: "# Queue retries\n\n## Facts\n\n- Cap retries at three.\n",
    };
}

/** Serve one native docs call with the journal armed, and read it back. */
async function serve(
    lakes: readonly LakeSpec[],
    input: Record<string, unknown>,
): Promise<{ lines: string[]; result: unknown }> {
    const directory = temporary("journal");
    const path = join(directory, "docs-operations.jsonl");
    const journalPathName = exportedName(packed, "OPERATION_JOURNAL_ENV");
    const journalKeyName = exportedName(packed, "OPERATION_JOURNAL_KEY_ENV");
    process.env[journalPathName] = path;
    process.env[journalKeyName] = KEY;
    try {
        const tool = packed.createDocsTool({
            lakes: packed.createLakes(lakes),
        });
        const result = await tool.execute(input, {
            sessionID: SESSION,
            messageID: MESSAGE,
            id: CALL,
        });
        assert.ok(
            existsSync(path),
            "the plugin wrote a journal line for the served call",
        );
        return {
            lines: readFileSync(path, "utf8").split("\n"),
            result,
        };
    } finally {
        delete process.env[journalPathName];
        delete process.env[journalKeyName];
    }
}

/** Verify one captured line against the host dispatch this test asserts. */
function verify(
    lines: readonly string[],
    hostInput: unknown,
): ReturnType<typeof verifyOperationsJournal> {
    return verifyOperationsJournal({
        lines,
        key: KEY,
        identity: {
            sessions: new Set([SESSION]),
            messages: new Set([MESSAGE]),
        },
        callIds: new Set([CALL]),
        nativeCalls: [
            {
                tool: "docs",
                status: "completed",
                input: hostInput,
                callId: CALL,
            },
        ],
        dispatches: [],
    });
}

/** The signed result's metadata from the one credited record. */
function assertCreditedMetadata(
    verification: ReturnType<typeof verifyOperationsJournal>,
): { written: boolean; lake: string } {
    const record = verification.credited[0]?.record;
    assert.ok(record, "one journal line is credited");
    const result = record.result as {
        metadata: { written: boolean; lake: string };
    };
    return result.metadata;
}

/** The write facts the plugin served, asserting the write actually happened. */
function assertServedWrite(result: unknown): void {
    const metadata = (
        result as { metadata?: { written?: boolean; lake?: string } }
    ).metadata;
    assert.equal(
        metadata?.written,
        true,
        "the add wrote before credit was refused",
    );
    assert.equal(metadata?.lake, "docs");
}

before(async () => {
    packed = await loadPackedPlugin();
});

after(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("credits a packed-plugin native add whose host trail kept the JSON string", async () => {
    // Arrange: the host decodes the string before execute, so the plugin
    // journals the struct while the trail keeps the pre-decode form.
    const root = temporary("lake-string");
    const lakes = [lake(join(root, "docs"), "docs")];
    const add = addInput();

    // Act
    const { lines } = await serve(lakes, { lake: "docs", add });
    const verification = verify(lines, {
        lake: "docs",
        add: JSON.stringify(add),
    });

    // Assert
    assert.equal(verification.state, "verified");
    assert.equal(verification.credited.length, 1);
    assert.deepEqual(verification.rejected, []);
    assert.equal(assertCreditedMetadata(verification).written, true);
    assert.equal(assertCreditedMetadata(verification).lake, "docs");
});

for (const [behaviour, nestedLake] of [
    [
        "credits a matching undelivered nested lake against the declared top-level lake",
        "docs",
    ],
    [
        "keeps the declared top-level lake when the discarded nested value conflicts",
        "shared",
    ],
] as const) {
    test(behaviour, async () => {
        // Arrange: the nested `add.lake` is dropped before execute; only the
        // declared top-level selector is what the plugin saw and wrote.
        const root = temporary("lake-nested");
        const docs = lake(join(root, "docs"), "docs");
        const shared = lake(join(root, "docs", "shared"), "shared");
        const add = addInput();

        // Act
        const { lines } = await serve([docs, shared], {
            lake: "docs",
            add,
        });
        const verification = verify(lines, {
            lake: "docs",
            add: { ...add, lake: nestedLake },
        });

        // Assert
        assert.equal(verification.state, "verified");
        assert.equal(verification.credited.length, 1);
        assert.deepEqual(verification.rejected, []);
        assert.equal(assertCreditedMetadata(verification).lake, "docs");
    });
}

test("refuses credit for a successful write corroborated only by a nested lake", async () => {
    // Arrange: one writable lake means the add succeeds without a declared
    // selector, but the nested value cannot corroborate the destination.
    const root = temporary("lake-nested-only");
    const lakes = [lake(join(root, "docs"), "docs")];
    const add = addInput();

    // Act
    const { lines, result } = await serve(lakes, { add });
    const verification = verify(lines, { add: { ...add, lake: "docs" } });

    // Assert
    assertServedWrite(result);
    assert.equal(verification.state, "verified");
    assert.deepEqual(verification.credited, []);
    assert.deepEqual(verification.rejected, [
        { index: 0, reason: "no-host-dispatch" },
    ]);
});
