/**
 * Configured preservation inventories and local assertion scanning.
 *
 * A missing keyword never proves a lost fact and a matching keyword never
 * proves truth: this module reports recognised mentions, local negation and
 * conflicts between assertions, with exact spans, and leaves every semantic
 * verdict to the judge. Inventories are data (the manifest scenario's
 * configuration); no fact name is hard-coded here.
 *
 * Summary and Facts are scanned as separate surfaces, and each assertion is
 * evaluated independently so a rejecting clause in one sentence cannot
 * condemn an affirmative claim in another. Failed-approach bullets are
 * context, not affirmative claims.
 */
import type {
    PreservationFactSpec,
    PreservationInventorySpec,
} from "../model.ts";

/** One independently evaluated assertion with its document offsets. */
export interface Assertion {
    /** The assertion text. */
    text: string;
    /** The full bullet or Summary line the assertion came from. */
    context: string;
    /** Offset of the assertion start within the document. */
    start: number;
    /** Offset just past the assertion end within the document. */
    end: number;
}

/** The claim surface of one document. */
export interface ClaimSurface {
    /** The Summary value, or an empty string. */
    summary: string;
    /** Assertions of the Summary line with document offsets. */
    summaryAssertions: Assertion[];
    /** Fact bullets with their document offsets. */
    facts: Array<{ text: string; offset: number }>;
    /** Failed-approach bullets, kept as review context only. */
    failedApproaches: Array<{ text: string; offset: number }>;
}

/** One span of document text. */
export interface Span {
    /** The matched text. */
    text: string;
    /** Offset of the match start within the document. */
    start: number;
    /** Offset just past the match end within the document. */
    end: number;
}

/** One inventory trigger, with its context and exact spans. */
export interface InventoryTrigger {
    /** What kind of trigger this is. */
    kind: "negated-fact" | "obsolete-current" | "conflict";
    /** The inventory fact id. */
    factId: string;
    /** The full bullet or Summary text the assertion came from. */
    context: string;
    /** The evaluated assertion text. */
    assertion: string;
    /** The assertion's span within the document. */
    span: { start: number; end: number };
    /** The fact mention's span. */
    mention: Span;
    /** The negation cue's span, when one applied. */
    negation?: Span | undefined;
    /** The opposing assertion in a conflict. */
    other?:
        { assertion: string; span: { start: number; end: number } } | undefined;
}

/** The result of scanning one document against an inventory. */
export interface InventoryScan {
    /** Local negation, obsolete-current and conflict triggers, span-sorted. */
    triggers: InventoryTrigger[];
    /** Still-valid facts with no recognised mention. */
    missing: string[];
    /** Facts with at least one affirmative (or, for obsolete claims, any) mention. */
    recognised: string[];
}

/** A section heading line (text starts with a non-blank character). */
const HEADING = /^#{2,3}[ \t]+([^ \t].*)$/;
/** A bullet line (text starts with a non-blank character). */
const BULLET = /^[ \t]*[-*][ \t]+([^ \t].*)$/;
/** A Summary line. */
const SUMMARY = /^Summary:(.*)$/i;
/** Sentence/clause separators used to evaluate assertions independently. */
const SEPARATOR = /;\s*|\.\s+(?=[A-Z`])/g;

/**
 * Split text into assertions, keeping each assertion's document offsets.
 * @param text The text to split.
 * @param baseOffset The offset of `text` within the document.
 * @param context The full bullet or Summary line the text belongs to.
 * @returns The nonblank assertions in order.
 */
export function assertionsOf(
    text: string,
    baseOffset: number,
    context = text,
): Assertion[] {
    const assertions: Assertion[] = [];
    let cursor = 0;
    SEPARATOR.lastIndex = 0;
    for (
        let match = SEPARATOR.exec(text);
        match !== null;
        match = SEPARATOR.exec(text)
    ) {
        pushAssertion(
            assertions,
            text,
            baseOffset,
            cursor,
            match.index,
            context,
        );
        cursor = match.index + match[0].length;
    }
    pushAssertion(assertions, text, baseOffset, cursor, text.length, context);
    return assertions;
}

/**
 * Append one trimmed, nonblank assertion slice.
 * @param assertions The accumulator.
 * @param text The whole text.
 * @param baseOffset The text's document offset.
 * @param from Slice start.
 * @param to Slice end.
 * @param context The full bullet or Summary line.
 */
function pushAssertion(
    assertions: Assertion[],
    text: string,
    baseOffset: number,
    from: number,
    to: number,
    context: string,
): void {
    const raw = text.slice(from, to);
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const leading = raw.length - raw.trimStart().length;
    assertions.push({
        text: trimmed,
        context,
        start: baseOffset + from + leading,
        end: baseOffset + from + leading + trimmed.length,
    });
}

/**
 * Read a document's Summary, Facts and Failed-approach surfaces with offsets.
 * @param document The document body.
 * @returns The claim surface.
 */
export function claimSurfaceOf(document: string): ClaimSurface {
    const surface: ClaimSurface = {
        summary: "",
        summaryAssertions: [],
        facts: [],
        failedApproaches: [],
    };
    let section: "none" | "facts" | "failed" = "none";
    let offset = 0;
    for (const line of document.split("\n")) {
        section = lineSection(surface, line, offset, section);
        offset += line.length + 1;
    }
    return surface;
}

/**
 * Apply one document line to the claim surface.
 * @param surface The claim surface accumulator.
 * @param line The raw line.
 * @param offset The line's document offset.
 * @param section The section state before this line.
 * @returns The section state after this line.
 */
function lineSection(
    surface: ClaimSurface,
    line: string,
    offset: number,
    section: "none" | "facts" | "failed",
): "none" | "facts" | "failed" {
    const trimmed = line.trim();
    const heading = HEADING.exec(trimmed);
    if (heading !== null) return sectionOf((heading[1] ?? "").trim());
    const summary = SUMMARY.exec(trimmed);
    if (summary !== null) {
        recordSummary(surface, line, offset, (summary[1] ?? "").trim());
        return section;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null && section !== "none") {
        recordBullet(surface, bullet[1] ?? "", line, offset, section);
    }
    return section;
}

/**
 * Record a Summary line's value and assertions.
 * @param surface The claim surface.
 * @param line The raw line.
 * @param offset The line's document offset.
 * @param value The trimmed Summary value.
 */
function recordSummary(
    surface: ClaimSurface,
    line: string,
    offset: number,
    value: string,
): void {
    surface.summary = value;
    surface.summaryAssertions =
        value === ""
            ? []
            : assertionsOf(value, offset + line.indexOf(value), line.trim());
}

/**
 * Record one bullet line in its section.
 * @param surface The claim surface.
 * @param text The bullet text.
 * @param line The raw line.
 * @param offset The line's document offset.
 * @param section The current section.
 */
function recordBullet(
    surface: ClaimSurface,
    text: string,
    line: string,
    offset: number,
    section: "facts" | "failed",
): void {
    const entry = { text, offset: offset + line.indexOf(text) };
    if (section === "facts") surface.facts.push(entry);
    else surface.failedApproaches.push(entry);
}

/**
 * Classify a section heading for claim-surface purposes.
 * @param name The heading text.
 * @returns The section kind.
 */
function sectionOf(name: string): "none" | "facts" | "failed" {
    if (/^facts$/i.test(name)) return "facts";
    if (/^failed\s+(approaches|attempts)$/i.test(name)) return "failed";
    return "none";
}

/**
 * Find the first match of a regex source in an assertion, as a span.
 * @param source The regex source.
 * @param assertion The assertion.
 * @param baseOffset The assertion's document offset.
 * @returns The span, or undefined.
 */
function spanIn(
    source: string,
    assertion: Assertion,
    baseOffset: number,
): Span | undefined {
    const match = new RegExp(source, "i").exec(assertion.text);
    if (match === null) return undefined;
    return {
        text: match[0],
        start: baseOffset + match.index,
        end: baseOffset + match.index + match[0].length,
    };
}

/** A fact mention evaluated inside one assertion. */
interface Mention {
    /** The assertion the mention sits in. */
    assertion: Assertion;
    /** The mention span. */
    span: Span;
    /** The negation cue span when the mention is locally negated. */
    negation: Span | undefined;
}

/**
 * Collect every mention of one fact across the Summary and Facts assertions.
 * @param fact The configured fact.
 * @param assertions The assertions to scan, with document offsets.
 * @param negationCues The inventory's negation cue sources.
 * @returns The mentions in document order.
 */
function mentionsOf(
    fact: PreservationFactSpec,
    assertions: readonly Assertion[],
    negationCues: readonly string[],
): Mention[] {
    const patterns = fact.obsoleteCurrentPatterns ?? fact.mentionPatterns ?? [];
    const mentions: Mention[] = [];
    for (const assertion of assertions) {
        for (const pattern of patterns) {
            const span = spanIn(pattern, assertion, assertion.start);
            if (span === undefined) continue;
            const negation = negationCues
                .map((cue) => spanIn(cue, assertion, assertion.start))
                .find((cue): cue is Span => cue !== undefined);
            mentions.push({ assertion, span, negation });
            break;
        }
    }
    return mentions;
}

/**
 * Build the triggers one fact's mentions imply.
 * @param fact The configured fact.
 * @param mentions The fact's mentions.
 * @returns Triggers for local negation, obsolete-current claims and conflicts.
 */
function factTriggers(
    fact: PreservationFactSpec,
    mentions: readonly Mention[],
): InventoryTrigger[] {
    const obsolete = fact.obsoleteCurrentPatterns !== undefined;
    const triggers: InventoryTrigger[] = [];
    const affirmative = mentions.filter(
        (mention) => mention.negation === undefined,
    );
    for (const mention of mentions) {
        const base = {
            factId: fact.id,
            context: mention.assertion.context,
            assertion: mention.assertion.text,
            span: {
                start: mention.assertion.start,
                end: mention.assertion.end,
            },
            mention: mention.span,
        };
        if (obsolete) {
            if (mention.negation === undefined) {
                triggers.push({
                    ...base,
                    kind: "obsolete-current",
                });
            }
            continue;
        }
        if (mention.negation === undefined) continue;
        triggers.push({
            ...base,
            kind: "negated-fact",
            negation: mention.negation,
        });
        const opposing = affirmative[0];
        if (opposing !== undefined && opposing !== mention) {
            triggers.push({
                ...base,
                kind: "conflict",
                negation: mention.negation,
                other: {
                    assertion: opposing.assertion.text,
                    span: {
                        start: opposing.assertion.start,
                        end: opposing.assertion.end,
                    },
                },
            });
        }
    }
    return triggers;
}

/**
 * Scan one document against a configured inventory.
 * @param document The document body.
 * @param inventory The scenario's configured inventory.
 * @returns Triggers with spans, plus recognised and missing facts.
 */
export function scanInventory(
    document: string,
    inventory: PreservationInventorySpec,
): InventoryScan {
    const surface = claimSurfaceOf(document);
    const assertions: Assertion[] = [
        ...surface.summaryAssertions,
        ...surface.facts.flatMap((fact) =>
            assertionsOf(fact.text, fact.offset, fact.text),
        ),
    ];
    const triggers: InventoryTrigger[] = [];
    const missing: string[] = [];
    const recognised: string[] = [];
    for (const fact of inventory.facts) {
        const mentions = mentionsOf(fact, assertions, inventory.negationCues);
        triggers.push(...factTriggers(fact, mentions));
        const obsolete = fact.obsoleteCurrentPatterns !== undefined;
        seenFact(fact, mentions, obsolete, missing, recognised);
    }
    triggers.sort((left, right) => left.span.start - right.span.start);
    return { triggers, missing, recognised };
}

/**
 * Record whether a fact is recognised or missing.
 * @param fact The configured fact.
 * @param mentions The fact's mentions.
 * @param obsolete Whether the fact is an obsolete-claim fact.
 * @param missing The missing accumulator.
 * @param recognised The recognised accumulator.
 */
function seenFact(
    fact: PreservationFactSpec,
    mentions: readonly Mention[],
    obsolete: boolean,
    missing: string[],
    recognised: string[],
): void {
    if (obsolete) {
        if (mentions.length > 0) recognised.push(fact.id);
        return;
    }
    const affirmative = mentions.some(
        (mention) => mention.negation === undefined,
    );
    if (affirmative) recognised.push(fact.id);
    else missing.push(fact.id);
}

/** The deterministic cross-check result for one replacement document. */
export interface PreservationScreenResult {
    /** Rejected on an explicit contradiction; unknown when a fact is absent. */
    status: "accepted" | "rejected" | "unknown";
    /** Still-valid facts with no recognised mention. */
    missing: string[];
    /** Whether a current obsolete claim survived. */
    obsolete: boolean;
    /** Fact ids with a local contradiction or conflict. */
    contradicted: string[];
    /** The triggers behind a rejection, with full context and spans. */
    triggers: InventoryTrigger[];
    /** Always true: a keyword screen never decides the semantic guardrail. */
    requiresSemanticReview: true;
}

/**
 * Screen a replacement document against an inventory as a pre-check.
 *
 * This is a cross-check only. `accepted` still requires the evidence-based
 * semantic review; `unknown` means a keyword was absent, never that a fact
 * was lost.
 * @param document The resulting document body.
 * @param inventory The scenario's configured inventory.
 * @returns The screen result with every rejection's triggers.
 */
export function preservationScreen(
    document: string,
    inventory: PreservationInventorySpec,
): PreservationScreenResult {
    const scan = scanInventory(document, inventory);
    const obsolete = scan.triggers.some(
        (trigger) => trigger.kind === "obsolete-current",
    );
    const contradicted = [
        ...new Set(
            scan.triggers
                .filter((trigger) => trigger.kind !== "obsolete-current")
                .map((trigger) => trigger.factId),
        ),
    ];
    const status = obsolete
        ? "rejected"
        : contradicted.length > 0
          ? "rejected"
          : scan.missing.length > 0
            ? "unknown"
            : "accepted";
    return {
        status,
        missing: scan.missing,
        obsolete,
        contradicted,
        triggers: scan.triggers,
        requiresSemanticReview: true,
    };
}
