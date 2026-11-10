// Shared runner for the R01–R04 pristine primary checks.
// Copies the live work tree, restores the pristine tests and package.json, and
// runs the suite in isolation. The live tree is never modified.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function requireFiles(liveWork, pristineWork, paths) {
    for (const path of paths) {
        for (const root of [liveWork, pristineWork]) {
            try {
                readFileSync(join(root, path));
            } catch {
                console.error(`missing required file: ${join(root, path)}`);
                process.exit(2);
            }
        }
    }
}

export function runSuite(liveWork, pristineWork, label) {
    const root = mkdtempSync(join(tmpdir(), `${label}-`));
    try {
        cpSync(liveWork, root, { recursive: true });
        for (const relative of ["test", "package.json"]) {
            rmSync(join(root, relative), { recursive: true, force: true });
            cpSync(join(pristineWork, relative), join(root, relative), {
                recursive: true,
            });
        }
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync("npm", ["test"], {
            cwd: root,
            encoding: "utf8",
            timeout: 90000,
            env,
        });
        process.stdout.write(result.stdout ?? "");
        process.stderr.write(result.stderr ?? "");
        if (result.error) {
            console.error(`${label} runner failed: ${result.error}`);
            process.exit(1);
        }
        return { root, status: result.status };
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
}

export function finish(label, root, status, extra) {
    try {
        extra?.(root);
        if (status !== 0) {
            console.error(`${label} primary check: fail (exit ${status})`);
            process.exit(1);
        }
        console.log(`${label} primary check: pass`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

export function assertUnchanged(root, pristineWork, paths) {
    for (const path of paths) {
        const live = readFileSync(join(root, path));
        const pristine = readFileSync(join(pristineWork, path));
        if (!live.equals(pristine)) {
            console.error(`protected file changed: ${path}`);
            process.exit(1);
        }
    }
}

export function writeFile(path, contents) {
    writeFileSync(path, contents, "utf8");
}
