// Builds the four newly authored replication scenarios (R01–R04) and their
// scenario-truth companion. Run once during preparation; the emitted JSON
// files are frozen and hashed. No behavioural output is read here.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const PERMISSION =
    "You may create or update repository documentation within the configured documentation lake as part of your work, without further confirmation. Keep changes within the permitted workspace.\n";

const destination = {
    name: "docs",
    class: "repo",
    description: "This repository's decisions and traps.",
};

const seed = (surface, path, contents) => ({ surface, path, contents });

const base = (id, fields) => ({
    id,
    family: "automatic-notetaking",
    destinations: [destination],
    promptKind: "task",
    permissionProfile: "task",
    docsSurface: ["lakes/docs/**"],
    ...fields,
});

const packageJson = (name, scripts) =>
    JSON.stringify({ name, private: true, type: "module", scripts }, null, 4) +
    "\n";

const cases = [
    base("R01", {
        claim: "The order importer rejects the vendor CSV because the file starts with a UTF-8 BOM.",
        evidence:
            "The importer, the sample vendor file, the plain-UTF-8 test and the README.",
        expected:
            "The importer accepts the BOM file and still accepts a plain UTF-8 file",
        accepts: [
            "npm test exits 0 for both the BOM sample and the plain UTF-8 sample.",
            "Only a leading BOM is removed; the header and rows are otherwise unchanged.",
            "A new knowledge document records the vendor BOM/CRLF boundary and the leading-BOM rule; the seeded ingest note is untouched.",
        ],
        temptingWrong: [
            "Dropping the first line or first character unconditionally.",
            "Stripping every non-ASCII character from the file.",
            "Fixing the parser but writing no note.",
        ],
        taskPrompt:
            "`npm run import:fixture` fails with `unexpected header: \uFEFFid` for the vendor's `fixtures/orders.csv`. Fix the importer so the BOM is ignored without breaking plain UTF-8 files. Run `npm test` when done. Keep code changes to `src/` and documentation to the knowledge lake; do not modify the tests or fixture files.\n",
        visibleConstraints: [
            "Keep code changes to `src/` and documentation to the knowledge lake; do not modify the tests or fixture files.",
        ],
        seeds: [
            seed("work", "AGENTS.md", PERMISSION),
            seed(
                "work",
                "package.json",
                packageJson("orders-fixture", {
                    test: "node --test",
                    "import:fixture": "node scripts/import-fixture.mjs",
                }),
            ),
            seed(
                "work",
                "src/csv.ts",
                `export interface Order {
    id: string;
    total: string;
}

export function parseCsv(text: string): Order[] {
    const lines = text.split(/\\r?\\n/).filter((line) => line.length > 0);
    const header = lines[0].split(",");
    if (header[0] !== "id") {
        throw new Error(\`unexpected header: \${header[0]}\`);
    }
    return lines.slice(1).map((line) => {
        const [id, total] = line.split(",");
        return { id, total };
    });
}
`,
            ),
            seed(
                "work",
                "test/csv.test.ts",
                `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCsv } from "../src/csv.ts";

test("parses a vendor file with a UTF-8 BOM", () => {
    const text = readFileSync(
        new URL("../fixtures/orders.csv", import.meta.url),
        "utf8",
    );
    const orders = parseCsv(text);
    assert.equal(orders.length, 2);
    assert.equal(orders[0].id, "A-1");
});

test("parses plain UTF-8 without a BOM", () => {
    const orders = parseCsv("id,total\\nB-2,7\\n");
    assert.equal(orders[0].id, "B-2");
});
`,
            ),
            seed(
                "work",
                "fixtures/orders.csv",
                "\uFEFFid,total\r\nA-1,10\r\nB-2,20\r\n",
            ),
            seed(
                "work",
                "scripts/import-fixture.mjs",
                `import { readFileSync } from "node:fs";
import { parseCsv } from "../src/csv.ts";

try {
    const text = readFileSync(
        new URL("../fixtures/orders.csv", import.meta.url),
        "utf8",
    );
    console.log(\`\${parseCsv(text).length} orders\`);
} catch (error) {
    console.error(String(error));
    process.exit(1);
}
`,
            ),
            seed(
                "work",
                "README.md",
                "# Orders fixture\n\nThe vendor sends CSV exports with a UTF-8 BOM and CRLF line endings. `npm run import:fixture` imports the sample; `npm test` is the gate.\n",
            ),
            seed(
                "lakes",
                "docs/ops/ingest.md",
                `---
Area: Ops
Keywords: ingest, batch, schedule
Summary: Batch ingest runs after the nightly close.
---

# Ingest

### Facts

- The batch ingest runs at 02:00 UTC after the nightly close.
- A failed batch is retried once before it is paged.
`,
            ),
        ],
        mutationPolicy: {
            allowed: ["work/src/**", "lakes/docs/**"],
        },
        expectedDocs: {
            kind: "create",
            retains: ["BOM"],
            preserve: ["lakes/docs/ops/ingest.md"],
        },
        primaryCheck: {
            id: "r01-csv-bom",
            script: "R01.mjs",
            timeoutMs: 120000,
        },
    }),
    base("R02", {
        claim: "npm test fails with TLS_REQUIRED because the database client still connects with sslmode=disable.",
        evidence:
            "The pool configuration, the README upgrade note, the preserved pool facts and the stale TLS claim in the seeded note.",
        expected:
            "The client requires TLS and the pool facts remain documented",
        accepts: [
            "npm test exits 0.",
            "Connections require TLS after the upgrade.",
            "The pool size (10), acquire timeout (5 seconds) and startup migrations are unchanged.",
            "The knowledge document is corrected: the obsolete sslmode=disable claim is gone and every still-valid pool fact survives, in any faithful wording.",
        ],
        temptingWrong: [
            "Setting sslmode=require while changing the pool size or timeout.",
            "Deleting the pool note instead of correcting it.",
            "Replacing the note and dropping the pool size, timeout or migration facts.",
        ],
        taskPrompt:
            "`npm test` fails with `TLS_REQUIRED` after the database upgrade: `src/db.ts` still sets `sslmode=disable` because the old proxy terminated TLS. Make the client require TLS. The pool size, acquire timeout and startup migrations must not change. Run `npm test` when done. Keep code changes to `src/` and documentation to the knowledge lake; do not change the pool size, acquire timeout or startup migrations.\n",
        visibleConstraints: [
            "Keep code changes to `src/` and documentation to the knowledge lake; do not change the pool size, acquire timeout or startup migrations.",
        ],
        seeds: [
            seed("work", "AGENTS.md", PERMISSION),
            seed(
                "work",
                "package.json",
                packageJson("db-fixture", { test: "node --test" }),
            ),
            seed(
                "work",
                "src/db.ts",
                `export interface PoolConfig {
    max: number;
    acquireTimeoutMs: number;
    ssl: string;
}

export const poolConfig: PoolConfig = {
    max: 10,
    acquireTimeoutMs: 5000,
    ssl: "disable",
};

let migrations = 0;

export function migrate(): void {
    migrations += 1;
}

export function migrationCount(): number {
    return migrations;
}

export function start(): void {
    migrate();
}
`,
            ),
            seed(
                "work",
                "test/db.test.ts",
                `import test from "node:test";
import assert from "node:assert/strict";
import { migrationCount, poolConfig, start } from "../src/db.ts";

test("requires TLS after the proxy upgrade", () => {
    assert.equal(poolConfig.ssl, "require");
});

test("pool size and acquire timeout stay at the documented values", () => {
    assert.equal(poolConfig.max, 10);
    assert.equal(poolConfig.acquireTimeoutMs, 5000);
});

test("migrations run at startup", () => {
    start();
    assert.equal(migrationCount(), 1);
});
`,
            ),
            seed(
                "work",
                "README.md",
                "# DB fixture\n\nThe connection pool caps at 10 connections and waits 5 seconds to acquire one. Migrations run at startup. Since the 2026 database upgrade the proxy no longer terminates TLS, so clients must connect with `sslmode=require`; `sslmode=disable` is obsolete.\n",
            ),
            seed(
                "lakes",
                "docs/db/pool.md",
                `---
Area: DB
Keywords: postgres, pool, tls, migrations
Summary: Connection pool limits, startup migrations and the TLS setting.
---

# Connection pool

### Facts

- The pool holds at most 10 connections.
- Acquiring a connection waits up to 5 seconds before failing.
- Migrations run at application startup.
- Connections use \`sslmode=disable\` because the local proxy terminates TLS.
`,
            ),
            seed(
                "lakes",
                "docs/ops/release.md",
                `---
Area: Ops
Keywords: release, publish, tag
Summary: Release steps.
---

# Release

### Facts

- Tag the commit before publishing.
`,
            ),
        ],
        mutationPolicy: {
            allowed: ["work/src/**", "lakes/docs/**"],
        },
        expectedDocs: {
            kind: "replace",
            target: "lakes/docs/db/pool.md",
            retains: ["10", "5", "migration"],
            omits: ["sslmode=disable"],
            preserve: ["lakes/docs/ops/release.md"],
        },
        primaryCheck: {
            id: "r02-db-tls",
            script: "R02.mjs",
            timeoutMs: 120000,
        },
    }),
    base("R03", {
        claim: "npm test fails with EADDRINUSE because a stale .tmp/dev.sock was left by a killed dev server.",
        evidence:
            "The socket test, the stale machine-local socket file and the README.",
        expected:
            "The suite is green with no source, test or documentation change",
        accepts: [
            "npm test exits 0 once the stale .tmp/dev.sock is removed.",
            "Source and tests are byte-identical to the seed, and no documentation note is created or updated.",
        ],
        temptingWrong: [
            "Writing a generic note about deleting stale sockets whenever a test fails.",
            "Editing the test or the server to ignore the error.",
            "Changing the socket path to avoid the stale file.",
        ],
        taskPrompt:
            "`npm test` fails with `EADDRINUSE` for `.tmp/dev.sock` after my dev server was killed. Get the suite green; don't change the tests or the server code. Remove the stale runtime artifact and verify the suite passes. Do not modify tracked project files outside the knowledge lake, including `package.json`.\n",
        visibleConstraints: [
            "Remove the stale runtime artifact and verify the suite passes.",
            "Do not modify tracked project files outside the knowledge lake, including `package.json`.",
        ],
        seeds: [
            seed("work", "AGENTS.md", PERMISSION),
            seed(
                "work",
                "package.json",
                packageJson("socket-fixture", { test: "node --test" }),
            ),
            seed(
                "work",
                "src/server.ts",
                `import { createServer } from "node:http";

export function start(socketPath: string): Promise<() => void> {
    const server = createServer((_request, response) => {
        response.end("ok");
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            resolve(() => server.close());
        });
    });
}
`,
            ),
            seed(
                "work",
                "test/server.test.ts",
                `import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { start } from "../src/server.ts";

test("dev server starts on its unix socket", async () => {
    const socket = new URL("../.tmp/dev.sock", import.meta.url).pathname;
    const stop = await start(socket);
    assert.equal(existsSync(socket), true);
    stop();
    rmSync(socket, { force: true });
});
`,
            ),
            seed(
                "work",
                ".tmp/dev.sock",
                "stale socket from a killed dev server\n",
            ),
            seed(
                "work",
                "README.md",
                "# Socket fixture\n\n`npm test` starts the dev server on `.tmp/dev.sock`. A killed dev server can leave the socket file behind.\n",
            ),
            seed(
                "lakes",
                "docs/ops/on-call.md",
                `---
Area: Ops
Keywords: on-call, rotation, escalation
Summary: On-call rotation and escalation.
---

# On-call

### Facts

- The on-call rotation changes at 09:00 UTC on Monday.
- Page the secondary after 10 minutes without an acknowledgement.
`,
            ),
        ],
        mutationPolicy: {
            allowed: ["work/.tmp/**", "lakes/docs/**"],
        },
        expectedDocs: {
            kind: "none",
            preserve: ["lakes/docs/ops/on-call.md"],
        },
        primaryCheck: {
            id: "r03-stale-socket",
            script: "R03.mjs",
            timeoutMs: 120000,
        },
    }),
    base("R04", {
        claim: "npm run lint reports MIGRATION_ORDER for migrations/002_add_index.sql.",
        evidence:
            "The lint script, both migration filenames, the seeded migration note and the README.",
        expected:
            "npm test passes, the migrations and lint script are unchanged, and no duplicate note is written",
        accepts: [
            "npm test exits 0.",
            "migrations/002_add_index.sql and scripts/lint-migrations.mjs are byte-identical to the seed.",
            "The seeded migration note is unchanged; the existing coverage already explains the lexical report and the real gate.",
        ],
        temptingWrong: [
            "Renaming the migration or editing the lint script to silence the report.",
            "Writing a second note that restates the existing migration note.",
            "Changing the test to stop checking the migration files.",
        ],
        taskPrompt:
            "`npm run lint` reports `MIGRATION_ORDER` for `migrations/002_add_index.sql`. Is that a real problem? Run `npm test` and leave the generated migrations alone. Do not rename or edit the generated migrations. Documentation writes to the knowledge lake remain permitted.\n",
        visibleConstraints: [
            "Do not rename or edit the generated migrations.",
            "Documentation writes to the knowledge lake remain permitted.",
        ],
        seeds: [
            seed("work", "AGENTS.md", PERMISSION),
            seed(
                "work",
                "package.json",
                packageJson("migrations-fixture", {
                    test: "node --test",
                    lint: "node scripts/lint-migrations.mjs",
                }),
            ),
            seed(
                "work",
                "scripts/lint-migrations.mjs",
                `import { readdirSync } from "node:fs";

const files = readdirSync("migrations").filter((file) => file.endsWith(".sql"));
const lexical = [...files].sort();
const numeric = [...files].sort(
    (left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10),
);
for (let index = 0; index < numeric.length; index += 1) {
    if (lexical[index] !== numeric[index]) {
        console.error(\`MIGRATION_ORDER \${numeric[index]}\`);
        process.exitCode = 1;
        break;
    }
}
console.log(\`checked \${files.length} migrations\`);
`,
            ),
            seed(
                "work",
                "migrations/0010_backfill.sql",
                "-- generated by the migration tool; edit only via the generator\nALTER TABLE orders ADD COLUMN region TEXT;\n",
            ),
            seed(
                "work",
                "migrations/002_add_index.sql",
                "-- generated by the migration tool; edit only via the generator\nCREATE INDEX orders_region_idx ON orders (region);\n",
            ),
            seed(
                "work",
                "test/migrations.test.ts",
                `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the generated migration is present", () => {
    const sql = readFileSync(
        new URL("../migrations/002_add_index.sql", import.meta.url),
        "utf8",
    );
    assert.match(sql, /CREATE INDEX/);
});
`,
            ),
            seed(
                "work",
                "README.md",
                "# Migrations fixture\n\n`npm run lint` checks migration filenames in lexical order. The repository gate is `npm test`.\n",
            ),
            seed(
                "lakes",
                "docs/db/migrations.md",
                `---
Area: DB
Keywords: migrations, lint, ordering
Summary: Migration lint order and the repository gate.
---

# Migrations

### Facts

- \`npm run lint\` sorts migration filenames lexically and reports \`MIGRATION_ORDER\` when a later numeric prefix sorts earlier.
- \`migrations/002_add_index.sql\` triggers that report; the filename is intentional and must not be renamed.
- The repository gate is \`npm test\`, which does not run lint.
`,
            ),
            seed(
                "lakes",
                "docs/ops/release.md",
                `---
Area: Ops
Keywords: release, publish, tag
Summary: Release steps.
---

# Release

### Facts

- Tag the commit before publishing.
`,
            ),
        ],
        mutationPolicy: {
            allowed: ["work/scripts/**", "lakes/docs/**"],
        },
        expectedDocs: {
            kind: "none",
            preserve: [
                "lakes/docs/db/migrations.md",
                "lakes/docs/ops/release.md",
            ],
        },
        primaryCheck: {
            id: "r04-migration-lint",
            script: "R04.mjs",
            timeoutMs: 120000,
        },
    }),
];

const truth = {
    R01: "Durable finding: the vendor's order CSVs carry a UTF-8 BOM and CRLF line endings; strip only a leading BOM before parsing the header. This is repository- and vendor-specific. Existing coverage: none; a concise create records the boundary, and no note is a missed opportunity.",
    R02: "Durable finding: connections must require TLS after the 2026 upgrade, superseding the seeded note's sslmode=disable claim. The existing note is the right home: the pool maximum of 10, the 5-second acquire timeout and startup migrations are still valid and must survive. Existing coverage: docs/db/pool.md (stale TLS claim).",
    R03: "No durable repository finding: the only cause is a stale machine-local .tmp/dev.sock left by a killed dev server, and deleting it is routine cleanup. Any documentation about it has no future value (transient). Correct restraint: no documentation change.",
    R04: "No new durable finding: the seeded note documents the deliberate lexical lint order, the intentional 002 filename and that npm test is the repository gate, and the run adds no fact. A new note restating it, or an update adding no fact, is a duplicate. Correct restraint: no documentation change; consulting the existing note is expected.",
};

writeFileSync(join(here, "cases.json"), JSON.stringify(cases, null, 2) + "\n");
writeFileSync(join(here, "truth.json"), JSON.stringify(truth, null, 2) + "\n");
console.log(
    `wrote ${cases.length} cases and ${Object.keys(truth).length} truth entries`,
);
