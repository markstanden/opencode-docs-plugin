import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { CommandInvocation } from "@opencode/plugin/promise/command";
import type { Result } from "@opencode/plugin/promise/tool";
import {
    type AddMode,
    CLASS_LABELS,
    type DocEntry,
    type DocsAdd,
    type DocsInput,
    type LakeClass,
    type LakeProfile,
    classGuidance,
    parseFrontMatter,
    revisionOf,
    titleOf,
} from "./metadata.ts";
import {
    DEFAULT_PER_LAKE_QUOTA,
    type LakeInfo,
    MAX_CHECK_CHARS,
    helpText,
    rankDocs,
    render,
    resolveRequest,
} from "./ranking.ts";
import {
    collectDocs,
    fallbackDates,
    isUnder,
    realPathOf,
} from "./collection.ts";
import {
    DEFAULT_MAX_DOC_LINES,
    REFUSE,
    checkDocs,
    explicitTarget,
    overrideGiven,
    prepareAdd,
    slugify,
} from "./convention.ts";

export const NUDGED_TOOLS = ["grep", "glob"] as const;

/**
 * The text of a tool result's content: the string itself, or its text parts
 * joined. Non-text parts and foreign shapes contribute nothing.
 * @param content A `Tool.Result` content of any provenance.
 * @returns The searchable text, possibly empty.
 */
export function contentText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) =>
                typeof part === "object" &&
                part !== null &&
                "text" in part &&
                typeof (part as { text: unknown }).text === "string"
                    ? (part as { text: string }).text
                    : "",
            )
            .join("\n");
    }
    return "";
}

/**
 * Whether a grep/glob result reads as a search miss. Raw rg prints nothing
 * on a miss (exit 1, empty stdout) — "No matches found" and "No files found"
 * are the host wrapper's phrasings — so emptiness is the primary signal and
 * the phrases are a bonus that keeps working if the wrapper rewords.
 * @param content The tool result's content (string or content parts).
 * @returns True when the result is a miss.
 */
export function isSearchMiss(content: unknown): boolean {
    const trimmed = contentText(content).trim();
    return trimmed === "" || /no (matches|files) found/i.test(trimmed);
}

/** The grep/glob call's `pattern`, when the input carries a string one. */
export function patternOf(input: unknown): string {
    if (typeof input === "object" && input !== null && "pattern" in input) {
        const pattern = (input as { pattern: unknown }).pattern;
        if (typeof pattern === "string") {
            return pattern.trim();
        }
    }
    return "";
}

/**
 * The one-line pointer appended to a grep/glob miss: the docs tool indexes
 * the same knowledge, so echo the failed pattern when there is one.
 * @param pattern The failed call's pattern, possibly blank.
 * @returns The nudge line.
 */
export function missNudge(pattern: string): string {
    const suggestion =
        pattern === ""
            ? "a knowledge question may already be answered there."
            : `try \`docs search\` with terms from "${pattern}".`;
    return (
        "Note: the `docs` tool also indexes the knowledge lakes and project " +
        `READMEs before you move on — ${suggestion}`
    );
}

/** One tool call, as the miss-nudge decision sees it. */
export interface NudgeCall {
    /** The tool's registered name. */
    readonly tool: string;
    /** `"completed"` results only — an errored call is not a knowledge miss. */
    readonly status: "completed" | "error";
    /** The result's content (string or parts). */
    readonly content: unknown;
    /** The call's input, for the failed pattern. */
    readonly input: unknown;
}

/**
 * The nudge line for a tool call, or null when the call deserves none: not a
 * watched tool, an errored call, a genuine hit, or a session that has already
 * been nudged (or already used the lake).
 * @param call The tool call to judge.
 * @param alreadyNudged Whether the session was nudged — or used the docs
 * tool — already.
 * @returns The line to append, or null.
 */
export function missNudgeFor(
    call: NudgeCall,
    alreadyNudged: boolean,
): string | null {
    if (alreadyNudged || call.status !== "completed") {
        return null;
    }
    if (!(NUDGED_TOOLS as readonly string[]).includes(call.tool)) {
        return null;
    }
    if (!isSearchMiss(call.content)) {
        return null;
    }
    return missNudge(patternOf(call.input));
}

/**
 * The system part injected into compaction requests: the summariser has no
 * tools, so it cannot record — instead it shapes each durable finding as its
 * own record-ready block for the continuing agent, one artifact per topic,
 * never a session dump (the near-twin guard catches duplicates, not dumps).
 */
export const RECORD_NUDGE =
    "Before summarising, the active task comes first. If the session " +
    "established durable knowledge (decisions, traps, runbooks, verified " +
    "behaviour), add one `Record with docs add:` block per durable topic and " +
    "scope — coalesce related findings rather than one block per observation, " +
    "never one session dump, and never one mixed-scope doc. Each block names " +
    "its scope (Repository/Personal/Organisation — config repo, machine or " +
    "global), `Area`, `H1` title and `Keywords`, and keeps what was learned, " +
    "why it matters, the evidence or status, any unresolved uncertainty and " +
    "the intended scope, so the next agent can reconcile before writing and " +
    "confirm the destination fits. Reference a finding already recorded by " +
    "path rather than restating it, and assume persistence only where the " +
    "session confirms it.";

/**
 * Resolve the plugin's `nudge` option: unset means on; a boolean passes
 * through; anything else throws, matching `root`'s loud-failure precedent.
 * @param configured The raw option value as the host delivers it.
 * @returns Whether the runtime nudges are active.
 */
export function resolveNudge(configured: unknown): boolean {
    if (configured === undefined) {
        return true;
    }
    if (typeof configured === "boolean") {
        return configured;
    }
    throw new Error(
        `docs plugin option 'nudge' must be a boolean, ` +
            `got ${JSON.stringify(configured)}.`,
    );
}

/** A configured lake, before its runtime seams are attached. */
export interface LakeSpec {
    /** The lake's addressing name, unique within the configuration. */
    name: string;
    /** The source class. */
    class: LakeClass;
    /** The absolute lake root. */
    root: string;
    /** The writing convention. */
    profile: LakeProfile;
    /** Whether `add` may write to it. */
    writable: boolean;
    /**
     * What belongs in this particular destination, as configured. Absent lakes
     * fall back to the class guidance ({@link classGuidance}); it is
     * descriptive data shown in help and refusal candidate lists, never
     * indexed for search.
     */
    description?: string;
}

/**
 * Whether `check` validates a lake: validation follows writability, because a
 * lake the plugin cannot write is out of its control. A wiki lake is never
 * validated. One rule, no per-lake override.
 * @param lake The configured lake.
 * @returns True when the lake's docs are validated.
 */
export function lakeValidated(lake: LakeSpec): boolean {
    return lake.profile === "knowledge" && lake.writable;
}

/** A lake with its runtime seams. */
export interface Lake extends LakeSpec {
    /** Collects this lake's docs. */
    collect: () => DocEntry[];
    /** Reads a root-relative path. */
    read: (path: string) => string;
    /** Whether a root-relative path exists. */
    exists: (path: string) => boolean;
    /**
     * Writes a root-relative path, creating parent directories beneath an
     * existing root; throws when the root is absent rather than creating it.
     */
    write: (path: string, contents: string) => void;
    /**
     * The guarded publication route for real lakes: lock, re-verify, and
     * publish the whole document — a no-overwrite create, or an atomic
     * whole-file replacement against `expectedRevision`. Legacy closure lakes
     * omit it and fall back to the plain `write` seam.
     */
    publish?: (
        path: string,
        contents: string,
        options: {
            mode: AddMode;
            expectedRevision?: string | undefined;
            label: string;
        },
    ) => { revision: string } | { reason: string };
    /**
     * Legacy seam notes only. Real lakes compute their environment notes at
     * call time — a root that appears, disappears or gains a git checkout is
     * re-probed on the next `check`, `search` and help, never captured here.
     */
    notes?: readonly string[];
    /** Whether `check` should verify relative links; false for the legacy seam. */
    linkCheck: boolean;
}

/**
 * A lake path that would leave its root or pass through a symlink. The lake
 * seams raise it so `add` can refuse the request rather than fail the call.
 */
export class UnsafePathError extends Error {
    /** Handles constructor. */
    constructor(path: string) {
        super(`path '${path}' escapes the lake root or crosses a symlink.`);
        this.name = "UnsafePathError";
    }
}

/** Whether `path` is outside `root` or is the root itself. */
export function escapesRoot(root: string, path: string): boolean {
    const rest = relative(root, path);
    return (
        rest === "" ||
        rest === ".." ||
        rest.startsWith(`..${sep}`) ||
        isAbsolute(rest)
    );
}

/**
 * Resolve a root-relative path to an absolute target, refusing an escape and
 * any symlink in the path. Missing trailing segments are allowed, so a write
 * can create them beneath a real directory.
 *
 * ponytail: the check and the caller's file operation are separate syscalls,
 * so a local process that can swap a component for a symlink in between still
 * wins the race. The threat model is a symlink committed to the tree, not a
 * live local attacker; closing the gap needs per-component `O_NOFOLLOW` opens.
 * @param root The lake root.
 * @param path The root-relative path.
 * @returns The target, or null when the path escapes or crosses a symlink.
 */
export function safeLakeTarget(root: string, path: string): string | null {
    const target = join(root, path);
    if (escapesRoot(root, target)) {
        return null;
    }
    let current = root;
    for (const segment of relative(root, target).split(sep)) {
        current = join(current, segment);
        try {
            const stats = lstatSync(current);
            if (
                stats.isSymbolicLink() ||
                (current !== target && !stats.isDirectory())
            ) {
                return null;
            }
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ENOENT"
                ? target
                : null;
        }
    }
    return target;
}

/**
 * A held target lock. Release it on every ordinary exit; a lock left by an
 * interrupted process is never stolen automatically — the refusal names its
 * owner and the recovery is manual.
 */
export interface TargetLock {
    /** Removes the lock file; best effort. */
    release: () => void;
}

/**
 * The physical identity of a target: its deepest existing ancestor, real-pathed,
 * plus the exact remaining segments. Two configured roots that reach the same
 * tree by different routes resolve to one prefix and one tail, so their locks
 * and identities cannot silently diverge. The key is stable across the
 * target-or-parent-creation transition: real-pathing the existing prefix and
 * joining the missing tail yields the same absolute path before and after the
 * missing segments appear.
 * @param target The absolute target path.
 * @returns The existing real prefix and the missing tail.
 */
export function physicalRouteOf(target: string): {
    realPrefix: string;
    tail: readonly string[];
} {
    const tail: string[] = [];
    let head = target;
    while (!existsSync(head)) {
        tail.unshift(basename(head));
        const parent = dirname(head);
        if (parent === head) {
            break;
        }
        head = parent;
    }
    return { realPrefix: realpathSync(head), tail };
}

/**
 * The canonical on-disk identity of a target: its resolved existing prefix
 * plus the missing tail joined. Every configured route to the same file
 * produces this one string.
 * @param target The absolute target path.
 * @returns The real-path key.
 */
export function physicalTargetKey(target: string): string {
    const { realPrefix, tail } = physicalRouteOf(target);
    return join(realPrefix, ...tail);
}

/**
 * The lock directory for a target: a hidden `.docs-lock` inside the deepest
 * existing ancestor that can hold it — the target's own directory once the
 * target exists, its existing parent otherwise. Siting the lock beside the
 * physical target keeps all configured routes (and separately configured
 * processes) on one directory: aliasing roots resolve the same real prefix,
 * and nothing about the lock location depends on the current runtime's lake
 * list. Search and `check` skip dot-directories at every level, so the lock
 * directory is never mistaken for content.
 * @param target The absolute target path.
 * @returns The lock directory path.
 */
export function targetLockDirectory(target: string): string {
    const { realPrefix, tail } = physicalRouteOf(target);
    // The existing prefix is real-pathed already: for an existing target it
    // is the file itself (lock beside it), for a missing target it is the
    // deepest existing ancestor directory.
    return join(
        tail.length === 0 ? dirname(realPrefix) : realPrefix,
        ".docs-lock",
    );
}

/**
 * The lock file for a target: keyed by the target's canonical physical key and
 * sited beside it (see {@link targetLockDirectory}). Exported for diagnostics
 * and tests: refusals name the manual recovery path, and tests must consult
 * the real protocol's location rather than re-deriving it.
 * @param target The absolute target path.
 * @returns The lock file path.
 */
export function targetLockPath(target: string): string {
    return join(
        targetLockDirectory(target),
        `${createHash("sha256")
            .update(physicalTargetKey(target), "utf8")
            .digest("hex")}.lock`,
    );
}

/**
 * Prepare the lock directory without touching anything but what is ours: an
 * existing directory is kept, any other object (including a symlink) refuses
 * without being read, followed, truncated or removed, and a missing directory
 * is created one level inside the already-existing ancestor. Bounded — one
 * creation attempt, then a post-EEXIST re-stat; no spin, no cleanup of
 * foreign objects.
 * @param lockDir The computed lock directory.
 * @returns undefined when the directory is usable, or the refusal reason.
 */
export function ensureLockDirectory(
    lockDir: string,
): { error: string } | undefined {
    try {
        const stats = lstatSync(lockDir);
        if (stats.isDirectory()) {
            return undefined;
        }
        return {
            error:
                `the lock directory ${lockDir} is occupied by a ` +
                `${stats.isSymbolicLink() ? "symlink" : "non-directory"}; ` +
                "nothing was written. Remove or repair it deliberately.",
        };
    } catch {
        // Absent — create it, contended creation tolerated below.
    }
    try {
        mkdirSync(lockDir);
        return undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            return {
                error: `could not create the lock directory ${lockDir}: ${String(error)}.`,
            };
        }
        try {
            return lstatSync(lockDir).isDirectory()
                ? undefined
                : {
                      error: `the lock directory ${lockDir} appeared and is not a directory.`,
                  };
        } catch {
            return {
                error: `the lock directory ${lockDir} vanished while locking.`,
            };
        }
    }
}

/**
 * Acquire a target's publication lock with an exclusive create. A held lock
 * refuses busy with its recorded owner; it is never stolen, however old —
 * an interrupted process is recovered by a human confirming the owner is
 * gone and removing the file.
 * @param target The absolute target path.
 * @returns The held lock, or the busy reason.
 */
export function acquireTargetLock(
    target: string,
): TargetLock | { busy: string } {
    const lockPath = targetLockPath(target);
    const problem = ensureLockDirectory(dirname(lockPath));
    if (problem !== undefined) {
        return { busy: problem.error };
    }
    try {
        const fd = openSync(lockPath, "wx");
        try {
            writeFullBytes(
                fd,
                JSON.stringify({
                    pid: process.pid,
                    acquiredAt: new Date().toISOString(),
                }),
            );
        } finally {
            closeSync(fd);
        }
        return {
            release: (): void => {
                try {
                    unlinkSync(lockPath);
                } catch {
                    // Best effort: a later refusal names the surviving lock.
                }
            },
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }
        let owner = "details unreadable";
        try {
            const raw = readFileSync(lockPath, "utf8").trim();
            if (raw !== "") {
                owner = raw;
            }
        } catch {
            // Keep the fallback text.
        }
        return {
            busy:
                `another writer holds the target lock (${owner}); retry ` +
                `later, or after confirming that process is gone remove ` +
                `${lockPath}.`,
        };
    }
}

/**
 * Write the whole byte sequence through an open descriptor. A short write is
 * looped — regular files rarely short-write, but nothing here reports a
 * revision for bytes it did not fully store: a mid-loop failure propagates
 * and the publication never renames.
 * @param fd The descriptor to write through, positioned by the OS.
 * @param contents The full serialised document.
 * @param write The single write primitive; injected for short-write tests.
 */
export function writeFullBytes(
    fd: number,
    contents: string,
    write: typeof writeSync = writeSync,
): void {
    const buffer = Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
        const written = write(fd, buffer, offset, buffer.length - offset);
        if (typeof written !== "number" || written <= 0) {
            throw new Error(
                `write stalled after ${offset} of ${buffer.length} bytes`,
            );
        }
        offset += written;
    }
}

/** A temp file this operation exclusively created and owns. */
export interface OwnedTemp {
    /** The exclusive-create descriptor; all writes go through it. */
    fd: number;
    /** The temp's path, for the atomic rename. */
    path: string;
}

/**
 * The exclusive temp-name selection seam: create one new regular file at a
 * name this operation owns, or throw `EEXIST` when a foreign object already
 * occupies the candidate. It is never reopened by pathname for writing — the
 * returned descriptor is the only write route — and a pre-existing symlink,
 * regular file or directory is never followed, truncated or removed.
 */
export type TempFactory = (target: string) => OwnedTemp;

/** The attempts made on distinct exclusive temp names before giving up. */
export const MAX_TEMP_ATTEMPTS = 8;

/** The module-level temp-file counter: unique publication temps per process. */
let publishTempCounter = 0;

/**
 * The default temp selection: `${target}.${pid}.${counter}.tmp` created
 * exclusively. A pre-existing object at a candidate name — including a
 * symlink seeded in advance — makes the create fail without touching it, and
 * the retry loop below moves to the next fresh name. The counter never
 * repeats within a process, so ordinary contention cannot exhaust the bound.
 * @param target The absolute target path.
 * @returns The owned temp descriptor and path.
 */
export const defaultTempFactory: TempFactory = (target) => {
    const path = `${target}.${process.pid}.${publishTempCounter++}.tmp`;
    const fd = openSync(path, "wx");
    return { fd, path };
};

/**
 * The publication seams: the narrow, injectable primitives the guarded
 * publication uses, exercised by default against the real filesystem. Tests
 * inject them to make collisions and mid-publication failures deterministic;
 * production code never reopens a claimed temp, and every seam default
 * satisfies the exclusive-create and full-write contracts.
 */
export interface PublicationSeams {
    /** Exclusive temp selection; defaults to {@link defaultTempFactory}. */
    temp?: TempFactory;
    /** The full-write primitive; defaults to {@link writeFullBytes}. */
    writeFull?: (fd: number, contents: string) => void;
    /** The atomic rename; defaults to `renameSync`. */
    rename?: (temp: string, target: string) => void;
    /** Stage observation for coordination and failure injection. */
    onStage?: (stage: PublicationStage) => void;
}

/** The observations a guarded publication announces. */
export type PublicationStage =
    | "locked"
    | "verified"
    | /** create only: the target is exclusively open, bytes not yet written */ "targetOpen"
    | "published";

/**
 * The bounded retry over exclusive temp names: each attempt is a fresh name
 * the factory must exclusively create; an `EEXIST` retry is bounded and never
 * touches the foreign object it collided with.
 * @param make The temp seam in use.
 * @param target The absolute target path, for the candidate names.
 * @returns An owned temp, or null when every attempt collided.
 */
export function acquireTemp(
    make: TempFactory,
    target: string,
): OwnedTemp | null {
    for (let remaining = MAX_TEMP_ATTEMPTS; remaining > 0; remaining -= 1) {
        try {
            return { ...make(target) };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }
    }
    return null;
}

/**
 * Verify the replace contract while the target lock is held: the target must
 * be a regular file (a vanished target is a conflict, never an implicit
 * create) and its current bytes must match the caller's token, so two
 * differently routed replace calls verify the same physical bytes under the
 * same lock.
 * @param target The absolute, guarded target path.
 * @param options Publication options.
 * @param options.expectedRevision The replace's stale-write token.
 * @param options.label The qualified target label, for refusals.
 * @returns null when the write may proceed, else the refusal reason.
 */
export function verifyUnderLock(
    target: string,
    options: { expectedRevision?: string | undefined; label: string },
): string | null {
    let present: boolean;
    try {
        present = lstatSync(target).isFile();
    } catch {
        present = false;
    }
    if (!present) {
        return (
            `${REFUSE} no doc at ${options.label} — replace never ` +
            'creates; pass mode:"create" for a new doc.'
        );
    }
    const found = revisionOf(readFileSync(target, "utf8"));
    if (found !== options.expectedRevision) {
        const short = (value: string | undefined): string =>
            (value ?? "none").slice(0, 12);
        return (
            `${REFUSE} ${options.label} changed since you read it ` +
            `(expected ${short(options.expectedRevision)}, found ` +
            `${short(found)}). Read it again, reconcile, and ` +
            "resubmit the replacement deliberately."
        );
    }
    return null;
}

/**
 * The refusal for a caught publication error, or null when the error is not
 * one the caller should see as a refusal: a losing create's EEXIST, or an
 * unwritable lake's EACCES/EPERM. Everything else propagates.
 * @param label The qualified target label, for refusals.
 * @param mode The mutation mode the write follows.
 * @param error The caught error.
 * @returns The refusal reason, or null to rethrow.
 */
export function publicationErrorRefusal(
    label: string,
    mode: AddMode,
    error: unknown,
): string | null {
    const code = (error as NodeJS.ErrnoException).code;
    if (mode === "create" && code === "EEXIST") {
        return (
            `${REFUSE} ${label} already exists — read it and pass ` +
            'mode:"replace" to overwrite it deliberately.'
        );
    }
    if (code === "EACCES" || code === "EPERM") {
        return (
            `${REFUSE} could not publish ${label}: ${String(error)}. ` +
            "The lake or its directories are not writable by this process."
        );
    }
    return null;
}

/**
 * The publication state/ownership sketch (one replace call):
 *
 *   acquire lock    exclusive create beside the physical target
 *   onStage locked
 *   verify          current bytes re-read under the lock (stale refusal)
 *   onStage verified
 *   create temp     exclusive create beside the target; owned fd retained
 *   write full      through the fd only; short writes loop or fail
 *   rename          atomic temp → target; the file published is ours
 *   onStage published
 *   release lock
 *   cleanup duties: on any ordinary failure, unlink ONLY the temp this
 *   operation created; the lock release in the outer finally; never a
 *   foreign temp, lock or document path.
 *
 * The guarantee covers cooperating plugin writers; a manual editor can still
 * race any filesystem operation, and a local attacker able to swap
 * directories between individual syscalls is outside this threat model
 * (documented, not fought with privileged machinery).
 * @param spec The lake spec.
 * @param target The absolute, guarded target path.
 * @param contents The serialised file contents.
 * @param options Publication options.
 * @param options.mode The mutation mode.
 * @param options.expectedRevision The replace's stale-write token.
 * @param options.label The qualified target label, for refusals.
 * @param options.seams The injectable publication primitives.
 * @returns The new revision, or the refusal reason.
 */
/** The resources one guarded publication has claimed so far. */
export interface PublicationLedger {
    /** The temp this operation exclusively created, while unpublished. */
    owned: OwnedTemp | null;
    /** Whether the submitted bytes are durably at the target. */
    published: boolean;
    /** Whether the target file is this operation's own `wx` create. */
    createdTarget: boolean;
}

/**
 * The guarded create: exclusive open, full write through the descriptor, no
 * overwrite. Sets the ledger on the way through; throws on failure so the
 * caller's cleanup owns the partial file.
 * @param target The absolute, guarded target path.
 * @param contents The serialised file contents.
 * @param ledger The claimed resources, updated in place.
 * @param writeFull The full-write primitive.
 * @param onStage Stage observation.
 */
export function publishCreate(
    target: string,
    contents: string,
    ledger: PublicationLedger,
    writeFull: (fd: number, contents: string) => void,
    onStage: (stage: PublicationStage) => void,
): void {
    mkdirSync(dirname(target), { recursive: true });
    const fd = openSync(target, "wx");
    // From here the file at the target is this operation's own exclusive
    // create: a failure owns and removes it, never a rival's `EEXIST` loss.
    ledger.createdTarget = true;
    // Deliberately observable window: a create's guarantees are exclusive
    // naming and eventually-complete bytes, not the replacement path's
    // all-or-nothing swap — "targetOpen" marks the readers-see-it-first state
    // for coordination and tests.
    onStage("targetOpen");
    try {
        writeFull(fd, contents);
    } finally {
        closeSync(fd);
    }
    // The whole sequence succeeded: the no-overwrite create contract, now
    // with a full-write guarantee.
    ledger.published = true;
    onStage("published");
}

/**
 * The guarded replace under the held lock: re-verify the token, exclusively
 * create a fresh temp, write the whole sequence through its descriptor and
 * swap atomically.
 * @param target The absolute, guarded target path.
 * @param contents The serialised file contents.
 * @param ledger The claimed resources, updated in place.
 * @param options Publication options.
 * @param options.expectedRevision The replace's stale-write token.
 * @param options.label The qualified target label, for refusals.
 * @param seams The publication seams.
 * @returns null when the bytes are published, else the refusal reason.
 */
export function publishReplace(
    target: string,
    contents: string,
    ledger: PublicationLedger,
    options: { expectedRevision?: string | undefined; label: string },
    seams: PublicationSeams,
): string | null {
    const refusal = verifyUnderLock(target, options);
    if (refusal !== null) {
        return refusal;
    }
    seams.onStage?.("verified");
    const temp = acquireTemp(seams.temp ?? defaultTempFactory, target);
    if (temp === null) {
        return (
            `${REFUSE} could not publish ${options.label}: every ` +
            "candidate temp name was occupied by an object this " +
            "operation does not own; nothing was changed."
        );
    }
    ledger.owned = temp;
    try {
        (seams.writeFull ?? writeFullBytes)(temp.fd, contents);
    } finally {
        closeSync(temp.fd);
    }
    (seams.rename ?? renameSync)(temp.path, target);
    // From here the temp path no longer holds our bytes.
    ledger.owned = null;
    ledger.published = true;
    seams.onStage?.("published");
    return null;
}

/**
 * The publication state/ownership sketch (one call):
 *
 *   acquire lock    exclusive create beside the physical target
 *   onStage locked
 *   verify          replace: current bytes re-read under the lock
 *   onStage verified
 *   open target     create: `wx` open, this operation's file, no bytes yet
 *   onStage targetOpen (create only — readers can observe the empty file)
 *   write full      through the fd only; short writes loop or fail
 *   rename          replace: atomic temp → target; the file published is ours
 *   onStage published
 *   release lock
 *   cleanup duties: on any ordinary failure, unlink ONLY the temp this
 *   operation created (and its own partial create target); the lock release
 *   in the outer finally; never a foreign temp, lock or document path.
 *
 * The guarantee covers cooperating plugin writers; a manual editor can still
 * race any filesystem operation, and a local attacker able to swap
 * directories between individual syscalls is outside this threat model
 * (documented, not fought with privileged machinery).
 * @param target The absolute, guarded target path. (The lake's identity is
 * implied by the guard.)
 * @param contents The serialised file contents.
 * @param options Publication options.
 * @param options.mode The mutation mode.
 * @param options.expectedRevision The replace's stale-write token.
 * @param options.label The qualified target label, for refusals.
 * @param options.seams The injectable publication primitives.
 * @returns The new revision, or the refusal reason.
 */
export function publishTarget(
    target: string,
    contents: string,
    options: {
        mode: AddMode;
        expectedRevision?: string | undefined;
        label: string;
        seams?: PublicationSeams;
    },
): { revision: string } | { reason: string } {
    const seams = options.seams ?? {};
    const lock = acquireTargetLock(target);
    if ("busy" in lock) {
        return { reason: `${REFUSE} ${lock.busy}` };
    }
    // The resource ledger: only the temp this operation exclusively created
    // is ever unlinked (and only while unpublished), and only a target file
    // this operation created itself is removed on a create failure — never a
    // rival's `EEXIST` loss.
    const ledger: PublicationLedger = {
        owned: null,
        published: false,
        createdTarget: false,
    };
    const onStage = (stage: PublicationStage): void => {
        seams.onStage?.(stage);
    };
    try {
        onStage("locked");
        if (options.mode === "create") {
            publishCreate(
                target,
                contents,
                ledger,
                seams.writeFull ?? writeFullBytes,
                onStage,
            );
        } else {
            const refusal = publishReplace(
                target,
                contents,
                ledger,
                options,
                seams,
            );
            if (refusal !== null) {
                return { reason: refusal };
            }
        }
        return { revision: revisionOf(contents) };
    } catch (error) {
        const handled = publicationFailure(target, ledger, options, error);
        if (handled !== null) {
            return { reason: handled };
        }
        throw error;
    } finally {
        if (ledger.owned !== null) {
            try {
                unlinkSync(ledger.owned.path);
            } catch {
                // Owned temp may already be gone with its rename.
            }
        }
        lock.release();
    }
}

/**
 * Handle one caught publication error: remove the partial file this
 * operation created itself, translate the mapped refusal codes, and leave
 * everything else for the caller to rethrow.
 * @param target The absolute, guarded target path.
 * @param ledger The claimed resources.
 * @param options Publication options.
 * @param options.label The qualified target label, for refusals.
 * @param options.mode The mutation mode the write follows.
 * @param error The caught error.
 * @returns The refusal reason, or null to rethrow.
 */
export function publicationFailure(
    target: string,
    ledger: PublicationLedger,
    options: { label: string; mode: AddMode },
    error: unknown,
): string | null {
    if (ledger.createdTarget && !ledger.published) {
        // A create that opened `wx` then failed owns its own partial file;
        // remove it, and never the rival's.
        try {
            unlinkSync(target);
        } catch {
            // Best effort; the failure already reports itself.
        }
    }
    return publicationErrorRefusal(options.label, options.mode, error);
}

/** One other configured lake, for publishing's physical containment checks. */
export interface Containment {
    /** The other lake's identity and writability. */
    lake: { name: string; root: string; writable: boolean };
    /** The other lake's real (symlink-resolved) root. */
    realRoot: string;
}

/**
 * The refusal for a public write whose physical target reaches a nested
 * lake's tree through the selected lake's route, or null. The owner is the
 * deepest enclosing configured lake: addressing content physically inside
 * another lake's root through an outer alias would mutate a subtree the outer
 * lake never indexes, and a read-only owner's tree must not become writable
 * by reaching it through a writable outer lake. Naming the correct owner
 * leaves the caller one explicit re-address away.
 * @param spec The selected lake being published through.
 * @param target The absolute, guarded target path.
 * @param others The other configured lakes' real roots.
 * @returns The refusal reason, or null when the selected lake owns the tree.
 */
export function containmentRefusal(
    spec: LakeSpec,
    target: string,
    others: readonly Containment[],
): string | null {
    const own = realPathOf(spec.root);
    const key = physicalTargetKey(target);
    let deepest: Containment | undefined;
    for (const other of others) {
        if (other.realRoot === own) {
            continue;
        }
        if (
            isUnder(other.realRoot, own) &&
            isUnder(key, other.realRoot) &&
            (deepest === undefined || isUnder(other.realRoot, deepest.realRoot))
        ) {
            deepest = other;
        }
    }
    if (deepest === undefined) {
        return null;
    }
    const access = deepest.lake.writable
        ? `address it through lake:'${deepest.lake.name}' so it lands in the tree that indexes that address`
        : `its owner lake '${deepest.lake.name}' is read-only, so this content cannot be written`;
    return (
        `${REFUSE} the addressed file physically resolves inside lake ` +
        `'${deepest.lake.name}' (${deepest.lake.root}; ` +
        `${deepest.lake.writable ? "writable" : "read-only"}) — ${access}.`
    );
}

/**
 * Attach the filesystem seams to a lake spec.
 * @param spec The configured lake.
 * @param options Runtime options.
 * @param options.skip Absolute roots of other lakes, so a nested lake is not
 * collected twice.
 * @param options.containment The other lakes' real roots, for the publish
 * containment guard; omitted by direct callers that carry one lake only.
 * @param options.seams Injectable publication primitives; the real
 * filesystem defaults are used when absent, and tests inject them to make
 * collisions and failures deterministic.
 * @returns The lake the tool serves.
 */
export function createLake(
    spec: LakeSpec,
    options: {
        skip?: readonly string[];
        containment?: readonly Containment[];
        seams?: PublicationSeams;
    } = {},
): Lake {
    const guarded = (path: string): string => {
        const target = safeLakeTarget(spec.root, path);
        if (target === null) {
            throw new UnsafePathError(path);
        }
        return target;
    };
    return {
        ...spec,
        linkCheck: true,
        collect: () =>
            collectDocs(spec.root, (paths) => fallbackDates(spec.root, paths), {
                profile: spec.profile,
                lake: spec.name,
                class: spec.class,
                skip: options.skip ?? [],
            }),
        read: (path) => readFileSync(guarded(path), "utf8"),
        exists: (path) => {
            const target = safeLakeTarget(spec.root, path);
            return target !== null && existsSync(target);
        },
        write: (path, contents) => {
            const target = guarded(path);
            // The root is configured, never invented: a mistyped path must not
            // bootstrap a lake. `add` pre-checks for a friendlier refusal.
            if (!existsSync(spec.root)) {
                throw new Error(
                    `lake '${spec.name}' root ${spec.root} does not exist; ` +
                        "create it first.",
                );
            }
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, contents);
        },
        publish: (path, contents, publishOptions) => {
            const target = guarded(path);
            if (!existsSync(spec.root)) {
                return {
                    reason: `lake '${spec.name}' root ${spec.root} does not exist; create it first.`,
                };
            }
            if (options.containment !== undefined) {
                const refusal = containmentRefusal(
                    spec,
                    target,
                    options.containment,
                );
                if (refusal !== null) {
                    return { reason: refusal };
                }
            }
            return publishTarget(target, contents, {
                ...publishOptions,
                ...(options.seams !== undefined
                    ? { seams: options.seams }
                    : {}),
            });
        },
    };
}

/**
 * Build every configured lake, each aware of the others so a nested root is
 * collected once and never published through an outer alias. Nesting is
 * decided on real paths, so a symlinked root cannot defeat containment: the
 * skip paths handed to the walker are re-anchored under the collecting lake's
 * configured root.
 * @param specs The configured lakes.
 * @param options Runtime options.
 * @param options.seams The publication seams observed by every lake's
 * guarded publication.
 * @returns The runtime lakes.
 */
export function createLakes(
    specs: readonly LakeSpec[],
    options: { seams?: PublicationSeams } = {},
): Lake[] {
    const realRoots = specs.map((spec) => realPathOf(spec.root));
    return specs.map((spec, index) => {
        const own = realRoots[index] ?? spec.root;
        const skip = specs.flatMap((other, otherIndex) => {
            if (otherIndex === index) {
                return [];
            }
            const otherRoot = realRoots[otherIndex] ?? other.root;
            return otherRoot !== own && isUnder(otherRoot, own)
                ? [join(spec.root, relative(own, otherRoot))]
                : [];
        });
        const containment: Containment[] = specs.flatMap(
            (other, otherIndex) => {
                if (otherIndex === index) {
                    return [];
                }
                return [
                    {
                        lake: {
                            name: other.name,
                            root: other.root,
                            writable: other.writable,
                        },
                        realRoot: realRoots[otherIndex] ?? other.root,
                    },
                ];
            },
        );
        return createLake(spec, {
            skip,
            ...(containment.length > 0 ? { containment } : {}),
            ...(options.seams !== undefined ? { seams: options.seams } : {}),
        });
    });
}

/** The lake classes the configuration accepts. */
export const LAKE_CLASSES = ["repo", "machine", "global", "wiki"] as const;

/**
 * The human-facing scope label per class, shown beside the config value in
 * help and candidate lists so agents can connect the two. Configuration
 * values never change: `repo`, `machine`, `global`, `wiki`.
 */
export const REPO_LAKES_FILE = ".opencode/docs-lakes.json";

/** The plugin's options, as the host delivers them. */
export interface DocsPluginOptions {
    /** The single repo-lake override; mutually exclusive with `lakes`. */
    root?: unknown;
    /** The `root` lake's name; defaults to the root folder name. Needs `root`. */
    name?: unknown;
    /** The `root` lake's description; what belongs there. Needs `root`. */
    description?: unknown;
    /** Base lake declarations, merged after `lakesFile` and the repo file. */
    lakes?: unknown;
    /** A JSON file of base lakes (`{ "lakes": [...] }`). */
    lakesFile?: unknown;
    /** The runtime nudges' switch; defaults to on. */
    nudge?: unknown;
    /** The soft body-line limit; defaults to 200, `0` disables. */
    maxDocLines?: unknown;
    /** The per-source result reservation; defaults to 3, `0` disables. */
    perLakeQuota?: unknown;
}

/**
 * Resolve a non-negative integer option, or throw loudly.
 * @param value The raw option value.
 * @param name The option name, for the error.
 * @param fallback The value when unset.
 * @returns The validated number.
 */
export function resolveNonNegativeInt(
    value: unknown,
    name: string,
    fallback: number,
): number {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
    }
    throw new Error(
        `docs plugin option '${name}' must be a non-negative integer, ` +
            `got ${JSON.stringify(value)}.`,
    );
}

/** Resolve the `lakesFile` option to an absolute path, or undefined. */
export function resolveLakesFilePath(
    configured: unknown,
    location: string,
): string | undefined {
    if (configured === undefined) {
        return undefined;
    }
    if (typeof configured !== "string" || configured.trim() === "") {
        throw new Error(
            `docs plugin option 'lakesFile' must be a non-empty string path, ` +
                `got ${JSON.stringify(configured)}.`,
        );
    }
    return resolveRoot(configured, location);
}

/**
 * Read a lakes JSON file. A base file is required; the repo file is optional.
 * @param path Absolute file path.
 * @param label Human-readable source name, for errors.
 * @param required Whether a missing file is an error.
 * @returns The raw lake entries.
 */
export function readLakesJson(
    path: string,
    label: string,
    required: boolean,
): unknown[] {
    if (!existsSync(path)) {
        if (required) {
            throw new Error(`docs plugin ${label} not found: ${path}.`);
        }
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new Error(
            `docs plugin ${label} is not valid JSON (${path}): ${String(error)}`,
            { cause: error },
        );
    }
    let lakes: unknown;
    if (Array.isArray(parsed)) {
        lakes = parsed;
    } else if (
        typeof parsed === "object" &&
        parsed !== null &&
        "lakes" in parsed
    ) {
        lakes = (parsed as { lakes: unknown }).lakes;
    } else {
        lakes = undefined;
    }
    if (!Array.isArray(lakes)) {
        throw new TypeError(
            `docs plugin ${label} must contain a "lakes" array: ${path}.`,
        );
    }
    return lakes;
}

/** A safe lake name: lower-case word characters and dashes. */
export const LAKE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The raw shape a lake declaration may take. */
export interface RawLake {
    /** The class value. */
    class?: unknown;
    /** The root value. */
    root?: unknown;
    /** The name value. */
    name?: unknown;
    /** The writable value. */
    writable?: unknown;
    /** The description value. */
    description?: unknown;
}

/** Narrow an unknown lake declaration to its raw shape. */
export function asLakeEntry(raw: unknown): RawLake {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(
            `docs plugin lake entry must be an object, got ${JSON.stringify(raw)}.`,
        );
    }
    return raw as RawLake;
}

/** Validate the lake class and the repo-file restriction. */
export function lakeClassOf(entry: RawLake, fromRepoFile: boolean): LakeClass {
    const given = entry.class ?? "repo";
    if (
        typeof given !== "string" ||
        !(LAKE_CLASSES as readonly string[]).includes(given)
    ) {
        throw new Error(
            `docs plugin lake class must be one of ${LAKE_CLASSES.join(", ")}, ` +
                `got ${JSON.stringify(entry.class)}.`,
        );
    }
    const lakeClass = given as LakeClass;
    if (fromRepoFile && lakeClass !== "repo") {
        throw new Error(
            `docs plugin repo lake file may only declare "repo" lakes; ` +
                `got ${JSON.stringify(lakeClass)}.`,
        );
    }
    return lakeClass;
}

/** Resolve and validate a lake root, applying the repo default. */
export function lakeRootOf(
    entry: RawLake,
    lakeClass: LakeClass,
    location: string,
    fromRepoFile: boolean,
): string {
    const blank =
        entry.root === undefined ||
        (typeof entry.root === "string" && entry.root.trim() === "");
    if (blank && lakeClass !== "repo") {
        throw new Error(
            `docs plugin ${lakeClass} lake needs a root path, ` +
                `got ${JSON.stringify(entry.root)}.`,
        );
    }
    if (blank) {
        return join(location, "docs");
    }
    if (typeof entry.root !== "string") {
        throw new TypeError(
            `docs plugin ${lakeClass} lake root must be a string, ` +
                `got ${JSON.stringify(entry.root)}.`,
        );
    }
    const root = resolveRoot(entry.root, location);
    if (fromRepoFile && !isUnder(realPathOf(root), realPathOf(location))) {
        throw new Error(
            `docs plugin repo lake root must stay inside the location: ${root}.`,
        );
    }
    return root;
}

/** Resolve and validate a lake name. */
export function lakeNameOf(
    entry: RawLake,
    root: string,
    lakeClass: LakeClass,
): string {
    const derived = slugify(basename(root)) || lakeClass;
    let name: string;
    if (entry.name === undefined) {
        name = derived;
    } else if (typeof entry.name === "string") {
        name = entry.name.trim();
    } else {
        name = "";
    }
    if (!LAKE_NAME.test(name)) {
        throw new Error(
            `docs plugin lake name must match ${LAKE_NAME}, ` +
                `got ${JSON.stringify(entry.name ?? derived)}.`,
        );
    }
    if (name === "instructions") {
        throw new Error(
            "docs plugin lake name 'instructions' is reserved for project READMEs.",
        );
    }
    return name;
}

/** Resolve and validate a lake's writability. */
export function lakeWritableOf(
    entry: RawLake,
    lakeClass: LakeClass,
    name: string,
): boolean {
    if (entry.writable !== undefined && typeof entry.writable !== "boolean") {
        throw new Error(
            `docs plugin lake '${name}' writable must be a boolean, ` +
                `got ${JSON.stringify(entry.writable)}.`,
        );
    }
    const writable = entry.writable ?? lakeClass !== "wiki";
    if (lakeClass === "wiki" && writable) {
        throw new Error(
            `docs plugin lake '${name}' is a wiki lake and cannot be writable.`,
        );
    }
    return writable;
}

/**
 * Resolve a lake description: trimmed when present, absent when blank. A
 * non-string fails loudly — a mistyped description must not become lake prose.
 * @param entry The raw declaration.
 * @param name The resolved lake name, for the error.
 * @returns The trimmed description, or undefined when absent.
 */
export function lakeDescriptionOf(
    entry: RawLake,
    name: string,
): string | undefined {
    if (entry.description === undefined) {
        return undefined;
    }
    if (typeof entry.description !== "string") {
        throw new Error(
            `docs plugin lake '${name}' description must be a string, ` +
                `got ${JSON.stringify(entry.description)}.`,
        );
    }
    const trimmed = entry.description.trim();
    return trimmed === "" ? undefined : trimmed;
}

/**
 * Validate one raw lake declaration and resolve its defaults.
 * @param raw The raw entry from a config file or inline option.
 * @param location The project directory the plugin loaded in.
 * @param fromRepoFile Whether the entry came from the repo-local file, which
 * may only add repo lakes rooted inside the location.
 * @returns The resolved lake spec.
 */
export function lakeSpecFrom(
    raw: unknown,
    location: string,
    fromRepoFile: boolean,
): LakeSpec {
    const entry = asLakeEntry(raw);
    const lakeClass = lakeClassOf(entry, fromRepoFile);
    const root = lakeRootOf(entry, lakeClass, location, fromRepoFile);
    const name = lakeNameOf(entry, root, lakeClass);
    const description = lakeDescriptionOf(entry, name);
    return {
        name,
        class: lakeClass,
        root,
        profile: lakeClass === "wiki" ? "wiki" : "knowledge",
        writable: lakeWritableOf(entry, lakeClass, name),
        ...(description !== undefined ? { description } : {}),
    };
}

/**
 * Resolve the plugin's lakes: the base `lakesFile`, the repo-local additions,
 * inline `lakes`, then `root` sugar. One implicit repo lake at
 * `<location>/docs` is added when no repo lake is configured, so a repo needs
 * no lake file unless its docs live elsewhere.
 * @param options The plugin options.
 * @param location The directory the plugin loaded in.
 * @returns The configured lake specs.
 */
/** Reject the ambiguous option combinations before reading any file. */
export function assertLakesOptions(options: DocsPluginOptions): void {
    if (options.lakes !== undefined && !Array.isArray(options.lakes)) {
        throw new Error(
            `docs plugin option 'lakes' must be an array, ` +
                `got ${JSON.stringify(options.lakes)}.`,
        );
    }
    if (options.root !== undefined && options.lakes !== undefined) {
        throw new Error(
            "docs plugin options 'root' and 'lakes' are mutually exclusive; " +
                "use 'root' for one repo lake or 'lakes' for the full list.",
        );
    }
    if (options.name !== undefined && options.root === undefined) {
        throw new Error(
            "docs plugin option 'name' names the 'root' lake; " +
                "set 'name' inside a 'lakes' entry instead.",
        );
    }
    if (options.description !== undefined && options.root === undefined) {
        throw new Error(
            "docs plugin option 'description' describes the 'root' lake; " +
                "set 'description' inside a 'lakes' entry instead.",
        );
    }
}

/** Map raw lake entries from a file to specs. */
export function specsFromFile(
    path: string,
    location: string,
    fromRepoFile: boolean,
): LakeSpec[] {
    const label = fromRepoFile ? "repo lake file" : "lakesFile";
    return readLakesJson(path, label, !fromRepoFile).map((raw) =>
        lakeSpecFrom(raw, location, fromRepoFile),
    );
}

/** Map the inline `lakes` option to specs. */
export function specsFromInline(
    rawLakes: unknown,
    location: string,
): LakeSpec[] {
    return Array.isArray(rawLakes)
        ? rawLakes.map((raw) => lakeSpecFrom(raw, location, false))
        : [];
}

/** Throw when two lakes share a name. */
export function assertUniqueLakeNames(specs: readonly LakeSpec[]): void {
    const names = new Set<string>();
    for (const spec of specs) {
        if (names.has(spec.name)) {
            throw new Error(
                `docs plugin lake name '${spec.name}' is declared twice; ` +
                    "give each lake a unique name.",
            );
        }
        names.add(spec.name);
    }
}

/** Throw when two differently named lakes resolve to the same root. */
export function assertUniqueLakeRoots(specs: readonly LakeSpec[]): void {
    const roots = new Map<string, string>();
    for (const spec of specs) {
        const key = realPathOf(spec.root);
        const existing = roots.get(key);
        if (existing !== undefined) {
            throw new Error(
                `docs plugin lakes '${existing}' and '${spec.name}' share ` +
                    `the root ${spec.root}; give each lake its own root.`,
            );
        }
        roots.set(key, spec.name);
    }
}

/**
 * Resolve the plugin's lakes: the base `lakesFile`, the repo-local additions,
 * inline `lakes`, then `root` sugar. One implicit repo lake at
 * `<location>/docs` is added when no repo lake is configured, so a repo needs
 * no lake file unless its docs live elsewhere.
 * @param options The plugin options.
 * @param location The directory the plugin loaded in.
 * @returns The configured lake specs.
 */
export function resolveLakes(
    options: DocsPluginOptions,
    location: string,
): LakeSpec[] {
    assertLakesOptions(options);
    const basePath = resolveLakesFilePath(options.lakesFile, location);
    const specs: LakeSpec[] = [
        ...(basePath === undefined
            ? []
            : specsFromFile(basePath, location, false)),
        ...specsFromFile(join(location, REPO_LAKES_FILE), location, true),
        ...specsFromInline(options.lakes, location),
    ];
    if (options.root !== undefined) {
        specs.push(
            lakeSpecFrom(
                {
                    class: "repo",
                    root: options.root,
                    name: options.name,
                    description: options.description,
                },
                location,
                false,
            ),
        );
    }
    if (!specs.some((spec) => spec.class === "repo")) {
        specs.push(
            lakeSpecFrom(
                { class: "repo", root: join(location, "docs") },
                location,
                false,
            ),
        );
    }
    assertUniqueLakeNames(specs);
    assertUniqueLakeRoots(specs);
    return specs;
}

/** Runtime deps shared by the tool and the command. */
export interface RuntimeInput {
    /** The configured lakes; omit for the legacy single-lake seams. */
    lakes?: readonly Lake[];
    /** Collects the lake docs; legacy seam. */
    collect?: () => DocEntry[];
    /** Collects everything searchable — lake docs plus local READMEs. */
    search?: () => DocEntry[];
    /** Whether a root-relative doc path exists; legacy seam. */
    exists?: (path: string) => boolean;
    /** Writes a root-relative doc path; legacy seam. */
    write?: (path: string, contents: string) => void;
    /** Reads a root-relative doc path's raw contents; legacy seam. */
    read?: (path: string) => string;
    /** Environment notes appended to the `check` report; legacy seam. */
    notes?: readonly string[];
    /** The soft body-line limit; defaults to {@link DEFAULT_MAX_DOC_LINES}. */
    maxDocLines?: number;
    /** The per-source result reservation; defaults to {@link DEFAULT_PER_LAKE_QUOTA}. */
    perLakeQuota?: number;
}

/** A resolved runtime: lakes plus the search and check knobs. */
export interface Runtime {
    /** The lakes value. */
    lakes: readonly Lake[];
    /** The search value. */
    search: () => DocEntry[];
    /** The max doc lines value. */
    maxDocLines: number;
    /** The per lake quota value. */
    perLakeQuota: number;
}

/** The legacy single-lake closure wrapped as a {@link Lake}. */
export function legacyLake(deps: RuntimeInput): Lake {
    const collect = deps.collect ?? deps.search ?? (() => []);
    return {
        name: "docs",
        class: "repo",
        root: "",
        profile: "knowledge",
        writable: true,
        collect,
        read: deps.read ?? (() => ""),
        exists: deps.exists ?? (() => false),
        write: deps.write ?? (() => {}),
        notes: deps.notes ?? [],
        linkCheck: deps.exists !== undefined,
    };
}

/** Normalise the old closure seams and the lake seams into one runtime. */
export function runtimeOf(deps: RuntimeInput): Runtime {
    const lakes = deps.lakes ?? [legacyLake(deps)];
    return {
        lakes,
        search: deps.search ?? (() => lakes.flatMap((lake) => lake.collect())),
        maxDocLines: deps.maxDocLines ?? DEFAULT_MAX_DOC_LINES,
        perLakeQuota: deps.perLakeQuota ?? DEFAULT_PER_LAKE_QUOTA,
    };
}

/** The first repo lake, else the first lake; the one rendered without a prefix. */
export function primaryLakeName(lakes: readonly Lake[]): string | undefined {
    return (lakes.find((lake) => lake.class === "repo") ?? lakes[0])?.name;
}

/** Find a lake by name. */
export function findLake(
    lakes: readonly Lake[],
    name: string,
): Lake | undefined {
    return lakes.find((lake) => lake.name === name);
}

/**
 * The environment notes for one lake, probed at call time. Legacy seams keep
 * their captured notes; every real lake re-probes, so a root that appears,
 * disappears or gains a git checkout is reported by the next surface that
 * looks — `check`, `search` and help never disagree with a stale capture.
 * @param lake The lake to describe.
 * @returns The note lines.
 */
export function lakeNotes(lake: Lake): readonly string[] {
    return lake.root === ""
        ? (lake.notes ?? [])
        : unversionedNote(lake.root, lake.name);
}

/** Whether a lake root is absent, probed at call time. */
export function lakeMissing(lake: Lake): boolean {
    return lake.root !== "" && !existsSync(lake.root);
}

/**
 * How many knowledge lakes enclose a lake — the nesting depth used to pick the
 * narrowest owner of a path and the deepest writable target for `add`. Wiki
 * lakes never enclose anything.
 * @param lake The lake to measure.
 * @param lakes The configured lakes.
 * @returns The number of enclosing knowledge lakes.
 */
export function nestingDepth(lake: Lake, lakes: readonly Lake[]): number {
    const root = realPathOf(lake.root);
    return lakes.filter((other) => {
        if (other === lake || other.profile === "wiki") {
            return false;
        }
        const otherRoot = realPathOf(other.root);
        return otherRoot !== root && isUnder(root, otherRoot);
    }).length;
}

/**
 * One candidate line for a destination refusal: name, scope label beside the
 * config value, root, availability, and the configured description or the
 * class guidance — everything an agent needs to choose deliberately.
 * @param lake The candidate lake.
 * @returns The rendered line.
 */
export function candidateLine(lake: Lake): string {
    const label = `${CLASS_LABELS[lake.class]} [${lake.class}]`;
    const missing = lakeMissing(lake) ? " — missing root" : "";
    const description = lake.description ?? classGuidance(lake.class);
    return `- ${lake.name} (${label}): ${lake.root}${missing} — ${description}`;
}

/**
 * The lake `add` writes to, or the refusal reason.
 *
 * An explicit name selects that exact lake or refuses — read-only, unknown
 * and (later, in `addDoc`) missing-root lakes never fall back elsewhere.
 * With `lake` omitted the write needs exactly one deliberate destination: the
 * sole configured writable knowledge lake. When two or more writable
 * knowledge lakes are configured the omission refuses with every candidate —
 * nesting, class, configuration order and current root existence change
 * nothing, because folder depth cannot infer the semantic owner of a claim.
 * Nesting still resolves the physical owner of an already named target (see
 * {@link uniqueHolder} and the publication containment guard); destination
 * choice and physical ownership are deliberately separate decisions.
 * @param lakes The configured lakes.
 * @param name The explicit lake selector, when given.
 * @returns The target lake, or the refusal reason.
 */
export function writableLake(
    lakes: readonly Lake[],
    name: string | undefined,
): Lake | { reason: string } {
    if (name !== undefined) {
        const lake = findLake(lakes, name);
        if (lake === undefined) {
            return { reason: `${REFUSE} no lake named '${name}'.` };
        }
        if (!lake.writable) {
            return {
                reason: `${REFUSE} lake '${name}' is read-only (${lake.profile}).`,
            };
        }
        return lake;
    }
    const pool = lakes.filter(
        (lake) => lake.profile === "knowledge" && lake.writable,
    );
    if (pool.length === 0) {
        return {
            reason:
                `${REFUSE} no writable knowledge lake is configured; ` +
                "wiki and read-only lakes are never written — add a repo, " +
                "machine or global lake.",
        };
    }
    if (pool.length > 1) {
        return {
            reason:
                `${REFUSE} ${pool.length} writable knowledge lakes could ` +
                "take this write; pass lake — one of:\n" +
                pool.map((lake) => candidateLine(lake)).join("\n"),
        };
    }
    return pool[0] as Lake;
}

/** Qualify a path with its lake when more than one lake is configured. */
export function address(
    lake: Lake,
    path: string,
    lakes: readonly Lake[],
): string {
    return lakes.length > 1 ? `${lake.name}:${path}` : path;
}

/** Search every lake, optionally limited to one, and render the ranked result. */
export function searchDocs(
    runtime: Runtime,
    query: string,
    lakeName: string | undefined,
): { content: string; count: number; omitted: number } {
    const all = runtime.search();
    let entries = all;
    if (lakeName !== undefined) {
        if (lakeName === "instructions") {
            entries = all.filter((entry) => entry.class === "instructions");
        } else if (findLake(runtime.lakes, lakeName) === undefined) {
            return {
                content: `No lake named '${lakeName}'.`,
                count: 0,
                omitted: 0,
            };
        } else {
            entries = all.filter((entry) => entry.lake === lakeName);
        }
    }
    const {
        entries: ranked,
        closest,
        omitted,
    } = rankDocs(entries, query, { perLakeQuota: runtime.perLakeQuota });
    const content = render(ranked, {
        closest,
        omitted,
        primaryLake: primaryLakeName(runtime.lakes) ?? "",
    });
    // A dormant lake contributes nothing, so without the note a typo'd root
    // looks like an empty lake rather than a broken path.
    const missing = runtime.lakes
        .filter(
            (lake) =>
                (lakeName === undefined || lakeName === lake.name) &&
                lakeMissing(lake),
        )
        .map((lake) => missingRootNote(lake.root, lake.name));
    return {
        content:
            missing.length > 0
                ? `${content}\n\n${missing.join("\n")}`
                : content,
        count: ranked.length,
        omitted,
    };
}

/** Why a lake is skipped by `check`, in one short line. */
export function skippedLakeLine(lake: LakeSpec): string {
    const why = lake.profile === "wiki" ? "wiki class, read-only" : "read-only";
    return `${lake.name}: ${why}, not validated.`;
}

/**
 * Truncate a check report at a line boundary, counting the lines cut and
 * pointing at the narrower report. A finding-heavy lake otherwise floods a
 * tool result.
 * @param content The full report text.
 * @returns The report, within {@link MAX_CHECK_CHARS}, or its capped form.
 */
export function cappedCheck(content: string): string {
    if (content.length <= MAX_CHECK_CHARS) {
        return content;
    }
    const lines = content.split("\n");
    const kept: string[] = [];
    let length = 0;
    for (const line of lines) {
        const next = length + (kept.length > 0 ? 1 : 0) + line.length;
        if (next > MAX_CHECK_CHARS) {
            break;
        }
        kept.push(line);
        length = next;
    }
    const omitted = lines.length - kept.length;
    const head = kept.length > 0 ? `${kept.join("\n")}\n\n` : "";
    return (
        `${head}… and ${omitted} more lines not shown. ` +
        "Narrow it per lake with the `lake` selector."
    );
}

/** Run one lake's check report and count the docs looked at. */
export function lakeReport(
    runtime: Runtime,
    lake: Lake,
): { report: string; checked: number } {
    const entries = lake.collect();
    return {
        report: checkDocs(entries, lake.read, lakeNotes(lake), {
            maxDocLines: runtime.maxDocLines,
            ...(lake.linkCheck ? { exists: lake.exists } : {}),
        }),
        checked: entries.length,
    };
}

/**
 * Join the validated lakes' reports and the skipped-lake lines. Only the
 * reports are capped: "no findings" must never read as "compliant" when a lake
 * was simply not looked at.
 * @param reports The validated lakes' reports, in configuration order.
 * @param skipped One-line reasons for each lake `check` did not validate.
 * @returns The check result text.
 */
export function assembleCheck(
    reports: readonly string[],
    skipped: readonly string[],
): string {
    const report = reports.length > 0 ? cappedCheck(reports.join("\n\n")) : "";
    const tail = skipped.join("\n");
    if (report === "" && tail === "") {
        return "No knowledge lakes configured.";
    }
    if (report === "" || tail === "") {
        return report || tail;
    }
    return `${report}\n\n${tail}`;
}

/** Check the knowledge lakes, optionally limited to one. */
export function checkLakes(
    runtime: Runtime,
    lakeName: string | undefined,
): { content: string; checked: number } {
    if (lakeName !== undefined) {
        const lake = findLake(runtime.lakes, lakeName);
        if (lake === undefined) {
            return { content: `No lake named '${lakeName}'.`, checked: 0 };
        }
        if (!lakeValidated(lake)) {
            return { content: skippedLakeLine(lake), checked: 0 };
        }
        const { report, checked } = lakeReport(runtime, lake);
        return { content: cappedCheck(report), checked };
    }
    let checked = 0;
    const reports = runtime.lakes.filter(lakeValidated).map((lake) => {
        const outcome = lakeReport(runtime, lake);
        checked += outcome.checked;
        return runtime.lakes.length > 1
            ? `${lake.name}:\n${outcome.report}`
            : outcome.report;
    });
    const skipped = runtime.lakes
        .filter((lake) => !lakeValidated(lake))
        .map(skippedLakeLine);
    return { content: assembleCheck(reports, skipped), checked };
}

/**
 * The refusal for a legacy-seam write whose target is in the wrong state:
 * a create whose target exists (never an implicit overwrite), a replace whose
 * target vanished (never an implicit create), or a replace whose current
 * bytes no longer match the caller's `expectedRevision`. Legacy closure
 * seams cannot exclude other processes, so this route is in-process only.
 * @param target The lake the write lands in.
 * @param outcome The prepared write.
 * @param outcome.mode The mutation mode the write follows.
 * @param outcome.path The root-relative target path.
 * @param expected The caller's revision token, when replacing.
 * @param labelled The qualified target label, for refusals.
 * @returns The refusal, or null when the target state allows the write.
 */
export function legacyPublicationRefusal(
    target: Lake,
    outcome: { mode: AddMode; path: string },
    expected: string | undefined,
    labelled: string,
): string | null {
    const present = target.exists(outcome.path);
    if (outcome.mode === "create") {
        return present
            ? `${REFUSE} ${labelled} already exists — read it and pass ` +
                  'mode:"replace" to overwrite it deliberately.'
            : null;
    }
    if (!present) {
        return (
            `${REFUSE} no doc at ${labelled} — replace never creates; ` +
            'pass mode:"create" for a new doc.'
        );
    }
    const found = revisionOf(target.read(outcome.path));
    return found === expected
        ? null
        : `${REFUSE} ${labelled} changed since you read it (expected ` +
              `${(expected ?? "none").slice(0, 12)}, found ` +
              `${found.slice(0, 12)}). Read it again, reconcile, and ` +
              "resubmit the replacement deliberately.";
}

/**
 * The lake a write lands in, with its root verified present: the destination
 * refusal ({@link writableLake}) plus the dormant-root refusal in one step, so
 * a mistyped root never bootstraps a tree.
 * @param lakes The configured lakes.
 * @param lakeName The explicit lake selector, when given.
 * @returns The verified lake, or the refusal reason.
 */
export function writeTarget(
    lakes: readonly Lake[],
    lakeName: string | undefined,
): Lake | { reason: string } {
    const target = writableLake(lakes, lakeName);
    if ("reason" in target) {
        return target;
    }
    if (target.root !== "" && !existsSync(target.root)) {
        return {
            reason:
                `${REFUSE} lake '${target.name}' root ${target.root} does ` +
                "not exist — create it first.",
        };
    }
    return target;
}

/**
 * Publish a prepared write through a legacy lake's plain write seam,
 * translating the seam's path-safety error into a refusal.
 *
 * The shipped route never needs this: every lake `createLakes` builds carries
 * the guarded `publish` seam. The legacy shape is still supported — a `Lake`
 * whose optional `publish` is absent may expose a guarded `write` (for example
 * one taken from `createLake`), so the symlink refusal can arrive here and must
 * surface as a refusal rather than a failed tool call.
 * @param target The lake the write lands in.
 * @param outcome The prepared write.
 * @param outcome.path The root-relative target path.
 * @param outcome.contents The serialised file contents.
 * @returns The refusal on an unsafe path, or null once written.
 */
export function publishLegacy(
    target: Lake,
    outcome: { path: string; contents: string },
): string | null {
    try {
        target.write(outcome.path, outcome.contents);
    } catch (error) {
        if (error instanceof UnsafePathError) {
            return `${REFUSE} ${error.message}`;
        }
        throw error;
    }
    return null;
}

/**
 * Publish through a lake's guarded protocol seam, translating its path-safety
 * error into a refusal.
 * @param publish The lake's publication seam.
 * @param outcome The prepared write.
 * @param outcome.mode The mutation mode the write follows.
 * @param outcome.path The root-relative target path.
 * @param outcome.contents The serialised file contents.
 * @param expected The caller's revision token, when replacing.
 * @param label The qualified target label, for refusals.
 * @returns The new revision, or the refusal reason.
 */
export function guardedPublish(
    publish: NonNullable<Lake["publish"]>,
    outcome: { mode: AddMode; path: string; contents: string },
    expected: string | undefined,
    label: string,
): { revision: string } | { reason: string } {
    try {
        return publish(outcome.path, outcome.contents, {
            mode: outcome.mode,
            expectedRevision: expected,
            label,
        });
    } catch (error) {
        if (error instanceof UnsafePathError) {
            return { reason: `${REFUSE} ${error.message}` };
        }
        throw error;
    }
}

/**
 * The one-line success report: the qualified target, the outcome, and an
 * override note when a near-twin was crossed deliberately.
 * @param outcome The prepared write.
 * @param outcome.mode The mutation mode the write follows.
 * @param label The qualified target label.
 * @param overridden Whether a near-twin override was used.
 * @returns The report head.
 */
export function successHead(
    outcome: { mode: AddMode },
    label: string,
    overridden: boolean,
): string {
    return (
        `${label} — ${outcome.mode === "replace" ? "replaced" : "created"}.` +
        (overridden ? " near-twin overridden." : "")
    );
}

/**
 * The success metadata: the written flag, the resolved lake and path, and the
 * new content revision when the route produced one.
 * @param target The lake the write landed in.
 * @param outcome The prepared write.
 * @param outcome.path The root-relative target path.
 * @param revision The new revision, when the route produced one.
 * @returns The metadata object.
 */
export function successMetadata(
    target: Lake,
    outcome: { path: string },
    revision: string | undefined,
): Record<string, unknown> {
    return {
        written: true,
        lake: target.name,
        path: outcome.path,
        ...(revision !== undefined ? { revision } : {}),
    };
}

/**
 * Publish a prepared write through the target lake's route: real lakes use
 * the guarded {@link publishTarget} protocol (lock, re-verify, atomic
 * publish); legacy closure lakes fall back to the plain seam with the same
 * contracts, in-process only.
 * @param target The verified destination lake.
 * @param outcome The prepared write.
 * @param outcome.mode The mutation mode the write follows.
 * @param outcome.path The root-relative target path.
 * @param outcome.contents The serialised file contents.
 * @param expected The caller's revision token, when replacing.
 * @param label The qualified target label, for refusals.
 * @returns The new revision, or the refusal reason.
 */
export function publishPrepared(
    target: Lake,
    outcome: {
        /** The mutation mode the write follows. */
        mode: AddMode;
        /** The root-relative target path. */
        path: string;
        /** The serialised file contents. */
        contents: string;
    },
    expected: string | undefined,
    label: string,
): { revision?: string; reason?: string } {
    if (target.publish !== undefined) {
        const result = guardedPublish(target.publish, outcome, expected, label);
        return "reason" in result
            ? { reason: result.reason }
            : { revision: result.revision };
    }
    const legacy = legacyPublicationRefusal(target, outcome, expected, label);
    if (legacy !== null) {
        return { reason: legacy };
    }
    const unsafe = publishLegacy(target, outcome);
    return unsafe === null ? {} : { reason: unsafe };
}

/**
 * Add a doc to the target lake through its publication route: real lakes use
 * the guarded {@link publishTarget} protocol (lock, re-verify, atomic
 * publish); legacy closure lakes fall back to the plain seam with the same
 * contracts, in-process only.
 * @param runtime The resolved runtime.
 * @param add The typed request.
 * @param lakeName The explicit lake selector, when given.
 * @returns The result content, written flag and success metadata.
 */
export function addDoc(
    runtime: Runtime,
    add: DocsAdd,
    lakeName: string | undefined,
): {
    content: string;
    written: boolean;
    metadata?: Record<string, unknown>;
} {
    const target = writeTarget(runtime.lakes, lakeName);
    if ("reason" in target) {
        return { content: target.reason, written: false };
    }
    const entries = target.collect();
    const outcome = prepareAdd(add, entries, {
        maxDocLines: runtime.maxDocLines,
        profile: target.profile,
    });
    if (outcome.action === "refuse") {
        return { content: outcome.reason, written: false };
    }
    const label = address(target, outcome.path, runtime.lakes);
    const expected = add.expectedRevision?.trim();
    const published = publishPrepared(target, outcome, expected, label);
    if (published.reason !== undefined) {
        return { content: published.reason, written: false };
    }
    const revision = published.revision;
    const head = successHead(
        outcome,
        label,
        outcome.mode === "create" && overrideGiven(add),
    );
    // The path and outcome are the answer; a list of same-area neighbours was
    // unsolicited context that grew with the area and was picked by collection
    // order, not relevance. Refusals still carry their candidates.
    const notes =
        outcome.notes.length > 0 ? `\n\n${outcome.notes.join("\n")}` : "";
    return {
        content:
            `${head}${notes}` +
            (revision !== undefined ? revisionNote(revision, true) : ""),
        written: true,
        metadata: successMetadata(target, outcome, revision),
    };
}

/** A parsed read request: the lake (when known) and the path. */
export interface ReadTarget {
    /** The lake value. */
    lake?: Lake;
    /** The path value. */
    path: string;
    /** The reason value. */
    reason?: string;
}

/** Split `lake:path` or an explicit lake selector into a target. */
export function readTargetOf(
    runtime: Runtime,
    given: string,
    lakeName: string | undefined,
): ReadTarget {
    const path = given.trim();
    if (lakeName !== undefined) {
        const lake = findLake(runtime.lakes, lakeName);
        const prefix = `${lakeName}:`;
        const selectedPath = path.startsWith(prefix)
            ? path.slice(prefix.length)
            : path;
        return lake === undefined
            ? { path, reason: `${REFUSE} no lake named '${lakeName}'.` }
            : { lake, path: selectedPath };
    }
    const colon = path.indexOf(":");
    if (colon <= 0) {
        return { path };
    }
    if (path.startsWith("instructions:")) {
        return {
            path,
            reason:
                `${REFUSE} instructions: paths are project READMEs; ` +
                "use the built-in read tool.",
        };
    }
    const lake = findLake(runtime.lakes, path.slice(0, colon));
    return lake === undefined
        ? { path }
        : { lake, path: path.slice(colon + 1) };
}

/** The unique lake holding a path, or the refusal reason. */
export function uniqueHolder(
    runtime: Runtime,
    path: string,
): Lake | { reason: string } {
    const holders = runtime.lakes.filter((lake) => lake.exists(path));
    if (holders.length === 0) {
        return { reason: `No doc at ${path}.` };
    }
    if (holders.length === 1) {
        return holders[0] as Lake;
    }
    // Nested lakes both hold an inner path: the narrowest enclosing lake owns
    // it. Non-nested holders tie on depth, which stays a documented refusal —
    // never a silent pick by collection order.
    const deepest = holders.map((lake) => ({
        lake,
        depth: nestingDepth(lake, holders),
    }));
    const max = Math.max(...deepest.map((item) => item.depth));
    const winners = deepest.filter((item) => item.depth === max);
    if (winners.length === 1) {
        return winners[0]?.lake as Lake;
    }
    return {
        reason:
            `${REFUSE} ${path} exists in multiple lakes ` +
            `(${holders.map((lake) => lake.name).join(", ")}); pass lake.`,
    };
}

/** Read one doc, resolving a `lake:path` prefix or the unique match. */
export function readDoc(
    runtime: Runtime,
    given: string,
    lakeName: string | undefined,
): {
    content: string;
    read: string | null;
    lake?: string;
    path?: string;
    revision?: string;
} {
    const target = readTargetOf(runtime, given, lakeName);
    if (target.reason !== undefined) {
        return { content: target.reason, read: null };
    }
    const guarded = explicitTarget(target.path);
    if ("reason" in guarded) {
        return {
            content: `${REFUSE} ${guarded.reason}`,
            read: null,
        };
    }
    const selected = target.lake ?? uniqueHolder(runtime, guarded.path);
    if ("reason" in selected) {
        return { content: selected.reason, read: null };
    }
    if (!selected.exists(guarded.path)) {
        return {
            content: `No doc at ${address(
                selected,
                guarded.path,
                runtime.lakes,
            )}.`,
            read: null,
        };
    }
    const raw = selected.read(guarded.path);
    const { body } = parseFrontMatter(raw);
    const label = address(selected, guarded.path, runtime.lakes);
    const revision =
        selected.profile === "knowledge" ? revisionOf(raw) : undefined;
    return {
        content:
            `${label} — ${titleOf(guarded.path, body)}\n\n${raw}` +
            (revision !== undefined ? revisionNote(revision, false) : ""),
        read: label,
        lake: selected.name,
        path: guarded.path,
        // Wiki pages are read-only reference and promise no write-capable
        // revision workflow; knowledge docs carry their content hash.
        ...(revision !== undefined ? { revision } : {}),
    };
}

/**
 * The model-facing revision note: the one line that makes an optimistic-
 * concurrency token visible through every real host path, stored per-call
 * metadata kept alongside it for UI and programmatic callers. Host evidence
 * (opencode v2.2.5): a plugin tool's result reaches the model only through its
 * `content` — `Session.Tool.Success` persists metadata as optional UI data,
 * the model-facing lowering (`to-llm-message.ts` → `toolResult()`) serialises
 * only `content`, and the Code Mode twin's `resultValue()` drops `metadata`
 * for tools without an output schema. Content text is the one channel both
 * surfaces forward, so the token rides it. The note sits after an explicit
 * blank separator, never inside the verbatim document body.
 * @param revision The content's SHA-256 revision.
 * @param fresh False for a caller's read; true when a replacement just
 * published these bytes.
 * @returns The note text with its leading blank-line separator.
 */
export function revisionNote(revision: string, fresh: boolean): string {
    return (
        `\n\ndocs: revision ${revision} — ` +
        (fresh ? "the newly published bytes" : "these bytes") +
        "; cite it as expectedRevision when replacing (a stale token refuses)."
    );
}

/** The lake help view shared by the tool and command. */
export function lakeInfo(lakes: readonly Lake[]): LakeInfo[] {
    return lakes.map((lake) => ({
        name: lake.name,
        class: lake.class,
        root: lake.root,
        writable: lake.writable,
        validated: lakeValidated(lake),
        missing: lakeMissing(lake),
        ...(lake.description !== undefined
            ? { description: lake.description }
            : {}),
    }));
}

/** Deliver a rendered result to a session. */
export type PromptSender = (
    sessionID: CommandInvocation["sessionID"],
    text: string,
) => Promise<unknown>;

/** Tool deps: lakes (or the legacy single-lake closures) plus knobs. */
export type DocsToolDeps = RuntimeInput;

/** Command deps: tool deps plus the session prompt sender. */
export interface DocsCommandDeps extends RuntimeInput {
    /** Delivers the rendered result to the session. */
    prompt: PromptSender;
}

/**
 * The twin's description: the Code Mode catalog is injected into every
 * `execute` prompt, so it pays its way in a short paragraph — the verbs, not
 * the full doctrine the native `docs` description carries.
 */
export const TWIN_DESCRIPTION =
    "Search, read, add and check the configured knowledge lakes and nested " +
    "project `README.md` files (search-only) from inside `execute` — the `docs` " +
    "tool's Code Mode twin, same verbs and lakes. A blank search lists recent " +
    "docs; `read` returns a matched doc verbatim; `add` writes through a typed " +
    "DTO; `check` validates the lakes.";

/**
 * Run one resolved `docs` request against the runtime.
 * @param runtime The resolved lakes and seams.
 * @param input The typed tool input.
 * @returns The tool result.
 */
export function executeRequest(runtime: Runtime, input: DocsInput): Result {
    const request = resolveRequest(input);
    if (request.verb === "add") {
        const result = addDoc(runtime, request.add, request.lake);
        return {
            content: result.content,
            metadata: result.metadata ?? { written: result.written },
        };
    }
    if (request.verb === "check") {
        const result = checkLakes(runtime, request.lake);
        return {
            content: result.content,
            metadata: { checked: result.checked },
        };
    }
    if (request.verb === "read") {
        const result = readDoc(runtime, request.read, request.lake);
        return {
            content: result.content,
            metadata: {
                read: result.read,
                ...(result.lake !== undefined ? { lake: result.lake } : {}),
                ...(result.path !== undefined ? { path: result.path } : {}),
                ...(result.revision !== undefined
                    ? { revision: result.revision }
                    : {}),
            },
        };
    }
    if (request.verb === "help") {
        return {
            content: helpText(lakeInfo(runtime.lakes)),
            metadata: { count: 0, omitted: 0 },
        };
    }
    const result = searchDocs(runtime, request.search, request.lake);
    return {
        content: result.content,
        metadata: {
            count: result.count,
            omitted: result.omitted,
        },
    };
}

/**
 * The environment variables enabling the opt-in operation journal: a path
 * and a per-run signing key. Both unset — the production default — the
 * plugin writes no journal at all. The key makes capture tamper-evident; a
 * trial tool can write a shaped line but cannot sign it.
 */
/**
 * Build the `docs` tool from its dependencies.
 *
 * By default the tool is registered with `codemode: false` so it stays on the
 * provider's native tool list. That option is exclusive: a tool defaults into
 * Code Mode (`codemode` defaults true) and is dropped from the native list;
 * only `codemode: false` keeps it natively callable — and `codemode: true`
 * with a `namespace` is how the host's own plugins expose tools to `execute`
 * (the catalog renders `tools.<namespace>.<name>(…)`). Pass a distinct
 * `name` and `codemode: true` to register a Code Mode twin of the same core;
 * the registry is name-keyed, so the twin cannot also be called `docs`.
 * @param deps Runtime seams used on each call.
 * @param options Registration shape.
 * @param options.name The tool name (default `"docs"`); a Code Mode twin
 * passes a distinct name — the registry is name-keyed, so two tools cannot
 * share one.
 * @param options.codemode True to register for the `execute` catalog under
 * the `docs` namespace (default `false` — the native tool list).
 * @returns The tool the host registers.
 */

/** Handles export function resolveRoot. */
export function resolveRoot(
    configured: unknown,
    locationDirectory: string,
): string {
    if (configured === undefined) {
        return join(locationDirectory, "docs");
    }
    if (typeof configured !== "string") {
        throw new TypeError(
            `docs plugin option 'root' must be a non-empty string path, ` +
                `got ${JSON.stringify(configured)}.`,
        );
    }
    const given = configured.trim();
    if (given === "") {
        return join(locationDirectory, "docs");
    }
    const expanded =
        given === "~" || given.startsWith("~/")
            ? join(homedir(), given.slice(1))
            : given;
    return isAbsolute(expanded) ? expanded : join(locationDirectory, expanded);
}

/**
 * The advisory note for a lake root that is absent. A missing root is a
 * configuration smell, not a failure: the lake stays dormant until the
 * directory exists, and `add` refuses rather than creating it.
 * @param root The resolved lake root.
 * @param lake The lake name, when known.
 * @returns The note line.
 */
export function missingRootNote(root: string, lake?: string): string {
    const subject =
        lake === undefined
            ? `lake root ${root}`
            : `lake '${lake}' root ${root}`;
    return (
        `note: ${subject} does not exist — it is ignored until it does. ` +
        "A missing root is not an error."
    );
}

/**
 * The environment notes for a lake root: missing, or unversioned. An absent
 * root is flagged but tolerated; an unversioned root still works — dates fall
 * back to file mtimes and the knowledge has no history — so it is surfaced,
 * not refused.
 * @param root The lake root to probe.
 * @param lake The lake name, when known.
 * @returns The note lines; empty when the root is present and version-controlled.
 */
export function unversionedNote(
    root: string,
    lake?: string,
): readonly string[] {
    if (!existsSync(root)) {
        return [missingRootNote(root, lake)];
    }
    const probe = spawnSync(
        "git", // NOSONAR: portable git lookup; cwd is trusted local config.
        ["rev-parse", "--show-toplevel"],
        { cwd: root },
    );
    if (probe.status === 0) {
        return [];
    }
    return [
        "note: the lake root is not inside a git work tree — dates fall " +
            "back to file mtimes and the knowledge has no history. Put the " +
            "root under version control to fix both.",
    ];
}

/** The registered tool names that count as using the lake. */
