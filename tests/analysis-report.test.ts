import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    escapeCell,
    renderAnalysisJson,
    renderReport,
} from "./fixtures/placement-harness/analysis/render.ts";
import { parseManifest } from "./fixtures/placement-harness/analysis/model.ts";

const here = import.meta.dirname;
const cli = join(
    here,
    "fixtures",
    "placement-harness",
    "analysis",
    "analyse.mts",
);
const manifest = join(here, "fixtures", "analysis", "manifests", "mini.json");
const corpus = join(here, "fixtures", "analysis", "mini-corpus");

const runCli = (args: readonly string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        timeout: 120000,
    });

const freshDir = (label: string): string =>
    mkdtempSync(join(tmpdir(), `${label}-`));

const analyse = (
    out: string,
    extra: readonly string[] = [],
    evidence = corpus,
) =>
    runCli([
        "--campaign",
        manifest,
        "--evidence-root",
        evidence,
        "--out",
        out,
        ...extra,
    ]);

describe("Markdown rendering", () => {
    it("escapes pipes and newlines so evidence cannot corrupt a table", () => {
        // Act / Assert
        assert.equal(escapeCell("a|b\nc"), "a\\|b c");
        assert.equal(escapeCell(42), "42");
    });

    it("renders the report and the JSON from one structured result, byte-stable on rerender", () => {
        // Arrange
        const out = freshDir("analysis-render");
        try {
            const run = analyse(out);
            assert.equal(run.status, 0, run.stderr);
            const json = readFileSync(join(out, "analysis.json"), "utf8");
            const report = readFileSync(join(out, "REPORT.md"), "utf8");
            const result = JSON.parse(json) as Parameters<
                typeof renderReport
            >[0];

            // Act
            const rerenderedJson = renderAnalysisJson(result);
            const rerenderedReport = renderReport(result);

            // Assert
            assert.equal(rerenderedJson, json);
            assert.equal(rerenderedReport, report);
            assert.ok(
                report.startsWith(
                    `# Trial analysis: ${result.campaign.id}\n**Personal-trial screen:** ${result.measures.personalTrial.recommendation}`,
                ),
            );
            assert.ok(
                report.includes(
                    `**Utility threshold (component, not the recommendation):** ${result.decision.overall}`,
                ),
            );
            assert.ok(
                report.includes(
                    `Documented coverage: ${result.totals.documented}/${result.totals.planned} planned slots.`,
                ),
            );
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    });

    it("renders every accounting number from the structured result", () => {
        // Arrange
        const out = freshDir("analysis-reconcile");
        try {
            const run = analyse(out);
            assert.equal(run.status, 0, run.stderr);
            const result = JSON.parse(
                readFileSync(join(out, "analysis.json"), "utf8"),
            ) as {
                arms: Record<
                    string,
                    {
                        accounting: {
                            planned: number;
                            documented: number;
                            assessed: number;
                            gate: { pass: number; blocked: number };
                        };
                    }
                >;
            };
            const report = readFileSync(join(out, "REPORT.md"), "utf8");

            // Act / Assert
            for (const [arm, reportBlock] of Object.entries(result.arms)) {
                const counts = reportBlock.accounting;
                assert.ok(
                    report.includes(
                        `| ${arm} | ${counts.planned} | ${counts.planned} |`,
                    ),
                    `no accounting row for ${arm} in ${report}`,
                );
                assert.ok(
                    report.includes(
                        `${counts.documented} | ${counts.assessed}`,
                    ),
                );
                assert.ok(
                    report.includes(
                        `${counts.gate.pass}/${counts.gate.blocked}`,
                    ),
                );
            }
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    });
});

describe("analyse CLI", () => {
    it("replays the mini corpus and writes the four artefacts", () => {
        // Arrange
        const out = freshDir("analysis-cli");
        try {
            // Act
            const run = analyse(out);

            // Assert
            assert.equal(run.status, 0, run.stderr);
            assert.match(run.stdout, /mini-20261111: inconclusive/);
            assert.deepEqual(readdirSync(out).sort(), [
                "REPORT.md",
                "SCREENING.json",
                "analysis-receipt.json",
                "analysis.json",
            ]);
            const receipt = JSON.parse(
                readFileSync(join(out, "analysis-receipt.json"), "utf8"),
            ) as {
                renderedAt: string;
                manifestSha256: string;
                inputs: unknown[];
            };
            assert.match(receipt.renderedAt, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(receipt.manifestSha256.length, 64);
            assert.ok(receipt.inputs.length > 1);
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    });

    it("refuses an accidental overwrite and preserves authored interpretation on rerender", () => {
        // Arrange
        const out = freshDir("analysis-overwrite");
        try {
            assert.equal(analyse(out).status, 0);
            const interpretation = join(out, "INTERPRETATION.md");
            writeFileSync(interpretation, "Authored: B looks promising.\n");

            // Act
            const refused = analyse(out);
            const rerendered = analyse(out, ["--rerender"]);

            // Assert
            assert.notEqual(refused.status, 0);
            assert.match(refused.stderr, /not empty/);
            assert.equal(rerendered.status, 0, rerendered.stderr);
            assert.equal(
                readFileSync(interpretation, "utf8"),
                "Authored: B looks promising.\n",
            );
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    });

    it("refuses an output directory inside the evidence root", () => {
        // Arrange
        const out = join(corpus, "analysis-out");

        // Act
        const run = analyse(out);

        // Assert
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /overlaps the evidence root/);
    });

    it("replays a manifest against absent evidence without inventing outcomes", () => {
        // Arrange
        const evidence = freshDir("analysis-empty-evidence");
        const out = freshDir("analysis-empty-out");
        try {
            // Act
            const run = analyse(out, [], evidence);

            // Assert
            assert.equal(run.status, 0, run.stderr);
            const result = JSON.parse(
                readFileSync(join(out, "analysis.json"), "utf8"),
            ) as {
                totals: {
                    documented: number;
                    assessed: number;
                    utilityTotal: number;
                    outcomes: Record<string, number>;
                };
                decision: { overall: string };
            };
            assert.equal(result.totals.documented, 0);
            assert.equal(result.totals.assessed, 0);
            assert.equal(result.totals.utilityTotal, 0);
            assert.ok(
                Object.values(result.totals.outcomes).every(
                    (count) => count === 0,
                ),
            );
            assert.equal(result.decision.overall, "inconclusive");
        } finally {
            rmSync(evidence, { recursive: true, force: true });
            rmSync(out, { recursive: true, force: true });
        }
    });

    it("has no model-launch capability", () => {
        // Act
        const source = readFileSync(cli, "utf8");

        // Assert
        assert.equal(source.includes("child_process"), false);
        assert.equal(source.includes("spawn"), false);
    });
});

describe("committed manifests", () => {
    it("validate without requiring any external evidence", () => {
        // Arrange
        const dir = join(here, "fixtures", "analysis", "manifests");
        const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

        // Act / Assert
        assert.ok(files.length > 0);
        for (const file of files) {
            const raw: unknown = JSON.parse(
                readFileSync(join(dir, file), "utf8"),
            );
            const parsed = parseManifest(raw);
            assert.deepEqual(parsed.problems, [], `${file} must validate`);
            assert.ok(parsed.value !== undefined, `${file} must parse`);
        }
    });
});
