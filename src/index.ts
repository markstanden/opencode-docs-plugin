import { Plugin, Skill } from "@opencode/plugin";
import { AbsolutePath } from "@opencode/schema/schema";
import { createHash } from "node:crypto";
import type {
    CommandDefinition,
    CommandInvocation,
} from "@opencode/plugin/promise/command";
import type { Info, Result } from "@opencode/plugin/promise/tool";
import { spawnSync } from "node:child_process";
import {
    closeSync,
    type Dirent,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { homedir } from "node:os";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    normalize,
    relative,
    sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

/**
 * V2 docs plugin.
 *
 * Registers a model-callable `docs` tool so the agent can discover the
 * knowledge lakes mid-task. The lakes are configurable (`lakes`, `lakesFile`,
 * or the single-lake `root` sugar; default `<location>/docs`): a blank search
 * returns the most recently changed docs (`path — Area — date — Summary`), a
 * search ranks the docs by how well their front-matter, path and body
 * identifiers match, falling back to the closest matches rather than a dead
 * end. `add` writes knowledge, `check` validates the knowledge lakes. Reading
 * a matched doc stays the built-in `read` for project files; the tool's own
 * `read` serves lake docs and wiki pages.
 *
 * Everything below the default export is pure or dependency-injected so it can
 * be exercised directly against Node's built-in test runner without OpenCode.
 */

/** The doc classes the plugin serves. `instructions` is the implicit README source. */
export type DocClass = "instructions" | "repo" | "machine" | "global" | "wiki";

/** The shape of a content revision: SHA-256, hex-encoded. */
export const REVISION_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A doc's content revision: the SHA-256 of the exact stored UTF-8 bytes,
 * front-matter and newline bytes included. It represents the bytes, not an
 * edit history — the same bytes hash to the same revision — and it is never
 * persisted into the doc.
 * @param raw The exact file contents.
 * @returns The hex digest.
 */
export function revisionOf(raw: string): string {
    return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** The classes that can be a configured lake. */
export type LakeClass = Exclude<DocClass, "instructions">;

/** The two writing conventions a lake can use. */
export type LakeProfile = "knowledge" | "wiki";

/** One knowledge doc, as the tool sees it. */
export interface DocEntry {
    /** Root-relative path, e.g. `decisions/choose-a-queue.md`. */
    path: string;
    /** The lake name; empty for a project README (the instructions source). */
    lake: string;
    /** The source class. */
    class: DocClass;
    /** Front-matter `Area`, else the first path segment under the root. */
    area: string;
    /** Resolved at read time: last git commit, else file mtime. Never front-matter. */
    date: string;
    /** First `# ` heading in the body, else the file name. */
    title: string;
    /** Front-matter `Summary`, else the wiki's first prose paragraph, else "". */
    summary: string;
    /** Front-matter `Keywords`, split on commas and trimmed. */
    keywords: readonly string[];
    /** Body H2/H3 headings plus inline `code` spans, trimmed and de-duplicated. */
    identifiers: readonly string[];
    /** Wiki prose and table text; empty for knowledge docs and READMEs. */
    text: string;
}

/**
 * The `docs` tool's input. The field annotation is a description the host turns
 * into JSON Schema, so the model sees how to call the tool. The typed DTOs
 * below derive from it, so the contract has one source.
 */
export const DOCS_INPUT = Schema.Struct({
    search: Schema.optional(
        Schema.String.annotate({
            description:
                "Case-insensitive search over title, path, keywords, headings, code spans, area, summary and wiki prose. Blank lists recent docs; a partial match returns the closest.",
        }),
    ),
    lake: Schema.optional(
        Schema.String.annotate({
            description:
                "Optional lake name: search and check are limited to it; read and add target it. Omit to search or read the unique match; add writes the sole writable lake, refusing with candidates otherwise.",
        }),
    ),
    add: Schema.optional(
        Schema.Struct({
            mode: Schema.Literals(["create", "replace"]).annotate({
                description:
                    "Required: create (a new doc; never overwrites) or replace (wholesale-replaces the doc at path).",
            }),
            path: Schema.optional(
                Schema.String.annotate({
                    description:
                        "create: optional; derived from Area and the H1 when omitted. replace: required; the doc to replace.",
                }),
            ),
            allowNearTwinReason: Schema.optional(
                Schema.String.annotate({
                    description:
                        "create only: non-blank reason to write despite a same-area near-twin; bypasses only that guard.",
                }),
            ),
            expectedRevision: Schema.optional(
                Schema.String.annotate({
                    description:
                        "replace only: the revision token from your last read or write; stale or missing refuses.",
                }),
            ),
            metadata: Schema.Struct({
                Area: Schema.String,
                Keywords: Schema.Array(Schema.String),
                Summary: Schema.String,
            }).annotate({
                description:
                    "Front-matter metadata, serialised; all three required, never blank.",
            }),
            body: Schema.String.annotate({
                description:
                    "Markdown body: an H1 title plus a claim section as an H2/H3 — Facts, Inferred, Tested, Failed approaches, Open questions.",
            }),
        }).annotate({
            description:
                "create: the target must not exist; explicit paths get the same checks as derived ones. replace: path names an existing doc whose bytes must match expectedRevision — never creates. Refused: blank metadata, traversal, a non-.md or symlinked target, no claim section, unreconciled near-twins. Wiki lakes are read-only.",
        }),
    ),
    check: Schema.optional(
        Schema.Boolean.annotate({
            description:
                "Validate knowledge docs: front-matter, an H1, a claim section, no hand-maintained Date, a distinctive identity, near-twins, broken relative links, a soft length note. Only writable knowledge lakes are validated; skipped lakes are named.",
        }),
    ),
    read: Schema.optional(
        Schema.String.annotate({
            description:
                "Root-relative path, or `lake:path`: the doc verbatim. Lake and wiki pages only; project READMEs use the built-in `read` tool. Knowledge reads end with a revision line, the replace token.",
        }),
    ),
});

/**
 * The `docs` tool's input, derived from {@link DOCS_INPUT} so the schema is the
 * one source and the implementation cannot drift from the model-facing
 * contract.
 */
export type DocsInput = Schema.Schema.Type<typeof DOCS_INPUT>;

/**
 * The `add` mode's typed DTO: the single writer's whole input. `mode` picks
 * the contract: `create` derives `<Area>/<slug>.md` from the H1 unless an
 * explicit `path` is given, and never overwrites; `replace` requires the
 * `path` of an existing doc and replaces it wholesale.
 */
export type DocsAdd = NonNullable<DocsInput["add"]>;

/** The two mutation modes of {@link DocsAdd}. */
export type AddMode = DocsAdd["mode"];

/** The typed metadata of a knowledge doc, serialised to front-matter. */
export type DocMetadata = DocsAdd["metadata"];

/** Top-level directories under the root the tool ignores: scratch and mirrors. */
export const EXCLUDED_AREAS = ["plans", "requirements", "wiki"] as const;

/**
 * Split a doc into its YAML front-matter key/values and body. Flat `Key: value`
 * lines only — enough for the doc schema, so no YAML parser.
 * @param raw Full file contents.
 * @returns Parsed metadata and the body after the closing `---`.
 */
export function parseFrontMatter(raw: string): {
    meta: Record<string, string>;
    body: string;
} {
    if (!raw.startsWith("---\n")) {
        return { meta: {}, body: raw };
    }
    const end = raw.indexOf("\n---", 4);
    if (end === -1) {
        return { meta: {}, body: raw };
    }
    const meta: Record<string, string> = {};
    for (const line of raw.slice(4, end).split("\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) {
            continue;
        }
        const key = line.slice(0, colon).trim();
        if (key !== "") {
            meta[key] = line.slice(colon + 1).trim();
        }
    }
    return { meta, body: raw.slice(end + 4).replace(/^\n+/, "") };
}

/**
 * The front-matter fields in canonical order, and whether `add` requires
 * them. The single source shared by serialisation ({@link serializeDoc},
 * order) and the `check` validation to come (requiredness).
 */
export const FRONT_MATTER_FIELDS = [
    { name: "Area", required: true },
    { name: "Keywords", required: true },
    { name: "Summary", required: true },
] as const;

/**
 * Serialise a doc: front-matter from the metadata in
 * {@link FRONT_MATTER_FIELDS} order (the `Date` is derived by git, never
 * written), then the body.
 * @param metadata The typed metadata; `Keywords` joins into the comma form.
 * @param body Markdown body; a single trailing newline is ensured.
 * @returns The full file contents to write.
 */
export function serializeDoc(metadata: DocMetadata, body: string): string {
    const lines = FRONT_MATTER_FIELDS.map(({ name }) => {
        const value = metadata[name];
        const text = Array.isArray(value) ? value.join(", ") : value;
        return `${name}: ${text}`;
    });
    return `---\n${lines.join("\n")}\n---\n\n${body.replace(/(?<!\n)\n+$/, "")}\n`;
}

/**
 * The doc's H1 text: the first `# ` heading's body, trimmed. The one H1
 * detector, shared by {@link titleOf}, the `add` guard and the `check` rule.
 * @param body Doc body (front-matter already stripped).
 * @returns The heading text, or undefined when the body carries no H1.
 */
function h1Of(body: string): string | undefined {
    const heading = body.split("\n").find((line) => line.startsWith("# "));
    return heading?.slice(2).trim();
}

/**
 * The doc's title: its {@link h1Of} heading, else the file name without `.md`.
 * @param path Repo-relative doc path.
 * @param body Doc body (front-matter already stripped).
 * @returns Display title.
 */
export function titleOf(path: string, body: string): string {
    const heading = h1Of(body);
    if (heading !== undefined) {
        return heading;
    }
    const base = path.split("/").pop() ?? path;
    return base.replace(/\.md$/, "");
}

/** Split a front-matter `Keywords` value into trimmed, non-empty terms. */
function splitKeywords(value: string): string[] {
    return value
        .split(",")
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword !== "");
}

/**
 * An open fenced code block: the opener's delimiter character and run length.
 * The length and character are remembered so a shorter or different-character
 * run inside the block cannot close it.
 */
interface Fence {
    readonly char: "`" | "~";
    readonly length: number;
}

/**
 * The supported Markdown fence subset: a backtick or tilde run of three or
 * more, indented by at most three spaces. A backtick opener's info string may
 * not contain a backtick. Four-space indentation is an indented code block, not
 * a fence, and is not modelled; nor are tab-indented fences or the full
 * CommonMark block grammar.
 * @param line One source line.
 * @returns The opened fence, or null when the line is not an opener.
 */
function fenceOpener(line: string): Fence | null {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match === null) {
        return null;
    }
    const run = match[1] ?? "";
    const info = line.slice(match[0].length);
    const char = run[0] as Fence["char"];
    if (char === "`" && info.includes("`")) {
        return null;
    }
    return { char, length: run.length };
}

/**
 * Whether a line closes `fence`: the same delimiter character, a run at least
 * as long as the opener, and nothing after it but spaces or tabs.
 * @param line One source line.
 * @param fence The open fence.
 * @returns True when the line closes the block.
 */
function closesFence(line: string, fence: Fence): boolean {
    const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (match === null) {
        return false;
    }
    const run = match[1] ?? "";
    return run.startsWith(fence.char) && run.length >= fence.length;
}

/**
 * The body's lines outside fenced code blocks, fence delimiters included in
 * neither. An unclosed fence keeps every remaining line inside the block.
 * @param body Doc body, front-matter already stripped.
 * @returns Source lines with fenced blocks removed.
 */
function outsideFenceLines(body: string): string[] {
    const lines: string[] = [];
    let fence: Fence | null = null;
    for (const line of body.split("\n")) {
        if (fence === null) {
            const opener = fenceOpener(line);
            if (opener !== null) {
                fence = opener;
                continue;
            }
            lines.push(line);
        } else if (closesFence(line, fence)) {
            fence = null;
        }
    }
    return lines;
}

/** Drop an ATX heading's trailing `#` decoration (and any trailing spaces). */
function stripTrailingHashes(text: string): string {
    return text.replace(/(?<![ #])[ #]+$/, "");
}

/** The body's indexable pieces, from one fence-aware walk of the source. */
interface BodyScan {
    /** H2/H3 heading texts, trimmed, in first-seen order. */
    readonly headings: string[];
    /** Inline `` `code` `` span texts, trimmed, in first-seen order. */
    readonly spans: string[];
}

/**
 * One fence-aware walk of a doc body, yielding the H2/H3 heading texts and the
 * inline `` `code` `` span texts — the one scanner behind search indexing
 * ({@link identifiersOf}) and the `check` claim-section rule
 * ({@link validateDoc}).
 * @param body Doc body, front-matter already stripped.
 * @returns The headings and code spans found outside fenced code blocks.
 */
function scanBody(body: string): BodyScan {
    const headings: string[] = [];
    const spans: string[] = [];
    for (const line of outsideFenceLines(body)) {
        const heading = /^(#{2,3})\s+/.exec(line);
        if (heading !== null) {
            const text = stripTrailingHashes(
                line.slice(heading[0].length).replaceAll("`", ""),
            ).trim();
            if (text !== "") {
                headings.push(text);
            }
        }
        for (const span of line.matchAll(/`([^`]+)`/g)) {
            const text = (span[1] ?? "").trim();
            if (text !== "") {
                spans.push(text);
            }
        }
    }
    return { headings, spans };
}

/**
 * The body's indexable identifiers: H2/H3 heading texts plus inline `` `code` ``
 * spans, trimmed and de-duplicated in first-seen order (headings first). Fenced
 * code blocks and free prose are skipped — a fence merely repeats imports and
 * usage, and long prose admits the noise the closest-match gate exists to keep
 * out (2026-10-10).
 * @param body Doc body, front-matter already stripped; both lists come from
 * {@link scanBody}.
 * @returns The identifiers to index.
 */
export function identifiersOf(body: string): string[] {
    const { headings, spans } = scanBody(body);
    return [...new Set([...headings, ...spans])];
}

/** The text inside inline links, dropping the URL; manual scan keeps it linear. */
function stripInlineLinks(text: string): string {
    let result = "";
    let index = 0;
    while (index < text.length) {
        if (text[index] === "[" && text[index - 1] !== "!") {
            const close = text.indexOf("](", index + 1);
            if (close !== -1) {
                const end = text.indexOf(")", close + 2);
                if (end !== -1) {
                    result += text.slice(index + 1, close);
                    index = end + 1;
                    continue;
                }
            }
        }
        result += text[index];
        index += 1;
    }
    return result;
}

/** Strip inline Markdown from a prose fragment: links keep their text, code keeps its content. */
function plainProse(text: string): string {
    return stripInlineLinks(text)
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/(?<!_)_([^_]+)_(?!_)/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

/** The body with fenced code blocks removed. */
function withoutFences(body: string): string {
    return outsideFenceLines(body).join("\n");
}

/** Block prefixes that are never a wiki summary. */
const SUMMARY_SKIP_PREFIXES = ["#", "|", ">", "<", "---", ":::", "!["] as const;

/** Whether a blank-line-separated block is prose worth summarising. */
function isSummaryBlock(block: string): boolean {
    const trimmed = block.trim();
    if (trimmed === "" || trimmed.startsWith("[![")) {
        return false;
    }
    if (SUMMARY_SKIP_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
        return false;
    }
    if (/^([-*+]|\d+\.)\s/.test(trimmed)) {
        return false;
    }
    return plainProse(trimmed) !== "";
}

/** The wiki summary: the first prose paragraph after the H1, capped. */
export function summaryOf(body: string): string {
    const text = withoutFences(body);
    const heading = text.indexOf("# ");
    if (heading === -1) {
        return "";
    }
    const lineEnd = text.indexOf("\n", heading);
    const after = lineEnd === -1 ? "" : text.slice(lineEnd + 1);
    for (const block of after.split(/\n\s*\n/)) {
        if (isSummaryBlock(block)) {
            return plainProse(block).slice(0, 240);
        }
    }
    return "";
}

/** The indexable wiki prose: the whole body, front-matter already stripped. */
export function proseOf(body: string): string {
    return body;
}

/** The doc's area: front-matter `Area`, else the first path segment. */
function areaOf(meta: Record<string, string>, path: string): string {
    if (meta.Area !== undefined) {
        return meta.Area;
    }
    const segments = path.split("/");
    return segments.length > 1 ? (segments[0] ?? "") : "";
}

/** The doc's summary: front-matter, else a derived wiki paragraph, else "". */
function summaryFor(
    meta: Record<string, string>,
    body: string,
    profile: LakeProfile,
): string {
    if (meta.Summary !== undefined) {
        return meta.Summary;
    }
    return profile === "wiki" ? summaryOf(body) : "";
}

/**
 * Build a doc entry from its path, raw contents and the date to show.
 * @param path Repo-relative doc path.
 * @param raw Full file contents.
 * @param date The resolved date (last git commit, else file mtime). Front-matter
 * `Date` is deliberately ignored — the date is derived, never hand-maintained.
 * @param options The source lake/class and the profile's indexing rules.
 * @param options.lake The lake name stamped on the entry.
 * @param options.class The source class stamped on the entry.
 * @param options.profile The writing convention; `wiki` derives prose and summary.
 * @returns The entry the tool ranks and renders.
 */
export function toEntry(
    path: string,
    raw: string,
    date: string,
    options: {
        lake?: string;
        class?: DocClass;
        profile?: LakeProfile;
    } = {},
): DocEntry {
    const {
        lake = "",
        class: docClass = "repo",
        profile = "knowledge",
    } = options;
    const { meta, body } = parseFrontMatter(raw);
    return {
        path,
        lake,
        class: docClass,
        area: areaOf(meta, path),
        date,
        title: titleOf(path, body),
        summary: summaryFor(meta, body, profile),
        keywords: splitKeywords(meta.Keywords ?? ""),
        identifiers: identifiersOf(body),
        text: profile === "wiki" ? proseOf(body) : "",
    };
}

/**
 * Shortest query term that still counts as a match. Shorter terms are usually
 * filler (`to`, `a`, `of`) that appear in nearly every Summary, dragging the
 * whole catalogue into the closest-match fallback; dropping them keeps the
 * fallback meaningful. A query made only of short terms is searched as typed.
 * The single knob for `matches` and `score` alike — tune here.
 */
export const MIN_TERM_LENGTH = 3;

/**
 * The most docs any call returns — the blank catalogue, full matches and the
 * closest-match fallback alike, with the cut reported as `omitted`. An agent
 * needing the full inventory can list the tree itself. The single knob for the
 * cap — tune here.
 */
export const MAX_RESULTS = 10;

/**
 * The most characters a `check` report returns before it is truncated with an
 * `and N more` tail. A finding-heavy run once returned 39,871 characters in one
 * tool result; the cap keeps a report readable. The single knob for the cap.
 */
export const MAX_CHECK_CHARS = 8000;

/** Split a raw query into lower-cased, non-empty terms, dropping filler. */
function termsOf(query: string): string[] {
    const terms = query
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term !== "");
    const kept = terms.filter((term) => term.length >= MIN_TERM_LENGTH);
    return kept.length > 0 ? kept : terms;
}

/**
 * Whether a doc matches the query. A blank query matches everything; otherwise
 * every kept term (see {@link MIN_TERM_LENGTH}) must appear
 * case-insensitively in the doc's searchable text.
 * @param entry Doc to test.
 * @param query Raw query text.
 * @returns True when the doc should be listed.
 */
export function matches(entry: DocEntry, query: string): boolean {
    const terms = termsOf(query);
    if (terms.length === 0) {
        return true;
    }
    const haystack = [
        entry.path,
        entry.area,
        entry.title,
        entry.summary,
        entry.text,
        ...entry.keywords,
        ...entry.identifiers,
    ]
        .join("\n")
        .toLowerCase();
    return terms.every((term) => haystack.includes(term));
}

/**
 * Field weights, most significant first. Each term scores its best field hit
 * as `weight × quality` (see {@link QUALITY}) — multiplicative, so an exact
 * keyword (4×4=16) beats a substring title (6×2=12). The single source of the
 * weights — dial here.
 */
export const FIELD_WEIGHTS = {
    title: 6,
    path: 5,
    keywords: 4,
    identifiers: 3,
    area: 2,
    summary: 1,
    text: 1,
} as const;

/** The weighted searchable fields, weights from {@link FIELD_WEIGHTS}. */
const FIELDS: ReadonlyArray<
    readonly [weight: number, values: (entry: DocEntry) => readonly string[]]
> = [
    [FIELD_WEIGHTS.title, (entry) => [entry.title]],
    [FIELD_WEIGHTS.path, (entry) => [entry.path]],
    [FIELD_WEIGHTS.keywords, (entry) => entry.keywords],
    [FIELD_WEIGHTS.identifiers, (entry) => entry.identifiers],
    [FIELD_WEIGHTS.area, (entry) => [entry.area]],
    [FIELD_WEIGHTS.summary, (entry) => [entry.summary]],
    [FIELD_WEIGHTS.text, (entry) => [entry.text]],
];

/**
 * How well one term hits one field: exact beats prefix beats substring; `miss`
 * is no hit. Deliberately no subsequence pass — a lone subsequence matched
 * nearly every Summary, so the closest-match fallback dumped the catalogue
 * (2026-10-10). The single source of the qualities — dial here.
 */
export const QUALITY = {
    exact: 4,
    prefix: 3,
    substring: 2,
    miss: 0,
} as const;

function quality(term: string, text: string): number {
    const haystack = text.toLowerCase();
    if (haystack === term) {
        return QUALITY.exact;
    }
    if (haystack.startsWith(term)) {
        return QUALITY.prefix;
    }
    return haystack.includes(term) ? QUALITY.substring : QUALITY.miss;
}

/**
 * Rank a doc against a query's terms: the sum over terms of the best
 * weighted field hit. Higher is a better match; `0` means every term missed.
 * @param entry Doc to score.
 * @param terms Lower-cased query terms.
 * @returns The doc's score.
 */
export function score(entry: DocEntry, terms: readonly string[]): number {
    let total = 0;
    for (const term of terms) {
        let best = 0;
        for (const [weight, values] of FIELDS) {
            for (const text of values(entry)) {
                best = Math.max(best, weight * quality(term, text));
            }
        }
        total += best;
    }
    return total;
}

/** The ranked search result: the docs to show, and whether they are a fallback. */
export interface RankedDocs {
    /** Docs to show, best match first, at most {@link MAX_RESULTS} of them. */
    entries: DocEntry[];
    /** True when no doc had every term, so these are the closest matches. */
    closest: boolean;
    /** Docs cut by the {@link MAX_RESULTS} cap. */
    omitted: number;
}

/**
 * Class precedence when scores tie. Narrow, local, vetted first.
 * The single source of the order — dial here.
 */
export const CLASS_RANK: Readonly<Record<DocClass, number>> = {
    repo: 0,
    instructions: 1,
    global: 2,
    machine: 3,
    wiki: 4,
};

/**
 * How many results each source reserves in the first pass, so a broad wiki
 * cannot bury a focused repo doc. A reservation, not a cap: unused slots are
 * filled by score. `0` disables reservation. The single knob — tune here.
 */
export const DEFAULT_PER_LAKE_QUOTA = 3;

/** The reservation key: a lake name, or the implicit instructions source. */
function sourceKey(entry: DocEntry): string {
    return entry.lake === "" ? "instructions" : entry.lake;
}

/**
 * Most recently changed first, then class precedence, then path ascending;
 * an empty date is oldest.
 */
function byRecency(a: DocEntry, b: DocEntry): number {
    return (
        b.date.localeCompare(a.date) ||
        CLASS_RANK[a.class] - CLASS_RANK[b.class] ||
        a.path.localeCompare(b.path)
    );
}

/**
 * Cut a ranked list to {@link MAX_RESULTS}, reporting what did not fit.
 * @param entries Docs in their final display order.
 * @returns The shown entries and the omitted count.
 */
function capped(entries: DocEntry[]): Pick<RankedDocs, "entries" | "omitted"> {
    return {
        entries: entries.slice(0, MAX_RESULTS),
        omitted: Math.max(0, entries.length - MAX_RESULTS),
    };
}

/**
 * Fill the result cap with a per-source reservation first, then the best
 * leftovers. This keeps every configured source visible without hard-capping a
 * single-lake tree.
 * @param entries Docs in ranked order.
 * @param quota Results reserved per source; `0` disables reservation.
 * @returns The shown entries and the omitted count.
 */
function reserved(
    entries: DocEntry[],
    quota: number,
): Pick<RankedDocs, "entries" | "omitted"> {
    if (quota <= 0) {
        return capped(entries);
    }
    const first: DocEntry[] = [];
    const rest: DocEntry[] = [];
    const counts = new Map<string, number>();
    for (const entry of entries) {
        const key = sourceKey(entry);
        const seen = counts.get(key) ?? 0;
        if (seen < quota) {
            counts.set(key, seen + 1);
            first.push(entry);
        } else {
            rest.push(entry);
        }
    }
    return capped([...first, ...rest]);
}

/**
 * Sort by score, best first, then class precedence, then recency, then the
 * stable path order. Each doc is scored once into the decorated list — the
 * comparator sorts on precomputed points instead of re-scoring every
 * comparison.
 */
function byScore(
    entries: readonly DocEntry[],
    terms: readonly string[],
): DocEntry[] {
    return [...entries]
        .map((doc) => ({ doc, points: score(doc, terms) }))
        .sort(
            (a, b) =>
                b.points - a.points ||
                CLASS_RANK[a.doc.class] - CLASS_RANK[b.doc.class] ||
                b.doc.date.localeCompare(a.doc.date) ||
                a.doc.path.localeCompare(b.doc.path),
        )
        .map(({ doc }) => doc);
}

/**
 * Rank the docs for a query. A blank query returns the most recently changed
 * docs as the catalogue; a query that some doc satisfies fully returns those
 * docs ranked; otherwise it falls back to the docs that match any term as a
 * substring, ranked, flagged `closest`. Every outcome reserves
 * {@link DEFAULT_PER_LAKE_QUOTA} results per source, caps at
 * {@link MAX_RESULTS} and reports the cut as `omitted`.
 * @param entries Docs to rank, already path-ordered.
 * @param query Raw query text.
 * @param options Ranking options.
 * @param options.perLakeQuota Results reserved per source; `0` disables.
 * @returns The docs to show, the fallback flag, and the omitted count.
 */
export function rankDocs(
    entries: readonly DocEntry[],
    query: string,
    options: { perLakeQuota?: number } = {},
): RankedDocs {
    const quota = options.perLakeQuota ?? DEFAULT_PER_LAKE_QUOTA;
    const terms = termsOf(query);
    if (terms.length === 0) {
        return {
            ...reserved([...entries].sort(byRecency), quota),
            closest: false,
        };
    }
    const full = entries.filter((entry) => matches(entry, query));
    if (full.length > 0) {
        return { ...reserved(byScore(full, terms), quota), closest: false };
    }
    const partial = entries.filter((entry) => score(entry, terms) > 0);
    return {
        ...reserved(byScore(partial, terms), quota),
        closest: partial.length > 0,
    };
}

/** The provenance prefix for a result: instructions, non-primary lake, or none. */
function resultPrefix(
    entry: DocEntry,
    primaryLake: string | undefined,
): string {
    if (entry.class === "instructions") {
        return "instructions";
    }
    if (entry.lake !== "" && entry.lake !== primaryLake) {
        return entry.lake;
    }
    return "";
}

/**
 * Render matched docs as `path — Area — date` lines with the summary indented
 * beneath; a non-primary lake is prefixed `lake:` so provenance is clear. A
 * closest-match fallback set is labelled; a cap cut is counted in a trailing
 * note; nothing matched is stated plainly.
 * @param entries Docs to render, already ranked and capped.
 * @param options Render options.
 * @param options.closest True when the entries are a closest-match fallback.
 * @param options.omitted Docs cut by the cap, shown as a trailing note.
 * @param options.primaryLake The lake rendered without a prefix (the local repo).
 * @returns The tool's text result.
 */
export function render(
    entries: readonly DocEntry[],
    options: {
        closest?: boolean;
        omitted?: number;
        primaryLake?: string;
    } = {},
): string {
    if (entries.length === 0) {
        return "No knowledge docs matched.";
    }
    const body = entries
        .map((entry) => {
            const parts = [entry.area, entry.date].filter(
                (part) => part !== "",
            );
            const meta = parts.join(" — ");
            const head = meta === "" ? entry.path : `${entry.path} — ${meta}`;
            const prefix = resultPrefix(entry, options.primaryLake);
            const labelled = prefix === "" ? head : `${prefix}:${head}`;
            return entry.summary === ""
                ? labelled
                : `${labelled}\n  ${entry.summary}`;
        })
        .join("\n");
    const headed = options.closest
        ? `Closest matches (no doc had every term):\n\n${body}`
        : body;
    const omitted = options.omitted ?? 0;
    return omitted > 0
        ? `${headed}\n\n… and ${omitted} more not shown.`
        : headed;
}

/**
 * Whether a query asks for help rather than a search: exactly `help`, trimmed
 * and case-insensitive. Accepted trade-off: a doc titled or keyworded `help`
 * is not reachable by that lone term (the blank catalogue still lists it).
 * @param query Raw query text.
 * @returns True when the call should answer with {@link explainRanking}.
 */
export function isHelp(query: string): boolean {
    return query.trim().toLowerCase() === "help";
}

/**
 * Explain the ranking in plain text: the field weights, the hit qualities,
 * the knobs, the four call outcomes, and that the shared `docs/` prefix is
 * not searched. Values come from the consts, so the text tracks the dials.
 * @returns The help text.
 */
export function explainRanking(): string {
    return [
        "How docs search ranks:",
        `- Fields weighted: title ${FIELD_WEIGHTS.title} > path ${FIELD_WEIGHTS.path} > keywords ${FIELD_WEIGHTS.keywords} > identifiers ${FIELD_WEIGHTS.identifiers} > area ${FIELD_WEIGHTS.area} > summary ${FIELD_WEIGHTS.summary} > wiki prose ${FIELD_WEIGHTS.text}.`,
        `- Each term scores its best field as weight × quality; quality is exact > prefix > substring.`,
        `- Terms shorter than MIN_TERM_LENGTH (${MIN_TERM_LENGTH}) are dropped when longer terms exist; otherwise all query terms are kept.`,
        "- Search covers every configured lake and nested project `README.md` files, honouring `.gitignore` (dependency and build directories are skipped when the project is not in git). READMEs are searchable only: `add` and `check` ignore them, and their results are prefixed `instructions:` so they read with the built-in `read` tool.",
        `- Each source reserves up to ${DEFAULT_PER_LAKE_QUOTA} results (configurable), then leftover slots fill by score. Every call returns at most MAX_RESULTS (${MAX_RESULTS}), best matches first, then the most recently edited; anything cut is counted as "… and N more not shown."`,
        "- Class precedence on a tie: repo > instructions > global > machine > wiki.",
        '- Outcomes: a blank query lists the most recently changed docs; a doc carrying every term ranks the full matches; otherwise the docs matching any term as a substring are listed under "Closest matches"; nothing hits is "No knowledge docs matched."',
    ].join("\n");
}

/** One configured lake, as the help text describes it. */
export interface LakeInfo {
    /** The lake's addressing name. */
    name: string;
    /** The source class. */
    class: DocClass;
    /** The absolute lake root. */
    root: string;
    /** Whether `add` may write to it. */
    writable: boolean;
    /** Whether `check` validates it. */
    validated: boolean;
    /** Whether the root is absent, so the lake contributes nothing yet. */
    missing?: boolean;
    /** What belongs there, as configured; absent lakes use the class guidance. */
    description?: string;
}

/**
 * Describe the configured lakes, then the ranking. The agent learns where
 * knowledge lives without loading the full convention. Each line pairs the
 * human scope label with its config value, and carries the lake's description
 * (or the class guidance) so a write destination is chosen deliberately.
 * @param lakes The configured lakes.
 * @returns The help text.
 */
export function helpText(lakes: readonly LakeInfo[]): string {
    const lines = ["Configured lakes:"];
    for (const lake of lakes) {
        const access = lake.writable ? "writable" : "read-only";
        const checked = lake.validated ? "checked" : "not checked";
        const missing = lake.missing === true ? " — missing" : "";
        const label =
            lake.class in CLASS_LABELS
                ? `${CLASS_LABELS[lake.class as LakeClass]} [${lake.class}]`
                : lake.class;
        const description =
            lake.description ?? classGuidance(lake.class as LakeClass);
        lines.push(
            `- ${lake.name} (${label}, ${access}, ${checked}): ${lake.root}${missing}`,
        );
        lines.push(`  ${description}`);
    }
    lines.push(
        "- instructions (read-only, not checked): nested project README.md " +
            "files; results are prefixed `instructions:` and read with the " +
            "built-in read tool",
    );
    lines.push(
        "add writes to the sole writable knowledge lake when `lake` is " +
            "omitted; with several, pass lake — one of the names above.",
    );
    lines.push(
        "reads of knowledge docs end with a docs: revision line — pass its " +
            "hash as expectedRevision when replacing that doc.",
    );
    return `${lines.join("\n")}\n\n${explainRanking()}`;
}

/** A resolved `docs` tool call: exactly one verb wins (`add` > `check` > `read` > `help` > `search`). */
export type DocsRequest =
    | { verb: "add"; add: DocsAdd; lake?: string }
    | { verb: "check"; lake?: string }
    | { verb: "read"; read: string; lake?: string }
    | { verb: "help" }
    | { verb: "search"; search: string; lake?: string };

/** The trimmed lake selector, or undefined when unset. */
function lakeOf(input: DocsInput): string | undefined {
    const lake = input.lake?.trim() ?? "";
    return lake === "" ? undefined : lake;
}

/** Add a lake selector to a request when one was given. */
function requestWithLake<T extends object>(
    request: T,
    lake: string | undefined,
): T {
    return lake === undefined ? request : ({ ...request, lake } as T);
}

/**
 * Resolve a tool call to one verb. An explicit `add` is never downgraded; a
 * `check` outranks a read; a non-blank `read` outranks a search; a lone `help`
 * search explains the ranking; anything else searches.
 * @param input The raw tool input.
 * @param input.search The raw search text, when given.
 * @param input.add The typed add DTO, when given.
 * @param input.check The check flag, when given.
 * @param input.read The root-relative doc path (or `lake:path`) to read, when given.
 * @param input.lake The optional lake selector.
 * @returns The single resolved request.
 */
export function resolveRequest(input: DocsInput): DocsRequest {
    const lake = lakeOf(input);
    if (input.add !== undefined) {
        return requestWithLake({ verb: "add", add: input.add }, lake);
    }
    if (input.check === true) {
        return requestWithLake({ verb: "check" }, lake);
    }
    const read = input.read?.trim() ?? "";
    if (read !== "") {
        return requestWithLake({ verb: "read", read }, lake);
    }
    if (isHelp(input.search ?? "")) {
        return { verb: "help" };
    }
    return requestWithLake(
        { verb: "search", search: input.search ?? "" },
        lake,
    );
}

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

/**
 * Walk a lake root, returning its `.md` paths relative to the root. Dot
 * directories are skipped (which drops `.git` and `.attachments`), as are
 * symlinked directories and any other configured lake root nested inside.
 * Knowledge lakes also skip the scratch and mirror areas.
 * @param root The lake root.
 * @param options Collection rules.
 * @returns Root-relative paths, ordered by path.
 */
/** Read a directory, returning no entries when it is unreadable. */
function readDirectory(directory: string): Dirent[] {
    try {
        return readdirSync(directory, { withFileTypes: true });
    } catch {
        return [];
    }
}

/**
 * Whether a directory is outside the lake's collection rules.
 * @param item The directory entry.
 * @param directory Its parent directory.
 * @param root The lake root.
 * @param excluded Top-level areas the profile excludes.
 * @param nested Other lake roots nested inside this one.
 * @returns True when the walk should not enter it.
 */
function skipDirectory(
    item: Dirent,
    directory: string,
    root: string,
    excluded: readonly string[],
    nested: readonly string[],
): boolean {
    if (item.name.startsWith(".") || item.name === "node_modules") {
        return true;
    }
    if (item.isSymbolicLink()) {
        return true;
    }
    const path = join(directory, item.name);
    if (nested.some((other) => isUnder(path, other))) {
        return true;
    }
    return directory === root && excluded.includes(item.name);
}

/**
 * Code-unit string order, matching the default sort but stated explicitly.
 * @param a Left string.
 * @param b Right string.
 * @returns Negative, zero or positive in code-unit order.
 */
function compareText(a: string, b: string): number {
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
    const excluded =
        profile === "knowledge" ? (EXCLUDED_AREAS as readonly string[]) : [];
    const paths: string[] = [];
    const walk = (directory: string): void => {
        for (const item of readDirectory(directory)) {
            const path = join(directory, item.name);
            if (item.isDirectory()) {
                if (!skipDirectory(item, directory, root, excluded, nested)) {
                    walk(path);
                }
                continue;
            }
            if (
                !item.isFile() ||
                item.isSymbolicLink() ||
                !item.name.endsWith(".md")
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
function isUnder(path: string, root: string): boolean {
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
function realPathOf(path: string): string {
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
function isReadme(name: string): boolean {
    return name.toLowerCase() === "readme.md";
}

/**
 * The project's nested README paths, relative to `location`. Inside a git work
 * tree git supplies the list — tracked plus untracked, honouring `.gitignore` —
 * so dependency, build and scratch directories follow the project's own rules.
 * Outside one, a walk skips {@link README_EXCLUDED_DIRS} and dot-directories.
 * Paths under `skip` (the lake root) are dropped: they are already lake docs.
 * A tracked file deleted from disk is dropped too — git still lists it.
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
        .filter((path) => existsSync(join(location, path)))
        .filter(
            (path) => !skip.some((root) => isUnder(join(location, path), root)),
        )
        .sort(compareText);
}

/**
 * README paths from git's index and untracked non-ignored files, or undefined
 * when `location` is not inside a git work tree.
 */
function gitReadmePaths(location: string): string[] | undefined {
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
function walkedReadmePaths(location: string): string[] {
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
export function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|(?<!-)-+$/g, "");
}

/** The outcome of preparing an `add`: either a write or a refusal. */
export type AddOutcome =
    | {
          action: "write";
          /** The mutation mode the write follows. */
          mode: AddMode;
          /** Root-relative target. */
          path: string;
          /** The serialised file contents. */
          contents: string;
          /**
           * Same-area docs already on disk. Not rendered in the tool result —
           * the success path names the path and outcome only — but retained for
           * programmatic callers that want the surrounding context.
           */
          neighbours: readonly DocEntry[];
          /** Soft advisory lines (e.g. a long doc worth splitting). */
          notes: readonly string[];
      }
    | {
          action: "refuse";
          /** Why the write was refused; renders any candidates inline. */
          reason: string;
          /** Same-area near-twins, when the refusal is a reconcile hit. */
          candidates: readonly DocEntry[];
      };

/** The guardrails' refusal prefix — the DTO is the caller's to fix. */
const REFUSE = "Rejected:";

/** The first blank required front-matter field, else null. */
function blankRequiredField(metadata: DocMetadata): string | null {
    for (const { name } of FRONT_MATTER_FIELDS) {
        const value = metadata[name];
        const blank = Array.isArray(value)
            ? value.length === 0 ||
              value.some((keyword) => keyword.trim() === "")
            : typeof value === "string" && value.trim() === "";
        if (blank) {
            return name;
        }
    }
    return null;
}

/**
 * The mutation mode of an `add` request, guarded for direct core callers:
 * the typed schema requires `mode`, but nothing stops a JS caller bypassing
 * it, so the core refuses rather than guessing.
 * @param add The typed request, as delivered.
 * @returns The mode, or the refusal reason.
 */
function modeOf(add: DocsAdd): AddMode | { reason: string } {
    if (add.mode === "create" || add.mode === "replace") {
        return add.mode;
    }
    return {
        reason:
            'mode is required and must be "create" (write a new doc) or ' +
            '"replace" (wholesale-replace the doc at path).',
    };
}

/**
 * Whether a create's deliberate near-twin override is present: a non-blank,
 * non-empty explanation. It bypasses only the semantic near-twin guard, never
 * the structural checks or the target state.
 * @param add The typed request.
 * @returns True when the override may be used in this mode.
 */
function overrideGiven(add: DocsAdd): boolean {
    if (add.mode !== "create") {
        return false;
    }
    return (
        typeof add.allowNearTwinReason === "string" &&
        add.allowNearTwinReason.trim() !== ""
    );
}

/**
 * Validate an explicit `add` path: relative, inside the lake root, naming a
 * `.md` file.
 * @param given The trimmed, non-empty `path` the caller supplied.
 * @returns The root-relative target path, or the refusal reason.
 */
function explicitTarget(given: string): { path: string } | { reason: string } {
    if (
        given.startsWith("/") ||
        given.includes("..") ||
        given.includes("\\") ||
        given.includes(":")
    ) {
        return {
            reason: "path must be relative and stay inside the lake root.",
        };
    }
    if (!given.endsWith(".md")) {
        return { reason: "path must end in .md." };
    }
    const stem = given.slice(0, -".md".length);
    if (stem === "" || stem.endsWith("/")) {
        return { reason: "path must name a .md file under the lake root." };
    }
    return { path: given };
}

/**
 * The root-relative target path for an `add`, or the reason it is refused.
 * An explicit path must stay inside the lake root and name a `.md` file; a
 * create with no path derives `<Area>/<slug>.md` from the H1; a replace has
 * no path to derive — its `path` is required.
 * @param add The typed request.
 * @returns The target path, or the refusal reason.
 */
function targetOf(add: DocsAdd): { path: string } | { reason: string } {
    const given = add.path?.trim() ?? "";
    if (given !== "") {
        return explicitTarget(given);
    }
    if (add.mode === "replace") {
        return {
            reason: "replace requires the path of the existing doc to replace.",
        };
    }
    const slug = slugify(h1Of(add.body) ?? "");
    if (slug === "") {
        return { reason: "The H1 does not yield a usable file name." };
    }
    return { path: `${add.metadata.Area}/${slug}.md` };
}

/**
 * The identity terms of a doc: its H1 title and Keywords joined — the words
 * that must all hit a same-area doc for the two to be near-twins. The single
 * source shared by `add`'s {@link reconcileQuery} and `check`'s pairwise
 * report.
 * @param title The doc's H1 title.
 * @param keywords The doc's Keywords.
 * @returns The raw identity query.
 */
function identityQuery(title: string, keywords: readonly string[]): string {
    return [title, ...keywords].join(" ");
}

/**
 * Whether an identity query carries a term long enough to identify a doc — at
 * least one term of {@link MIN_TERM_LENGTH} or longer. The one
 * distinctive-identity rule, shared by `add`'s guard and `check`'s finding;
 * the two differ only in the message they raise.
 * @param query A doc's raw identity query ({@link identityQuery}).
 * @returns True when the identity is distinctive enough to search on.
 */
function hasDistinctiveIdentity(query: string): boolean {
    return termsOf(query).some((term) => term.length >= MIN_TERM_LENGTH);
}

/**
 * The near-twin query for an `add`: the H1 and the Keywords joined — the new
 * doc's own identity terms, searched against the existing tree. The Summary is
 * deliberately excluded: its filler dragged whole areas into the candidate
 * list (2026-10-10 dial-in). Dial-in seam: tests read this to show exactly
 * which words vote.
 * @param add The typed request.
 * @returns The raw reconcile query.
 */
export function reconcileQuery(add: DocsAdd): string {
    return identityQuery(h1Of(add.body) ?? "", add.metadata.Keywords);
}

/**
 * The one definition of a near-twin (2026-10-10 review): a same-area doc that
 * matches **every** identity term ({@link identityQuery} via
 * {@link matches}), ranked best first and capped at {@link MAX_RESULTS}.
 * `add` refuses on a non-empty result and `check` reports it pairwise — the
 * same rule, never re-derived.
 * @param query The raw identity query of the doc being reconciled.
 * @param area The area the twins must share.
 * @param entries The docs to test, already excluding the doc itself.
 * @returns The ranked near-twins.
 */
export function nearTwins(
    query: string,
    area: string,
    entries: readonly DocEntry[],
): DocEntry[] {
    return byScore(
        entries.filter((doc) => doc.area === area && matches(doc, query)),
        termsOf(query),
    ).slice(0, MAX_RESULTS);
}

/**
 * The near-twin refusal for a create, or null when the write may proceed.
 * Every create reconciles — derived and explicit paths alike — unless the
 * caller supplies a non-blank {@link DocsAdd.allowNearTwinReason}; replace is
 * the deliberate update contract and has no create guard.
 * @param add The typed request.
 * @param entries The current docs.
 * @returns The refusal, or null.
 */
function nearTwinRefusal(
    add: DocsAdd,
    entries: readonly DocEntry[],
): AddOutcome | null {
    if (add.mode !== "create" || overrideGiven(add)) {
        return null;
    }
    const nearTwinDocs = nearTwins(
        reconcileQuery(add),
        add.metadata.Area,
        entries,
    );
    if (nearTwinDocs.length === 0) {
        return null;
    }
    return {
        action: "refuse",
        reason:
            `${REFUSE} ${add.metadata.Area} already holds a near-twin of ` +
            'this doc. Pass its path with mode:"replace" to replace it, ' +
            "or a non-blank allowNearTwinReason to write a deliberate " +
            "distinct doc:\n\n" +
            render(nearTwinDocs),
        candidates: nearTwinDocs,
    };
}

/**
 * The refusal for a misused `allowNearTwinReason`, or null. Replace has no
 * near-twin guard, so the field is meaningless there; a create must explain
 * the override in non-blank prose.
 * @param add The typed request.
 * @returns The refusal reason, or null when the field is acceptable.
 */
function overrideRefusal(add: DocsAdd): string | null {
    if (add.allowNearTwinReason === undefined) {
        return null;
    }
    if (add.mode === "replace") {
        return (
            "allowNearTwinReason is create-only; replace has no " +
            "near-twin guard to bypass."
        );
    }
    if (
        typeof add.allowNearTwinReason !== "string" ||
        add.allowNearTwinReason.trim() === ""
    ) {
        return (
            "allowNearTwinReason must be a non-blank explanation of why " +
            "this doc is distinct from its near-twin."
        );
    }
    return null;
}

/**
 * The refusal for a misused `expectedRevision`, or null. Replace requires the
 * revision token of the doc being replaced — its stale-write guard; create
 * carries a not-exists precondition instead and rejects the field outright.
 * @param add The typed request.
 * @returns The refusal reason, or null when the field is acceptable.
 */
function revisionRefusal(add: DocsAdd): string | null {
    if (add.mode === "create") {
        return add.expectedRevision === undefined
            ? null
            : "expectedRevision is replace-only; a create's precondition is " +
                  "that the target does not exist.";
    }
    const given = add.expectedRevision?.trim() ?? "";
    if (given === "") {
        return (
            "replace requires expectedRevision — the revision returned with " +
            "your last read or write of the doc, so a stale whole-doc " +
            "replacement refuses instead of overwriting a newer edit."
        );
    }
    if (!REVISION_PATTERN.test(given)) {
        return (
            "expectedRevision must be the SHA-256 hex digest returned with " +
            "the doc you read; reread it and resubmit."
        );
    }
    return null;
}

/**
 * The refusal for DTO content a knowledge doc may not carry: blank required
 * metadata, an `Area` off the root, a missing `H1`, no claim section, or an
 * identity too weak to reconcile.
 * @param add The typed request.
 * @returns The refusal reason, or null when the content is acceptable.
 */
function contentRefusal(add: DocsAdd): string | null {
    const blank = blankRequiredField(add.metadata);
    if (blank !== null) {
        return `${blank} is required and must not be blank.`;
    }
    if (/[/\\]|\.\./.test(add.metadata.Area)) {
        return "Area must be a single folder name under the lake root.";
    }
    if (h1Of(add.body) === undefined) {
        return "The body must carry an H1 (`# Title`).";
    }
    // The same rule `check` applies, enforced before anything touches disk: a
    // doc that `check` would flag on the next run should never be written.
    if (!hasClaimSection(add.body)) {
        return (
            "the body carries no claim section; add an H2/H3 headed Facts, " +
            "Inferred, Tested, Failed approaches or Open questions."
        );
    }
    if (!hasDistinctiveIdentity(reconcileQuery(add))) {
        return (
            `the H1 and Keywords together carry no term of MIN_TERM_LENGTH ` +
            `(${MIN_TERM_LENGTH}) or longer; add a distinctive term so ` +
            "reconcile can tell this doc apart."
        );
    }
    return null;
}

/**
 * Validate an `add` request and prepare it for writing — pure, no fs.
 *
 * Trust boundary: the caller is a model. `mode` is required: `create` derives
 * the target from `Area` and the H1 unless an explicit `path` is given, and
 * reconciles against same-area near-twins either way; `replace` requires the
 * path of an existing doc. Blank required metadata, a body without an H1, a
 * path or `Area` escaping the lake root, a non-`.md` target and a title that
 * yields no slug are all refused. A same-area near-twin — a doc matching every
 * reconcile query term ({@link reconcileQuery}) — refuses a create unless a
 * non-blank `allowNearTwinReason` explains the deliberate distinct doc.
 * Target existence is the caller seam's to verify: creates must not overwrite
 * and replaces must exist.
 * @param add The typed request.
 * @param entries The current docs, for reconcile and neighbours.
 * @param options Soft-limit configuration.
 * @param options.maxDocLines Note when the body exceeds this line count; `0` disables.
 * @returns The prepared write, or the refusal.
 */
export function prepareAdd(
    add: DocsAdd,
    entries: readonly DocEntry[],
    options: { maxDocLines?: number } = {},
): AddOutcome {
    const refuse = (reason: string): AddOutcome => ({
        action: "refuse",
        reason: `${REFUSE} ${reason}`,
        candidates: [],
    });

    const mode = modeOf(add);
    if (typeof mode !== "string") {
        return refuse(mode.reason);
    }
    const override = overrideRefusal(add);
    if (override !== null) {
        return refuse(override);
    }
    const revision = revisionRefusal(add);
    if (revision !== null) {
        return refuse(revision);
    }
    const content = contentRefusal(add);
    if (content !== null) {
        return refuse(content);
    }
    const target = targetOf(add);
    if ("reason" in target) {
        return refuse(target.reason);
    }

    const nearTwin = nearTwinRefusal(add, entries);
    if (nearTwin !== null) {
        return nearTwin;
    }

    const neighbours = entries
        .filter(
            (doc) => doc.area === add.metadata.Area && doc.path !== target.path,
        )
        .slice(0, MAX_RESULTS);
    return {
        action: "write",
        mode,
        path: target.path,
        contents: serializeDoc(add.metadata, add.body),
        neighbours,
        notes: longDocNotes(add.body, options.maxDocLines),
    };
}

/** Default soft limit for a single doc's body, in lines. `0` disables the note. */
export const DEFAULT_MAX_DOC_LINES = 200;

/**
 * The soft length notes for a body: one note when it exceeds the configured
 * limit. A note only — the write always proceeds.
 * @param body Markdown body.
 * @param limit The configured line limit; `0` disables.
 * @returns Zero or one note.
 */
function longDocNotes(body: string, limit = DEFAULT_MAX_DOC_LINES): string[] {
    if (limit <= 0) {
        return [];
    }
    const lines = body.replace(/\n$/, "").split("\n").length;
    return lines > limit
        ? [
              `note: ${lines} body lines exceeds maxDocLines (${limit}); ` +
                  "consider splitting by topic or scope.",
          ]
        : [];
}

/** The claim sections a knowledge doc must carry at least one of. */
export const CLAIM_SECTIONS = [
    "Facts",
    "Inferred",
    "Tested",
    "Failed approaches",
    "Open questions",
] as const;

/**
 * Whether a body carries at least one recognisable claim section as an H2/H3
 * heading. This is the one rule {@link prepareAdd} and {@link validateDoc}
 * share, so `add` cannot accept a doc that `check` would immediately flag.
 *
 * It reads through {@link scanBody}, so a fenced code block or an inline code
 * span cannot masquerade as a section, and a `# H1` or `#### H4` does not
 * satisfy it.
 * @param body Markdown body, front-matter already stripped.
 * @returns True when a claim-section heading is present.
 */
export function hasClaimSection(body: string): boolean {
    const claims = new Set(
        CLAIM_SECTIONS.map((section) => section.toLowerCase()),
    );
    return scanBody(body).headings.some((heading) =>
        claims.has(heading.toLowerCase()),
    );
}

/**
 * The required front-matter fields that are blank in a raw doc: `Keywords` is
 * blank when it yields no terms (matching `add`'s typed rule in
 * {@link blankRequiredField} — `Keywords: , ,` is blank), the others when
 * missing or whitespace.
 * @param meta Parsed front-matter.
 * @returns The blank required field names, in canonical order.
 */
function blankMetaFields(meta: Record<string, string>): string[] {
    const blank = (name: string, value: string | undefined): boolean =>
        name === "Keywords"
            ? splitKeywords(value ?? "").length === 0
            : (value ?? "").trim() === "";
    return FRONT_MATTER_FIELDS.filter(({ name }) =>
        blank(name, meta[name]),
    ).map(({ name }) => name);
}

/**
 * Validate one doc's raw contents against the writing convention — pure, no
 * fs. Findings: a missing H1; blank required front-matter
 * ({@link FRONT_MATTER_FIELDS}); a hand-maintained `Date` (derived by git,
 * never written); none of the {@link CLAIM_SECTIONS} as an H2/H3 heading; and
 * the short-identity guard — an H1 and Keywords that between them carry no
 * term at {@link MIN_TERM_LENGTH} or longer. Near-twins are pairwise across
 * docs, so they are reported by {@link checkDocs}, not here.
 * @param path Repo-relative doc path (title fallback when the H1 is missing).
 * @param raw Full file contents.
 * @returns The findings; empty means the doc complies.
 */
export function validateDoc(path: string, raw: string): string[] {
    const { meta, body } = parseFrontMatter(raw);
    const findings: string[] = [];
    if (h1Of(body) === undefined) {
        findings.push("no H1 (`# Title`).");
    }
    for (const name of blankMetaFields(meta)) {
        findings.push(`${name} is required and must not be blank.`);
    }
    if (meta.Date !== undefined) {
        findings.push(
            "hand-maintained `Date` — the date is derived by git, never written.",
        );
    }
    if (!hasClaimSection(body)) {
        findings.push(
            "no claim section (Facts / Inferred / Tested / Failed approaches / Open questions).",
        );
    }
    const query = identityQuery(
        titleOf(path, body),
        splitKeywords(meta.Keywords ?? ""),
    );
    if (!hasDistinctiveIdentity(query)) {
        findings.push(
            `the H1 and Keywords carry no term of MIN_TERM_LENGTH ` +
                `(${MIN_TERM_LENGTH}) or longer.`,
        );
    }
    return findings;
}

/**
 * Every near-twin pair in the tree, one entry per pair even when both
 * directions of the {@link nearTwins} rule fire.
 * @param entries The docs to test.
 * @returns Path-ordered `[doc, twin]` pairs.
 */
function nearTwinPairs(
    entries: readonly DocEntry[],
): Array<[DocEntry, DocEntry]> {
    const pairs = new Map<string, [DocEntry, DocEntry]>();
    for (const doc of entries) {
        const query = identityQuery(doc.title, doc.keywords);
        const others = entries.filter((other) => other.path !== doc.path);
        for (const twin of nearTwins(query, doc.area, others)) {
            const key = [doc.path, twin.path].sort(compareText).join("\n");
            if (!pairs.has(key)) {
                pairs.set(key, [doc, twin]);
            }
        }
    }
    return [...pairs.values()];
}

/**
 * Resolve a relative Markdown link target against the linking doc's folder.
 * @param from The linking doc's root-relative path.
 * @param target The link target, anchors/query already stripped.
 * @returns The resolved root-relative path, or null when it escapes the root.
 */
function resolveLink(from: string, target: string): string | null {
    const base = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    const stack = base === "" ? [] : base.split("/");
    for (const segment of target.split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment === "..") {
            if (stack.length === 0) {
                return null;
            }
            stack.pop();
            continue;
        }
        stack.push(segment);
    }
    return stack.join("/");
}

/** An inline link's destination and the index of its closing `)`. */
interface InlineLink {
    readonly destination: string | undefined;
    readonly end: number;
}

/**
 * Parse an inline `[text](target)` link starting at `start`.
 * @param line One source line.
 * @param start Index of the opening `[`.
 * @returns The destination and closing index, or null when the link is incomplete.
 */
function inlineLinkAt(line: string, start: number): InlineLink | null {
    const close = line.indexOf("](", start + 1);
    if (close === -1) {
        return null;
    }
    const end = line.indexOf(")", close + 2);
    if (end === -1) {
        return null;
    }
    const destination = line
        .slice(close + 2, end)
        .trim()
        .split(/\s+/)[0];
    return { destination, end };
}

/** Inline `[text](target)` destinations on one line; images are skipped. */
function inlineTargets(line: string): string[] {
    const targets: string[] = [];
    let index = 0;
    while (index < line.length) {
        if (line[index] === "[" && line[index - 1] !== "!") {
            const link = inlineLinkAt(line, index);
            if (link !== null) {
                if (link.destination !== undefined && link.destination !== "") {
                    targets.push(link.destination);
                }
                index = link.end + 1;
                continue;
            }
        }
        index += 1;
    }
    return targets;
}

/**
 * The local `.md` link targets in a body: inline links and reference
 * definitions, fence-aware. Images, URLs, anchors and `lake:` links are
 * dropped by the caller.
 * @param body Markdown body, front-matter stripped.
 * @returns Targets in first-seen order.
 */
export function markdownTargets(body: string): string[] {
    const targets: string[] = [];
    for (const line of outsideFenceLines(body)) {
        targets.push(...inlineTargets(line));
        const reference = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(line);
        if (reference?.[1] !== undefined) {
            targets.push(reference[1]);
        }
    }
    return targets;
}

/** Whether a link target is external or otherwise outside the lake's concern. */
function isExternalTarget(target: string): boolean {
    return (
        target === "" ||
        target.startsWith("#") ||
        target.startsWith("//") ||
        target.startsWith("/") ||
        target.startsWith("lake:") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target)
    );
}

/**
 * The broken-link findings for one doc. Only relative `.md` targets that stay
 * inside the lake are checked; project links, URLs, anchors and images are
 * left alone.
 * @param path The doc's root-relative path.
 * @param raw Full file contents.
 * @param exists Whether a root-relative path exists in the lake.
 * @returns Findings for targets that do not resolve.
 */
export function linkFindings(
    path: string,
    raw: string,
    exists: (path: string) => boolean,
): string[] {
    const { body } = parseFrontMatter(raw);
    const findings: string[] = [];
    const seen = new Set<string>();
    for (const target of markdownTargets(body)) {
        if (isExternalTarget(target)) {
            continue;
        }
        const clean = target.split("#")[0]?.split("?")[0] ?? "";
        if (!clean.toLowerCase().endsWith(".md")) {
            continue;
        }
        let decoded = clean;
        try {
            decoded = decodeURIComponent(clean);
        } catch {
            // Keep the raw target when it is not valid percent-encoding.
        }
        const resolved = resolveLink(path, decoded);
        if (resolved === null || seen.has(resolved)) {
            continue;
        }
        seen.add(resolved);
        if (!exists(resolved)) {
            findings.push(`broken link to ${target} (no ${resolved}).`);
        }
    }
    return findings;
}

/**
 * The soft notes for one doc: obsolete lifecycle fields and a long body. These
 * are advisory, not compliance failures.
 * @param path The doc's root-relative path.
 * @param raw Full file contents.
 * @param maxDocLines The body line limit; `0` disables the length note.
 * @returns The note lines, without the path prefix.
 */
export function docNotes(
    path: string,
    raw: string,
    maxDocLines = DEFAULT_MAX_DOC_LINES,
): string[] {
    const { meta, body } = parseFrontMatter(raw);
    const notes: string[] = [];
    for (const field of ["Status", "Supersedes"] as const) {
        if (meta[field] !== undefined) {
            notes.push(
                `obsolete field \`${field}\` — the convention has no lifecycle ` +
                    "fields; remove it or delete the doc.",
            );
        }
    }
    notes.push(
        ...longDocNotes(body, maxDocLines).map((note) =>
            note.replace(/^note: /, ""),
        ),
    );
    return notes;
}

/** One doc's findings and advisory notes for `check`. */
interface DocCheck {
    /** Structural failures. */
    findings: string[];
    /** Advisory notes. */
    notes: string[];
}

/**
 * Collect one doc's check findings and notes.
 * @param entry The doc to check.
 * @param read Resolves its raw contents.
 * @param options Check options.
 * @param options.maxDocLines The body line limit.
 * @param options.exists Resolves a root-relative path for link checking.
 * @returns The findings and notes, path-prefixed.
 */
function checkOne(
    entry: DocEntry,
    read: (path: string) => string,
    options: {
        maxDocLines?: number;
        exists?: (path: string) => boolean;
    },
): DocCheck {
    const raw = read(entry.path);
    const findings = validateDoc(entry.path, raw).map(
        (finding) => `${entry.path}: ${finding}`,
    );
    if (options.exists !== undefined) {
        findings.push(
            ...linkFindings(entry.path, raw, options.exists).map(
                (finding) => `${entry.path}: ${finding}`,
            ),
        );
    }
    const notes = docNotes(entry.path, raw, options.maxDocLines).map(
        (note) => `${entry.path}: ${note}`,
    );
    return { findings, notes };
}

/** The near-twin findings for a tree, one line per pair. */
function nearTwinFindings(entries: readonly DocEntry[]): string[] {
    return nearTwinPairs(entries).map(
        ([doc, twin]) =>
            `${doc.path} and ${twin.path}: near-twins — reconcile ` +
            "(merge, or repoint one).",
    );
}

/**
 * Check the whole tree: per-doc {@link validateDoc} findings, broken relative
 * links, then the {@link nearTwinPairs}. Obsolete fields, long docs and
 * environment notes are advisory notes, not findings.
 * @param entries The docs to check.
 * @param read Resolves a root-relative doc path to its raw contents;
 * injected so the check is testable.
 * @param notes Environment notes (e.g. an unversioned root) appended to the
 * report; findings they describe are still reported per doc.
 * @param options Check options.
 * @param options.maxDocLines The body line limit; `0` disables the length note.
 * @param options.exists Resolves a root-relative path for link checking; when
 * omitted, links are not checked.
 * @returns The report text.
 */
export function checkDocs(
    entries: readonly DocEntry[],
    read: (path: string) => string,
    notes: readonly string[] = [],
    options: {
        maxDocLines?: number;
        exists?: (path: string) => boolean;
    } = {},
): string {
    const findings: string[] = [];
    const advisory: string[] = [...notes];
    for (const entry of entries) {
        const report = checkOne(entry, read, options);
        findings.push(...report.findings);
        advisory.push(...report.notes);
    }
    findings.push(...nearTwinFindings(entries));
    const head =
        findings.length === 0
            ? `All ${entries.length} docs comply.`
            : findings.join("\n");
    if (advisory.length === 0) {
        return head;
    }
    const noteLines = advisory.map((note) => `- ${note}`).join("\n");
    return `${head}\n\nNotes:\n${noteLines}`;
}

/** The built-in tools the miss-nudge watches: content searches, both miss-prone. */
export const NUDGED_TOOLS = ["grep", "glob"] as const;

/**
 * The text of a tool result's content: the string itself, or its text parts
 * joined. Non-text parts and foreign shapes contribute nothing.
 * @param content A `Tool.Result` content of any provenance.
 * @returns The searchable text, possibly empty.
 */
function contentText(content: unknown): string {
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
function patternOf(input: unknown): string {
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
function lakeValidated(lake: LakeSpec): boolean {
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
class UnsafePathError extends Error {
    constructor(path: string) {
        super(`path '${path}' escapes the lake root or crosses a symlink.`);
        this.name = "UnsafePathError";
    }
}

/** Whether `path` is outside `root` or is the root itself. */
function escapesRoot(root: string, path: string): boolean {
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
function safeLakeTarget(root: string, path: string): string | null {
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
interface TargetLock {
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
function physicalRouteOf(target: string): {
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
function ensureLockDirectory(lockDir: string): { error: string } | undefined {
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
function acquireTargetLock(target: string): TargetLock | { busy: string } {
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
interface OwnedTemp {
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
const defaultTempFactory: TempFactory = (target) => {
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
export type PublicationStage = "locked" | "verified" | "published";

/**
 * The bounded retry over exclusive temp names: each attempt is a fresh name
 * the factory must exclusively create; an `EEXIST` retry is bounded and never
 * touches the foreign object it collided with.
 * @param make The temp seam in use.
 * @param target The absolute target path, for the candidate names.
 * @returns An owned temp, or null when every attempt collided.
 */
function acquireTemp(make: TempFactory, target: string): OwnedTemp | null {
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
function verifyUnderLock(
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
function publicationErrorRefusal(
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
interface PublicationLedger {
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
function publishCreate(
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
function publishReplace(
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
 *   create temp     exclusive create beside the target; owned fd retained
 *   write full      through the fd only; short writes loop or fail
 *   rename          atomic temp → target; the file published is ours
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
function publishTarget(
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
function publicationFailure(
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
function containmentRefusal(
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
export const CLASS_LABELS: Readonly<Record<LakeClass, string>> = {
    repo: "Repository",
    machine: "Personal",
    global: "Organisation",
    wiki: "Wiki",
};

/**
 * The ownership guidance for a class, used when a lake carries no configured
 * description. Generic by design: domain-specific ownership is never inferred
 * from a path or a name.
 * @param lakeClass The lake's class.
 * @returns The concise default guidance.
 */
export function classGuidance(lakeClass: LakeClass): string {
    const guidance: Record<LakeClass, string> = {
        repo: "knowledge needed to understand or maintain this repository",
        machine: "knowledge tied to one person's devices, accounts and setup",
        global: "organisation-wide standards, services and integrations",
        wiki: "human-facing reference and narrative",
    };
    return guidance[lakeClass];
}

/** The repo-local lake additions file, relative to the location. */
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
function resolveLakesFilePath(
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
function readLakesJson(
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
const LAKE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The raw shape a lake declaration may take. */
interface RawLake {
    class?: unknown;
    root?: unknown;
    name?: unknown;
    writable?: unknown;
    description?: unknown;
}

/** Narrow an unknown lake declaration to its raw shape. */
function asLakeEntry(raw: unknown): RawLake {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(
            `docs plugin lake entry must be an object, got ${JSON.stringify(raw)}.`,
        );
    }
    return raw as RawLake;
}

/** Validate the lake class and the repo-file restriction. */
function lakeClassOf(entry: RawLake, fromRepoFile: boolean): LakeClass {
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
function lakeRootOf(
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
function lakeNameOf(
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
function lakeWritableOf(
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
function lakeDescriptionOf(entry: RawLake, name: string): string | undefined {
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
function lakeSpecFrom(
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
function assertLakesOptions(options: DocsPluginOptions): void {
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
function specsFromFile(
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
function specsFromInline(rawLakes: unknown, location: string): LakeSpec[] {
    return Array.isArray(rawLakes)
        ? rawLakes.map((raw) => lakeSpecFrom(raw, location, false))
        : [];
}

/** Throw when two lakes share a name. */
function assertUniqueLakeNames(specs: readonly LakeSpec[]): void {
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
function assertUniqueLakeRoots(specs: readonly LakeSpec[]): void {
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
interface Runtime {
    lakes: readonly Lake[];
    search: () => DocEntry[];
    maxDocLines: number;
    perLakeQuota: number;
}

/** The legacy single-lake closure wrapped as a {@link Lake}. */
function legacyLake(deps: RuntimeInput): Lake {
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
function runtimeOf(deps: RuntimeInput): Runtime {
    const lakes = deps.lakes ?? [legacyLake(deps)];
    return {
        lakes,
        search: deps.search ?? (() => lakes.flatMap((lake) => lake.collect())),
        maxDocLines: deps.maxDocLines ?? DEFAULT_MAX_DOC_LINES,
        perLakeQuota: deps.perLakeQuota ?? DEFAULT_PER_LAKE_QUOTA,
    };
}

/** The first repo lake, else the first lake; the one rendered without a prefix. */
function primaryLakeName(lakes: readonly Lake[]): string | undefined {
    return (lakes.find((lake) => lake.class === "repo") ?? lakes[0])?.name;
}

/** Find a lake by name. */
function findLake(lakes: readonly Lake[], name: string): Lake | undefined {
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
function lakeNotes(lake: Lake): readonly string[] {
    return lake.root === ""
        ? (lake.notes ?? [])
        : unversionedNote(lake.root, lake.name);
}

/** Whether a lake root is absent, probed at call time. */
function lakeMissing(lake: Lake): boolean {
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
function nestingDepth(lake: Lake, lakes: readonly Lake[]): number {
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
function candidateLine(lake: Lake): string {
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
function writableLake(
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
function address(lake: Lake, path: string, lakes: readonly Lake[]): string {
    return lakes.length > 1 ? `${lake.name}:${path}` : path;
}

/** Search every lake, optionally limited to one, and render the ranked result. */
function searchDocs(
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
function skippedLakeLine(lake: LakeSpec): string {
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
function cappedCheck(content: string): string {
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
function lakeReport(
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
function assembleCheck(
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
function checkLakes(
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
function legacyPublicationRefusal(
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
function writeTarget(
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
 * @param target The lake the write lands in.
 * @param outcome The prepared write.
 * @param outcome.path The root-relative target path.
 * @param outcome.contents The serialised file contents.
 * @returns The refusal on an unsafe path, or null once written.
 */
function publishLegacy(
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
function guardedPublish(
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
function successHead(
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
function successMetadata(
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
function publishPrepared(
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
function addDoc(
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
interface ReadTarget {
    lake?: Lake;
    path: string;
    reason?: string;
}

/** Split `lake:path` or an explicit lake selector into a target. */
function readTargetOf(
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
function uniqueHolder(
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
function readDoc(
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
function revisionNote(revision: string, fresh: boolean): string {
    return (
        `\n\ndocs: revision ${revision} — ` +
        (fresh ? "the newly published bytes" : "these bytes") +
        "; cite it as expectedRevision when replacing (a stale token refuses)."
    );
}

/** The lake help view shared by the tool and command. */
function lakeInfo(lakes: readonly Lake[]): LakeInfo[] {
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
const TWIN_DESCRIPTION =
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
function executeRequest(runtime: Runtime, input: DocsInput): Result {
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
export function createDocsTool(
    deps: DocsToolDeps,
    options: { name?: string; codemode?: boolean } = {},
): Info<typeof DOCS_INPUT> {
    const { name = "docs", codemode = false } = options;
    const runtime = runtimeOf(deps);
    return {
        name,
        description: codemode
            ? TWIN_DESCRIPTION
            : "Search the configured knowledge lakes and nested project " +
              "`README.md` files before a broad grep for how-to knowledge. " +
              "A blank search lists recent docs; `help` shows the lakes and " +
              "ranking. `read` returns a lake doc verbatim plus its " +
              "revision token; `instructions:` results open with the " +
              "built-in read tool. `add` creates or replaces a knowledge " +
              "doc (replace needs that revision); `check` audits " +
              "convention compliance.",
        input: DOCS_INPUT,
        options: codemode
            ? { namespace: "docs", codemode: true }
            : { codemode: false },
        execute(input) {
            return Promise.resolve(executeRequest(runtime, input));
        },
    };
}

/** `/docs` verbs: `search <text>` is explicit; bare text searches too. */
const SEARCH_VERB = "search";
const ADD_VERB = "add";
const CHECK_VERB = "check";

/**
 * The prompt delivered by `/docs add <text>`: ask the agent to call the tool's
 * `add` with a typed DTO rather than searching. An empty body is named as the
 * mistake it is.
 * @param subject Text after the `add` verb.
 * @returns The prompt to deliver to the session.
 */
function addPrompt(subject: string): string {
    if (subject === "") {
        return "`/docs add` needs the text to record: `/docs add <fact>`.";
    }
    return (
        "Record this as durable knowledge in the docs lakes: call the `docs` " +
        'tool\'s `add` with a typed DTO — mode:"create" for a new doc, ' +
        "metadata (Area/Keywords/Summary) and a body starting with an H1 — " +
        "for:\n\n" +
        subject
    );
}

/**
 * Build the `/docs` command over the same core as the tool: a search ranks the
 * catalogue (`search <text>`, or bare text), `add <text>` asks the agent to
 * write the knowledge through the tool's typed `add`, and `check` validates
 * the knowledge lakes.
 * @param deps Runtime seams used on each call.
 * @returns The command the host registers.
 */
export function createDocsCommand(deps: DocsCommandDeps): CommandDefinition {
    const runtime = runtimeOf(deps);
    return {
        name: "docs",
        description:
            "Search the configured knowledge lakes, ranked, plus nested project `README.md` files (search only); `add <text>` records new knowledge through the tool's typed `add`; `check` validates the lakes; a blank search lists recent docs.",
        async execute({ sessionID, prompt }) {
            const text = prompt.text.trim();
            if (isHelp(text)) {
                await deps.prompt(sessionID, helpText(lakeInfo(runtime.lakes)));
                return;
            }
            const [verb, ...rest] = text.split(/\s+/);
            const lower = verb?.toLowerCase();
            if (lower === ADD_VERB) {
                await deps.prompt(sessionID, addPrompt(rest.join(" ")));
                return;
            }
            if (lower === CHECK_VERB) {
                await deps.prompt(
                    sessionID,
                    checkLakes(runtime, undefined).content,
                );
                return;
            }
            const query = lower === SEARCH_VERB ? rest.join(" ") : text;
            const result = searchDocs(runtime, query, undefined);
            await deps.prompt(sessionID, result.content);
        },
    };
}

/**
 * Resolve a lake root from its `root` option. Unset → the
 * location's `docs/` directory — a blank string counts as unset, since it is
 * almost always an empty environment variable or half-finished config rather
 * than a deliberate path; `~` or `~/…` expands against the home
 * directory; absolute paths pass through; anything else resolves against the
 * plugin location. The resolved value is the knowledge tree itself — no
 * segment is appended. A non-string value throws: a mistyped option
 * must fail loudly, not silently fall back to the wrong tree.
 * @param configured The raw option value as the host delivers it.
 * @param locationDirectory The directory the plugin instance loaded in.
 * @returns The lake root.
 */
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
const DOCS_TOOL_NAMES = new Set(["docs", "docs_search"]);

/**
 * Content with `line` appended: string concatenation, or one extra text part.
 * @param content The tool result's content, when it has one.
 * @param line The nudge line.
 * @returns The content to write back.
 */
function appendLine(
    content: NonNullable<Result["content"]> | undefined,
    line: string,
): NonNullable<Result["content"]> {
    if (typeof content === "string" || content === undefined) {
        return `${content ?? ""}\n\n${line}`;
    }
    return [...content, { type: "text", text: line }];
}

export default Plugin.define({
    id: "docs",
    async setup(ctx) {
        const options = (ctx.options ?? {}) as DocsPluginOptions;
        const nudge = resolveNudge(options.nudge);
        const maxDocLines = resolveNonNegativeInt(
            options.maxDocLines,
            "maxDocLines",
            DEFAULT_MAX_DOC_LINES,
        );
        const perLakeQuota = resolveNonNegativeInt(
            options.perLakeQuota,
            "perLakeQuota",
            DEFAULT_PER_LAKE_QUOTA,
        );
        const lakes = createLakes(
            resolveLakes(options, ctx.location.directory),
        );
        const search = () => [
            ...lakes.flatMap((lake) => lake.collect()),
            ...collectReadmes(
                ctx.location.directory,
                (paths) => fallbackDates(ctx.location.directory, paths),
                lakes.map((lake) => lake.root),
            ),
        ];
        const toolDeps = {
            lakes,
            search,
            maxDocLines,
            perLakeQuota,
        };
        // Two registrations of one core: the native `docs` for direct calls,
        // and the Code Mode twin `docs_search` so `execute` reaches the same
        // lakes as `tools.docs.docs_search(…)`. The registry is name-keyed, so
        // the twin must carry its own name.
        await ctx.tool.transform((editor) => {
            editor.add(createDocsTool(toolDeps));
            editor.add(
                createDocsTool(toolDeps, {
                    name: "docs_search",
                    codemode: true,
                }),
            );
        });
        await ctx.command.transform((editor) => {
            editor.add(
                createDocsCommand({
                    lakes,
                    search,
                    maxDocLines,
                    perLakeQuota,
                    prompt: (sessionID, text) => {
                        // Any `/docs` use counts as consulting the lakes.
                        nudged.add(sessionID);
                        return ctx.session.prompt({ sessionID, text });
                    },
                }),
            );
        });
        // The nudges (default on; `nudge: false` restores silence). The
        // miss-nudge fires once per session, at the first grep/glob miss, and
        // is fail-quiet by construction — it must never break the tool it
        // wraps. The record-nudge rides compaction: the summariser has no
        // tools, so it shapes record-ready blocks for the continuing agent.
        const nudged = new Set<string>();
        if (nudge) {
            await ctx.tool.hook("execute.after", (event) => {
                try {
                    if (event.status !== "completed") {
                        return;
                    }
                    if (DOCS_TOOL_NAMES.has(event.tool)) {
                        nudged.add(event.sessionID);
                        return;
                    }
                    const line = missNudgeFor(
                        {
                            tool: event.tool,
                            status: event.status,
                            content: event.result.content,
                            input: event.input,
                        },
                        nudged.has(event.sessionID),
                    );
                    if (line === null) {
                        return;
                    }
                    nudged.add(event.sessionID);
                    event.result = {
                        ...event.result,
                        content: appendLine(event.result.content, line),
                    };
                } catch {
                    // Fail-quiet: a nudge must never break the wrapped tool.
                }
            });
            await ctx.session.hook("compaction", (compaction) => {
                compaction.system.push({ type: "text", text: RECORD_NUDGE });
            });
        }
        // The skill is the doctrine's runtime face. Its content ships next to
        // this module and is resolved through `import.meta.url`, so it works
        // whether the plugin is loaded from a local path or an installed
        // package.
        const skillURL = new URL("SKILL.md", import.meta.url);
        const skill = readFileSync(skillURL, "utf8");
        await ctx.skill.transform((editor) => {
            editor.add({
                id: Skill.ID.make("docs"),
                name: Skill.Name.make("Docs"),
                description:
                    "Entry point to the configured knowledge lakes " +
                    "(repo, machine, global, read-only wiki) and nested project " +
                    "README.md files: find and read the right doc, then record " +
                    "focused knowledge at the narrowest justified scope. Use " +
                    "before searching the codebase for how-to knowledge, or " +
                    "when a session learns something durable.",
                path: AbsolutePath.make(fileURLToPath(skillURL)),
                content: skill,
            });
        });
    },
});
