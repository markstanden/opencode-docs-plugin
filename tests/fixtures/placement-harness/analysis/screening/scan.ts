/**
 * Static-screening orchestration for one recorded trial.
 *
 * Reads the resulting documents, before/after states, the final response, the
 * task prompt and the recorded writes, applies the configured rules and
 * returns findings with hashed sources. The screen is advisory infrastructure:
 * it never modifies judge inputs, eligibility, outcomes, scores or guardrails,
 * and it is generated independently of any judge packet.
 */
import {
    docChanges,
    type DocumentationChange,
    type LakeDocument,
} from "../../ac/campaign.mts";
import type { PreservationInventorySpec } from "../model.ts";
import {
    claimMutationFindings,
    duplicationFindings,
    permissionFindings,
    sourceOf,
    structureFindings,
    transientWordingFindings,
    SCREENING_RULES_VERSION,
    type Finding,
    type FindingSource,
} from "./rules.ts";
import { scanInventory, type InventoryTrigger } from "./inventory.ts";

/** Everything one trial's static screen reads. */
export interface ScreenTrialInput {
    /** The scenario id the trial ran. */
    scenario: string;
    /** The exact task prompt. */
    taskPrompt: string;
    /** The trial's final answer. */
    finalAnswer: string;
    /** The knowledge-lake documents before the trial. */
    beforeDocs: LakeDocument[];
    /** The knowledge-lake documents after the trial. */
    afterDocs: LakeDocument[];
    /** The recorded writes report text. */
    writesText: string;
    /** Paths the trial changed. */
    changedPaths: string[];
    /** The scenario's configured preservation inventory, when present. */
    inventory?: PreservationInventorySpec | undefined;
    /** Configured transient-wording regex sources. */
    transientPatterns?: string[] | undefined;
    /** Durable-troubleshooting counterexample regex sources. */
    durableCounterexamples?: string[] | undefined;
    /** The recorded allowed mutation globs, when the campaign records them. */
    allowedGlobs?: string[] | undefined;
}

/** The screen result for one trial. */
export interface ScreenResult {
    /** Findings, stably sorted by source, span and rule. */
    findings: Finding[];
    /** Every hashed source the screen read, sorted by reference. */
    sources: FindingSource[];
    /** The recorded document change classification. */
    changes: DocumentationChange;
}

/**
 * Convert one inventory trigger into a finding.
 * @param trigger The trigger with its spans.
 * @param source The scanned document's source record.
 * @param scenario The scenario id.
 * @returns The finding.
 */
function triggerFinding(
    trigger: InventoryTrigger,
    source: FindingSource,
    scenario: string,
): Finding {
    const base = {
        ruleVersion: SCREENING_RULES_VERSION,
        applicability: scenario,
        authority: "mechanical" as const,
        source,
        excerpt: trigger.mention.text,
        span: { start: trigger.mention.start, end: trigger.mention.end },
        factId: trigger.factId,
    };
    if (trigger.kind === "obsolete-current") {
        return {
            ...base,
            ruleId: "fact-obsolete-current",
            category: "fact-obsolete-current",
            explanation:
                "the configured obsolete claim is presented as current; no local negation qualifies it",
        };
    }
    if (trigger.kind === "conflict") {
        return {
            ...base,
            ruleId: "fact-conflict",
            category: "fact-conflict",
            explanation: `the document asserts and locally negates the same fact; opposing assertion: ${JSON.stringify(trigger.other?.assertion ?? "")}`,
        };
    }
    return {
        ...base,
        ruleId: "fact-negation",
        category: "fact-negation",
        explanation: `a local negation cue ${JSON.stringify(trigger.negation?.text ?? "")} applies to this mention; a local cue does not by itself prove semantic loss`,
    };
}

/**
 * Convert one unrecognised inventory fact into an advisory finding.
 * @param factId The fact id.
 * @param factLabel The configured label.
 * @param source The scanned document's source record.
 * @param scenario The scenario id.
 * @returns The finding.
 */
function coverageFinding(
    factId: string,
    factLabel: string,
    source: FindingSource,
    scenario: string,
): Finding {
    return {
        ruleId: "fact-coverage-unknown",
        ruleVersion: SCREENING_RULES_VERSION,
        category: "fact-coverage-unknown",
        applicability: scenario,
        authority: "advisory",
        source,
        excerpt: "",
        span: { start: 0, end: 0 },
        factId,
        explanation: `no recognised mention of ${JSON.stringify(factLabel)}; a missing keyword does not prove loss, and an unrecognised paraphrase remains possible`,
    };
}

/**
 * Read every source the screen consults, hashed and sorted.
 * @param input The screen input.
 * @returns The source records.
 */
function sourcesOf(input: ScreenTrialInput): FindingSource[] {
    const sources: FindingSource[] = [
        sourceOf("final-response", "final.md", input.finalAnswer),
        sourceOf("task-prompt", "prompt.md", input.taskPrompt),
        sourceOf("recorded-write", "writes.txt", input.writesText),
        ...input.beforeDocs.map((doc) =>
            sourceOf("before-document", doc.path, doc.contents),
        ),
        ...input.afterDocs.map((doc) =>
            sourceOf("after-document", doc.path, doc.contents),
        ),
    ];
    return sources.sort(
        (left, right) =>
            left.reference.localeCompare(right.reference) ||
            left.kind.localeCompare(right.kind),
    );
}

/**
 * Transient-wording findings over the answer and every changed document.
 * @param input The screen input.
 * @param changedDocs The new or modified documents.
 * @returns Advisory findings.
 */
function wordingFindings(
    input: ScreenTrialInput,
    changedDocs: readonly LakeDocument[],
): Finding[] {
    const patterns = input.transientPatterns ?? [];
    if (patterns.length === 0) return [];
    const counterexamples = input.durableCounterexamples ?? [];
    return [
        ...transientWordingFindings({
            text: input.finalAnswer,
            reference: "final.md",
            kind: "final-response",
            scenario: input.scenario,
            patterns,
            counterexamples,
        }),
        ...changedDocs.flatMap((doc) =>
            transientWordingFindings({
                text: doc.contents,
                reference: doc.path,
                kind: "resulting-document",
                scenario: input.scenario,
                patterns,
                counterexamples,
            }),
        ),
    ];
}

/**
 * Permission findings, when the campaign records an allowed mutation set.
 * @param input The screen input.
 * @returns Mechanical findings for out-of-policy paths.
 */
function permissionFindingList(input: ScreenTrialInput): Finding[] {
    const allowedGlobs = input.allowedGlobs ?? [];
    if (allowedGlobs.length === 0) return [];
    return permissionFindings({
        changedPaths: input.changedPaths,
        allowedGlobs,
        taskPrompt: input.taskPrompt,
        writesText: input.writesText,
        reference: "writes.txt",
        scenario: input.scenario,
    });
}

/**
 * Inventory findings over every changed document.
 * @param input The screen input.
 * @param changedDocs The new or modified documents.
 * @returns Trigger and coverage-unknown findings.
 */
function inventoryFindingList(
    input: ScreenTrialInput,
    changedDocs: readonly LakeDocument[],
): Finding[] {
    const inventory = input.inventory;
    if (inventory === undefined) return [];
    return changedDocs.flatMap((doc) => {
        const source = sourceOf("resulting-document", doc.path, doc.contents);
        const scan = scanInventory(doc.contents, inventory);
        const triggerList = scan.triggers.map((trigger) =>
            triggerFinding(trigger, source, input.scenario),
        );
        const coverageList = scan.missing.map((factId) => {
            const fact = inventory.facts.find((entry) => entry.id === factId);
            return coverageFinding(
                factId,
                fact?.label ?? factId,
                source,
                input.scenario,
            );
        });
        return [...triggerList, ...coverageList];
    });
}

/**
 * Screen one recorded trial.
 * @param input Everything the screen reads.
 * @returns Findings, hashed sources and the change classification.
 */
export function screenTrial(input: ScreenTrialInput): ScreenResult {
    const changes = docChanges(input.beforeDocs, input.afterDocs);
    const before = new Map(
        input.beforeDocs.map((doc) => [doc.path, doc.contents]),
    );
    const changedDocs = input.afterDocs.filter(
        (doc) => before.get(doc.path) !== doc.contents,
    );
    const findings: Finding[] = [
        ...changedDocs.flatMap((doc) => structureFindings(doc, input.scenario)),
        ...claimMutationFindings({
            answer: input.finalAnswer,
            changes,
            reference: "final.md",
            scenario: input.scenario,
        }),
        ...duplicationFindings(
            input.beforeDocs,
            input.afterDocs,
            input.scenario,
        ),
        ...wordingFindings(input, changedDocs),
        ...permissionFindingList(input),
        ...inventoryFindingList(input, changedDocs),
    ];
    findings.sort(
        (left, right) =>
            left.source.reference.localeCompare(right.source.reference) ||
            left.span.start - right.span.start ||
            left.ruleId.localeCompare(right.ruleId),
    );
    return { findings, sources: sourcesOf(input), changes };
}
