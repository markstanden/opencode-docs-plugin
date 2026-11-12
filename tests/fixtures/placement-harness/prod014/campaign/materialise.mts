// Materialise the campaign into a fresh campaign root.
//
// Two source modes:
// - fresh (default): checked sources under `active/`, hashed by
//   `active/snapshot.json` so a partially published or edited tree refuses;
// - `--historical`: the frozen `scripts.json` snapshot, kept for replay of the
//   2026-11-11 campaign (attempt-002).
//
// Nothing is written into an existing campaign, and publication is atomic:
// sources are verified and staged before any of them is published.
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const historical = args.includes("--historical");
const updateSnapshot = args.includes("--snapshot");
const target = args.find((arg) => !arg.startsWith("--"));
if (!target) {
    console.error(
        "usage: materialise.mts <campaign-root> [--historical] [--snapshot]",
    );
    process.exit(2);
}

const sha256 = (body: Uint8Array | string): string =>
    createHash("sha256").update(body).digest("hex");

/** A JSON object of string values, or a refusal. */
function recordOf(value: unknown, label: string): Record<string, string> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        console.error(`${label} must be a JSON object`);
        process.exit(1);
    }
    const record: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== "string") {
            console.error(`${label}.${key} must be a string`);
            process.exit(1);
        }
        record[key] = entry;
    }
    return record;
}

/** The frozen script snapshot, or a refusal. */
function scriptSnapshotOf(value: unknown): {
    files: Record<string, string>;
    hashes: Record<string, string>;
} {
    if (typeof value !== "object" || value === null) {
        console.error("scripts.json must be a JSON object");
        process.exit(1);
    }
    const { files, hashes } = value as {
        files?: unknown;
        hashes?: unknown;
    };
    return {
        files: recordOf(files, "scripts.json.files"),
        hashes: recordOf(hashes, "scripts.json.hashes"),
    };
}

const filesUnder = (dir: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...filesUnder(path));
        else if (entry.isFile()) found.push(path);
    }
    return found.sort();
};

/** Every fresh source file, keyed by its campaign-relative name. */
function activeSources(): Record<string, Buffer> {
    const root = join(here, "active");
    const sources: Record<string, Buffer> = {};
    for (const path of filesUnder(root)) {
        const name = relative(root, path).split("\\").join("/");
        if (name === "snapshot.json") continue;
        sources[name] = readFileSync(path);
    }
    return sources;
}

/** Verify or regenerate the checked source snapshot. */
function snapshotOf(
    sources: Record<string, Uint8Array | string>,
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(sources).map(([name, body]) => [name, sha256(body)]),
    );
}

const active = historical ? null : activeSources();
if (updateSnapshot) {
    if (active === null) {
        console.error("--snapshot describes the fresh sources; do not combine");
        process.exit(2);
    }
    writeFileSync(
        join(here, "active/snapshot.json"),
        `${JSON.stringify(snapshotOf(active), null, 4)}\n`,
        "utf8",
    );
    const runnerPath = join(here, "runner.json");
    const runner = JSON.parse(readFileSync(runnerPath, "utf8")) as unknown;
    if (typeof runner !== "object" || runner === null) {
        console.error("runner.json must be a JSON object");
        process.exit(1);
    }
    const files = recordOf(
        (runner as { files?: unknown }).files,
        "runner.json.files",
    );
    for (const name of Object.keys(files)) {
        files[name] = sha256(
            readFileSync(join(here, "..", "..", "analysis", name)),
        );
    }
    const next = { ...(runner as Record<string, unknown>), files };
    writeFileSync(runnerPath, `${JSON.stringify(next, null, 4)}\n`, "utf8");
    console.log(
        `wrote active/snapshot.json (${Object.keys(active).length} files) and runner.json (${Object.keys(files).length} modules)`,
    );
    process.exit(0);
}

/** The frozen script snapshot used for historical replay. */
function historicalSources(): Record<string, Buffer> {
    const snapshot = scriptSnapshotOf(
        JSON.parse(readFileSync(join(here, "scripts.json"), "utf8")),
    );
    const sources: Record<string, Buffer> = {};
    for (const [name, body] of Object.entries(snapshot.files)) {
        const hash = sha256(body);
        if (hash !== snapshot.hashes[name]) {
            console.error(`script ${name} does not match its frozen hash`);
            process.exit(1);
        }
        sources[name] = Buffer.from(body, "utf8");
    }
    return sources;
}

if (active !== null) {
    const expected = recordOf(
        JSON.parse(readFileSync(join(here, "active/snapshot.json"), "utf8")),
        "active/snapshot.json",
    );
    const actual = snapshotOf(active);
    const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const problems = [...names]
        .sort()
        .filter((name) => expected[name] !== actual[name])
        .map((name) =>
            expected[name] === undefined
                ? `active source not in snapshot: ${name}`
                : actual[name] === undefined
                  ? `snapshot source missing: ${name}`
                  : `active source changed: ${name}`,
        );
    if (problems.length > 0) {
        console.error(problems.join("\n"));
        process.exit(1);
    }
}

const sources = active ?? historicalSources();

// Refuse before writing anything: a materialised or frozen campaign is owned by
// its evidence, never overwritten by a later materialisation.
const prepareDir = join(target, "prepare");
const runnerDir = join(target, "runner");
if (existsSync(join(target, "evidence/FROZEN.json"))) {
    console.error("refusing to materialise over a frozen campaign");
    process.exit(1);
}
for (const dir of [prepareDir, runnerDir]) {
    if (existsSync(dir) && readdirSync(dir).length > 0) {
        console.error(`refusing to overwrite existing ${dir}`);
        process.exit(1);
    }
}

const runnerRecord = JSON.parse(
    readFileSync(join(here, "runner.json"), "utf8"),
) as unknown;
if (typeof runnerRecord !== "object" || runnerRecord === null) {
    console.error("runner.json must be a JSON object");
    process.exit(1);
}
const runner = {
    files: recordOf(
        (runnerRecord as { files?: unknown }).files,
        "runner.json.files",
    ),
};
const runnerSources: Record<string, Buffer> = {};
for (const [name, expected] of Object.entries(runner.files)) {
    const body = readFileSync(join(here, "..", "..", "analysis", name), "utf8");
    if (sha256(body) !== expected) {
        console.error(`runner ${name} does not match its pinned hash`);
        process.exit(1);
    }
    runnerSources[name] = Buffer.from(body, "utf8");
}

mkdirSync(target, { recursive: true });
const staging = mkdtempSync(join(target, ".materialise-"));
try {
    for (const [name, body] of Object.entries(sources)) {
        const path = join(staging, "prepare", name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
        if (name.endsWith(".sh") || name === "shim/podman") {
            chmodSync(path, 0o755);
        }
    }
    for (const [name, body] of Object.entries(runnerSources)) {
        const path = join(staging, "runner", name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
    }
    // Publish only fully staged trees.
    mkdirSync(join(target, "prepare"), { recursive: true });
    mkdirSync(join(target, "runner"), { recursive: true });
    for (const name of Object.keys(sources)) {
        const destination = join(prepareDir, name);
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(join(staging, "prepare", name), destination);
    }
    for (const name of Object.keys(runnerSources)) {
        const destination = join(runnerDir, name);
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(join(staging, "runner", name), destination);
    }
    rmSync(staging, { recursive: true, force: true });
} catch (error) {
    rmSync(staging, { recursive: true, force: true });
    console.error(
        `materialisation failed before publication: ${String(error)}`,
    );
    process.exit(1);
}

console.log(
    `materialised ${Object.keys(sources).length} ${historical ? "historical" : "fresh"} scripts into ${target}/prepare and ${Object.keys(runnerSources).length} pinned runner modules into ${target}/runner`,
);
