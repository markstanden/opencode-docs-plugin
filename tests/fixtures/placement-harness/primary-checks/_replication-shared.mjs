// Shared runner for the R01–R04 pristine primary checks.
// Copies the live work tree, restores the pristine tests and package.json, and
// runs the suite in isolation. The live tree is never modified.
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Refuse when a required file is missing from either tree. */
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

/** Copy the live tree, restore the pristine tests, and run `npm test`. */
export function runSuite(liveWork, pristineWork, label) {
    return runRestoredSuite(liveWork, pristineWork, label, [
        "test",
        "package.json",
    ]);
}

/**
 * Copy the live tree, restore an explicit set of pristine paths, and run
 * `npm test` in isolation.
 * @param liveWork The trial's live work tree.
 * @param pristineWork The pristine fixture work tree.
 * @param label Temporary-directory and report label.
 * @param restore Paths to restore from the pristine tree.
 * @returns The temporary root and the suite's exit status.
 */
export function runRestoredSuite(liveWork, pristineWork, label, restore) {
    const root = mkdtempSync(join(tmpdir(), `${label}-`));
    try {
        cpSync(liveWork, root, { recursive: true });
        for (const relative of restore) {
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

/** Emit the verdict, run optional extra assertions, then clean up. */
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

/** Refuse when a protected file differs from its pristine bytes. */
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

/** Write a UTF-8 file. */
export function writeFile(path, contents) {
    writeFileSync(path, contents, "utf8");
}
