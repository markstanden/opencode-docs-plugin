// Registered-surface measurement for one arm, with no model call.
//
// Imports the arm's own plugin, runs its setup against a fake context, and
// records the exact native description the host receives plus the schema
// annotation payload the model reads alongside it.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [armDir, outPath] = process.argv.slice(2);
if (!armDir || !outPath) {
    console.error("usage: surfaces.mjs <arm-dir> <out.json>");
    process.exit(2);
}

const requireFromArm = createRequire(join(armDir, "package.json"));
const effectPath = requireFromArm.resolve("effect");
const { Schema: effectSchema } = await import(pathToFileURL(effectPath).href);
const plugin = (await import(pathToFileURL(join(armDir, "src/index.ts")).href))
    .default;

const bucket = { tools: [], commands: [], skills: [] };
const domain = (target) => ({
    hook: async () => ({ dispose: async () => {} }),
    transform: async (callback) => {
        callback({ add: (definition) => void target.push(definition) });
    },
});

await plugin.setup({
    options: {},
    location: { directory: armDir },
    tool: domain(bucket.tools),
    command: domain(bucket.commands),
    skill: domain(bucket.skills),
    session: {
        hook: async () => ({ dispose: async () => {} }),
        prompt: async () => {},
    },
});

const native = bucket.tools.find((tool) => tool.name === "docs");
const twin = bucket.tools.find((tool) => tool.name === "docs_search");
if (native === undefined) throw new Error("native docs tool not registered");

const document = effectSchema.toJsonSchemaDocument(native.input);
const found = [];
const seen = new Set();
const walk = (node) => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if (typeof node.description === "string") found.push(node.description);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else walk(value);
    }
};
walk(document.schema);

const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const nativeDescription = native.description;
const annotationText = found.join(" ");

const record = {
    armDir,
    nativeChars: [...nativeDescription].length,
    nativeHash: hash(nativeDescription),
    native: nativeDescription,
    twinChars: [...(twin?.description ?? "")].length,
    twinHash: hash(twin?.description ?? ""),
    annotationChars: annotationText.length,
    annotationHash: hash(annotationText),
    combinedChars: nativeDescription.length + annotationText.length,
    toolNames: bucket.tools.map((tool) => tool.name).sort(),
    skillDescriptions: bucket.skills.map((skill) => skill.description),
};
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(
    `${armDir}: native ${record.nativeChars} ${record.nativeHash}; combined ${record.combinedChars}`,
);
