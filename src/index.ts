import { Plugin, Skill } from "@opencode/plugin";
import { AbsolutePath } from "@opencode/schema/schema";
import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { Info, Result } from "@opencode/plugin/promise/tool";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DOCS_INPUT } from "./metadata.ts";
import { DEFAULT_PER_LAKE_QUOTA, helpText, isHelp } from "./ranking.ts";
import { collectReadmes, fallbackDates } from "./collection.ts";
import { DEFAULT_MAX_DOC_LINES } from "./convention.ts";
import { journalOperation } from "./journal.ts";
import {
    checkLakes,
    createLakes,
    executeRequest,
    lakeInfo,
    missNudgeFor,
    resolveLakes,
    resolveNudge,
    resolveNonNegativeInt,
    RECORD_NUDGE,
    TWIN_DESCRIPTION,
    runtimeOf,
    searchDocs,
    type DocsCommandDeps,
    type DocsPluginOptions,
    type DocsToolDeps,
} from "./lakes.ts";

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

// The public surface is the pre-split one. Module helpers are exported for
// cross-module use only; re-exporting them wholesale would quietly widen the
// package API, so each public name is listed once here.
export {
    type AddMode,
    CLASS_LABELS,
    DOCS_INPUT,
    type DocClass,
    type DocEntry,
    type DocMetadata,
    type DocsAdd,
    type DocsInput,
    EXCLUDED_AREAS,
    FRONT_MATTER_FIELDS,
    type LakeClass,
    type LakeProfile,
    REVISION_PATTERN,
    classGuidance,
    identifiersOf,
    parseFrontMatter,
    proseOf,
    revisionOf,
    serializeDoc,
    summaryOf,
    titleOf,
    toEntry,
} from "./metadata.ts";
export {
    type AddOutcome,
    CLAIM_SECTIONS,
    DEFAULT_MAX_DOC_LINES,
    checkDocs,
    docNotes,
    hasClaimSection,
    linkFindings,
    markdownTargets,
    nearTwins,
    prepareAdd,
    reconcileQuery,
    slugify,
    validateDoc,
} from "./convention.ts";
export {
    CLASS_RANK,
    DEFAULT_PER_LAKE_QUOTA,
    type DocsRequest,
    FIELD_WEIGHTS,
    type LakeInfo,
    MAX_CHECK_CHARS,
    MAX_RESULTS,
    MIN_TERM_LENGTH,
    QUALITY,
    type RankedDocs,
    explainRanking,
    helpText,
    isHelp,
    matches,
    rankDocs,
    render,
    resolveRequest,
    score,
} from "./ranking.ts";
export {
    type CollectOptions,
    README_EXCLUDED_DIRS,
    collectDocPaths,
    collectDocs,
    collectReadmes,
    fallbackDates,
    gitDates,
    readmePaths,
    uncollectedSegment,
} from "./collection.ts";
export {
    type Containment,
    type DocsCommandDeps,
    type DocsPluginOptions,
    type DocsToolDeps,
    LAKE_CLASSES,
    type Lake,
    type LakeSpec,
    MAX_TEMP_ATTEMPTS,
    NUDGED_TOOLS,
    type NudgeCall,
    type PromptSender,
    type PublicationSeams,
    type PublicationStage,
    RECORD_NUDGE,
    REPO_LAKES_FILE,
    type RuntimeInput,
    type TempFactory,
    createLake,
    createLakes,
    isSearchMiss,
    missNudge,
    missNudgeFor,
    missingRootNote,
    physicalTargetKey,
    resolveLakes,
    resolveNonNegativeInt,
    resolveNudge,
    resolveRoot,
    targetLockDirectory,
    targetLockPath,
    unversionedNote,
    writeFullBytes,
} from "./lakes.ts";
export { OPERATION_JOURNAL_ENV, OPERATION_JOURNAL_KEY_ENV } from "./journal.ts";

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
        execute(input, context) {
            const base = {
                schemaVersion: 1 as const,
                tool: name,
                surface: codemode
                    ? ("codemode-twin" as const)
                    : ("native" as const),
                input,
                sessionID: context?.sessionID,
                messageID: context?.messageID,
                callID: context?.id,
            };
            try {
                const result = executeRequest(runtime, input);
                journalOperation({
                    ...base,
                    status: "completed",
                    result: {
                        content: result.content,
                        metadata: result.metadata,
                    },
                });
                return Promise.resolve(result);
            } catch (error) {
                journalOperation({
                    ...base,
                    status: "error",
                    error: String(error),
                });
                return Promise.reject(error);
            }
        },
    };
}

/** `/docs` verbs: `search <text>` is explicit; bare text searches too. */
const SEARCH_VERB = "search";
const ADD_VERB = "add";
const CHECK_VERB = "check";

/**
 * The instruction delivered by a bare `/docs`: the user has already decided
 * that the conversation established something worth preserving, so the agent
 * chooses the finding, the lake and whether to update or create.
 *
 * This wording is the command's model-visible contract, held here as one named
 * component. It deliberately appears in no tool description, skill or
 * always-loaded prompt: only invoking the command delivers it.
 */
export const RECORD_CONVERSATION_INSTRUCTION =
    "Identify the reusable knowledge established in this conversation and " +
    "preserve it using the docs tool. Search for related documentation " +
    "first, then update an existing note or create one in the appropriate " +
    "lake. Capture the findings, reasoning and constraints needed to apply " +
    "the knowledge later. Verify that the saved content accurately reflects " +
    "what we established, then briefly report what you stored and where.";

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
 * Build the `/docs` command over the same core as the tool: a bare `/docs`
 * delivers {@link RECORD_CONVERSATION_INSTRUCTION} so the agent records what
 * the conversation established, a search ranks the catalogue
 * (`search <text>`, or bare text), `add <text>` asks the agent to write the
 * knowledge through the tool's typed `add`, and `check` validates the
 * knowledge lakes.
 * @param deps Runtime seams used on each call.
 * @returns The command the host registers.
 */
export function createDocsCommand(deps: DocsCommandDeps): CommandDefinition {
    const runtime = runtimeOf(deps);
    return {
        name: "docs",
        description:
            "Search the configured knowledge lakes, ranked, plus nested project `README.md` files (search only); `add <text>` records new knowledge through the tool's typed `add`; `check` validates the lakes; bare `/docs` records the conversation's durable knowledge.",
        async execute({ sessionID, prompt }) {
            const text = prompt.text.trim();
            if (text === "") {
                await deps.prompt(sessionID, RECORD_CONVERSATION_INSTRUCTION);
                return;
            }
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
