// Replace the native `docs` description in one arm worktree with an exact
// frozen asset, leaving every other byte of src/index.ts untouched. Refuses if
// the current block is not the expected control text.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [file, assetPath, arm] = process.argv.slice(2);
const description = readFileSync(assetPath, "utf8");
const source = readFileSync(file, "utf8");

const pattern =
    /(description: codemode\s*\? TWIN_DESCRIPTION\s*: )("Search the configured knowledge lakes[\s\S]*?"convention compliance\.")(,\s*input: DOCS_INPUT,)/;
if (!pattern.test(source)) {
    console.error(`arm ${arm}: expected control description block not found`);
    process.exit(1);
}
const replaced = source.replace(
    pattern,
    (_match, before, _old, after) =>
        `${before}${JSON.stringify(description)}${after}`,
);
writeFileSync(file, replaced, "utf8");
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
console.log(
    `arm ${arm}: description replaced (${[...description].length} chars, ${hash(description)})`,
);
