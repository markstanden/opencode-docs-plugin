/**
 * The package's public surface is a contract, not whatever the modules happen
 * to export. The split into focused modules briefly widened it from 99 names
 * to 231 through `export *`; nothing failed, because nothing pinned it. This
 * suite freezes the documented names so an accidental leak is a red test and
 * an intentional addition is a deliberate edit here.
 *
 * The runtime names below are the value exports. The type-only exports are
 * pinned by {@link PublicTypeSurface}, which `npm run typecheck` verifies.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as docs from "../src/index.ts";

/** The documented runtime exports, sorted. */
const PUBLIC_VALUES = [
    "CLAIM_SECTIONS",
    "CLASS_LABELS",
    "CLASS_RANK",
    "DEFAULT_MAX_DOC_LINES",
    "DEFAULT_PER_LAKE_QUOTA",
    "DOCS_INPUT",
    "EXCLUDED_AREAS",
    "FIELD_WEIGHTS",
    "FRONT_MATTER_FIELDS",
    "LAKE_CLASSES",
    "MAX_CHECK_CHARS",
    "MAX_RESULTS",
    "MAX_TEMP_ATTEMPTS",
    "MIN_TERM_LENGTH",
    "NUDGED_TOOLS",
    "OPERATION_JOURNAL_ENV",
    "OPERATION_JOURNAL_KEY_ENV",
    "QUALITY",
    "README_EXCLUDED_DIRS",
    "RECORD_CONVERSATION_INSTRUCTION",
    "RECORD_NUDGE",
    "REPO_LAKES_FILE",
    "REVISION_PATTERN",
    "checkDocs",
    "classGuidance",
    "collectDocPaths",
    "collectDocs",
    "collectReadmes",
    "createDocsCommand",
    "createDocsTool",
    "createLake",
    "createLakes",
    "docNotes",
    "explainRanking",
    "fallbackDates",
    "gitDates",
    "hasClaimSection",
    "helpText",
    "identifiersOf",
    "isHelp",
    "isSearchMiss",
    "linkFindings",
    "markdownTargets",
    "matches",
    "missNudge",
    "missNudgeFor",
    "missingRootNote",
    "nearTwins",
    "parseFrontMatter",
    "physicalTargetKey",
    "prepareAdd",
    "proseOf",
    "rankDocs",
    "readmePaths",
    "reconcileQuery",
    "render",
    "resolveLakes",
    "resolveNonNegativeInt",
    "resolveNudge",
    "resolveRequest",
    "resolveRoot",
    "revisionOf",
    "score",
    "serializeDoc",
    "slugify",
    "summaryOf",
    "targetLockDirectory",
    "targetLockPath",
    "titleOf",
    "toEntry",
    "uncollectedSegment",
    "unversionedNote",
    "validateDoc",
    "writeFullBytes",
] as const;

/**
 * The documented type-only exports. Referencing each one here makes a missing
 * or renamed type a typecheck failure, alongside the runtime assertion.
 */
export type PublicTypeSurface = readonly [
    docs.AddMode,
    docs.AddOutcome,
    docs.CollectOptions,
    docs.Containment,
    docs.DocClass,
    docs.DocEntry,
    docs.DocMetadata,
    docs.DocsAdd,
    docs.DocsCommandDeps,
    docs.DocsInput,
    docs.DocsPluginOptions,
    docs.DocsRequest,
    docs.DocsToolDeps,
    docs.Lake,
    docs.LakeClass,
    docs.LakeInfo,
    docs.LakeProfile,
    docs.LakeSpec,
    docs.NudgeCall,
    docs.PromptSender,
    docs.PublicationSeams,
    docs.PublicationStage,
    docs.RankedDocs,
    docs.RuntimeInput,
    docs.TempFactory,
];

test("the public entry point exposes exactly the documented names", () => {
    // Arrange: the default plugin export plus every documented value export.
    const expected = [...PUBLIC_VALUES, "default"].sort();

    // Act
    const actual = Object.keys(docs).sort();

    // Assert
    assert.deepEqual(actual, expected);
});
