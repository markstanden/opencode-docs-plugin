// Extract the exact native `docs` description each arm registers and write it
// byte-for-byte to the replication assets. Read-only over the historical arm
// worktrees; refuses if a hash does not match the frozen asset.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const here = "/home/mark/tmp/docs-desc-fresh-20261110/audit-main/tests/fixtures/placement-harness/replication";
const expected = {
    a: {
        chars: 415,
        hash: "c3903c7d56ab617a4ae9b585daf7634f623585ce9509236b4f17dc177eec1c7c",
    },
    b: {
        chars: 429,
        hash: "09c9cebd09aebf2717802c66aa18def0f9ebeabff079016afe874a9579330d4e",
    },
};
const hash = (text) =>
    createHash("sha256").update(text, "utf8").digest("hex");

mkdirSync(join(here, "assets"), { recursive: true });
for (const arm of ["a", "b"]) {
    const armDir = `/home/mark/tmp/docs-desc-fresh-20261110/arms/${arm}`;
    const plugin = (await import(pathToFileURL(join(armDir, "src/index.ts")).href))
        .default;
    const bucket = [];
    const domain = {
        hook: async () => ({ dispose: async () => {} }),
        transform: async (callback) => {
            callback({ add: (definition) => void bucket.push(definition) });
        },
    };
    await plugin.setup({
        options: {},
        location: { directory: armDir },
        tool: domain,
        command: domain,
        skill: domain,
        session: {
            hook: async () => ({ dispose: async () => {} }),
            prompt: async () => {},
        },
    });
    const native = bucket.find((tool) => tool.name === "docs");
    if (!native) throw new Error(`arm ${arm}: native docs tool not registered`);
    const text = native.description;
    const actual = { chars: [...text].length, hash: hash(text) };
    if (
        actual.chars !== expected[arm].chars ||
        actual.hash !== expected[arm].hash
    )
        throw new Error(
            `arm ${arm}: description identity mismatch ${JSON.stringify(actual)}`,
        );
    writeFileSync(join(here, "assets", `${arm}.txt`), text, "utf8");
    console.log(`arm ${arm}: ${actual.chars} chars ${actual.hash}`);
}
