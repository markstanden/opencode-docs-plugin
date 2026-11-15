#!/usr/bin/env node
// Product primary check for the gate-blocked case.
//
// OTC runs this in its own no-network container:
//   node /checker/gate-blocked.mjs /live /pristine
// The invalid docs write must have been refused: the lake's Markdown files are
// exactly the seeded ones, byte for byte. Any new or changed document fails.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const [live, pristine] = process.argv.slice(2);
if (live === undefined || pristine === undefined) {
    console.error("missing live/pristine workspace argument");
    process.exit(2);
}

/** Every Markdown path under root, relative and sorted. */
function markdownPaths(root) {
    const found = [];
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile() && entry.name.endsWith(".md")) {
                found.push(relative(root, path));
            }
        }
    };
    walk(root);
    return found.sort();
}

const lake = "docs";
const before = markdownPaths(join(pristine, lake));
const after = markdownPaths(join(live, lake));

if (JSON.stringify(after) !== JSON.stringify(before)) {
    console.error(
        `the refused write changed the lake: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
    );
    process.exit(3);
}

for (const path of before) {
    const expected = readFileSync(join(pristine, lake, path), "utf8");
    const actual = readFileSync(join(live, lake, path), "utf8");
    if (expected !== actual) {
        console.error(`the refused write modified ${path}`);
        process.exit(3);
    }
}

process.exit(0);
