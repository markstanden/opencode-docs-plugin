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

/**
 * Read text. A missing file is an empty string; every other read failure
 * (directory, permission, I/O) throws so it cannot masquerade as empty.
 * @param path The file to read.
 * @returns Its contents, or an empty string when it does not exist.
 */
export function readText(path: string): string {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
    }
}

/** A read failure as one line, for a refusal or an accounting problem. */
export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
    assessment?: {
        attemptId?: string;
        /** The optional registered recovery policy, validated by its reader. */
        recovery?: unknown;
    };
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
        return assessmentOf(value, path);
    } catch {
        return null;
    }
}

/** The validated assessment section of one manifest. */
function assessmentOf(
    value: Record<string, unknown>,
    path: string,
): Manifest {
    const assessment =
        value.assessment === undefined
            ? undefined
            : recordOf(value.assessment, `${path}.assessment`);
    const attemptId = assessment?.attemptId;
    if (attemptId !== undefined && typeof attemptId !== "string") {
        fail(`${path}.assessment.attemptId must be a string`);
    }
    const recovery = assessment?.recovery;
    if (attemptId === undefined && recovery === undefined) return {};
    return {
        assessment: {
            ...(attemptId === undefined ? {} : { attemptId }),
            ...(recovery === undefined ? {} : { recovery }),
        },
    };
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
function stringField(
    record: Record<string, unknown>,
    key: string,
    label: string,
): string {
    const value = record[key];
    if (typeof value !== "string") fail(`${label}.${key} must be a string`);
    return value;
}

function numberField(
    record: Record<string, unknown>,
    key: string,
    label: string,
): number {
    const value = record[key];
    if (typeof value !== "number") fail(`${label}.${key} must be a number`);
    return value;
}

function booleanField(
    record: Record<string, unknown>,
    key: string,
    label: string,
): boolean {
    const value = record[key];
    if (typeof value !== "boolean") fail(`${label}.${key} must be a boolean`);
    return value;
}

function arrayField(
    record: Record<string, unknown>,
    key: string,
    label: string,
): unknown[] {
    const value = record[key];
    if (!Array.isArray(value)) fail(`${label}.${key} must be an array`);
    return value;
}

/** One frozen arm identity. */
function frozenArmOf(
    value: unknown,
    label: string,
): FreezeRecord["arms"][number] {
    const entry = recordOf(value, label);
    return {
        id: stringField(entry, "id", label),
        commit: stringField(entry, "commit", label),
        tree: stringField(entry, "tree", label),
        clean: booleanField(entry, "clean", label),
        descriptionChars: numberField(entry, "descriptionChars", label),
        descriptionHash: stringField(entry, "descriptionHash", label),
        deliveredChars: numberField(entry, "deliveredChars", label),
        deliveredHash: stringField(entry, "deliveredHash", label),
        annotationChars: numberField(entry, "annotationChars", label),
        annotationHash: stringField(entry, "annotationHash", label),
    };
}

/** The declared ceilings, or zero for a record that predates them. */
function ceilingsOf(value: unknown): { trial: number; judge: number } {
    if (value === undefined) return { trial: 0, judge: 0 };
    const ceiling = recordOf(value, "FROZEN.json ceilings");
    return {
        trial: numberField(ceiling, "trial", "FROZEN.json ceilings"),
        judge: numberField(ceiling, "judge", "FROZEN.json ceilings"),
    };
}

/**
 * The freeze record embedded in FROZEN.json, or null when absent.
 *
 * The record is validated field by field before a command reads a ceiling, an
 * image identity or an immutable input. A legacy record without ceilings reads
 * as zero, which blocks every claim.
 * @param value The `freeze` member of FROZEN.json.
 * @returns The validated record, or null when the campaign has none.
 */
export function freezeRecordOf(value: unknown): FrozenRecord | null {
    if (value === undefined || value === null) return null;
    const stored = recordOf(value, "FROZEN.json freeze");
    const label = "FROZEN.json freeze";
    return {
        schemaVersion: numberField(stored, "schemaVersion", label),
        campaign: stringField(stored, "campaign", label),
        sourceRevision: stringField(stored, "sourceRevision", label),
        sourceTree: stringField(stored, "sourceTree", label),
        imageId: stringField(stored, "imageId", label),
        containerCli: stringField(stored, "containerCli", label),
        measurementSha256: stringField(stored, "measurementSha256", label),
        arms: arrayField(stored, "arms", label).map((arm, index) =>
            frozenArmOf(arm, `FROZEN.json arms[${index}]`),
        ),
        files: arrayField(stored, "files", label).map((file, index) =>
            frozenFileOf(file, `FROZEN.json files[${index}]`),
        ),
        inventories: arrayField(stored, "inventories", label).map(
            (inventory, index) =>
                frozenInventoryOf(
                    inventory,
                    `FROZEN.json inventories[${index}]`,
                ),
        ),
        stoppingRules: arrayField(stored, "stoppingRules", label).map(
            (rule, index) => {
                if (typeof rule !== "string")
                    fail(
                        `FROZEN.json stoppingRules[${index}] must be a string`,
                    );
                return rule;
            },
        ),
        ceilings: ceilingsOf(stored.ceilings),
    };
}
