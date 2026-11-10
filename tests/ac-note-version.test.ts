import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = join(
    here,
    "fixtures",
    "placement-harness",
    "replication",
    "note-version.mjs",
);

const verdict = (document: string): string => {
    const script = `
        import { noteVersionVerdict } from ${JSON.stringify(modulePath)};
        process.stdout.write(noteVersionVerdict(${JSON.stringify(document)}));
    `;
    const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
};

test("a completed Node 24 update is useful", () => {
    // Arrange
    const document = `Summary: This repository requires Node 24 or newer.\n\n### Facts\n\n- \`package.json\` declares \`>=24\`.\n- \`.nvmrc\` pins 24.\n`;

    // Act / Assert
    assert.equal(verdict(document), "useful-update");
});

test("a partial fix that keeps Node 22 as the supported floor is misleading", () => {
    // Arrange
    const document = `Summary: This repository supports Node 22 or newer.\n\n### Facts\n\n- \`engines\` accepts Node 22 or newer.\n- \`.nvmrc\` pins 24.\n`;

    // Act / Assert
    assert.equal(verdict(document), "misleading");
});

test("a failed-approach mention of 22 does not cancel a completed 24 update", () => {
    // Arrange
    const document = `Summary: This repository requires Node 24 or newer.\n\n### Facts\n\n- \`engines\` is \`>=24\`.\n\n### Failed approaches\n\n- Comparing \`major !== 22\` broke setup.\n`;

    // Act / Assert
    assert.equal(verdict(document), "useful-update");
});
