import { spawnSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statSync,
} from "node:fs";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    normalize,
    relative,
    sep,
} from "node:path";
import {
    EXCLUDED_AREAS,
    toEntry,
    type DocClass,
    type DocEntry,
    type DocsAdd,
    type LakeProfile,
} from "./metadata.ts";
import { targetOf } from "./convention.ts";
import type { Dirent } from "node:fs";

/**
 * The newest commit date per path, in one `git log` pass over all paths.
 * `git log` lists commits newest first, so the first date seen for a path is
 * its latest edit; paths absent from history are absent from the map.
 * @param cwd Directory inside the lake root's work tree; git resolves the
 * work-tree root itself.
 * @param paths Root-relative paths.
 * @returns A `YYYY-MM-DD` per known path.
 */
export function gitDates(
    cwd: string,
    paths: readonly string[],
): Map<string, string> {
    const dates = new Map<string, string>();
    if (paths.length === 0) {
        return dates;
    }
    const result = spawnSync(
        "git", // NOSONAR: portable git lookup; cwd is trusted local config, not model input.
        // `--relative` keeps the output paths root-relative to `cwd`; without
        // it a lake rooted at `<repo>/docs` maps `docs/foo.md` while the
        // requested paths are `foo.md`, silently falling back to mtimes.
        ["log", "--relative", "--format=%cs", "--name-only", "--", ...paths],
        // The default 1MB cap silently truncates a long history's output, which
        // would drop every git date back to mtime — so give it room.
        { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.status !== 0) {
        return dates;
    }
    let committed = "";
    for (const line of (result.stdout ?? "").split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") {
            continue;
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            committed = trimmed;
        } else if (committed !== "" && !dates.has(trimmed)) {
            dates.set(trimmed, committed);
        }
    }
    return dates;
}

/**
 * A date per path in one batch: git's newest commit date, else the file
 * mtime, else "". One git pass for the whole tree, however many docs.
 * @param cwd Directory inside the lake root's work tree.
 * @param paths Root-relative paths.
 * @returns A date per path.
 */
export function fallbackDates(
    cwd: string,
    paths: readonly string[],
): Map<string, string> {
    const dates = gitDates(cwd, paths);
    for (const path of paths) {
        if (dates.has(path)) {
            continue;
        }
        try {
            dates.set(
                path,
                statSync(join(cwd, path)).mtime.toISOString().slice(0, 10),
            );
        } catch {
            dates.set(path, "");
        }
    }
    return dates;
}

/** How a lake's tree is collected. */
export interface CollectOptions {
    /** The writing convention: knowledge excludes scratch and mirrors; wiki does not. */
    profile?: LakeProfile;
    /** The lake name stamped on each entry. */
    lake?: string;
    /** The class stamped on each entry. */
    class?: DocClass;
    /** Absolute roots to skip (another lake nested inside this one). */
    skip?: readonly string[];
}

/** Read a directory, returning no entries when it is unreadable. */
export function readDirectory(directory: string): Dirent[] {
    try {
        return readdirSync(directory, { withFileTypes: true });
    } catch {
        return [];
    }
}

/**
 * The one collection-visibility rule for a root-relative doc path: the
 * path segment that makes it invisible to collection, or null when the path
 * is collected. Knowledge lakes skip the scratch and mirror areas at the
 * top level; every profile skips dot-directories and `node_modules` at any
 * depth. Shared by the collection walk ({@link collectDocPaths}) and the
 * `add` target validation, so a write can never land where collection
 * refuses to look.
 * @param path Root-relative doc path, `/`-separated.
 * @param profile The lake's writing convention.
 * @returns The offending segment, or null when the path is collected.
 */
export function uncollectedSegment(
    path: string,
    profile: LakeProfile,
): string | null {
    const segments = path.split("/");
    const top = segments[0] ?? "";
    if (
        profile === "knowledge" &&
        (EXCLUDED_AREAS as readonly string[]).includes(top)
    ) {
        return top;
    }
    for (const segment of segments) {
        if (segment.startsWith(".") || segment === "node_modules") {
            return segment;
        }
    }
    return null;
}

/**
 * Whether a directory is outside the lake's collection rules.
 * @param item The directory entry.
 * @param directory Its parent directory.
 * @param root The lake root.
 * @param profile The lake's writing convention.
 * @param nested Other lake roots nested inside this one.
 * @returns True when the walk should not enter it.
 */
export function skipDirectory(
    item: Dirent,
    directory: string,
    root: string,
    profile: LakeProfile,
    nested: readonly string[],
): boolean {
    const path = join(directory, item.name);
    if (nested.some((other) => isUnder(path, other))) {
        return true;
    }
    return (
        uncollectedSegment(
            relative(root, path).split(sep).join("/"),
            profile,
        ) !== null
    );
}

/**
 * Code-unit string order, matching the default sort but stated explicitly.
 * @param a Left string.
 * @param b Right string.
 * @returns Negative, zero or positive in code-unit order.
 */
export function compareText(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}

/**
 * Walk a lake root, returning its `.md` paths relative to the root. Dot
 * directories are skipped (which drops `.git` and `.attachments`), as are
 * symlinked directories, `node_modules` and any other configured lake root
 * nested inside. Knowledge lakes also skip the scratch and mirror areas.
 * @param root The lake root.
 * @param options Collection rules.
 * @param options.profile The writing convention.
 * @param options.lake The lake name (unused by the path walk).
 * @param options.class The source class (unused by the path walk).
 * @param options.skip Absolute roots of other lakes nested inside this one.
 * @returns Root-relative paths, ordered by path.
 */
export function collectDocPaths(
    root: string,
    options: CollectOptions = {},
): string[] {
    const profile = options.profile ?? "knowledge";
    const skip = options.skip ?? [];
    const nested = skip.filter(
        (other) => other !== root && isUnder(other, root),
    );
    const paths: string[] = [];
    const walk = (directory: string): void => {
        for (const item of readDirectory(directory)) {
            const path = join(directory, item.name);
            if (item.isDirectory()) {
                if (!skipDirectory(item, directory, root, profile, nested)) {
                    walk(path);
                }
                continue;
            }
            if (
                !item.isFile() ||
                item.isSymbolicLink() ||
                !item.name.endsWith(".md") ||
                uncollectedSegment(
                    relative(root, path).split(sep).join("/"),
                    profile,
                ) !== null
            ) {
                continue;
            }
            paths.push(relative(root, path).split(sep).join("/"));
        }
    };
    if (existsSync(root)) {
        walk(root);
    }
    return paths.sort(compareText);
}

/**
 * Collect every doc under a lake root, honouring the profile's exclusions and
 * the other lakes nested inside it.
 * @param root Lake root — the directory that is the tree.
 * @param resolve Resolves every doc path's date in one batched call.
 * @param options Collection rules.
 * @param options.profile The writing convention.
 * @param options.lake The lake name stamped on each entry.
 * @param options.class The source class stamped on each entry.
 * @param options.skip Absolute roots of other lakes nested inside this one.
 * @returns Entries ordered by path, or none when the root is absent.
 */
export function collectDocs(
    root: string,
    resolve: (paths: readonly string[]) => ReadonlyMap<string, string>,
    options: CollectOptions = {},
): DocEntry[] {
    const profile = options.profile ?? "knowledge";
    const paths = collectDocPaths(root, options);
    const dates = resolve(paths);
    return paths.map((path) =>
        toEntry(
            path,
            readFileSync(join(root, path), "utf8"),
            dates.get(path) ?? "",
            {
                lake: options.lake ?? "",
                class: options.class ?? (profile === "wiki" ? "wiki" : "repo"),
                profile,
            },
        ),
    );
}

/**
 * Directory names the fallback README walk never enters, for a project outside
 * a git work tree (inside one, `.gitignore` decides; dot-directories are always
 * skipped). Kept to dependencies and build output — the usual noise — rather
 * than every convention going.
 */
export const README_EXCLUDED_DIRS = [
    "node_modules",
    "dist",
    "build",
    "coverage",
    "target",
    "vendor",
    "__pycache__",
] as const;

/**
 * Whether `path` is `root` itself or sits beneath it. Only an exact `..` path
 * segment escapes the root — a `..`-prefixed name like `..drafts` does not.
 */
export function isUnder(path: string, root: string): boolean {
    const rest = relative(root, path);
    return (
        rest === "" ||
        (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
    );
}

/**
 * Resolve symlinks in the existing prefix of a path, appending any missing
 * suffix. Used to compare lake roots by their real filesystem location.
 * @param path The path to resolve.
 * @returns The real path, or a normalised path when it cannot be resolved.
 */
export function realPathOf(path: string): string {
    let current = path;
    const missing: string[] = [];
    while (!existsSync(current)) {
        const parent = dirname(current);
        if (parent === current) {
            return normalize(path);
        }
        missing.unshift(basename(current));
        current = parent;
    }
    try {
        return join(realpathSync(current), ...missing);
    } catch {
        return normalize(path);
    }
}

/** Whether a file name is a README in any case (`README.md`, `readme.md`). */
export function isReadme(name: string): boolean {
    return name.toLowerCase() === "readme.md";
}

/**
 * Resolve an `add` request's target path and apply the collection-visibility
 * rule: the resolved path (derived or explicit) must be a path the target
 * lake would actually collect, or the refusal explains why.
 * @param add The typed request.
 * @param profile The target lake's writing convention.
 * @returns The target path, or the refusal reason.
 */
export function resolvedTargetOf(
    add: DocsAdd,
    profile: LakeProfile,
): { path: string } | { reason: string } {
    const target = targetOf(add);
    if ("reason" in target) {
        return target;
    }
    const invisible = uncollectedSegment(target.path, profile);
    if (invisible !== null) {
        return {
            reason:
                `'${invisible}' in ${target.path} is never collected by a ` +
                `${profile} lake — the write would succeed yet stay ` +
                "invisible to search, read and check. Choose a visible " +
                "Area or path.",
        };
    }
    return target;
}

/**
 * The project's nested README paths, relative to `location`. Inside a git work
 * tree git supplies the list — tracked plus untracked, honouring `.gitignore` —
 * so dependency, build and scratch directories follow the project's own rules.
 * Outside one, a walk skips {@link README_EXCLUDED_DIRS} and dot-directories.
 * Both sources keep regular files only, and never follow a link: a leaf
 * symlink, a broken link, or a symlinked directory anywhere along the path
 * below `location` is not the project's own content, and following it could
 * index a file outside the tree — git can still list tracked paths whose
 * directory was replaced by a link. The project directory itself is the
 * trusted root: when it resolves through a symlink, containment is validated
 * from it downward, not above. Paths under `skip` (the lake root) are
 * dropped: they are already lake docs. A tracked file deleted from disk is
 * dropped too — git still lists it.
 * @param location The project directory the plugin loaded in.
 * @param skip Absolute roots whose READMEs are collected elsewhere.
 * @returns Project-relative README paths, ordered by path.
 */
export function readmePaths(
    location: string,
    skip: readonly string[] = [],
): string[] {
    const candidates = gitReadmePaths(location) ?? walkedReadmePaths(location);
    return candidates
        .filter((path) => isContainedRegularFile(location, path))
        .filter(
            (path) => !skip.some((root) => isUnder(join(location, path), root)),
        )
        .sort(compareText);
}

/** Whether a path exists and is a regular file, never following a symlink. */
export function isRegularFile(path: string): boolean {
    try {
        return lstatSync(path).isFile();
    } catch {
        return false;
    }
}

/** Whether a path exists and is a real directory, never following a symlink. */
export function isRealDirectory(path: string): boolean {
    try {
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Whether `relativePath` names a regular file whose every intermediate
 * component below `location` is a real directory, never a symlink — the
 * leaf check alone would follow a link planted mid-path into outside
 * content.
 * @param location The trusted project root; containment is validated below it.
 * @param relativePath A project-relative README candidate path.
 * @returns True only for a fully contained regular file.
 */
export function isContainedRegularFile(
    location: string,
    relativePath: string,
): boolean {
    const parts = relativePath.split("/");
    const leaf = parts.pop() ?? "";
    let current = location;
    for (const part of parts) {
        current = join(current, part);
        if (!isRealDirectory(current)) return false;
    }
    return isRegularFile(join(current, leaf));
}

/**
 * README paths from git's index and untracked non-ignored files, or undefined
 * when `location` is not inside a git work tree.
 */
export function gitReadmePaths(location: string): string[] | undefined {
    const result = spawnSync(
        "git", // NOSONAR: portable git lookup; cwd is trusted local config, not model input.
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd: location, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.status !== 0) {
        return undefined;
    }
    return (result.stdout ?? "")
        .split("\0")
        .filter((path) => path !== "" && isReadme(path.split("/").pop() ?? ""));
}

/** README paths from a directory walk, for a location outside a work tree. */
export function walkedReadmePaths(location: string): string[] {
    const paths: string[] = [];
    const excluded = README_EXCLUDED_DIRS as readonly string[];
    const walk = (directory: string): void => {
        let entries: Dirent[];
        try {
            entries = readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const item of entries) {
            const path = join(directory, item.name);
            if (item.isDirectory()) {
                if (item.name.startsWith(".") || excluded.includes(item.name)) {
                    continue;
                }
                walk(path);
            } else if (item.isFile() && isReadme(item.name)) {
                paths.push(relative(location, path));
            }
        }
    };
    walk(location);
    return paths;
}

/**
 * Collect the project's nested READMEs as search entries, with the same shape
 * as lake docs: H1 title, path-derived area, no front-matter.
 * @param location The project directory the plugin loaded in.
 * @param resolve Resolves every path's date in one batched call.
 * @param skip Absolute roots whose READMEs are collected elsewhere.
 * @param options The source class/lake stamped on each entry.
 * @param options.class The source class; defaults to `instructions`.
 * @param options.lake The lake name; empty for the implicit instructions source.
 * @returns Entries ordered by path, or none when the project is unreadable.
 */
export function collectReadmes(
    location: string,
    resolve: (paths: readonly string[]) => ReadonlyMap<string, string>,
    skip: readonly string[] = [],
    options: { class?: DocClass; lake?: string } = {},
): DocEntry[] {
    const paths = readmePaths(location, skip);
    const dates = resolve(paths);
    return paths.map((path) =>
        toEntry(
            path,
            readFileSync(join(location, path), "utf8"),
            dates.get(path) ?? "",
            {
                lake: options.lake ?? "",
                class: options.class ?? "instructions",
            },
        ),
    );
}

/**
 * Kebab-case a doc title into a file-name slug: lower-cased word characters,
 * everything else collapsed to single dashes, dashes trimmed.
 * @param text The H1 text.
 * @returns The slug, empty when no word characters remain.
 */
