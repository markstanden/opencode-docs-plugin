// Boundary contracts for the live campaign commands.
//
// Every record these commands read from disk is `unknown` until a validator
// here proves the fields the command actually uses. Nothing infers a type from
// a cast alone: a missing or malformed field names the file and refuses.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
    FreezeRecord,
    FrozenFile,
    FrozenInventory,
} from "../runner/freeze.ts";

/** Refuse with a named problem. */
export function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

/** Parse JSON as unknown; callers validate before use. */
export function readJson(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8"));
}

/** Read text, or an empty string when the file is absent. */
export function readText(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

/** One JSON object, or a refusal naming the file. */
export function recordOf(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`${label} must be a JSON object`);
    }
    return value as Record<string, unknown>;
}

/** Every file under a directory, recursively, sorted. */
export function filesUnder(dir: string): string[] {
    const found: string[] = [];
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) found.push(...filesUnder(path));
            else if (entry.isFile()) found.push(path);
        }
    } catch {
        return [];
    }
    return found.sort();
}

/** One scheduled slot. */
export interface ScheduleSlot {
    /** Execution order across the whole schedule. */
    slot: number;
    /** Pair identity, P01…P08. */
    pairId: string;
    /** Repetition index within the scenario. */
    repetition: number;
    /** Scenario id. */
    scenario: string;
    /** Arm letter. */
    arm: "A" | "B";
    /** The slot stamp; repeated across campaigns by design. */
    stamp: string;
}

/** The frozen schedule. */
export interface Schedule {
    /** Campaign identity. */
    campaign: string;
    /** All slots in execution order. */
    slots: ScheduleSlot[];
}

/** The schedule, validated field by field before any dispatch. */
export function scheduleOf(path: string): Schedule {
    const value = recordOf(readJson(path), path);
    if (typeof value.campaign !== "string" || !Array.isArray(value.slots)) {
        fail(`${path} needs a string campaign and a slots array`);
    }
    const slots = value.slots.map((entry) => {
        const slot = recordOf(entry, `${path}.slots`);
        const arm = slot.arm;
        if (
            typeof slot.slot !== "number" ||
            typeof slot.pairId !== "string" ||
            typeof slot.repetition !== "number" ||
            typeof slot.scenario !== "string" ||
            (arm !== "A" && arm !== "B") ||
            typeof slot.stamp !== "string"
        ) {
            fail(`${path}.slots has a malformed slot`);
        }
        const letter: "A" | "B" = arm === "A" ? "A" : "B";
        return {
            slot: slot.slot,
            pairId: slot.pairId,
            repetition: slot.repetition,
            scenario: slot.scenario,
            arm: letter,
            stamp: slot.stamp,
        };
    });
    return { campaign: value.campaign, slots };
}

/** The campaign manifest. */
export interface Manifest {
    /** The frozen assessment selection. */
    assessment?: { attemptId?: string };
}

/**
 * A stored freeze record. A legacy record without ceilings reads as zero, which
 * blocks every claim; `spendFreezeProblem` refuses it first.
 */
export type FrozenRecord = FreezeRecord;

/** The manifest, validated for the selection field it carries. */
export function manifestOf(path: string): Manifest | null {
    try {
        const value = recordOf(readJson(path), path);
        const assessment =
            value.assessment === undefined
                ? undefined
                : recordOf(value.assessment, `${path}.assessment`);
        const attemptId = assessment?.attemptId;
        if (attemptId !== undefined && typeof attemptId !== "string") {
            fail(`${path}.assessment.attemptId must be a string`);
        }
        if (attemptId === undefined) return {};
        return { assessment: { attemptId } };
    } catch {
        return null;
    }
}

/** One frozen single-file input. */
function frozenFileOf(value: unknown, label: string): FrozenFile {
    const file = recordOf(value, label);
    if (typeof file.path !== "string" || typeof file.sha256 !== "string") {
        fail(`${label} needs string path and sha256`);
    }
    return { path: file.path, sha256: file.sha256 };
}

/** One frozen directory inventory. */
function frozenInventoryOf(value: unknown, label: string): FrozenInventory {
    const inventory = recordOf(value, label);
    if (typeof inventory.path !== "string" || !Array.isArray(inventory.files)) {
        fail(`${label} needs a path and a files array`);
    }
    return {
        path: inventory.path,
        files: inventory.files.map((file, index) =>
            frozenFileOf(file, `${label}.files[${index}]`),
        ),
    };
}

/**
 * The freeze record embedded in FROZEN.json, or null when absent.
 *
 * A legacy record may predate the ceilings; `verifyFreeze` decides whether the
 * record is usable, so this validator proves only the fields the commands read.
 */
export function freezeRecordOf(value: unknown): FrozenRecord | null {
    if (value === undefined || value === null) return null;
    const stored = recordOf(value, "FROZEN.json freeze");
    const ceilings = stored.ceilings;
    if (
        typeof stored.schemaVersion !== "number" ||
        typeof stored.campaign !== "string" ||
        typeof stored.sourceRevision !== "string" ||
        typeof stored.sourceTree !== "string" ||
        typeof stored.imageId !== "string" ||
        typeof stored.containerCli !== "string" ||
        typeof stored.measurementSha256 !== "string" ||
        !Array.isArray(stored.arms) ||
        !Array.isArray(stored.files) ||
        !Array.isArray(stored.inventories) ||
        !Array.isArray(stored.stoppingRules) ||
        (ceilings !== undefined &&
            (typeof ceilings !== "object" ||
                ceilings === null ||
                typeof (ceilings as Record<string, unknown>).trial !==
                    "number" ||
                typeof (ceilings as Record<string, unknown>).judge !==
                    "number"))
    ) {
        fail("FROZEN.json freeze record is malformed");
    }
    const ceiling = ceilings as { trial: number; judge: number } | undefined;
    return {
        schemaVersion: stored.schemaVersion,
        campaign: stored.campaign,
        sourceRevision: stored.sourceRevision,
        sourceTree: stored.sourceTree,
        imageId: stored.imageId,
        containerCli: stored.containerCli,
        measurementSha256: stored.measurementSha256,
        arms: stored.arms.map((arm, index) => {
            const entry = recordOf(arm, `FROZEN.json arms[${index}]`);
            if (
                typeof entry.id !== "string" ||
                typeof entry.commit !== "string" ||
                typeof entry.tree !== "string" ||
                typeof entry.clean !== "boolean" ||
                typeof entry.descriptionChars !== "number" ||
                typeof entry.descriptionHash !== "string" ||
                typeof entry.deliveredChars !== "number" ||
                typeof entry.deliveredHash !== "string" ||
                typeof entry.annotationChars !== "number" ||
                typeof entry.annotationHash !== "string"
            ) {
                fail(`FROZEN.json arms[${index}] is malformed`);
            }
            return {
                id: entry.id,
                commit: entry.commit,
                tree: entry.tree,
                clean: entry.clean,
                descriptionChars: entry.descriptionChars,
                descriptionHash: entry.descriptionHash,
                deliveredChars: entry.deliveredChars,
                deliveredHash: entry.deliveredHash,
                annotationChars: entry.annotationChars,
                annotationHash: entry.annotationHash,
            };
        }),
        files: stored.files.map((file, index) =>
            frozenFileOf(file, `FROZEN.json files[${index}]`),
        ),
        inventories: stored.inventories.map((inventory, index) =>
            frozenInventoryOf(inventory, `FROZEN.json inventories[${index}]`),
        ),
        stoppingRules: stored.stoppingRules.map((rule, index) => {
            if (typeof rule !== "string")
                fail(`FROZEN.json stoppingRules[${index}] must be a string`);
            return rule;
        }),
        ceilings:
            ceiling === undefined
                ? { trial: 0, judge: 0 }
                : { trial: ceiling.trial, judge: ceiling.judge },
    };
}
