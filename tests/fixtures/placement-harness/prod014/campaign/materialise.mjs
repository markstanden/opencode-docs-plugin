// Materialise the frozen campaign scripts into a fresh campaign root.
// The scripts are data, not executable repository code: a rerun writes them
// outside the repository and never imports them from here.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
if (!target) {
    console.error("usage: materialise.mjs <campaign-root>");
    process.exit(2);
}
const snapshot = JSON.parse(readFileSync(join(here, "scripts.json"), "utf8"));
for (const [name, body] of Object.entries(snapshot.files)) {
    const hash = createHash("sha256").update(body).digest("hex");
    if (hash !== snapshot.hashes[name]) {
        console.error(`script ${name} does not match its frozen hash`);
        process.exit(1);
    }
    const path = join(target, "prepare", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
    if (name.endsWith(".sh") || name === "shim/podman") {
        chmodSync(path, 0o755);
    }
}
console.log(
    `materialised ${Object.keys(snapshot.files).length} scripts into ${target}/prepare`,
);
