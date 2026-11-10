// Deterministic readiness check for R01–R04. Materialises each case, proves the
// seeded state fails (or passes for R04), proves the intended fix passes, and
// proves a plausible wrong fix fails. Also exercises the R02 preservation rule
// with a paraphrase, a supported obsolete-fact removal and a valid-fact loss.
import { spawnSync } from "node:child_process";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preservationVerdict } from "./preservation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checksDir = join(here, "..", "primary-checks");
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));

const materialise = (testCase, root) => {
    for (const one of testCase.seeds) {
        const target = join(root, one.surface, one.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, one.contents, "utf8");
    }
    spawnSync("git", ["init", "-q"], {
        cwd: join(root, "work"),
        stdio: "ignore",
    });
    return join(root, "work");
};

const runCheck = (testCase, liveWork, pristineWork) => {
    const result = spawnSync(
        process.execPath,
        [join(checksDir, testCase.primaryCheck.script), liveWork, pristineWork],
        { encoding: "utf8", timeout: 120000 },
    );
    return {
        status: result.status,
        detail: (result.stdout ?? "") + (result.stderr ?? ""),
    };
};

const report = [];
const record = (id, label, expected, actual, detail) => {
    const ok = expected === actual;
    report.push({ id, label, expected, actual, ok, detail });
    console.log(
        `${ok ? "PASS" : "FAIL"} ${id} ${label}: expected ${expected}, got ${actual}`,
    );
    if (!ok && detail) console.log(detail.slice(0, 800));
};

const fixes = {
    R01: {
        intended(work) {
            const path = join(work, "src/csv.ts");
            const source = readFileSync(path, "utf8");
            writeFileSync(
                path,
                source.replace(
                    "export function parseCsv(text: string): Order[] {\n    const lines = text.split(",
                    'export function parseCsv(text: string): Order[] {\n    const normalized = text.replace(/^\\uFEFF/, "");\n    const lines = normalized.split(',
                ),
            );
        },
        wrong(work) {
            const path = join(work, "src/csv.ts");
            writeFileSync(
                path,
                readFileSync(path, "utf8").replace(
                    "const lines = text.split(",
                    "const lines = text.slice(1).split(",
                ),
            );
        },
    },
    R02: {
        intended(work) {
            const path = join(work, "src/db.ts");
            writeFileSync(
                path,
                readFileSync(path, "utf8").replace(
                    'ssl: "disable"',
                    'ssl: "require"',
                ),
            );
        },
        wrong(work) {
            const path = join(work, "src/db.ts");
            writeFileSync(
                path,
                readFileSync(path, "utf8")
                    .replace('ssl: "disable"', 'ssl: "require"')
                    .replace("max: 10", "max: 20"),
            );
        },
    },
    R03: {
        intended(work) {
            rmSync(join(work, ".tmp/dev.sock"), { force: true });
        },
        wrong(work) {
            const path = join(work, "test/server.test.ts");
            writeFileSync(
                path,
                readFileSync(path, "utf8").replace(
                    "const stop = await start(socket);",
                    "let stop: () => void = () => {};\n    try { stop = await start(socket); } catch { stop = () => {}; }",
                ),
            );
        },
    },
    R04: {
        intended() {},
        wrong(work) {
            cpSync(
                join(work, "migrations/002_add_index.sql"),
                join(work, "migrations/0020_add_index.sql"),
            );
            rmSync(join(work, "migrations/002_add_index.sql"));
        },
    },
};

for (const testCase of cases) {
    const pristineRoot = mkdtempSync(
        join(tmpdir(), `pristine-${testCase.id}-`),
    );
    const pristineWork = materialise(testCase, pristineRoot);

    const liveRoot = mkdtempSync(join(tmpdir(), `live-${testCase.id}-`));
    const liveWork = materialise(testCase, liveRoot);
    const seeded = runCheck(testCase, liveWork, pristineWork);
    const seededPasses = testCase.id === "R04";
    record(
        testCase.id,
        "seeded state",
        seededPasses ? 0 : 1,
        seeded.status === 0 ? 0 : 1,
        seeded.detail,
    );

    const fixRoot = mkdtempSync(join(tmpdir(), `fix-${testCase.id}-`));
    const fixWork = materialise(testCase, fixRoot);
    fixes[testCase.id].intended(fixWork);
    const fixed = runCheck(testCase, fixWork, pristineWork);
    record(testCase.id, "intended fix", 0, fixed.status, fixed.detail);

    const wrongRoot = mkdtempSync(join(tmpdir(), `wrong-${testCase.id}-`));
    const wrongWork = materialise(testCase, wrongRoot);
    fixes[testCase.id].wrong(wrongWork);
    const wrong = runCheck(testCase, wrongWork, pristineWork);
    record(
        testCase.id,
        "counterexample",
        1,
        wrong.status === 0 ? 0 : 1,
        wrong.detail,
    );

    for (const root of [pristineRoot, liveRoot, fixRoot, wrongRoot])
        rmSync(root, { recursive: true, force: true });
}

const base = `# Pool

### Facts

`;
const validFacts =
    "- The pool holds at most 10 connections.\n- Acquiring a connection waits up to 5 seconds before failing.\n- Migrations run at application startup.\n";
const examples = {
    "valid paraphrase": `${base}- The pool is capped at ten connections.\n- A caller waits five seconds for a connection.\n- Schema migrations run at start-up.\n- TLS is required.\n`,
    "supported obsolete-fact removal": `${base}${validFacts}- TLS is required after the upgrade.\n`,
    "valid-fact loss": `${base}- TLS is required after the upgrade.\n`,
};
const expectations = {
    "valid paraphrase": true,
    "supported obsolete-fact removal": true,
    "valid-fact loss": false,
};
for (const [label, document] of Object.entries(examples)) {
    const verdict = preservationVerdict(document);
    record(
        "R02-preservation",
        label,
        expectations[label],
        verdict.accepted,
        JSON.stringify(verdict),
    );
}

const failed = report.filter((one) => !one.ok);
console.log(
    `\n${report.length - failed.length}/${report.length} checks passed`,
);
process.exit(failed.length === 0 ? 0 : 1);
