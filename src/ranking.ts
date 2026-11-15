import {
    CLASS_LABELS,
    classGuidance,
    type DocClass,
    type DocEntry,
    type DocsAdd,
    type DocsInput,
    type LakeClass,
} from "./metadata.ts";

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
export function termsOf(query: string): string[] {
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
export const FIELDS: ReadonlyArray<
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

/** The match quality of one query term in one text field; values are {@link QUALITY}. */
export function quality(term: string, text: string): number {
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
export function sourceKey(entry: DocEntry): string {
    return entry.lake === "" ? "instructions" : entry.lake;
}

/**
 * Most recently changed first, then class precedence, then path ascending;
 * an empty date is oldest.
 */
export function byRecency(a: DocEntry, b: DocEntry): number {
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
export function capped(
    entries: DocEntry[],
): Pick<RankedDocs, "entries" | "omitted"> {
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
export function reserved(
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
export function byScore(
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
export function resultPrefix(
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
export function lakeOf(input: DocsInput): string | undefined {
    const lake = input.lake?.trim() ?? "";
    return lake === "" ? undefined : lake;
}

/** Add a lake selector to a request when one was given. */
export function requestWithLake<T extends object>(
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
