import { createHash } from "node:crypto";
import { Schema } from "effect";

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
 * lines only — enough for the doc schema, so no YAML parser. CRLF files are
 * accepted (a hand-edited Windows checkout is still a doc); the writer always
 * emits LF, so the same bytes have one canonical form.
 * @param raw Full file contents.
 * @returns Parsed metadata and the body after the closing `---`.
 */
export function parseFrontMatter(raw: string): {
    meta: Record<string, string>;
    body: string;
} {
    const opener = /^---\r?\n/.exec(raw);
    if (opener === null) {
        return { meta: {}, body: raw };
    }
    const end = raw.indexOf("\n---", opener[0].length);
    if (end === -1) {
        return { meta: {}, body: raw };
    }
    const meta: Record<string, string> = {};
    for (const line of raw.slice(opener[0].length, end).split("\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) {
            continue;
        }
        const key = line.slice(0, colon).trim();
        if (key !== "") {
            meta[key] = line.slice(colon + 1).trim();
        }
    }
    return { meta, body: raw.slice(end + 4).replace(/^(?:\r?\n)+/, "") };
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
export function h1Of(body: string): string | undefined {
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
export function splitKeywords(value: string): string[] {
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
export interface Fence {
    /** The char value. */
    readonly char: "`" | "~";
    /** The length value. */
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
export function fenceOpener(line: string): Fence | null {
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
export function closesFence(line: string, fence: Fence): boolean {
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
export function outsideFenceLines(body: string): string[] {
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
export function stripTrailingHashes(text: string): string {
    return text.replace(/(?<![ #])[ #]+$/, "");
}

/** The body's indexable pieces, from one fence-aware walk of the source. */
export interface BodyScan {
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
export function scanBody(body: string): BodyScan {
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
export function stripInlineLinks(text: string): string {
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
export function plainProse(text: string): string {
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
export function withoutFences(body: string): string {
    return outsideFenceLines(body).join("\n");
}

/** Block prefixes that are never a wiki summary. */
export const SUMMARY_SKIP_PREFIXES = [
    "#",
    "|",
    ">",
    "<",
    "---",
    ":::",
    "![",
] as const;

/** Whether a blank-line-separated block is prose worth summarising. */
export function isSummaryBlock(block: string): boolean {
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
export function areaOf(meta: Record<string, string>, path: string): string {
    if (meta.Area !== undefined) {
        return meta.Area;
    }
    const segments = path.split("/");
    return segments.length > 1 ? (segments[0] ?? "") : "";
}

/** The doc's summary: front-matter, else a derived wiki paragraph, else "". */
export function summaryFor(
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
