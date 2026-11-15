import {
    FRONT_MATTER_FIELDS,
    REVISION_PATTERN,
    h1Of,
    parseFrontMatter,
    outsideFenceLines,
    scanBody,
    serializeDoc,
    splitKeywords,
    titleOf,
    type AddMode,
    type DocEntry,
    type DocsAdd,
    type DocMetadata,
    type LakeProfile,
} from "./metadata.ts";
import {
    MAX_RESULTS,
    MIN_TERM_LENGTH,
    byScore,
    matches,
    render,
    termsOf,
} from "./ranking.ts";
import { compareText, resolvedTargetOf } from "./collection.ts";

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
export const REFUSE = "Rejected:";

/** The first blank required front-matter field, else null. */
export function blankRequiredField(metadata: DocMetadata): string | null {
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
export function modeOf(add: DocsAdd): AddMode | { reason: string } {
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
 * the structural checks or the target state. Callers establish create mode
 * first, so this checks the explanation alone.
 * @param add The typed request.
 * @returns True when a non-blank override explanation is present.
 */
export function overrideGiven(add: DocsAdd): boolean {
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
export function explicitTarget(
    given: string,
): { path: string } | { reason: string } {
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
export function targetOf(add: DocsAdd): { path: string } | { reason: string } {
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
export function identityQuery(
    title: string,
    keywords: readonly string[],
): string {
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
export function hasDistinctiveIdentity(query: string): boolean {
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
export function nearTwinRefusal(
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
export function overrideRefusal(add: DocsAdd): string | null {
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
export function revisionRefusal(add: DocsAdd): string | null {
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
 * The first required metadata field whose value carries a line break, or
 * null. The front-matter serialisation is flat `Key: value` lines: a break
 * inside a value would emit a second line that parses as its own field (a
 * hand-maintained `Date`, a shadowed `Keywords`), so multiline values are
 * refused at the boundary rather than corrupted on disk.
 * @param metadata The typed request metadata.
 * @returns The offending field name, or null.
 */
export function multilineMetadataField(metadata: DocMetadata): string | null {
    for (const { name } of FRONT_MATTER_FIELDS) {
        const value = metadata[name];
        const pieces = Array.isArray(value) ? value : [value];
        if (
            pieces.some(
                (piece) => typeof piece === "string" && /[\r\n]/.test(piece),
            )
        ) {
            return name;
        }
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
export function contentRefusal(add: DocsAdd): string | null {
    const blank = blankRequiredField(add.metadata);
    if (blank !== null) {
        return `${blank} is required and must not be blank.`;
    }
    const multiline = multilineMetadataField(add.metadata);
    if (multiline !== null) {
        return (
            `${multiline} must be a single line: line breaks in serialized ` +
            "front-matter would corrupt the doc's metadata (a second line " +
            "becomes a field of its own). Keep each value one line; pass " +
            "Keywords as several elements, not one delimited string."
        );
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
 * non-blank `allowNearTwinReason` explains the deliberate distinct doc. A
 * target the lake would never collect ({@link uncollectedSegment}) is
 * refused too: a successful write that search cannot see is a silent loss.
 * Target existence is the caller seam's to verify: creates must not overwrite
 * and replaces must exist.
 * @param add The typed request.
 * @param entries The current docs, for reconcile and neighbours.
 * @param options Soft-limit configuration and the target lake's profile.
 * @param options.maxDocLines Note when the body exceeds this line count; `0` disables.
 * @param options.profile The target lake's writing convention, for the
 * collection-visibility rule; defaults to `knowledge`.
 * @returns The prepared write, or the refusal.
 */
export function prepareAdd(
    add: DocsAdd,
    entries: readonly DocEntry[],
    options: { maxDocLines?: number; profile?: LakeProfile } = {},
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
    const target = resolvedTargetOf(add, options.profile ?? "knowledge");
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
export function longDocNotes(
    body: string,
    limit = DEFAULT_MAX_DOC_LINES,
): string[] {
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
export function blankMetaFields(meta: Record<string, string>): string[] {
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
export function nearTwinPairs(
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
export function resolveLink(from: string, target: string): string | null {
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
export interface InlineLink {
    /** The destination value. */
    readonly destination: string | undefined;
    /** The end value. */
    readonly end: number;
}

/**
 * Parse an inline `[text](target)` link starting at `start`.
 * @param line One source line.
 * @param start Index of the opening `[`.
 * @returns The destination and closing index, or null when the link is incomplete.
 */
export function inlineLinkAt(line: string, start: number): InlineLink | null {
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
export function inlineTargets(line: string): string[] {
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
export function isExternalTarget(target: string): boolean {
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
export interface DocCheck {
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
export function checkOne(
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
export function nearTwinFindings(entries: readonly DocEntry[]): string[] {
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
