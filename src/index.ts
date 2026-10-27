import { Plugin, Skill } from "@opencode/plugin";
import { AbsolutePath } from "@opencode/schema/schema";
import type {
    CommandDefinition,
    CommandInvocation,
} from "@opencode/plugin/promise/command";
import type { Info, Result } from "@opencode/plugin/promise/tool";
import { spawnSync } from "node:child_process";
import {
    type Dirent,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
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
                "Case-insensitive search over title, path, keywords, body headings and code spans, area, summary and wiki prose. Omit or leave blank to list the most recently changed docs; a partial match returns the closest docs.",
        }),
    ),
    lake: Schema.optional(
        Schema.String.annotate({
            description:
                "Optional lake name. Search and check are limited to it; read and add target it. Omit to search every lake, read the unique match, or add to the first writable repo lake.",
        }),
    ),
    add: Schema.optional(
        Schema.Struct({
            path: Schema.optional(
                Schema.String.annotate({
                    description:
                        "Update target, e.g. `guides/getting-started.md` (relative to the lake root). Omit to create `<Area>/<slug>.md` from the H1.",
                }),
            ),
            metadata: Schema.Struct({
                Area: Schema.String,
                Keywords: Schema.Array(Schema.String),
                Summary: Schema.String,
            }).annotate({
                description:
                    "Front-matter metadata; serialised, never copied. All three fields are required and must not be blank.",
            }),
            body: Schema.String.annotate({
                description:
                    "Markdown body: an H1, then the claim sections (Facts / Inferred / Tested / Failed approaches / Open questions).",
            }),
        }).annotate({
            description:
                "The only mutating mode: writes a new knowledge doc, or wholesale-replaces the doc at `path`. Blank required metadata, path traversal, a non-.md target, and a same-area near-twin (when `path` is omitted) are all refused. Wiki lakes are read-only.",
        }),
    ),
    check: Schema.optional(
        Schema.Boolean.annotate({
            description:
                "Validate every knowledge doc against the convention: required front-matter, an H1, claim sections, no hand-maintained Date, a distinctive H1+Keywords identity, same-area near-twins, broken relative links, and a soft length note. Wiki lakes and READMEs are not validated.",
        }),
    ),
    read: Schema.optional(
        Schema.String.annotate({
            description:
                "A root-relative doc path, or `lake:path`, to return verbatim — front-matter and body — so find-then-read is one call. Lake docs and wiki pages only: project READMEs stay with the built-in `read` tool.",
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
 * The `add` mode's typed DTO: the single writer's whole input. Pass `path` to
 * update (`docs/<area>/<name>.md`); omit it to create `docs/<Area>/<slug>.md`
 * from the H1.
 */
export type DocsAdd = NonNullable<DocsInput["add"]>;

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

/** Whether a line opens or closes a fenced code block. */
function isFence(line: string): boolean {
    return line.trimStart().startsWith("```");
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
    let fenced = false;
    for (const line of body.split("\n")) {
        if (isFence(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) {
            continue;
        }
        const heading = /^(#{2,3})\s+/.exec(line);
        if (heading !== null) {
            const text = stripTrailingHashes(
                line.slice(heading[0].length).replace(/`/g, ""),
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
    const lines: string[] = [];
    let fenced = false;
    for (const line of body.split("\n")) {
        if (isFence(line)) {
            fenced = !fenced;
            continue;
        }
        if (!fenced) {
            lines.push(line);
        }
    }
    return lines.join("\n");
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
            const labelled =
                entry.lake !== "" && entry.lake !== options.primaryLake
                    ? `${entry.lake}:${head}`
                    : head;
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
        `- Terms shorter than MIN_TERM_LENGTH (${MIN_TERM_LENGTH}) are ignored unless they are the whole query.`,
        "- Search covers every configured lake and nested project `README.md` files, honouring `.gitignore` (dependency and build directories are skipped when the project is not in git). READMEs are searchable only: `add` and `check` ignore them.",
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
}

/**
 * Describe the configured lakes, then the ranking. The agent learns where
 * knowledge lives without loading the full convention.
 * @param lakes The configured lakes.
 * @returns The help text.
 */
export function helpText(lakes: readonly LakeInfo[]): string {
    const lines = ["Configured lakes:"];
    for (const lake of lakes) {
        const access = lake.writable ? "writable" : "read-only";
        const checked = lake.validated ? "checked" : "not checked";
        lines.push(
            `- ${lake.name} (${lake.class}, ${access}, ${checked}): ${lake.root}`,
        );
    }
    lines.push(
        "- instructions (read-only, not checked): nested project README.md files",
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
        "git",
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
    return paths.sort();
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
        .sort();
}

/**
 * README paths from git's index and untracked non-ignored files, or undefined
 * when `location` is not inside a git work tree.
 */
function gitReadmePaths(location: string): string[] | undefined {
    const result = spawnSync(
        "git",
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
          /** Root-relative target. */
          path: string;
          /** The serialised file contents. */
          contents: string;
          /** Same-area docs already on disk, shown alongside the write. */
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
 * An explicit path must stay inside the lake root and name a `.md` file; an
 * omitted path derives `<Area>/<slug>.md` from the H1.
 * @param add The typed request.
 * @returns The target path, or the refusal reason.
 */
function targetOf(add: DocsAdd): { path: string } | { reason: string } {
    const given = add.path?.trim() ?? "";
    if (given !== "") {
        return explicitTarget(given);
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
 * The near-twin refusal for an `add`, or null when the write may proceed.
 * An explicit path is the update contract and skips reconcile.
 * @param add The typed request.
 * @param entries The current docs.
 * @returns The refusal, or null.
 */
function nearTwinRefusal(
    add: DocsAdd,
    entries: readonly DocEntry[],
): AddOutcome | null {
    if ((add.path?.trim() ?? "") !== "") {
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
            "this doc. Pass its path to update it, or a different path " +
            "to write anyway:\n\n" +
            render(nearTwinDocs),
        candidates: nearTwinDocs,
    };
}

/**
 * Validate an `add` request and prepare it for writing — pure, no fs.
 *
 * Trust boundary: the caller is a model. Blank required metadata, a body
 * without an H1, a path or `Area` escaping the lake root, a non-`.md` target
 * and a title that yields no slug are all refused. With `path` omitted the
 * target is `<Area>/<slug>.md` and a same-area near-twin — a doc matching every
 * reconcile query term ({@link reconcileQuery}) — refuses the write with the
 * candidates attached; an explicit `path` is the update contract (wholesale
 * replacement) and skips reconcile.
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

    const blank = blankRequiredField(add.metadata);
    if (blank !== null) {
        return refuse(`${blank} is required and must not be blank.`);
    }
    if (/[/\\]|\.\./.test(add.metadata.Area)) {
        return refuse("Area must be a single folder name under the lake root.");
    }
    if (h1Of(add.body) === undefined) {
        return refuse("The body must carry an H1 (`# Title`).");
    }
    if (!hasDistinctiveIdentity(reconcileQuery(add))) {
        return refuse(
            `the H1 and Keywords together carry no term of MIN_TERM_LENGTH ` +
                `(${MIN_TERM_LENGTH}) or longer; add a distinctive term so ` +
                "reconcile can tell this doc apart.",
        );
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
    const claims = CLAIM_SECTIONS.map((section) => section.toLowerCase());
    if (
        !scanBody(body).headings.some((h) => claims.includes(h.toLowerCase()))
    ) {
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
            const key = [doc.path, twin.path].sort().join("\n");
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

/** Inline `[text](target)` destinations on one line; images are skipped. */
function inlineTargets(line: string): string[] {
    const targets: string[] = [];
    let index = 0;
    while (index < line.length) {
        if (line[index] === "[" && line[index - 1] !== "!") {
            const close = line.indexOf("](", index + 1);
            if (close !== -1) {
                const end = line.indexOf(")", close + 2);
                if (end !== -1) {
                    const destination = line
                        .slice(close + 2, end)
                        .trim()
                        .split(/\s+/)[0];
                    if (destination !== undefined && destination !== "") {
                        targets.push(destination);
                    }
                    index = end + 1;
                    continue;
                }
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
    let fenced = false;
    for (const line of body.split("\n")) {
        if (isFence(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) {
            continue;
        }
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
    return `${head}\n\nNotes:\n${advisory.map((note) => `- ${note}`).join("\n")}`;
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
    "Before summarising: if this session established durable knowledge " +
    "(decisions, traps, runbooks, verified behaviour), open the " +
    "continuation with one `Record with docs add:` block per finding — " +
    "never one session dump, and never one mixed-scope doc. Each block names " +
    "its own artifact's class (repo, machine, or global), `Area`, `H1` title " +
    "and `Keywords`, plus a one-line what-and-why, so the next agent can " +
    "persist each as a separate focused doc at the narrowest true scope.";

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
}

/** A lake with its runtime seams. */
export interface Lake extends LakeSpec {
    /** Collects this lake's docs. */
    collect: () => DocEntry[];
    /** Reads a root-relative path. */
    read: (path: string) => string;
    /** Whether a root-relative path exists. */
    exists: (path: string) => boolean;
    /** Writes a root-relative path, creating parent directories. */
    write: (path: string, contents: string) => void;
    /** Environment notes for `check` (missing root, unversioned root). */
    notes: readonly string[];
    /** Whether `check` should verify relative links; false for the legacy seam. */
    linkCheck: boolean;
}

/**
 * Attach the filesystem seams to a lake spec.
 * @param spec The configured lake.
 * @param options Runtime options.
 * @param options.skip Absolute roots of other lakes, so a nested lake is not
 * collected twice.
 * @returns The lake the tool serves.
 */
export function createLake(
    spec: LakeSpec,
    options: { skip?: readonly string[] } = {},
): Lake {
    return {
        ...spec,
        notes: unversionedNote(spec.root),
        linkCheck: true,
        collect: () =>
            collectDocs(spec.root, (paths) => fallbackDates(spec.root, paths), {
                profile: spec.profile,
                lake: spec.name,
                class: spec.class,
                skip: options.skip ?? [],
            }),
        read: (path) => readFileSync(join(spec.root, path), "utf8"),
        exists: (path) => existsSync(join(spec.root, path)),
        write: (path, contents) => {
            const target = join(spec.root, path);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, contents);
        },
    };
}

/**
 * Build every configured lake, each aware of the others so a nested root is
 * collected once.
 * @param specs The configured lakes.
 * @returns The runtime lakes.
 */
export function createLakes(specs: readonly LakeSpec[]): Lake[] {
    return specs.map((spec) =>
        createLake(spec, {
            skip: specs
                .filter((other) => other !== spec)
                .map((other) => other.root),
        }),
    );
}

/** The lake classes the configuration accepts. */
export const LAKE_CLASSES = ["repo", "machine", "global", "wiki"] as const;

/** The repo-local lake additions file, relative to the location. */
export const REPO_LAKES_FILE = ".opencode/docs-lakes.json";

/** The plugin's options, as the host delivers them. */
export interface DocsPluginOptions {
    /** The single repo-lake override; mutually exclusive with `lakes`. */
    root?: unknown;
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
    const lakes = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null && "lakes" in parsed
          ? (parsed as { lakes: unknown }).lakes
          : undefined;
    if (!Array.isArray(lakes)) {
        throw new Error(
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
        throw new Error(
            `docs plugin ${lakeClass} lake root must be a string, ` +
                `got ${JSON.stringify(entry.root)}.`,
        );
    }
    const root = resolveRoot(entry.root, location);
    if (fromRepoFile && !isUnder(root, location)) {
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
    const name =
        entry.name === undefined
            ? derived
            : typeof entry.name === "string"
              ? entry.name.trim()
              : "";
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
    const writable =
        entry.writable === undefined ? lakeClass !== "wiki" : entry.writable;
    if (lakeClass === "wiki" && writable) {
        throw new Error(
            `docs plugin lake '${name}' is a wiki lake and cannot be writable.`,
        );
    }
    return writable;
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
    return {
        name,
        class: lakeClass,
        root,
        profile: lakeClass === "wiki" ? "wiki" : "knowledge",
        writable: lakeWritableOf(entry, lakeClass, name),
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
                { class: "repo", root: options.root },
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

/** The lake `add` writes to, or the refusal reason. */
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
    return (
        lakes.find((lake) => lake.class === "repo" && lake.writable) ??
        lakes.find((lake) => lake.profile === "knowledge" && lake.writable) ?? {
            reason:
                `${REFUSE} no writable knowledge lake is configured; ` +
                "add a repo, machine, or global lake.",
        }
    );
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
    return {
        content: render(ranked, {
            closest,
            omitted,
            primaryLake: primaryLakeName(runtime.lakes) ?? "",
        }),
        count: ranked.length,
        omitted,
    };
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
        if (lake.profile === "wiki") {
            return {
                content:
                    `Lake '${lake.name}' is a wiki lake — read-only reference, ` +
                    "not validated.",
                checked: 0,
            };
        }
        const entries = lake.collect();
        return {
            content: checkDocs(entries, lake.read, lake.notes, {
                maxDocLines: runtime.maxDocLines,
                ...(lake.linkCheck ? { exists: lake.exists } : {}),
            }),
            checked: entries.length,
        };
    }
    const knowledge = runtime.lakes.filter(
        (lake) => lake.profile === "knowledge",
    );
    let checked = 0;
    const reports = knowledge.map((lake) => {
        const entries = lake.collect();
        checked += entries.length;
        const report = checkDocs(entries, lake.read, lake.notes, {
            maxDocLines: runtime.maxDocLines,
            ...(lake.linkCheck ? { exists: lake.exists } : {}),
        });
        return knowledge.length > 1 || runtime.lakes.length > 1
            ? `${lake.name}:\n${report}`
            : report;
    });
    const wiki = runtime.lakes
        .filter((lake) => lake.profile === "wiki")
        .map((lake) => lake.name);
    if (wiki.length > 0) {
        reports.push(
            `note: wiki lakes are read-only reference and are not validated: ` +
                `${wiki.join(", ")}.`,
        );
    }
    return {
        content:
            reports.length > 0
                ? reports.join("\n\n")
                : "No knowledge lakes configured.",
        checked,
    };
}

/** Add a doc to the target lake. */
function addDoc(
    runtime: Runtime,
    add: DocsAdd,
    lakeName: string | undefined,
): { content: string; written: boolean } {
    const target = writableLake(runtime.lakes, lakeName);
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
    const updated = target.exists(outcome.path);
    target.write(outcome.path, outcome.contents);
    const head = `${address(target, outcome.path, runtime.lakes)} — ${
        updated ? "updated" : "created"
    }.`;
    const neighbours =
        outcome.neighbours.length > 0
            ? `\n\nNearby docs in the same area:\n\n${render(
                  outcome.neighbours,
                  { primaryLake: target.name },
              )}`
            : "";
    const notes =
        outcome.notes.length > 0 ? `\n\n${outcome.notes.join("\n")}` : "";
    return { content: `${head}${neighbours}${notes}`, written: true };
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
    if (holders.length > 1) {
        return {
            reason:
                `${REFUSE} ${path} exists in multiple lakes ` +
                `(${holders.map((lake) => lake.name).join(", ")}); pass lake.`,
        };
    }
    return holders[0] as Lake;
}

/** Read one doc, resolving a `lake:path` prefix or the unique match. */
function readDoc(
    runtime: Runtime,
    given: string,
    lakeName: string | undefined,
): { content: string; read: string | null } {
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
    return {
        content: `${label} — ${titleOf(guarded.path, body)}\n\n${raw}`,
        read: label,
    };
}

/** The lake help view shared by the tool and command. */
function lakeInfo(lakes: readonly Lake[]): LakeInfo[] {
    return lakes.map((lake) => ({
        name: lake.name,
        class: lake.class,
        root: lake.root,
        writable: lake.writable,
        validated: lake.profile === "knowledge",
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
    "Search, read, add and check the configured knowledge lakes (plus nested " +
    "project `README.md` files, search-only) from inside `execute` — the " +
    "`docs` tool's Code Mode twin. A blank search lists the most recently " +
    "changed docs; `read` returns a matched doc verbatim; `add` writes through " +
    "a typed DTO; `check` validates the knowledge lakes.";

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
            : "Discover the configured knowledge lakes plus nested `README.md` " +
              "files in the project tree. Prefer it over a broad grep when the " +
              "question is how-to knowledge rather than where code lives. A blank search lists the " +
              MAX_RESULTS +
              " most recently changed docs (path — Area — date — Summary); a search ranks docs over title, path, keywords, body headings and code spans, area, summary and wiki prose, falling back to the closest matches. Every source reserves a few results; every call caps at " +
              MAX_RESULTS +
              " and counts the rest. Search exactly `help` for the lakes and ranking. `read` returns a doc verbatim; pass a `lake` or a `lake:path`. `add` writes a new knowledge doc (or replaces the doc at `path`) from a typed DTO — metadata becomes front-matter, the body must start with an H1; blank fields, path traversal, non-.md targets, read-only lakes and same-area near-twins are refused. `check` validates the knowledge lakes (front-matter, H1, claim sections, no hand-maintained Date, distinctive identity, near-twins, broken links, soft length note); wiki lakes are read-only and not validated. READMEs are search-only. Read a matched project file with the built-in read tool.",
        input: DOCS_INPUT,
        options: codemode
            ? { namespace: "docs", codemode: true }
            : { codemode: false },
        async execute(input) {
            const request = resolveRequest(input);
            if (request.verb === "add") {
                const result = addDoc(runtime, request.add, request.lake);
                return {
                    content: result.content,
                    metadata: { written: result.written },
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
                    metadata: { read: result.read },
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
        "tool's `add` with a typed DTO (metadata Area/Keywords/Summary, body starting " +
        "with an H1) for:\n\n" +
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
            "Search the configured knowledge lakes, ranked, plus nested project `README.md` files (search only); `add <text>` records new knowledge through the tool's typed `add`; `check` validates the knowledge lakes; a blank search lists the " +
            MAX_RESULTS +
            " most recently changed.",
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
        throw new Error(
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
 * Probe whether the lake root sits inside a git work tree, as `check`-report
 * notes. An unversioned root still works — dates fall back to file mtimes and
 * the knowledge has no history — so it is surfaced, not refused.
 * @param root The lake root to probe.
 * @returns The note lines; empty when the root is version-controlled.
 */
export function unversionedNote(root: string): readonly string[] {
    if (!existsSync(root)) {
        return [
            "note: this lake root does not exist yet — it is ignored until " +
                "it does. A missing root is not an error.",
        ];
    }
    const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: root,
    });
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
                    "The entry point to the configured knowledge lakes " +
                    "(repo, machine, global and read-only wiki), plus the " +
                    "project's nested README.md files (search only): find the " +
                    "right doc with the docs tool, read it, and record focused " +
                    "task knowledge for the next human or agent at the " +
                    "narrowest true scope. Use before searching the codebase " +
                    "for how-to knowledge, when a task names a service, flag " +
                    "or error string the lake may already explain, at the " +
                    "start of unfamiliar work, when hunting for prior " +
                    "decisions or traps, when a session learns something the " +
                    "next one will need, and when closing out a session.",
                path: AbsolutePath.make(fileURLToPath(skillURL)),
                content: skill,
            });
        });
    },
});
