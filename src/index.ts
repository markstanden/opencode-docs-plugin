import { Plugin, Skill } from "@opencode/plugin";
import { AbsolutePath } from "@opencode/schema/schema";
import type {
    CommandDefinition,
    CommandInvocation,
} from "@opencode/plugin/promise/command";
import type { Info } from "@opencode/plugin/promise/tool";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

/**
 * V2 docs plugin.
 *
 * Registers a model-callable `docs` tool so the agent can discover the
 * knowledge tree mid-task — the docs root is configurable (`root` option,
 * default `<location>/docs`): a blank search returns the most recently changed
 * docs (`path — Area — date — Summary`), a search ranks the docs by
 * how well their front-matter, path and body identifiers match, falling back
 * to the closest matches rather than a dead end. `add` writes knowledge,
 * `check` validates the convention. Reading a matched doc stays the built-in
 * `read`.
 *
 * Everything below the default export is pure or dependency-injected so it can
 * be exercised directly against Node's built-in test runner without OpenCode.
 */

/** One knowledge doc, as the tool sees it. */
export interface DocEntry {
    /** Root-relative path, e.g. `decisions/choose-a-queue.md`. */
    path: string;
    /** Front-matter `Area`, else the first path segment under the root. */
    area: string;
    /** Resolved at read time: last git commit, else file mtime. Never front-matter. */
    date: string;
    /** First `# ` heading in the body, else the file name. */
    title: string;
    /** Front-matter `Summary`, else an empty string. */
    summary: string;
    /** Front-matter `Status: superseded` — the doc is marked as replaced. */
    superseded: boolean;
    /** Front-matter `Keywords`, split on commas and trimmed. */
    keywords: readonly string[];
    /** Body H2/H3 headings plus inline `code` spans, trimmed and de-duplicated. */
    identifiers: readonly string[];
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
                "Case-insensitive search over title, path, keywords, body headings and code spans, area and summary. Omit or leave blank to list the most recently changed docs; a partial match returns the closest docs.",
        }),
    ),
    add: Schema.optional(
        Schema.Struct({
            path: Schema.optional(
                Schema.String.annotate({
                    description:
                        "Update target, e.g. `guides/getting-started.md` (relative to the docs root). Omit to create `<Area>/<slug>.md` from the H1.",
                }),
            ),
            metadata: Schema.Struct({
                Area: Schema.String,
                Keywords: Schema.Array(Schema.String),
                Summary: Schema.String,
                Status: Schema.optional(
                    Schema.Union([
                        Schema.Literal("active"),
                        Schema.Literal("superseded"),
                    ]),
                ),
                Supersedes: Schema.optional(Schema.String),
            }).annotate({
                description:
                    "Front-matter metadata; serialised, never copied. All three fields are required and must not be blank.",
            }),
            body: Schema.String.annotate({
                description:
                    "Markdown body: an H1, then the claim sections (Facts / Inferred / Tested / Open questions).",
            }),
        }).annotate({
            description:
                "The only mutating mode: writes a new knowledge doc, or wholesale-replaces the doc at `path`. Blank required metadata, path traversal, a non-.md target, a body without an H1, and a same-area near-twin (when `path` is omitted) are all refused.",
        }),
    ),
    check: Schema.optional(
        Schema.Boolean.annotate({
            description:
                "Validate every doc under the docs root against the convention: required front-matter, an H1, claim sections, no hand-maintained Date, a distinctive H1+Keywords identity, a Supersedes naming a doc in the tree, and same-area near-twins. An empty report means compliant.",
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
    { name: "Status", required: false },
    { name: "Supersedes", required: false },
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
    const lines = FRONT_MATTER_FIELDS.flatMap(({ name }) => {
        const value = metadata[name];
        if (value === undefined) {
            return [];
        }
        const text = Array.isArray(value) ? value.join(", ") : value;
        return [`${name}: ${text}`];
    });
    return `---\n${lines.join("\n")}\n---\n\n${body.replace(/\n+$/, "")}\n`;
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
    return text.replace(/[ #]+$/, "");
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

/**
 * Build a doc entry from its path, raw contents and the date to show.
 * @param path Repo-relative doc path.
 * @param raw Full file contents.
 * @param date The resolved date (last git commit, else file mtime). Front-matter
 * `Date` is deliberately ignored — the date is derived, never hand-maintained.
 * @returns The entry the tool ranks and renders.
 */
export function toEntry(path: string, raw: string, date: string): DocEntry {
    const { meta, body } = parseFrontMatter(raw);
    const segments = path.split("/");
    const area = meta.Area ?? (segments.length > 1 ? (segments[0] ?? "") : "");
    return {
        path,
        area,
        date,
        title: titleOf(path, body),
        summary: meta.Summary ?? "",
        superseded: meta.Status?.trim().toLowerCase() === "superseded",
        keywords: splitKeywords(meta.Keywords ?? ""),
        identifiers: identifiersOf(body),
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
 * Most recently changed first, then the active doc of a same-date tie, then
 * path ascending; an empty date is oldest.
 */
function byRecency(a: DocEntry, b: DocEntry): number {
    return (
        b.date.localeCompare(a.date) ||
        Number(a.superseded) - Number(b.superseded) ||
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
 * Sort by score, best first, then the active doc of a same-score tie, then
 * recency, then the stable path order. Each doc is scored once into the
 * decorated list — the comparator sorts on precomputed points instead of
 * re-scoring every comparison.
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
                Number(a.doc.superseded) - Number(b.doc.superseded) ||
                b.doc.date.localeCompare(a.doc.date) ||
                a.doc.path.localeCompare(b.doc.path),
        )
        .map(({ doc }) => doc);
}

/**
 * Rank the docs for a query. A blank query returns the most recently changed
 * docs as the catalogue; a query that some doc satisfies fully returns those
 * docs ranked; otherwise it falls back to the docs that match any term as a
 * substring, ranked, flagged `closest`. Every outcome caps at
 * {@link MAX_RESULTS} and reports the cut as `omitted`.
 * @param entries Docs to rank, already path-ordered.
 * @param query Raw query text.
 * @returns The docs to show, the fallback flag, and the omitted count.
 */
export function rankDocs(
    entries: readonly DocEntry[],
    query: string,
): RankedDocs {
    const terms = termsOf(query);
    if (terms.length === 0) {
        return { ...capped([...entries].sort(byRecency)), closest: false };
    }
    const full = entries.filter((entry) => matches(entry, query));
    if (full.length > 0) {
        return { ...capped(byScore(full, terms)), closest: false };
    }
    const partial = entries.filter((entry) => score(entry, terms) > 0);
    return {
        ...capped(byScore(partial, terms)),
        closest: partial.length > 0,
    };
}

/**
 * Render matched docs as `path — Area — date` lines with the summary indented
 * beneath; a superseded doc carries a `(superseded)` marker. A closest-match
 * fallback set is labelled; a cap cut is counted in a trailing note; nothing
 * matched is stated plainly.
 * @param entries Docs to render, already ranked and capped.
 * @param options Render options.
 * @param options.closest True when the entries are a closest-match fallback.
 * @param options.omitted Docs cut by the cap, shown as a trailing note.
 * @returns The tool's text result.
 */
export function render(
    entries: readonly DocEntry[],
    options: { closest?: boolean; omitted?: number } = {},
): string {
    if (entries.length === 0) {
        return "No knowledge docs matched.";
    }
    const body = entries
        .map((entry) => {
            const parts = [entry.area, entry.date].filter(
                (part) => part !== "",
            );
            if (entry.superseded) {
                parts.push("(superseded)");
            }
            const meta = parts.join(" — ");
            const head = meta === "" ? entry.path : `${entry.path} — ${meta}`;
            return entry.summary === "" ? head : `${head}\n  ${entry.summary}`;
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
        `- Fields weighted: title ${FIELD_WEIGHTS.title} > path ${FIELD_WEIGHTS.path} > keywords ${FIELD_WEIGHTS.keywords} > identifiers ${FIELD_WEIGHTS.identifiers} > area ${FIELD_WEIGHTS.area} > summary ${FIELD_WEIGHTS.summary}.`,
        `- Each term scores its best field as weight × quality; quality is exact > prefix > substring.`,
        `- Terms shorter than MIN_TERM_LENGTH (${MIN_TERM_LENGTH}) are ignored unless they are the whole query.`,
        `- Every call returns at most MAX_RESULTS (${MAX_RESULTS}), best matches first, then the most recently edited; anything cut is counted as "… and N more not shown."`,
        '- Outcomes: a blank query lists the most recently changed docs; a doc carrying every term ranks the full matches; otherwise the docs matching any term as a substring are listed under "Closest matches"; nothing hits is "No knowledge docs matched."',
    ].join("\n");
}

/** A resolved `docs` tool call: exactly one verb wins (`add` > `check` > `help` > `search`). */
export type DocsRequest =
    | { verb: "add"; add: DocsAdd }
    | { verb: "check" }
    | { verb: "help" }
    | { verb: "search"; search: string };

/**
 * Resolve a tool call to one verb. An explicit `add` is never downgraded; a
 * `check` outranks a search; a lone `help` search explains the ranking;
 * anything else searches.
 * @param input The raw tool input.
 * @param input.search The raw search text, when given.
 * @param input.add The typed add DTO, when given.
 * @param input.check The check flag, when given.
 * @returns The single resolved request.
 */
export function resolveRequest(input: DocsInput): DocsRequest {
    if (input.add !== undefined) {
        return { verb: "add", add: input.add };
    }
    if (input.check === true) {
        return { verb: "check" };
    }
    if (isHelp(input.search ?? "")) {
        return { verb: "help" };
    }
    return { verb: "search", search: input.search ?? "" };
}

/**
 * The newest commit date per path, in one `git log` pass over all paths.
 * `git log` lists commits newest first, so the first date seen for a path is
 * its latest edit; paths absent from history are absent from the map.
 * @param cwd Directory inside the docs root's work tree; git resolves the
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
        ["log", "--format=%cs", "--name-only", "--", ...paths],
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
 * @param cwd Directory inside the docs root's work tree.
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

/**
 * Collect every knowledge doc under the docs root, skipping scratch and
 * mirrors.
 * @param root Docs root — the directory that is the knowledge tree.
 * @param resolve Resolves every doc path's date in one batched call.
 * @returns Entries ordered by path, or none when the root is absent.
 */
export function collectDocs(
    root: string,
    resolve: (paths: readonly string[]) => ReadonlyMap<string, string>,
): DocEntry[] {
    let files: string[];
    try {
        files = readdirSync(root, {
            recursive: true,
            encoding: "utf8",
        });
    } catch {
        return [];
    }
    const excluded = EXCLUDED_AREAS as readonly string[];
    const paths = files
        .filter((relativePath) => relativePath.endsWith(".md"))
        .filter(
            (relativePath) =>
                !excluded.includes(relativePath.split("/")[0] ?? ""),
        )
        .sort();
    const dates = resolve(paths);
    return paths.map((path) =>
        toEntry(
            path,
            readFileSync(join(root, path), "utf8"),
            dates.get(path) ?? "",
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
        .replace(/^-+|-+$/g, "");
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
    for (const { name, required } of FRONT_MATTER_FIELDS) {
        if (!required) {
            continue;
        }
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
 * Validate an explicit `add` path: relative, inside the docs root, naming a
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
            reason: "path must be relative and stay inside the docs root.",
        };
    }
    if (!given.endsWith(".md")) {
        return { reason: "path must end in .md." };
    }
    const stem = given.slice(0, -".md".length);
    if (stem === "" || stem.endsWith("/")) {
        return { reason: "path must name a .md file under the docs root." };
    }
    return { path: given };
}

/**
 * The root-relative target path for an `add`, or the reason it is refused.
 * An explicit path must stay inside the docs root and name a `.md` file; an
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
 * Validate an `add` request and prepare it for writing — pure, no fs.
 *
 * Trust boundary: the caller is a model. Blank required metadata, a body
 * without an H1, a path or `Area` escaping the docs root, a non-`.md` target
 * and a title that yields no slug are all refused. With `path` omitted the
 * target is `<Area>/<slug>.md` and a same-area near-twin — a doc matching every
 * reconcile query term ({@link reconcileQuery}) — refuses the write with the
 * candidates attached; an explicit `path` is the update contract (wholesale
 * replacement) and skips reconcile.
 * @param add The typed request.
 * @param entries The current docs, for reconcile and neighbours.
 * @returns The prepared write, or the refusal.
 */
export function prepareAdd(
    add: DocsAdd,
    entries: readonly DocEntry[],
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
        return refuse("Area must be a single folder name under the docs root.");
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

    if ((add.path?.trim() ?? "") === "") {
        const query = reconcileQuery(add);
        const nearTwinDocs = nearTwins(query, add.metadata.Area, entries);
        if (nearTwinDocs.length > 0) {
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
    };
}

/** The claim sections a knowledge doc must carry at least one of. */
export const CLAIM_SECTIONS = [
    "Facts",
    "Inferred",
    "Tested",
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
    return FRONT_MATTER_FIELDS.filter(
        ({ name, required }) => required && blank(name, meta[name]),
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
            "no claim section (Facts / Inferred / Tested / Open questions).",
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
 * Check the whole tree: per-doc {@link validateDoc} findings, a
 * `Supersedes` that names no doc, then the {@link nearTwinPairs}. An empty
 * report means compliant.
 * @param entries The docs to check.
 * @param read Resolves a root-relative doc path to its raw contents;
 * injected so the check is testable.
 * @param notes Environment notes (e.g. an unversioned root) appended to the
 * report; findings they describe are still reported per doc.
 * @returns The report text.
 */
export function checkDocs(
    entries: readonly DocEntry[],
    read: (path: string) => string,
    notes: readonly string[] = [],
): string {
    const paths = new Set(entries.map((entry) => entry.path));
    const lines = entries.flatMap((entry) => {
        const raw = read(entry.path);
        const findings = validateDoc(entry.path, raw);
        const supersedes = parseFrontMatter(raw).meta.Supersedes?.trim() ?? "";
        if (supersedes !== "" && !paths.has(supersedes)) {
            findings.push(`Supersedes names no doc: ${supersedes}.`);
        }
        return findings.map((finding) => `${entry.path}: ${finding}`);
    });
    for (const [doc, twin] of nearTwinPairs(entries)) {
        lines.push(
            `${doc.path} and ${twin.path}: near-twins — reconcile ` +
                "(merge, or repoint one).",
        );
    }
    lines.push(...notes);
    return lines.length === 0
        ? `All ${entries.length} docs comply.`
        : lines.join("\n");
}

export interface DocsToolDeps {
    /** Collects the docs to serve; injected so the tool is testable. */
    collect: () => DocEntry[];
    /** Whether a root-relative doc path exists; injected so writes are testable. */
    exists: (path: string) => boolean;
    /** Writes a root-relative doc path; injected so writes are testable. */
    write: (path: string, contents: string) => void;
    /** Reads a root-relative doc path's raw contents; injected so `check` is testable. */
    read: (path: string) => string;
    /** Environment notes appended to the `check` report; injected for testability. */
    notes?: readonly string[];
}

/** Delivers a rendered result to a session. */
export type PromptSender = (
    sessionID: CommandInvocation["sessionID"],
    text: string,
) => Promise<unknown>;

export interface DocsCommandDeps {
    /** Collects the docs to serve; injected so the command is testable. */
    collect: () => DocEntry[];
    /** Reads a root-relative doc path's raw contents; injected so `check` is testable. */
    read: (path: string) => string;
    /** Environment notes appended to the `check` report; injected for testability. */
    notes?: readonly string[];
    /** Delivers the rendered result to the session. */
    prompt: PromptSender;
}

/**
 * Build the `docs` tool from its dependencies.
 *
 * Registered with `codemode: false` so the tool stays on the provider's native
 * tool list. That option is exclusive: a tool defaults into Code Mode
 * (`codemode` defaults true) and is dropped from the native list; only
 * `codemode: false` keeps it natively callable. This tool is called directly,
 * so it opts out.
 * @param deps Runtime seams used on each call: the docs to serve, and the
 * write seam {@link DocsToolDeps} for `add`.
 * @returns The tool the host registers.
 */
export function createDocsTool(deps: DocsToolDeps): Info<typeof DOCS_INPUT> {
    const addDoc = (add: DocsAdd) => {
        const outcome = prepareAdd(add, deps.collect());
        if (outcome.action === "refuse") {
            return { content: outcome.reason, metadata: { written: false } };
        }
        const updated = deps.exists(outcome.path);
        deps.write(outcome.path, outcome.contents);
        const head = `${outcome.path} — ${updated ? "updated" : "created"}.`;
        const neighbours =
            outcome.neighbours.length > 0
                ? `\n\nNearby docs in the same area:\n\n${render(outcome.neighbours)}`
                : "";
        return {
            content: `${head}${neighbours}`,
            metadata: { written: true },
        };
    };
    return {
        name: "docs",
        description:
            "Discover the knowledge docs under the configured docs root " +
            "(default: the location's `docs/` directory). A blank search lists the " +
            MAX_RESULTS +
            " most recently changed docs (path — Area — date — Summary); a search ranks docs over title, path, keywords, body headings and code spans, area and summary, falling back to the closest matches. Every call returns at most " +
            MAX_RESULTS +
            " results and counts the rest. Search exactly `help` explains the ranking. `add` writes a new knowledge doc (or wholesale-replaces the doc at `path`) from a typed DTO — metadata becomes front-matter, the body must start with an H1; blank required fields, path traversal, non-.md targets and same-area near-twins are refused. `check` validates every doc against the convention (required front-matter, H1, claim sections, no hand-maintained Date, distinctive H1+Keywords, a Supersedes naming a doc in the tree, near-twins) and reports findings; an empty report means compliant. Read a matched file with the read tool.",
        input: DOCS_INPUT,
        options: { codemode: false },
        async execute(input) {
            const request = resolveRequest(input);
            if (request.verb === "add") {
                return addDoc(request.add);
            }
            if (request.verb === "check") {
                const entries = deps.collect();
                return {
                    content: checkDocs(entries, deps.read, deps.notes ?? []),
                    metadata: { checked: entries.length },
                };
            }
            if (request.verb === "help") {
                return {
                    content: explainRanking(),
                    metadata: { count: 0, omitted: 0 },
                };
            }
            const { entries, closest, omitted } = rankDocs(
                deps.collect(),
                request.search,
            );
            return {
                content: render(entries, { closest, omitted }),
                metadata: { count: entries.length, omitted },
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
        "Record this as durable knowledge in the docs root: call the `docs` " +
        "tool's `add` with a typed DTO (metadata Area/Keywords/Summary, body starting " +
        "with an H1) for:\n\n" +
        subject
    );
}

/**
 * Build the `/docs` command over the same core as the tool: a search ranks the
 * catalogue (`search <text>`, or bare text), `add <text>` asks the agent to
 * write the knowledge through the tool's typed `add`, and `check` validates
 * the tree against the convention.
 * @param deps Runtime seams used on each call.
 * @returns The command the host registers.
 */
export function createDocsCommand(deps: DocsCommandDeps): CommandDefinition {
    return {
        name: "docs",
        description:
            "Search the knowledge docs under the configured docs root, ranked; `add <text>` records new knowledge through the tool's typed `add`; `check` validates the convention; a blank search lists the " +
            MAX_RESULTS +
            " most recently changed.",
        async execute({ sessionID, prompt }) {
            const text = prompt.text.trim();
            if (isHelp(text)) {
                await deps.prompt(sessionID, explainRanking());
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
                    checkDocs(deps.collect(), deps.read, deps.notes ?? []),
                );
                return;
            }
            const query = lower === SEARCH_VERB ? rest.join(" ") : text;
            const { entries, closest, omitted } = rankDocs(
                deps.collect(),
                query,
            );
            await deps.prompt(sessionID, render(entries, { closest, omitted }));
        },
    };
}

/**
 * Resolve the plugin's docs root from its `root` option. Unset → the
 * location's `docs/` directory; `~` or `~/…` expands against the home
 * directory; absolute paths pass through; anything else resolves against the
 * plugin location. The resolved value is the knowledge tree itself — no
 * segment is appended. A non-string or blank value throws: a mistyped option
 * must fail loudly, not silently fall back to the wrong tree.
 * @param configured The raw option value as the host delivers it.
 * @param locationDirectory The directory the plugin instance loaded in.
 * @returns The docs root.
 */
export function resolveRoot(
    configured: unknown,
    locationDirectory: string,
): string {
    if (configured === undefined) {
        return join(locationDirectory, "docs");
    }
    if (typeof configured !== "string" || configured.trim() === "") {
        throw new Error(
            `docs plugin option 'root' must be a non-empty string path, ` +
                `got ${JSON.stringify(configured)}.`,
        );
    }
    const given = configured.trim();
    const expanded =
        given === "~" || given.startsWith("~/")
            ? join(homedir(), given.slice(1))
            : given;
    return isAbsolute(expanded) ? expanded : join(locationDirectory, expanded);
}

/**
 * Probe whether the docs root sits inside a git work tree, as `check`-report
 * notes. An unversioned root still works — dates fall back to file mtimes and
 * the knowledge has no history — so it is surfaced, not refused.
 * @param root The docs root to probe.
 * @returns The note lines; empty when the root is version-controlled.
 */
export function unversionedNote(root: string): readonly string[] {
    const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: root,
    });
    if (probe.status === 0) {
        return [];
    }
    return [
        "note: the docs root is not inside a git work tree — dates fall " +
            "back to file mtimes and the knowledge has no history. Put the " +
            "root under version control to fix both.",
    ];
}

export default Plugin.define({
    id: "docs",
    async setup(ctx) {
        const options = ctx.options as { root?: unknown } | undefined;
        const root = resolveRoot(options?.root, ctx.location.directory);
        const notes = unversionedNote(root);
        const collect = () =>
            collectDocs(root, (paths) => fallbackDates(root, paths));
        const read = (path: string) => readFileSync(join(root, path), "utf8");
        await ctx.tool.transform((editor) => {
            editor.add(
                createDocsTool({
                    collect,
                    exists: (path) => existsSync(join(root, path)),
                    write: (path, contents) => {
                        const target = join(root, path);
                        mkdirSync(dirname(target), { recursive: true });
                        writeFileSync(target, contents);
                    },
                    read,
                    notes,
                }),
            );
        });
        await ctx.command.transform((editor) => {
            editor.add(
                createDocsCommand({
                    collect,
                    read,
                    notes,
                    prompt: (sessionID, text) =>
                        ctx.session.prompt({ sessionID, text }),
                }),
            );
        });
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
                    "The entry point to the knowledge docs under the " +
                    "configured docs root: find the right file with the docs " +
                    "tool, read it, and record plans and task documentation " +
                    "for the next human or agent. Use at the start of " +
                    "unfamiliar work, when hunting for prior decisions or " +
                    "traps, and when closing out a session.",
                path: AbsolutePath.make(fileURLToPath(skillURL)),
                content: skill,
            });
        });
    },
});
