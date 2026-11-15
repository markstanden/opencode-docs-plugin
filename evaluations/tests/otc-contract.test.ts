/**
 * Consumer integration against the installed, pinned OTC artifact:
 *
 * - the product's suite declaration drives OTC's primary-check plan, with the
 *   fixed interpreter, argument contract and closed sandbox;
 * - the installed artifact carries no docs-harness bridge (the old
 *   `tests/fixtures/placement-harness/harness.mts` dependency is gone);
 * - recorded docs evidence replays through the installed evaluator, offline.
 *
 * No model call, no Podman and no container: the plan is inspected, and replay
 * reads committed evidence only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { primaryCheckPlan } from "@markstanden/opencode-test-container";

const HERE = import.meta.dirname;
const EVALUATIONS = dirname(HERE);
const REPO = dirname(EVALUATIONS);
const SUITE = join(EVALUATIONS, "docs-placement", "suite.json");

/** One docs case as the suite declares it. */
interface DocsCase {
    caseId: string;
    primaryCheck?: {
        id: string;
        directory: string;
        script: string;
        timeoutMs?: number;
    };
}

const suite = JSON.parse(readFileSync(SUITE, "utf8")) as {
    cases: DocsCase[];
};

/** The case's declared checker, asserted present. */
function declaredChecker(
    caseId: string,
): NonNullable<DocsCase["primaryCheck"]> {
    const found = suite.cases.find((item) => item.caseId === caseId);
    assert.ok(found, `${caseId} is declared`);
    assert.ok(found.primaryCheck, `${caseId} declares a primary check`);
    return found.primaryCheck;
}

test("the declared checker drives OTC's closed primary-check plan", (t) => {
    // Arrange: a temp campaign layout and the suite's own checker declaration.
    const root = mkdtempSync(join(tmpdir(), "docs-otc-plan-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const checker = declaredChecker("useful-write");
    const checkerDir = join(EVALUATIONS, "docs-placement", checker.directory);
    const live = join(root, "live");
    const pristine = join(root, "pristine");
    mkdirSync(live, { recursive: true });
    mkdirSync(pristine, { recursive: true });
    const envFile = join(root, "checker.env");

    // Act
    const plan = primaryCheckPlan({
        imageId: `sha256:${"a".repeat(64)}`,
        checkerDir,
        script: checker.script,
        workspace: live,
        pristine,
        envFile,
        timeoutMs: checker.timeoutMs ?? 30000,
    });

    // Assert
    assert.deepEqual(plan.argv, [
        "node",
        `/checker/${checker.script}`,
        "/live",
        "/pristine",
    ]);
    assert.equal(plan.network, "none");
    assert.equal(plan.workdir, "/tmp");
    assert.equal(plan.envFile, envFile);
    assert.deepEqual(plan.envNames, [
        "HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
    ]);
    assert.deepEqual(
        plan.mounts.map((mount) => ({
            target: mount.target,
            readOnly: mount.readOnly,
        })),
        [
            { target: "/live", readOnly: true },
            { target: "/pristine", readOnly: true },
            { target: "/checker", readOnly: true },
        ],
    );
});

test("the installed artifact carries no docs-harness bridge", () => {
    // Arrange: the bridge was a literal path into this checkout.
    const entry = fileURLToPath(
        import.meta.resolve("@markstanden/opencode-test-container"),
    );
    const packageRoot = dirname(dirname(entry));
    const offenders: string[] = [];
    const walk = (directory: string): void => {
        for (const item of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, item.name);
            if (item.isDirectory()) {
                walk(path);
            } else if (item.isFile() && item.name.endsWith(".js")) {
                if (readFileSync(path, "utf8").includes("placement-harness")) {
                    offenders.push(relative(packageRoot, path));
                }
            }
        }
    };

    // Act
    walk(join(packageRoot, "dist"));

    // Assert
    assert.deepEqual(offenders, []);
    assert.equal(
        existsSync(
            join(
                packageRoot,
                "dist",
                "evaluators",
                "docs",
                "harness",
                "run.js",
            ),
        ),
        false,
        "the removed harness module is not shipped",
    );
});

test("recorded docs evidence replays through the installed evaluator", (t) => {
    // Arrange: the committed mini corpus and the installed binary.
    const out = mkdtempSync(join(tmpdir(), "docs-otc-replay-"));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    const binary = join(EVALUATIONS, "node_modules", ".bin", "otc");

    // Act
    const result = spawnSync(
        binary,
        [
            "replay",
            "--manifest",
            join(
                REPO,
                "tests",
                "fixtures",
                "analysis",
                "manifests",
                "mini.json",
            ),
            "--evidence-root",
            join(REPO, "tests", "fixtures", "analysis", "mini-corpus"),
            "--out",
            join(out, "report"),
        ],
        { cwd: out, encoding: "utf8" },
    );

    // Assert
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^mini-20261111: inconclusive/m);
    assert.deepEqual(readdirSync(join(out, "report")).sort(), [
        "REPORT.md",
        "SCREENING.json",
        "analysis-receipt.json",
        "analysis.json",
    ]);
});
