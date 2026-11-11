/**
 * Static-screening orchestration for one recorded trial.
 *
 * Reads the resulting documents, before/after states, the final response, the
 * task prompt and the recorded writes, applies the configured rules and
 * returns findings with hashed, root-relative sources and trial provenance.
 * Every input is a {@link Loaded} record: a rule runs only with sufficient
 * evidence, so an unobserved change can never be published as a mechanical
 * contradiction. The screen is advisory infrastructure: it never modifies
 * judge inputs, eligibility, outcomes, scores or guardrails, and it is
 * generated independently of any judge packet.
 */
import {
    docChanges,
    type DocumentationChange,
    type LakeDocument,
} from "../../ac/campaign.mts";
import type {
    MutationPolicySpec,
    PreservationInventorySpec,
} from "../model.ts";
import type { Loaded } from "../records.ts";
import {
    claimMutationFindings,
    duplicationFindings,
    permissionFindings,
    sourceOf,
    structureFindings,
    transientWordingFindings,
    SCREENING_RULES_VERSION,
    type EvidenceRole,
    type Finding,
    type FindingDraft,
    type FindingSource,
    type SourceKind,
    type TrialIdentity,
} from "./rules.ts";
import { scanInventory, type InventoryTrigger } from "./inventory.ts";

/** The root-relative references a screen cites. */
export interface ScreenPaths {
    /** The trial's prompt file. */
    prompt: string;
    /** The trial's final answer file. */
    finalAnswer: string;
    /** The trial's writes report. */
    writes: string;
    /** The before-trial lake document root. */
    beforeRoot: string;
    /** The after-trial lake document root. */
    afterRoot: string;
}

/** Everything one trial's static screen reads. */
export interface ScreenTrialInput {
    /** The trial identity this screen belongs to. */
    trial: TrialIdentity;
    /** The exact task prompt. */
    taskPrompt: Loaded<string>;
    /** The trial's final answer. */
    finalAnswer: Loaded<string>;
    /** The knowledge-lake documents before the trial. */
    beforeDocs: Loaded<LakeDocument[]>;
    /** The knowledge-lake documents after the trial. */
    afterDocs: Loaded<LakeDocument[]>;
    /** The recorded writes report text. */
    writesText: Loaded<string>;
    /** The root-relative references for the cited evidence. */
    paths: ScreenPaths;
    /** The scenario's configured preservation inventory, when present. */
    inventory?: PreservationInventorySpec | undefined;
    /** Configured transient-wording regex sources. */
    transientPatterns?: string[] | undefined;
    /** Durable-troubleshooting counterexample regex sources. */
    durableCounterexamples?: string[] | undefined;
    /** The scenario's recorded mutation policy, when the campaign declares one. */
    mutationPolicy?: MutationPolicySpec | undefined;
}

/** The screen result for one trial. */
export interface ScreenResult {
    /** Findings, stably sorted by source, span and rule. */
    findings: Finding[];
    /** Every hashed source the screen read, sorted by reference. */
    sources: FindingSource[];
    /** The recorded document change classification, or null when unobservable. */
    changes: DocumentationChange | null;
}

/** Map one source kind to the evidence role it plays in a trial. */
const ROLE_OF: Record<SourceKind, EvidenceRole> = {
    "before-document": "before",
    "after-document": "after",
    "resulting-document": "after",
    "final-response": "response",
    "task-prompt": "prompt",
    "recorded-write": "writes",
};

/**
 * Rewrite one source's tree-relative reference to its root-relative identity.
 * Identity is positional, never content-derived: two trials may hold identical
 * final answers and still cite distinguishable sources.
 * @param source The source with a tree-relative or label reference.
 * @param paths The trial's root-relative references.
 * @returns The source with a root-relative reference.
 */
function rooted(source: FindingSource, paths: ScreenPaths): FindingSource {
    switch (source.kind) {
        case "before-document":
            return {
                ...source,
                reference: `${paths.beforeRoot}/${source.reference}`,
            };
        case "after-document":
        case "resulting-document":
            return {
                ...source,
                reference: `${paths.afterRoot}/${source.reference}`,
            };
        case "final-response":
            return { ...source, reference: paths.finalAnswer };
        case "task-prompt":
            return { ...source, reference: paths.prompt };
        case "recorded-write":
            return { ...source, reference: paths.writes };
    }
}

/**
 * Attach the trial identity, evidence role and root-relative source to one
 * rule-produced finding.
 * @param draft The rule finding.
 * @param input The screen input.
 * @returns The finding with provenance.
 */
function withProvenance(draft: FindingDraft, input: ScreenTrialInput): Finding {
    return {
        ...draft,
        trial: input.trial,
        role: ROLE_OF[draft.source.kind],
        source: rooted(draft.source, input.paths),
    };
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
): FindingDraft {
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
): FindingDraft {
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
 * Read every available source the screen consults, hashed, rooted and sorted.
 * A missing input contributes no source, so no hash can imply it was read.
 * @param input The screen input.
 * @returns The source records.
 */
function sourcesOf(input: ScreenTrialInput): FindingSource[] {
    const sources: FindingSource[] = [];
    const add = (source: FindingSource): void => {
        sources.push(rooted(source, input.paths));
    };
    if (input.finalAnswer.state === "available") {
        add(sourceOf("final-response", "final.md", input.finalAnswer.value));
    }
    if (input.taskPrompt.state === "available") {
        add(sourceOf("task-prompt", "prompt.md", input.taskPrompt.value));
    }
    if (input.writesText.state === "available") {
        add(sourceOf("recorded-write", "writes.txt", input.writesText.value));
    }
    if (input.beforeDocs.state === "available") {
        for (const doc of input.beforeDocs.value) {
            add(sourceOf("before-document", doc.path, doc.contents));
        }
    }
    if (input.afterDocs.state === "available") {
        for (const doc of input.afterDocs.value) {
            add(sourceOf("after-document", doc.path, doc.contents));
        }
    }
    return sources.sort(
        (left, right) =>
            left.reference.localeCompare(right.reference) ||
            left.kind.localeCompare(right.kind),
    );
}

/** One recorded change line: verb, path and artefact kind. */
const WRITE_LINE =
    /^(?:added|modified|removed|created|deleted): (.+?) \([a-z]+\)$/;

/**
 * Extract changed paths from a recorded writes report. Only the report's
 * change lines count: summary headers and repetition sections describe the
 * same changes again and must not become phantom paths.
 * @param writesText The report text.
 * @returns The distinct changed paths, in report order.
 */
function changedPathsOf(writesText: string): string[] {
    const paths = new Set<string>();
    for (const line of writesText.split("\n")) {
        const match = WRITE_LINE.exec(line.trim());
        if (match?.[1] !== undefined) paths.add(match[1]);
    }
    return [...paths];
}

/**
 * Transient-wording findings over the answer and every changed document. The
 * answer check needs the answer; the document check needs the after state.
 * @param input The screen input.
 * @param changedDocs The new or modified documents.
 * @returns Advisory findings.
 */
function wordingFindings(
    input: ScreenTrialInput,
    changedDocs: readonly LakeDocument[],
): FindingDraft[] {
    const patterns = input.transientPatterns ?? [];
    if (patterns.length === 0) return [];
    const counterexamples = input.durableCounterexamples ?? [];
    const findings: FindingDraft[] = [];
    if (input.finalAnswer.state === "available") {
        findings.push(
            ...transientWordingFindings({
                text: input.finalAnswer.value,
                reference: "final.md",
                kind: "final-response",
                scenario: input.trial.scenario,
                patterns,
                counterexamples,
            }),
        );
    }
    for (const doc of changedDocs) {
        findings.push(
            ...transientWordingFindings({
                text: doc.contents,
                reference: doc.path,
                kind: "resulting-document",
                scenario: input.trial.scenario,
                patterns,
                counterexamples,
            }),
        );
    }
    return findings;
}

/**
 * Permission findings, when the campaign records a policy and the writes are
 * observable. Without either, out-of-policy mutation is unknown, not clean.
 * @param input The screen input.
 * @returns Mechanical findings for out-of-policy paths.
 */
function permissionFindingList(input: ScreenTrialInput): FindingDraft[] {
    const policy = input.mutationPolicy;
    if (policy === undefined || policy.allowed.length === 0) return [];
    if (input.writesText.state !== "available") return [];
    return permissionFindings({
        changedPaths: changedPathsOf(input.writesText.value),
        allowedGlobs: policy.allowed,
        taskPrompt:
            input.taskPrompt.state === "available"
                ? input.taskPrompt.value
                : null,
        visibleConstraints: policy.visibleConstraints,
        writesText: input.writesText.value,
        reference: "writes.txt",
        scenario: input.trial.scenario,
    });
}

/**
 * Inventory findings over every candidate document.
 * @param input The screen input.
 * @param candidates The documents to scan.
 * @returns Trigger and coverage-unknown findings.
 */
function inventoryFindingList(
    input: ScreenTrialInput,
    candidates: readonly LakeDocument[],
): FindingDraft[] {
    const inventory = input.inventory;
    if (inventory === undefined) return [];
    return candidates.flatMap((doc) => {
        const source = sourceOf("resulting-document", doc.path, doc.contents);
        const scan = scanInventory(doc.contents, inventory);
        const triggerList = scan.triggers.map((trigger) =>
            triggerFinding(trigger, source, input.trial.scenario),
        );
        const coverageList = scan.missing.map((factId) => {
            const fact = inventory.facts.find((entry) => entry.id === factId);
            return coverageFinding(
                factId,
                fact?.label ?? factId,
                source,
                input.trial.scenario,
            );
        });
        return [...triggerList, ...coverageList];
    });
}

/**
 * The documents a resulting-document rule should describe. With the after
 * state observable but the before state absent, change is unknown and every
 * after document is a candidate; with both states, only new or modified ones.
 * @param before The before state, or null when unavailable.
 * @param after The after state, or null when unavailable.
 * @returns The candidate documents, or null when the after state is missing.
 */
function candidatesOf(
    before: readonly LakeDocument[] | null,
    after: readonly LakeDocument[] | null,
): LakeDocument[] | null {
    if (after === null) return null;
    if (before === null) return [...after];
    const beforeByPath = new Map(before.map((doc) => [doc.path, doc.contents]));
    return after.filter((doc) => beforeByPath.get(doc.path) !== doc.contents);
}

/**
 * Structural findings, only when the resulting documents are observable.
 * @param input The screen input.
 * @param candidates The candidate documents, or null.
 * @returns Structural findings.
 */
function structureFor(
    input: ScreenTrialInput,
    candidates: readonly LakeDocument[] | null,
): FindingDraft[] {
    if (candidates === null) return [];
    return candidates.flatMap((doc) =>
        structureFindings(doc, input.trial.scenario),
    );
}

/**
 * Claimed-mutation contradictions, only when both states are observable.
 * @param input The screen input.
 * @param before The before state, or null.
 * @param after The after state, or null.
 * @param answer The final answer, or null.
 * @returns Contradiction findings.
 */
function mutationFor(
    input: ScreenTrialInput,
    before: readonly LakeDocument[] | null,
    after: readonly LakeDocument[] | null,
    answer: string | null,
): FindingDraft[] {
    if (before === null || after === null || answer === null) return [];
    return claimMutationFindings({
        answer,
        changes: docChanges([...before], [...after]),
        reference: "final.md",
        scenario: input.trial.scenario,
    });
}

/**
 * Duplication findings, only when both states are observable.
 * @param input The screen input.
 * @param before The before state, or null.
 * @param after The after state, or null.
 * @returns Duplication findings.
 */
function duplicationFor(
    input: ScreenTrialInput,
    before: readonly LakeDocument[] | null,
    after: readonly LakeDocument[] | null,
): FindingDraft[] {
    if (before === null || after === null) return [];
    return duplicationFindings([...before], [...after], input.trial.scenario);
}

/**
 * Inventory findings, only when the resulting documents are observable.
 * @param input The screen input.
 * @param candidates The candidate documents, or null.
 * @returns Inventory findings.
 */
function inventoryFor(
    input: ScreenTrialInput,
    candidates: readonly LakeDocument[] | null,
): FindingDraft[] {
    if (candidates === null) return [];
    return inventoryFindingList(input, candidates);
}

/**
 * Screen one recorded trial. Each rule sees only the evidence it needs: the
 * after state for resulting-document rules, both states for mutation and
 * duplication, the answer for response wording, and the writes plus a
 * recorded policy for permissions.
 * @param input Everything the screen reads.
 * @returns Findings with provenance, hashed sources and the change state.
 */
export function screenTrial(input: ScreenTrialInput): ScreenResult {
    const before =
        input.beforeDocs.state === "available" ? input.beforeDocs.value : null;
    const after =
        input.afterDocs.state === "available" ? input.afterDocs.value : null;
    const answer =
        input.finalAnswer.state === "available"
            ? input.finalAnswer.value
            : null;
    const changes =
        before !== null && after !== null
            ? docChanges([...before], [...after])
            : null;
    const candidates = candidatesOf(before, after);
    const drafts: FindingDraft[] = [
        ...structureFor(input, candidates),
        ...mutationFor(input, before, after, answer),
        ...duplicationFor(input, before, after),
        ...wordingFindings(input, candidates ?? []),
        ...permissionFindingList(input),
        ...inventoryFor(input, candidates),
    ];
    const findings = drafts
        .map((draft) => withProvenance(draft, input))
        .sort(
            (left, right) =>
                left.source.reference.localeCompare(right.source.reference) ||
                left.span.start - right.span.start ||
                left.ruleId.localeCompare(right.ruleId),
        );
    return { findings, sources: sourcesOf(input), changes };
}
