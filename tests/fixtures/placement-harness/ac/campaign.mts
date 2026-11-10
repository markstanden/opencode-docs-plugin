/**
 * Pure primitives for the arm-blind automatic-notetaking campaign.
 *
 * These are the parts that must be identical across every review and rerun:
 * the seeded schedule, arm-to-directory resolution, the documentation-change
 * classification, the packet label guard and the tolerant JSON extraction.
 * They are pure so a test can pin them without spawning anything.
 */

/** The frozen schedule seed for the 2026-11-10 six-arm campaign. */
export const CAMPAIGN_SEED = 20261110;

/** Native-description arms, in the frozen arm-id order. */
export const ARMS: string[] = ["A", "B", "C", "D", "E", "F"];

/** One knowledge-lake document snapshot entry. */
export interface LakeDocument {
    /** Lake-relative document path. */
    path: string;
    /** Full document bytes. */
    contents: string;
}

/** The classification of a trial's documentation change. */
export interface DocumentationChange {
    /** Whether any knowledge-lake document changed at all. */
    documentsChanged: boolean;
    /** New Markdown documents. */
    createdPaths: string[];
    /** Changed pre-existing Markdown documents. */
    modifiedPaths: string[];
    /** Removed Markdown documents. */
    removedPaths: string[];
}

/** One scheduled trial slot. */
export interface ScheduleSlot {
    /** Stage name. */
    stage: "screening" | "confirmation";
    /** One-based position in the frozen execution order. */
    slot: number;
    /** Scenario/repetition block. */
    block: string;
    /** Screening repetition (1-based) or confirmation repetition (0-based). */
    repetition: number;
    /** Scenario id. */
    scenario: string;
    /** Screening arm letter. */
    arm?: string;
    /** Confirmation role: finalist or control. */
    role?: "F" | "A";
    /** Result stamp. */
    stamp: string;
}

/** Both frozen stages. */
export interface CampaignSchedule {
    /** The seed that reproduces the schedule. */
    seed: number;
    /** Screening slots. */
    screening: ScheduleSlot[];
    /** Confirmation slots. */
    confirmation: ScheduleSlot[];
}

/** Screening scenarios (the four NOTE cases). */
export const NOTE_CASES = ["NOTE-01", "NOTE-02", "NOTE-03", "NOTE-04"];

/** Confirmation scenarios, sealed for the 2026-11-10 campaign only. */
export const HELD_OUT = ["H01", "H02", "H03", "H04"];

/**
 * A deterministic 32-bit PRNG (mulberry32), so a schedule is reproducible
 * from its seed alone.
 * @param seed The integer seed.
 * @returns A function yielding successive floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Fisher–Yates shuffle with an injected random source.
 * @param random The random source.
 * @param items The items to shuffle.
 * @returns A shuffled copy.
 */
export function shuffle<T>(random: () => number, items: T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        const carried = copy[index] as T;
        copy[index] = copy[swap] as T;
        copy[swap] = carried;
    }
    return copy;
}

/**
 * Rotate a list left by `by` positions.
 * @param items The items.
 * @param by The rotation offset.
 * @returns The rotated list.
 */
export function rotate<T>(items: T[], by: number): T[] {
    return items.map((_, index) => items[(index + by) % items.length] as T);
}

/**
 * Build both frozen stages of the campaign schedule.
 *
 * Screening runs every arm once in a seeded order inside each
 * scenario/repetition block, with scenario order rotated across repetitions.
 * Confirmation alternates the finalist/control pair on (scenario index +
 * repetition) mod 2 and rotates scenario order by repetition.
 * @param seed The schedule seed; the campaign froze 20261110.
 * @returns The screening and confirmation slot lists.
 */
export function buildSchedule(seed = CAMPAIGN_SEED): CampaignSchedule {
    const random = mulberry32(seed);
    const screening: ScheduleSlot[] = [];
    let slot = 0;
    for (let repetition = 1; repetition <= 2; repetition += 1) {
        for (const scenario of rotate(NOTE_CASES, repetition - 1)) {
            for (const arm of shuffle(random, ARMS)) {
                slot += 1;
                screening.push({
                    stage: "screening",
                    slot,
                    block: `${repetition}-${scenario}`,
                    repetition,
                    scenario,
                    arm,
                    stamp: `fr-${arm}-s${repetition}-${scenario}`,
                });
            }
        }
    }
    const confirmation: ScheduleSlot[] = [];
    for (let repetition = 0; repetition <= 4; repetition += 1) {
        for (const scenario of rotate(HELD_OUT, repetition)) {
            const scenarioIndex = HELD_OUT.indexOf(scenario);
            const roles: Array<"F" | "A"> =
                (scenarioIndex + repetition) % 2 === 0
                    ? ["F", "A"]
                    : ["A", "F"];
            for (const role of roles) {
                slot += 1;
                confirmation.push({
                    stage: "confirmation",
                    slot,
                    block: `${repetition}-${scenario}`,
                    repetition,
                    scenario,
                    role,
                    stamp: `fc-${role}-r${repetition}-${scenario}`,
                });
            }
        }
    }
    return { seed, screening, confirmation };
}

/**
 * Resolve one arm letter to its external worktree directory.
 *
 * The arm letter is case-insensitive and must belong to the frozen set; a
 * runner that silently accepted an unknown letter or mixed case in a path is
 * exactly the defect that invalidated 20 confirmation slots in the original
 * campaign.
 * @param root The campaign root holding the arm worktrees.
 * @param arm The arm letter, either case.
 * @returns The arm's absolute-ish directory path.
 */
export function armDir(root: string, arm: string): string {
    const letter = String(arm).toLowerCase();
    if (!/^[a-f]$/.test(letter)) {
        throw new Error(`unknown arm ${JSON.stringify(arm)}: expected A-F`);
    }
    return `${root}/arms/${letter}`;
}

/**
 * Classify documentation changes between two knowledge-lake snapshots.
 * @param beforeDocs Markdown documents before the trial ({path, contents}).
 * @param afterDocs Markdown documents after the trial ({path, contents}).
 * @returns The created, modified and removed paths and a change flag.
 */
export function docChanges(
    beforeDocs: LakeDocument[],
    afterDocs: LakeDocument[],
): DocumentationChange {
    const before = new Map(beforeDocs.map((doc) => [doc.path, doc.contents]));
    const after = new Map(afterDocs.map((doc) => [doc.path, doc.contents]));
    const createdPaths = [...after.keys()].filter((path) => !before.has(path));
    const modifiedPaths = [...after.keys()].filter(
        (path) => before.has(path) && before.get(path) !== after.get(path),
    );
    const removedPaths = [...before.keys()].filter((path) => !after.has(path));
    return {
        documentsChanged:
            createdPaths.length > 0 ||
            modifiedPaths.length > 0 ||
            removedPaths.length > 0,
        createdPaths,
        modifiedPaths,
        removedPaths,
    };
}

/**
 * Patterns that must never reach a judge: campaign and host paths, arm or
 * stamp labels, and the words that frame an experiment.
 */
export const LABEL_PATTERNS = [
    /docs-desc-fresh/,
    /recording-confirm/,
    /\/home\/[^/\s]+/,
    /fr-[A-F]-[sr]\d/,
    /fc-[AF]-r\d/,
    /cc-[AB]-r\d/,
    /(?:^|\W)arm[_ -]?[A-F](?:\W|$)/i,
    /candidate/i,
    /control arm/i,
];

/**
 * Refuse a judge packet that carries any experiment label.
 * @param prompt The assembled packet text.
 * @returns The matched pattern sources; empty means arm-blind.
 */
export function labelLeaks(prompt: string): string[] {
    return LABEL_PATTERNS.filter((pattern) => pattern.test(prompt)).map(
        (pattern) => String(pattern),
    );
}

/**
 * Extract the first balanced JSON object from text, string- and
 * escape-aware, so trailing prose containing braces cannot corrupt the parse.
 * @param text The judge answer.
 * @returns The raw object text, or undefined when there is none.
 */
export function firstBalancedObject(text: string): string | undefined {
    const start = text.indexOf("{");
    if (start === -1) return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index] as string;
        if (inString) {
            ({ inString, escaped } = stepInString(char, escaped));
            continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") depth += 1;
        else if (char === "}") {
            depth -= 1;
            if (depth === 0) return text.slice(start, index + 1);
        }
    }
    return undefined;
}

/**
 * Advance the string-literal state by one character.
 * @param char The current character.
 * @param escaped Whether the previous character was an escape.
 * @returns The next string and escape state.
 */
function stepInString(
    char: string,
    escaped: boolean,
): { inString: boolean; escaped: boolean } {
    if (escaped) return { inString: true, escaped: false };
    if (char === "\\") return { inString: true, escaped: true };
    return { inString: char !== '"', escaped: false };
}
