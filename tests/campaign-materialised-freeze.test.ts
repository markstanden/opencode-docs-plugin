import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const here = import.meta.dirname;
const campaign = join(
    here,
    "fixtures",
    "placement-harness",
    "prod014",
    "campaign",
);
const ids = ["R01", "S02", "R02", "R03", "S05", "S06", "S07", "R04"];

/** Write one file, creating parents. */
function write(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
}

/** A minimal git arm worktree with the corpus and truth files. */
function arm(dir: string): void {
    mkdirSync(join(dir, "src"), { recursive: true });
    write(join(dir, "src/index.ts"), "export default {};\n");
    write(
        join(dir, "tests/fixtures/placement-harness/container-run.sh"),
        `#!/usr/bin/env sh
if [ "$1" = build-image ]; then printf 'sha256:frozen-image\\n'; fi
exit 0
`,
    );
    write(
        join(dir, "tests/fixtures/placement-harness/harness.mts"),
        "// harness\n",
    );
    write(join(dir, "package-lock.json"), "{}\n");
    write(join(dir, "package.json"), "{}\n");
    write(
        join(dir, "tests/fixtures/placement-harness/scenario-names.mts"),
        "// names\n",
    );
    write(
        join(dir, "tests/fixtures/placement-harness/prod014/cases.json"),
        JSON.stringify(
            ids.map((id) => ({ id, primaryCheck: { script: `${id}.mjs` } })),
        ),
    );
    write(
        join(dir, "tests/fixtures/placement-harness/prod014/truth.json"),
        JSON.stringify(Object.fromEntries(ids.map((id) => [id, "truth"]))),
    );
    for (const id of ids) {
        write(
            join(
                dir,
                `tests/fixtures/placement-harness/primary-checks/${id}.mjs`,
            ),
            "process.exit(0);\n",
        );
    }
    chmodSync(
        join(dir, "tests/fixtures/placement-harness/container-run.sh"),
        0o755,
    );
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "arm"],
        { cwd: dir },
    );
}

/** A campaign root with every immutable input freeze reads. */
function fixture(): {
    root: string;
    bin: string;
    imageFile: string;
    source: string;
} {
    const root = mkdtempSync(join(tmpdir(), "pd-freeze-cmd-"));
    execFileSync(process.execPath, [join(campaign, "materialise.mjs"), root], {
        encoding: "utf8",
    });
    write(
        join(root, "evidence/schedule.json"),
        JSON.stringify({
            campaign: "pd-freeze-cmd",
            slots: [
                {
                    slot: 1,
                    pairId: "P01",
                    repetition: 0,
                    scenario: "R01",
                    arm: "A",
                    stamp: "pd-A-r0-R01",
                },
            ],
        }),
    );
    const surfaces = {
        a: "Arm A records findings.",
        b: "Arm B records findings.",
    };
    for (const letter of ["a", "b"] as const) {
        arm(join(root, "arms", letter));
        write(join(root, `gen/${letter}/prompts/R01.md`), "task prompt\n");
        write(join(root, `gen/${letter}/rubrics/R01/rubric.md`), "rubric\n");
        for (const id of ids) {
            write(
                join(root, `gen/${letter}/fixtures/${id}/generation.json`),
                JSON.stringify({
                    pluginHash: "p",
                    inputsHash: "i",
                    outputs: { promptHash: "h" },
                }),
            );
            write(
                join(root, `gen/${letter}/prompts/${id}.md`),
                `prompt ${id}\n`,
            );
        }
        const description = surfaces[letter];
        const digest = execFileSync(
            process.execPath,
            [
                "-e",
                `process.stdout.write(require("node:crypto").createHash("sha256").update(${JSON.stringify(description)},"utf8").digest("hex"))`,
            ],
            { encoding: "utf8" },
        );
        write(
            join(root, `evidence/surfaces-${letter}.json`),
            JSON.stringify({
                nativeChars: [...description].length,
                nativeHash: digest,
                annotationChars: 0,
                annotationHash: "",
            }),
        );
        write(
            join(root, `evidence/delivery-${letter}/request-1.json`),
            JSON.stringify({
                model: "opencode-go/deepseek-v4.1-flash",
                tools: [
                    {
                        type: "function",
                        function: { name: "docs", description },
                    },
                ],
            }),
        );
    }
    write(
        join(root, "evidence/measurement-spec.json"),
        JSON.stringify({ scenarios: {} }),
    );
    // The independent measurement worktree freeze hashes and records.
    const measurement = join(root, "measurement");
    for (const path of [
        "tests/fixtures/placement-harness/ac-scoring.mts",
        "tests/fixtures/placement-harness/ac/run.mjs",
        "tests/fixtures/placement-harness/ac/judge-launcher.sh",
        "tests/fixtures/placement-harness/analysis/analyse.mts",
        "tests/fixtures/placement-harness/harness.mts",
    ]) {
        write(join(measurement, path), "// measurement\n");
    }
    execFileSync("git", ["init", "-q"], { cwd: measurement });
    execFileSync("git", ["add", "-A"], { cwd: measurement });
    execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "m"],
        { cwd: measurement },
    );

    // Fake external tools: podman reports the image identity from a file, so a
    // rebuilt image is one file edit away.
    const bin = join(root, "fake-bin");
    const imageFile = join(root, "fake-image.txt");
    write(imageFile, "sha256:frozen-image\n");
    write(
        join(bin, "podman"),
        `#!/usr/bin/env sh
case "$1" in
  --version) echo "podman 5.0.0" ; exit 0 ;;
  image) cat ${JSON.stringify(imageFile)} ; exit 0 ;;
  build) exit 0 ;;
  run) echo "opencode 2.2.7" ; exit 0 ;;
esac
exit 0
`,
    );
    write(join(bin, "opencode"), "#!/usr/bin/env sh\necho 'opencode 2.2.7'\n");
    chmodSync(join(bin, "podman"), 0o755);
    chmodSync(join(bin, "opencode"), 0o755);
    // A source repo independent of the test checkout, so the read-only gate
    // scope needs no .git metadata.
    const source = join(root, "source");
    write(join(source, "README.md"), "source\n");
    execFileSync("git", ["init", "-q"], { cwd: source });
    execFileSync("git", ["add", "-A"], { cwd: source });
    execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "s"],
        { cwd: source },
    );
    return { root, bin, imageFile, source };
}

/** Run the materialised freeze command. */
function freeze(
    root: string,
    bin: string,
    source: string,
): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [join(root, "prepare/freeze.mjs")], {
        env: {
            ...process.env,
            CAMPAIGN_ROOT: root,
            CAMPAIGN_SOURCE_REPO: source,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
        timeout: 120000,
    });
}

describe("materialised freeze command", () => {
    it("refuses the second freeze and preserves the first bytes", () => {
        // Arrange
        const { root, bin, source } = fixture();
        try {
            const first = freeze(root, bin, source);
            assert.equal(first.status, 0, String(first.stderr));
            const frozen = join(root, "evidence/FROZEN.json");
            const before = readFileSync(frozen, "utf8");

            // Act
            const second = freeze(root, bin, source);

            // Assert
            assert.notEqual(second.status, 0);
            assert.match(
                String(second.stderr),
                /already frozen|existing freeze|refusing/,
            );
            assert.equal(readFileSync(frozen, "utf8"), before);
            assert.ok(
                existsSync(join(root, "evidence/frozen-identities.json")),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

/** Run the materialised runner with a counting trial stub. */
function runCampaign(
    root: string,
    bin: string,
    source: string,
    counter: string,
): ReturnType<typeof spawnSync> {
    const stub = join(root, "trial-stub.sh");
    write(stub, `#!/usr/bin/env sh\nprintf 'trial\\n' >>"\${STUB_COUNTER}"\n`);
    chmodSync(stub, 0o755);
    return spawnSync(
        process.execPath,
        [
            join(root, "prepare/run.mjs"),
            "--pair-from",
            "1",
            "--pair-to",
            "1",
            "--trial-command",
            stub,
        ],
        {
            env: {
                ...process.env,
                CAMPAIGN_ROOT: root,
                CAMPAIGN_SOURCE_REPO: source,
                STUB_COUNTER: counter,
                ZAI_API_KEY: "stub",
                PATH: `${bin}:${process.env.PATH ?? ""}`,
            },
            encoding: "utf8",
            timeout: 120000,
        },
    );
}

/** Run the materialised recovery command with a counting judge stub. */
function rejudgeCampaign(
    root: string,
    bin: string,
    source: string,
    counter: string,
): ReturnType<typeof spawnSync> {
    const stub = join(
        root,
        "measurement/tests/fixtures/placement-harness/ac/run.mjs",
    );
    write(
        stub,
        `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.STUB_COUNTER, "judge\\n");\n`,
    );
    return spawnSync(process.execPath, [join(root, "prepare/rejudge.mjs")], {
        env: {
            ...process.env,
            CAMPAIGN_ROOT: root,
            CAMPAIGN_SOURCE_REPO: source,
            STUB_COUNTER: counter,
            ZAI_API_KEY: "stub",
            PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
        timeout: 120000,
    });
}

/** Run one launch and assert the premise blocked before any child ran. */
function expectBlocked(
    root: string,
    bin: string,
    source: string,
    counter: string,
    pattern: RegExp,
): void {
    const run = runCampaign(root, bin, source, counter);
    assert.equal(run.status, 2, String(run.stderr));
    assert.match(String(run.stderr), pattern);
    assert.equal(existsSync(counter) ? readFileSync(counter, "utf8") : "", "");
}

describe("freeze use at the spend boundary", () => {
    it("refuses to spend without a freeze at all", () => {
        // Arrange
        const { root, bin, source } = fixture();
        const counter = join(root, "counter.txt");
        try {
            rmSync(join(root, "evidence/FROZEN.json"), { force: true });

            // Act / Assert
            expectBlocked(root, bin, source, counter, /no freeze record/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a changed B plugin", () => {
        // Arrange
        const { root, bin, source } = fixture();
        const counter = join(root, "counter.txt");
        try {
            assert.equal(freeze(root, bin, source).status, 0);
            write(join(root, "arms/b/src/index.ts"), "export default 2;\n");

            // Act / Assert
            expectBlocked(root, bin, source, counter, /frozen premise changed/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses an input added after the freeze", () => {
        // Arrange
        const { root, bin, source } = fixture();
        const counter = join(root, "counter.txt");
        try {
            assert.equal(freeze(root, bin, source).status, 0);
            write(join(root, "gen/a/fixtures/R01/added.txt"), "added\n");

            // Act / Assert
            expectBlocked(
                root,
                bin,
                source,
                counter,
                /immutable input changed/,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a changed measurement launcher before recovery", () => {
        // Arrange
        const { root, bin, source } = fixture();
        const counter = join(root, "counter.txt");
        try {
            assert.equal(freeze(root, bin, source).status, 0);
            write(
                join(
                    root,
                    "measurement/tests/fixtures/placement-harness/ac/run.mjs",
                ),
                "// changed launcher\n",
            );

            // Act
            const rejudge = rejudgeCampaign(root, bin, source, counter);

            // Assert
            assert.equal(rejudge.status, 2);
            assert.match(String(rejudge.stderr), /frozen premise changed/);
            assert.equal(
                existsSync(counter) ? readFileSync(counter, "utf8") : "",
                "",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses an image substituted between preflight and dispatch", () => {
        // Arrange
        const { root, bin, imageFile, source } = fixture();
        const counter = join(root, "counter.txt");
        try {
            assert.equal(freeze(root, bin, source).status, 0);
            // The first inspect passes; every later one reports a rebuild.
            write(
                join(bin, "podman"),
                `#!/usr/bin/env sh
case "$1" in
  --version) echo "podman 5.0.0" ; exit 0 ;;
  image)
    if [ -f ${JSON.stringify(join(root, "seen-image"))} ]; then
      echo "sha256:substituted"
    else
      : >${JSON.stringify(join(root, "seen-image"))}
      cat ${JSON.stringify(imageFile)}
    fi
    exit 0 ;;
  run) echo "opencode 2.2.7" ; exit 0 ;;
esac
exit 0
`,
            );
            chmodSync(join(bin, "podman"), 0o755);

            // Act / Assert
            expectBlocked(
                root,
                bin,
                source,
                counter,
                /container image changed/,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("frozen premise enforcement", () => {
    it("refuses a changed rubric with no trial spawn and an intact freeze", () => {
        // Arrange
        const { root, bin, source } = fixture();
        const counter = join(root, "counter.txt");
        try {
            assert.equal(freeze(root, bin, source).status, 0);
            const frozenBytes = readFileSync(
                join(root, "evidence/FROZEN.json"),
                "utf8",
            );
            const ledger = join(root, "evidence/ATTEMPTS.jsonl");
            const ledgerBytes = existsSync(ledger)
                ? readFileSync(ledger, "utf8")
                : "";
            write(
                join(
                    root,
                    "arms/a/tests/fixtures/placement-harness/primary-checks/R01.mjs",
                ),
                "process.exit(1);\n",
            );

            // Act
            const run = runCampaign(root, bin, source, counter);

            // Assert
            assert.equal(run.status, 2);
            assert.match(String(run.stderr), /frozen premise changed/);
            assert.equal(
                readFileSync(join(root, "evidence/FROZEN.json"), "utf8"),
                frozenBytes,
            );
            assert.equal(
                existsSync(ledger) ? readFileSync(ledger, "utf8") : "",
                ledgerBytes,
            );
            assert.equal(
                existsSync(counter) ? readFileSync(counter, "utf8") : "",
                "",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("allows a clean continuation after the premise is restored", () => {
        // Arrange
        const { root, bin, source } = fixture();
        const counter = join(root, "counter.txt");
        try {
            assert.equal(freeze(root, bin, source).status, 0);

            // Act
            const run = runCampaign(root, bin, source, counter);

            // Assert: the premise passed and the single trial stub ran.
            assert.match(
                existsSync(counter) ? readFileSync(counter, "utf8") : "",
                /trial/,
                `stderr: ${String(run.stderr)}`,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a rebuilt image identity", () => {
        // Arrange
        const { root, bin, imageFile, source } = fixture();
        const counter = join(root, "counter.txt");
        try {
            assert.equal(freeze(root, bin, source).status, 0);
            write(imageFile, "sha256:rebuilt-image\n");

            // Act
            const run = runCampaign(root, bin, source, counter);

            // Assert
            assert.equal(run.status, 2);
            assert.match(String(run.stderr), /container image changed/);
            assert.equal(
                existsSync(counter) ? readFileSync(counter, "utf8") : "",
                "",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses recovery on a changed premise before any judge spawn", () => {
        // Arrange
        const { root, bin, source } = fixture();
        const counter = join(root, "counter.txt");
        try {
            assert.equal(freeze(root, bin, source).status, 0);
            write(
                join(
                    root,
                    "arms/a/tests/fixtures/placement-harness/primary-checks/R01.mjs",
                ),
                "process.exit(1);\n",
            );

            // Act
            const rejudge = rejudgeCampaign(root, bin, source, counter);

            // Assert
            assert.equal(rejudge.status, 2);
            assert.match(String(rejudge.stderr), /frozen premise changed/);
            assert.equal(
                existsSync(counter) ? readFileSync(counter, "utf8") : "",
                "",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
