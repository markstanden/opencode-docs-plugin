/**
 * Display-only scenario names for the trial harness.
 *
 * Historical fixture IDs remain the stable selector and the key into every
 * saved result. New run descriptions snapshot the display value so editing
 * this map cannot silently rename an old stamp. Names never enter a prompt.
 */

/** Version of the display map recorded with new run descriptions. */
export const NAMING_MAP_VERSION = 2;

/** One scenario's display identity. */
export interface ScenarioDisplay {
    /** The readable, stable report name, such as `REUSE-01`. */
    displayId: string;
    /** The short task title shown after the display id. */
    title: string;
}

/**
 * Current corpus scenarios, keyed by their historical fixture id.
 * Placement entries follow E01–E18 and R04; the family corpora follow their
 * own ids. A01 is the implemented implementation-diagnostic control.
 */
export const SCENARIO_DISPLAY: Readonly<Record<string, ScenarioDisplay>> = {
    E01: {
        displayId: "PLACE-01",
        title: "Place the search-index design decision",
    },
    E02: {
        displayId: "PLACE-02",
        title: "Place Kylo's Secure Boot requirement",
    },
    E03: { displayId: "PLACE-03", title: "Place personal editor preferences" },
    E04: {
        displayId: "PLACE-04",
        title: "Place the organisation's deployment identity rule",
    },
    E05: {
        displayId: "PLACE-05",
        title: "Keep the SDK finding within its proven scope",
    },
    E06: {
        displayId: "PLACE-06",
        title: "Choose where test instructions belong",
    },
    E07: {
        displayId: "PLACE-07",
        title: "Place a diagnosed regression and its evidence",
    },
    E08: {
        displayId: "PLACE-08",
        title: "Route an onboarding narrative to the wiki",
    },
    E09: {
        displayId: "PLACE-09",
        title: "Place a service exception to an existing policy",
    },
    E10: {
        displayId: "PLACE-10",
        title: "Place a bug's cause and failed workaround",
    },
    E11: {
        displayId: "PLACE-11",
        title: "Choose the workstation lake for a desktop fix",
    },
    E12: {
        displayId: "PLACE-12",
        title: "Handle a missing personal documentation destination",
    },
    E13: {
        displayId: "PLACE-13",
        title: "Preserve the payments team's policy boundary",
    },
    E14: {
        displayId: "PLACE-14",
        title: "Place an expired personal CLI session finding",
    },
    E15: {
        displayId: "PLACE-15",
        title: "Place the repository's formatter decision",
    },
    E16: {
        displayId: "PLACE-16",
        title: "Clarify personal preference versus team policy",
    },
    E17: {
        displayId: "PLACE-17",
        title: "Choose the correct lake among nested roots",
    },
    E18: {
        displayId: "PLACE-18",
        title: "Place a household appliance warranty",
    },
    R04: {
        displayId: "PLACE-19",
        title: "Defer placement when ownership is unresolved",
    },
    D01: {
        displayId: "DISCOVER-01",
        title: "Discover the workstation lake through docs help",
    },
    D02: {
        displayId: "NOTICE-01",
        title: "Recognise the retry-limit finding as knowledge worth recording",
    },
    D03: {
        displayId: "NOTICE-02",
        title: "Recognise the formatter decision as knowledge worth recording",
    },
    R01: {
        displayId: "REUSE-01",
        title: "Read and reuse the existing test instructions",
    },
    R02: {
        displayId: "REUSE-02",
        title: "Read and update the stale hook-guard finding",
    },
    R05: {
        displayId: "REUSE-03",
        title: "Reference the existing policy when recording an exception",
    },
    R06: {
        displayId: "REUSE-04",
        title: "Read the wiki page and follow its owners' workflow",
    },
    W01: {
        displayId: "RECORD-01",
        title: "Create one focused document within the permitted lake",
    },
    W02: {
        displayId: "RECORD-02",
        title: "Replace the existing document and preserve its marker",
    },
    A01: {
        displayId: "CONTROL-02",
        title: "Confirm docs help through the harness launch",
    },
    "NOTE-01": {
        displayId: "NOTE-01",
        title: "Diagnose the retry boundary",
    },
    "NOTE-02": {
        displayId: "NOTE-02",
        title: "Correct the stale setup rule",
    },
    "NOTE-03": {
        displayId: "NOTE-03",
        title: "Handle the interrupted run",
    },
    "NOTE-04": {
        displayId: "NOTE-04",
        title: "Reuse the replay diagnosis",
    },
};

/**
 * Historical diagnostic condition codes as report phrases. These are
 * conditions, not scenario ids (A01 is a scenario) or regression labels
 * (C01 is a test name).
 */
export const CONDITION_LABELS: Readonly<Record<string, string>> = {
    a: "native instruction",
    "native-instruction": "native instruction",
    a2: "sharpened native instruction",
    "sharpened-native-instruction": "sharpened native instruction",
    b: "Code Mode instruction",
    "code-mode-instruction": "Code Mode instruction",
    c: "natural task",
    "natural-task": "natural task",
    "explicit-read-control": "explicit read control",
};

/** The display entry for a current scenario, or undefined for an unmapped id. */
export function scenarioDisplayFor(id: string): ScenarioDisplay | undefined {
    return SCENARIO_DISPLAY[id];
}

/**
 * Resolve a condition code or descriptive value to its report phrase.
 * @returns The phrase, or undefined when the value is not a known condition.
 */
export function conditionLabel(
    value: string | null | undefined,
): string | undefined {
    if (value === null || value === undefined) return undefined;
    const key = value
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, "-");
    return CONDITION_LABELS[key];
}

/**
 * Render a scenario for a report. New runs use their saved display snapshot;
 * a run without one falls back to its recorded id and claim, never to a
 * newly assigned historical title.
 */
export function formatScenarioName(
    id: string,
    display: ScenarioDisplay | null | undefined,
    claim?: string | null,
): string {
    if (display) return `${display.displayId} — ${display.title} (${id})`;
    return claim && claim !== "" ? `${id} — ${claim}` : id;
}
