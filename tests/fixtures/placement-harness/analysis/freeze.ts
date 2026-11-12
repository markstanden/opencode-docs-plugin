/**
 * The experiment freeze: every immutable input, bound before the first launch.
 *
 * A freeze is exclusive. It is written once, with `wx`, after checking that no
 * trial, judge attempt or result exists yet, that both arm trees are clean, and
 * that each arm actually served the description its registration measured.
 * Verification later compares the same hashes, so a modified rubric, fixture,
 * script, spec or swapped description invalidates the premise instead of
 * silently changing the experiment.
 */

import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

/** One immutable input and its SHA-256. */
export interface FrozenFile {
    /** The root-relative identity. */
    path: string;
    /** The SHA-256 of its bytes. */
    sha256: string;
}

/** One directory inventory: every file under it, path-sorted. */
export interface FrozenInventory {
    /** The root-relative directory identity. */
    path: string;
    /** Every file beneath it. */
    files: FrozenFile[];
}

/** The current freeze record format. */
export const FREEZE_SCHEMA_VERSION = 2;

/** One arm's frozen identity. */
export interface FrozenArm {
    /** The arm id. */
    id: string;
    /** The arm worktree's commit. */
    commit: string;
    /** The arm worktree's tree. */
    tree: string;
    /** Whether the worktree was clean at freeze time. */
    clean: boolean;
    /** The registered native description's character count. */
    descriptionChars: number;
    /** The registered native description's SHA-256. */
    descriptionHash: string;
    /** The delivered description's character count. */
    deliveredChars: number;
    /** The delivered description's SHA-256. */
    deliveredHash: string;
    /** The annotation payload's character count. */
    annotationChars: number;
    /** The annotation payload's SHA-256. */
    annotationHash: string;
}

/** The frozen record. */
export interface FreezeRecord {
    /** The record format; absent means a legacy, read-only freeze. */
    schemaVersion: number;
    /** The campaign id. */
    campaign: string;
    /** The source revision the campaign was materialised from. */
    sourceRevision: string;
    /** The source tree. */
    sourceTree: string;
    /** The image identity actually used, if known before launch. */
    imageId: string;
    /** The container CLI identity. */
    containerCli: string;
    /** The measurement declaration hash. */
    measurementSha256: string;
    /** The arms, in id order. */
    arms: FrozenArm[];
    /** Every immutable single-file input, path-sorted. */
    files: FrozenFile[];
    /** Every immutable input directory and its complete file inventory. */
    inventories: FrozenInventory[];
    /** The stopping rules, verbatim. */
    stoppingRules: string[];
    /** The trial and judge ceilings. */
    ceilings: { trial: number; judge: number };
}

/** The freeze outcome. */
export type FreezeOutcome =
    { ok: true; record: FreezeRecord } | { ok: false; problems: string[] };

/** The inputs a freeze decision reads. */
export interface FreezeInput {
    /** The campaign id. */
    campaign: string;
    /** The source revision. */
    sourceRevision: string;
    /** The source tree. */
    sourceTree: string;
    /** The image identity. */
    imageId: string | null;
    /** The container CLI identity. */
    containerCli: string | null;
    /** The measurement declaration hash. */
    measurementSha256: string | null;
    /** The arms' registered and delivered descriptions. */
    arms: readonly FrozenArm[];
    /** Every immutable input. */
    files: readonly FrozenFile[];
    /** Every immutable input directory. */
    inventories: readonly FrozenInventory[];
    /** The stopping rules. */
    stoppingRules: readonly string[];
    /** The trial and judge ceilings. */
    ceilings: { trial: number; judge: number } | null;
    /** Whether any trial or judge evidence already exists. */
    started: boolean;
    /** Whether a freeze file already exists. */
    frozen: boolean;
}

/**
 * SHA-256 of exact text bytes.
 * @param text The text.
 * @returns The lowercase hex digest.
 */
export function sha256Text(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** One served tool description. */
export interface ServedDescription {
    /** The description text. */
    description: string;
    /** Its UTF-16 code-point count, matching the registration measurement. */
    chars: number;
    /** The SHA-256 of its UTF-8 bytes. */
    sha256: string;
}

/**
 * Extract the served description of one tool from a provider request body.
 *
 * The delivery probe saves the raw request body, so this is the actual payload
 * the provider received — never a hand-extracted copy. A body without the tool
 * is a problem, not an empty description.
 * @param body The parsed request body.
 * @param toolName The registered tool name.
 * @returns The served description, or a problem.
 */
export function deliveredToolDescription(
    body: unknown,
    toolName = "docs",
): { delivered?: ServedDescription; problem?: string } {
    if (typeof body !== "object" || body === null) {
        return { problem: "delivery request body is not an object" };
    }
    const tools = (body as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) {
        return { problem: "delivery request body has no tools array" };
    }
    for (const entry of tools) {
        const served = servedDescription(entry, toolName);
        if (served !== undefined) return served;
    }
    return { problem: `delivery request body does not serve tool ${toolName}` };
}

/**
 * Read one served tool's description.
 * @param entry The request body's tool entry.
 * @param toolName The registered tool name.
 * @returns The served description, a problem for a malformed match, or
 *   undefined when the entry is not the named tool.
 */
function servedDescription(
    entry: unknown,
    toolName: string,
): { delivered?: ServedDescription; problem?: string } | undefined {
    if (typeof entry !== "object" || entry === null) return undefined;
    const fn = (entry as { function?: unknown }).function;
    if (typeof fn !== "object" || fn === null) return undefined;
    if ((fn as { name?: unknown }).name !== toolName) return undefined;
    const description = (fn as { description?: unknown }).description;
    if (typeof description !== "string" || description.trim() === "") {
        return {
            problem: `served tool ${toolName} has no nonblank description`,
        };
    }
    return {
        delivered: {
            description,
            chars: [...description].length,
            sha256: sha256Text(description),
        },
    };
}

/**
 * Check one arm's registration against what the provider was served.
 * @param arm The arm identity.
 * @returns Problems; empty means registration and delivery agree.
 */
function armProblems(arm: FrozenArm): string[] {
    const problems: string[] = [];
    if (!arm.clean) problems.push(`arm ${arm.id} worktree is dirty`);
    if (arm.descriptionHash !== arm.deliveredHash) {
        problems.push(
            `arm ${arm.id} delivered description differs from the registered one`,
        );
    }
    if (arm.descriptionChars !== arm.deliveredChars) {
        problems.push(
            `arm ${arm.id} delivered description length differs from the registered one`,
        );
    }
    return problems;
}

/**
 * Decide whether the experiment may be frozen.
 *
 * Refusals happen before anything is written: a started experiment, an
 * existing freeze, a dirty arm, a missing or contradictory delivery, an absent
 * input or a ceiling all block. Inputs are deduplicated by path and sorted, so
 * two runs hash the same immutable set in the same order.
 * @param input Everything the decision reads.
 * @returns The record, or every problem.
 */
export function freezeExperiment(input: FreezeInput): FreezeOutcome {
    const problems = [
        ...stateProblems(input),
        ...armSetProblems(input.arms),
        ...identityProblems(input),
        ...inputFileProblems(input.files),
        ...inventoryProblems(input.inventories),
    ];
    if (problems.length > 0) return { ok: false, problems };
    const byPath = new Map<string, FrozenFile>();
    for (const file of input.files) byPath.set(file.path, file);
    return {
        ok: true,
        record: {
            schemaVersion: FREEZE_SCHEMA_VERSION,
            campaign: input.campaign,
            sourceRevision: input.sourceRevision,
            sourceTree: input.sourceTree,
            imageId: input.imageId as string,
            containerCli: input.containerCli as string,
            measurementSha256: input.measurementSha256 as string,
            arms: [...input.arms].sort((left, right) =>
                left.id.localeCompare(right.id),
            ),
            files: [...byPath.values()].sort((left, right) =>
                left.path.localeCompare(right.path),
            ),
            inventories: [...input.inventories]
                .map((inventory) => ({
                    path: inventory.path,
                    files: [...inventory.files].sort((left, right) =>
                        left.path.localeCompare(right.path),
                    ),
                }))
                .sort((left, right) => left.path.localeCompare(right.path)),
            stoppingRules: [...input.stoppingRules],
            ceilings: input.ceilings as { trial: number; judge: number },
        },
    };
}

/**
 * The inventory preconditions.
 * @param inventories The declared directory inventories.
 * @returns Problems; empty means each inventory is usable.
 */
function inventoryProblems(inventories: readonly FrozenInventory[]): string[] {
    const problems: string[] = [];
    for (const inventory of inventories) {
        if (inventory.path.trim() === "") {
            problems.push("every inventory needs a directory path");
        }
        if (inventory.files.length === 0) {
            problems.push(`inventory ${inventory.path} is empty`);
        }
        for (const file of inventory.files) {
            if (!file.path.startsWith(`${inventory.path}/`)) {
                problems.push(
                    `inventory file ${file.path} is outside ${inventory.path}`,
                );
            }
        }
    }
    return problems;
}

/**
 * The start/existing-freeze preconditions.
 * @param input The freeze input.
 * @returns Problems; empty means the experiment has not begun.
 */
function stateProblems(input: FreezeInput): string[] {
    const problems: string[] = [];
    if (input.started) {
        problems.push(
            "refusing to freeze after a launch, judge attempt or recorded result exists",
        );
    }
    if (input.frozen) {
        problems.push("refusing to overwrite an existing freeze");
    }
    return problems;
}

/**
 * The arm-set preconditions: at least two distinct arms, clean, delivered as
 * registered, and not serving identical descriptions.
 * @param arms The arms.
 * @returns Problems; empty means the arm set is coherent.
 */
function armSetProblems(arms: readonly FrozenArm[]): string[] {
    const problems: string[] = [];
    if (arms.length < 2) problems.push("a comparison needs at least two arms");
    const ids = arms.map((arm) => arm.id).sort();
    if (new Set(ids).size !== ids.length) {
        problems.push("arm ids must be distinct");
    }
    for (const arm of arms) problems.push(...armProblems(arm));
    const sorted = [...arms].sort((left, right) =>
        left.id.localeCompare(right.id),
    );
    const first = sorted[0];
    const second = sorted[1];
    if (
        first !== undefined &&
        second !== undefined &&
        first.descriptionHash === second.descriptionHash
    ) {
        problems.push("the arms serve an identical description");
    }
    return problems;
}

/**
 * The run-identity preconditions.
 * @param input The freeze input.
 * @returns Problems; empty means identity and rules are recorded.
 */
function identityProblems(input: FreezeInput): string[] {
    return [
        ...requiredIdentities(input),
        ...ruleProblems(input.ceilings, input.stoppingRules),
    ];
}

/**
 * The image, CLI and measurement identity checks.
 * @param input The freeze input.
 * @returns Problems; empty means those identities are recorded.
 */
function requiredIdentities(input: FreezeInput): string[] {
    const problems: string[] = [];
    if (input.imageId === null || input.imageId.trim() === "") {
        problems.push("no container image identity was observed");
    }
    if (input.containerCli === null || input.containerCli.trim() === "") {
        problems.push("no container CLI identity was observed");
    }
    if (
        input.measurementSha256 === null ||
        input.measurementSha256.trim() === ""
    ) {
        problems.push("no measurement declaration was frozen");
    }
    return problems;
}

/**
 * The ceiling and stopping-rule checks.
 * @param ceilings The declared ceilings, when present.
 * @param stoppingRules The declared stopping rules.
 * @returns Problems; empty means the rules are recorded.
 */
function ruleProblems(
    ceilings: { trial: number; judge: number } | null,
    stoppingRules: readonly string[],
): string[] {
    const problems: string[] = [];
    if (ceilings === null || ceilings.trial < 1 || ceilings.judge < 1) {
        problems.push("the trial and judge ceilings must both be positive");
    }
    if (stoppingRules.length === 0) {
        problems.push("the stopping rules must be recorded");
    }
    return problems;
}

/**
 * The immutable-input preconditions.
 * @param files The hashed inputs.
 * @returns Problems; empty means every input is identified.
 */
function inputFileProblems(files: readonly FrozenFile[]): string[] {
    const problems: string[] = [];
    if (files.length === 0) problems.push("no immutable inputs were hashed");
    for (const file of files) {
        if (file.path.trim() === "" || file.sha256.trim() === "") {
            problems.push("every immutable input needs a path and a hash");
        }
    }
    return problems;
}
/**
 * Write a verified freeze exclusively. An existing file refuses without
 * touching its bytes.
 * @param path The freeze file path.
 * @param record The verified record.
 * @returns Whether the write landed.
 */
export function writeFreeze(
    path: string,
    record: FreezeRecord,
): { ok: true } | { ok: false; reason: string } {
    try {
        writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
        });
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            reason:
                (error as NodeJS.ErrnoException).code === "EEXIST"
                    ? "refusing to overwrite an existing freeze"
                    : `cannot write freeze: ${String(error)}`,
        };
    }
}

/** The observed state a verification compares against the freeze. */
export interface FreezeObservation {
    /** The current immutable single-file inputs. */
    files: readonly FrozenFile[];
    /** The current inventory for every declared directory. */
    inventories: readonly FrozenInventory[];
    /** The image identity actually executed. */
    imageId: string;
    /** The container CLI actually used. */
    containerCli: string;
    /** The source revision in use. */
    sourceRevision: string;
}

/**
 * Why a freeze cannot authorise new spend, or null when it can.
 * @param record The recorded freeze, or undefined when absent.
 * @returns The refusal, or null for a modern complete record.
 */
export function spendFreezeProblem(
    record: FreezeRecord | null | undefined,
): string | null {
    if (record === null || record === undefined) {
        return "no freeze record; new spend requires a validated freeze";
    }
    if (record.schemaVersion !== FREEZE_SCHEMA_VERSION) {
        return `freeze format ${String(record.schemaVersion)} is legacy and read-only; re-freeze before spending`;
    }
    if (!Array.isArray(record.inventories) || record.inventories.length === 0) {
        return "the freeze carries no input inventory; it cannot detect added inputs";
    }
    if (
        record.ceilings === null ||
        !Number.isInteger(record.ceilings.trial) ||
        !Number.isInteger(record.ceilings.judge) ||
        record.ceilings.trial < 1 ||
        record.ceilings.judge < 1
    ) {
        return "the freeze carries no valid trial and judge ceilings";
    }
    if (record.imageId.trim() === "") {
        return "the freeze carries no container image identity";
    }
    return null;
}

/**
 * Compare observed inputs with the frozen record, including directory
 * inventories in both directions so an added input is caught too.
 * @param record The frozen record.
 * @param observation What is present now.
 * @returns Every mismatch; empty means the premise still holds.
 */
export function verifyFreeze(
    record: FreezeRecord,
    observation: FreezeObservation,
): string[] {
    const problems: string[] = [];
    if (observation.sourceRevision !== record.sourceRevision) {
        problems.push(
            `source revision changed: ${record.sourceRevision} to ${observation.sourceRevision}`,
        );
    }
    if (observation.imageId !== record.imageId) {
        problems.push(
            `container image changed: ${record.imageId} to ${observation.imageId}`,
        );
    }
    if (observation.containerCli !== record.containerCli) {
        problems.push(
            `container CLI changed: ${record.containerCli} to ${observation.containerCli}`,
        );
    }
    const frozen = new Map(
        record.files.map((file) => [file.path, file.sha256]),
    );
    for (const file of observation.files) {
        if (frozen.get(file.path) !== file.sha256) {
            problems.push(`immutable input changed: ${file.path}`);
        }
        frozen.delete(file.path);
    }
    for (const path of [...frozen.keys()].sort()) {
        problems.push(`immutable input missing: ${path}`);
    }
    problems.push(
        ...inventoryProblemsOf(record.inventories, observation.inventories),
    );
    return problems;
}

/**
 * Compare every declared directory inventory with what is present.
 * @param frozen The recorded inventories.
 * @param observed The inventories read now.
 * @returns Added, changed and missing file problems.
 */
function inventoryProblemsOf(
    frozen: readonly FrozenInventory[],
    observed: readonly FrozenInventory[],
): string[] {
    const problems: string[] = [];
    const byPath = new Map(observed.map((entry) => [entry.path, entry]));
    for (const inventory of frozen) {
        const current = byPath.get(inventory.path);
        if (current === undefined) {
            problems.push(`inventory missing: ${inventory.path}`);
            continue;
        }
        byPath.delete(inventory.path);
        const expected = new Map(
            inventory.files.map((file) => [file.path, file.sha256]),
        );
        for (const file of current.files) {
            if (expected.get(file.path) !== file.sha256) {
                problems.push(`immutable input changed: ${file.path}`);
            }
            expected.delete(file.path);
        }
        for (const path of [...expected.keys()].sort()) {
            problems.push(`immutable input missing: ${path}`);
        }
    }
    for (const path of [...byPath.keys()].sort()) {
        problems.push(`unexpected inventory: ${path}`);
    }
    return problems;
}

/** Whether a path already holds a freeze. */
export function freezeExists(path: string): boolean {
    return existsSync(path);
}
