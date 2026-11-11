/**
 * Versioned campaign manifest for the trial analysis framework.
 *
 * A manifest describes a campaign as data — identity, arms, scenarios, the
 * frozen schedule with declared pair identities, the evidence layout, the
 * recorded assessment-layer selection policy and the frozen measurement
 * policy — so a future agent can run the standard analyser without writing
 * another calculator. Validation is pure and total: it collects problems
 * instead of throwing, so a CLI can report every defect in one pass.
 *
 * Manifests are portable: evidence locations are layout ids and paths relative
 * to a runtime evidence root. Absolute paths and traversal segments are
 * refused here, never resolved at parse time. Nothing in this module reads
 * the filesystem or calls a model.
 */

/** The only manifest schema version this framework parses. */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Evidence layout adapters the loader knows how to read. The ledger-shaped
 * `rr-ledger-v1` layout is deliberately absent until an adapter exists: a
 * manifest declaring an unreadable layout is refused, never accepted and
 * silently read as ac-v1.
 */
export const EVIDENCE_LAYOUTS = ["ac-v1"] as const;

/** A known evidence layout adapter id. */
export type EvidenceLayout = (typeof EVIDENCE_LAYOUTS)[number];

/** Recorded policies for choosing among multiple judgement layers. */
export const SELECTION_POLICIES = [
    "resolution-then-judgement",
    "judgement-only",
] as const;

/** A known judgement-layer selection policy id. */
export type SelectionPolicy = (typeof SELECTION_POLICIES)[number];

/** Guardrail kinds the evaluator implements. */
export const GUARDRAIL_KINDS = ["mutation-policy", "destructive-loss"] as const;

/** A known guardrail kind. */
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

/** How a slot's observation relates to the frozen schedule. */
export const DISPOSITIONS = [
    "first-attempt",
    "replacement",
    "excluded",
] as const;

/** A known observation disposition. */
export type Disposition = (typeof DISPOSITIONS)[number];

/** The campaign being analysed. */
export interface CampaignIdentity {
    /** Stable campaign id, e.g. `rc-20261110`. */
    id: string;
    /** The frozen question, quoted in reports. */
    question?: string | undefined;
}

/** One arm's declared identity. */
export interface ArmIdentity {
    /** Stable arm id used by schedule slots and evidence roots. */
    id: string;
    /** Human-readable label, quoted in reports. */
    label?: string | undefined;
}

/** One configured still-valid fact an inventory assesses for preservation. */
export interface PreservationFactSpec {
    /** Stable fact id, e.g. `poolSize`; never a hard-coded framework name. */
    id: string;
    /** Human-readable label, quoted in findings. */
    label: string;
    /** Focused regex sources recognising the fact and its supported equivalents. */
    mentionPatterns?: string[] | undefined;
    /** Regex sources asserting the fact's obsolete current form (obsolete-claim facts). */
    obsoleteCurrentPatterns?: string[] | undefined;
}

/** One scenario's configured preservation inventory. */
export interface PreservationInventorySpec {
    /** The facts assessed for preservation. */
    facts: PreservationFactSpec[];
    /** Regex sources whose in-assertion match negates a fact mention. */
    negationCues: string[];
}

/** A scenario's recorded mutation policy and its visible constraints. */
export interface MutationPolicySpec {
    /** Allowed mutation globs, relative to the trial workspace. */
    allowed: string[];
    /** Constraints the task prompt communicated, when recorded. */
    visibleConstraints?: string[] | undefined;
}

/** One scenario's declared identity and optional measurement configuration. */
export interface ScenarioIdentity {
    /** Stable scenario id used by schedule slots and evidence. */
    id: string;
    /** Display-only measurement kind, e.g. `reuse-create`. */
    kind?: string | undefined;
    /** The scenario's configured preservation inventory, when it has one. */
    preservationInventory?: PreservationInventorySpec | undefined;
    /** The scenario's recorded mutation policy, when the campaign declares one. */
    mutationPolicy?: MutationPolicySpec | undefined;
}

/** One scheduled trial slot: a declared identity, never an array position. */
export interface SlotSpec {
    /** One-based position in the frozen execution order. */
    slot: number;
    /** The trial's result stamp. */
    stamp: string;
    /** The scenario the slot runs. */
    scenario: string;
    /** The arm the slot runs. */
    arm: string;
    /** The repetition within scenario and arm. */
    repetition: number;
    /** The declared pair id; pairs hold exactly two distinct-arm slots. */
    pairId?: string | undefined;
    /** How the observation relates to the schedule; defaults to first-attempt. */
    disposition?: Disposition | undefined;
}

/** The frozen schedule. */
export interface ScheduleSpec {
    /** Every scheduled slot; may be empty so zero denominators stay reportable. */
    slots: SlotSpec[];
}

/** Evidence locations relative to the runtime evidence root. */
export interface EvidenceSpec {
    /** The layout adapter id the loader uses to read this campaign. */
    layout: EvidenceLayout;
    /** Per-arm result roots, relative to the evidence root. */
    resultRoots: Record<string, string>;
    /** Extra named inputs, relative to the evidence root (e.g. a ledger). */
    inputs?: Record<string, string> | undefined;
}

/** The recorded policy for choosing among judgement layers. */
export interface AssessmentSpec {
    /** A known selection policy id; never implicitly "newest wins". */
    selectionPolicy: SelectionPolicy;
    /**
     * The judge attempt directory to read, e.g. `attempt-002`. Absent means
     * `attempt-001`; a preserved earlier attempt is never overwritten.
     */
    attemptId?: string;
}

/** One non-compensable guardrail. */
export interface GuardrailSpec {
    /** Stable guardrail id. */
    id: string;
    /** A known guardrail kind the evaluator implements. */
    kind: GuardrailKind;
    /** The requirement, quoted verbatim in reports. */
    requirement: string;
}

/** The declared pairwise comparison rule; absent means "not defined". */
export interface SelectionSpec {
    /** The arm the candidate is compared against. */
    controlArm: string;
    /** The arm under evaluation. */
    candidateArm: string;
    /** The required utility lead of candidate over control. */
    threshold: number;
    /** Whether complete assessment coverage of planned slots is required. */
    requireCompleteCoverage: boolean;
}

/** An optional sensitivity grid, frozen before scoring. */
export interface SensitivitySpec {
    /** Useful create/update rewards to explore. */
    usefulWeights: number[];
    /** Transient penalties (positive magnitudes) to explore. */
    transientPenalties: number[];
}

/** Optional static-screening configuration. */
export interface ScreeningSpec {
    /** The screening rules version these settings belong to. */
    rulesVersion: string;
    /** Advisory regex sources for transient-state wording. */
    transientWordingPatterns?: string[] | undefined;
    /** Regex sources for durable-troubleshooting counterexample wording. */
    durableCounterexamplePatterns?: string[] | undefined;
}

/** The frozen measurement policy. */
export interface PolicySpec {
    /** Identity of the frozen policy, quoted in reports. */
    policyId: string;
    /** Utility weights; complete, finite, frozen before scoring. */
    weights: UtilityWeightsSpec;
    /** The non-compensable guardrails this campaign declares. */
    guardrails: GuardrailSpec[];
    /** The declared comparison rule, when the campaign freezes one. */
    selection?: SelectionSpec | undefined;
    /** The declared sensitivity grid, when the campaign freezes one. */
    sensitivity?: SensitivitySpec | undefined;
    /** Static-screening configuration, when the campaign uses the scanner. */
    screening?: ScreeningSpec | undefined;
}

/** The five utility weight keys, all required. */
export interface UtilityWeightsSpec {
    /** Reward for a useful create and a useful update. */
    useful: number;
    /** Penalty for a supported but valueless transient note. */
    transient: number;
    /** Penalty for a duplicate note. */
    duplicate: number;
    /** Penalty for misleading or unsupported documentation. */
    misleading: number;
    /** Penalty for a failed primary task. */
    taskFailure: number;
}

/** A validated campaign manifest. */
export interface CampaignManifest {
    /** The manifest schema version; only 1 is accepted. */
    schemaVersion: number;
    /** The campaign identity. */
    campaign: CampaignIdentity;
    /** The declared arms. */
    arms: ArmIdentity[];
    /** The declared scenarios. */
    scenarios: ScenarioIdentity[];
    /** The frozen schedule. */
    schedule: ScheduleSpec;
    /** Evidence locations. */
    evidence: EvidenceSpec;
    /** The recorded judgement-layer policy. */
    assessment: AssessmentSpec;
    /** The frozen measurement policy. */
    policy: PolicySpec;
}

/** The outcome of parsing one manifest. */
export interface ManifestParseResult {
    /** The validated manifest, present only when there are no problems. */
    value?: CampaignManifest | undefined;
    /** Every validation problem found, each naming the offending field. */
    problems: string[];
}

/** The five weight keys, in reporting order. */
const WEIGHT_KEYS = [
    "useful",
    "transient",
    "duplicate",
    "misleading",
    "taskFailure",
] as const;

/** Whether a value is a plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a string with non-whitespace content. */
function isNonblankString(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "";
}

/** Whether a value is a finite number (JSON cannot carry NaN or Infinity). */
function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/** Whether a value is an array made only of strings. */
function isStringArray(value: unknown): value is string[] {
    return (
        Array.isArray(value) && value.every((one) => typeof one === "string")
    );
}

/**
 * Check that every regex source in a list compiles.
 * @param label The dotted field path, used in problem messages.
 * @param sources The regex source strings to compile.
 * @returns One problem per source that does not compile.
 */
function regexProblems(label: string, sources: string[]): string[] {
    const problems: string[] = [];
    for (const source of sources) {
        try {
            new RegExp(source);
        } catch {
            problems.push(`${label}: regex does not compile: ${source}`);
        }
    }
    return problems;
}

/**
 * Validate one optional field holding a nonempty array of regex sources.
 * @param label The dotted field path of the containing object.
 * @param fieldName The field name holding the array.
 * @param value The containing object.
 * @returns Whether the field is present with a nonempty array, and its problems.
 */
function regexSourceField(
    label: string,
    fieldName: string,
    value: Record<string, unknown>,
): { nonempty: boolean; problems: string[] } {
    const sources = value[fieldName];
    if (sources === undefined) return { nonempty: false, problems: [] };
    if (!isStringArray(sources) || sources.length === 0) {
        return {
            nonempty: false,
            problems: [
                `${label}.${fieldName} must be a nonempty array of regex source strings when present`,
            ],
        };
    }
    return {
        nonempty: true,
        problems: regexProblems(`${label}.${fieldName}`, sources),
    };
}

/**
 * Check that an evidence-relative path is portable: nonblank, relative,
 * no traversal segments.
 * @param label The dotted field path, used in problem messages.
 * @param path The path as written in the manifest.
 * @returns Problems; empty means portable.
 */
function relativePathProblems(label: string, path: string): string[] {
    const problems: string[] = [];
    if (path.trim() === "") problems.push(`${label}: path is blank`);
    if (path.startsWith("/")) {
        problems.push(`${label}: absolute path is not portable: ${path}`);
    }
    if (path.split("/").includes("..")) {
        problems.push(`${label}: traversal segment is not portable: ${path}`);
    }
    return problems;
}

/**
 * Collect the declared entity ids from an array-shaped field.
 * @param entries The array field (arms or scenarios).
 * @returns The nonblank id strings; an invalid array yields none.
 */
function declaredIds(entries: unknown): string[] {
    if (!Array.isArray(entries)) return [];
    return entries
        .filter(isPlainObject)
        .map((entry) => entry.id)
        .filter(isNonblankString);
}

/**
 * Validate the campaign identity section.
 * @param value The raw campaign field.
 * @returns Problems; empty means valid.
 */
function campaignProblems(value: unknown): string[] {
    if (!isPlainObject(value)) return ["campaign must be an object"];
    const problems: string[] = [];
    if (!isNonblankString(value.id)) {
        problems.push("campaign.id must be a nonblank string");
    }
    if (value.question !== undefined && !isNonblankString(value.question)) {
        problems.push(
            "campaign.question must be a nonblank string when present",
        );
    }
    return problems;
}

/**
 * Validate the arms section: a nonempty array with unique nonblank ids.
 * @param value The raw arms field.
 * @returns Problems; empty means valid.
 */
function armsProblems(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        return ["arms must be a nonempty array"];
    }
    const problems: string[] = [];
    const seen = new Set<string>();
    value.forEach((arm, index) => {
        if (!isPlainObject(arm)) {
            problems.push(`arms[${index}] must be an object`);
            return;
        }
        if (!isNonblankString(arm.id)) {
            problems.push(`arms[${index}].id must be a nonblank string`);
        } else if (seen.has(arm.id)) {
            problems.push(`duplicate arm id ${JSON.stringify(arm.id)}`);
        } else {
            seen.add(arm.id);
        }
        if (arm.label !== undefined && !isNonblankString(arm.label)) {
            problems.push(
                `arms[${index}].label must be a nonblank string when present`,
            );
        }
    });
    return problems;
}

/**
 * Validate one configured preservation fact.
 * @param label The dotted field path of the fact.
 * @param value The raw fact object.
 * @param seen Fact ids already declared in this inventory.
 * @returns Problems; empty means valid.
 */
function inventoryFactProblems(
    label: string,
    value: unknown,
    seen: Set<string>,
): string[] {
    if (!isPlainObject(value)) return [`${label} must be an object`];
    const problems: string[] = [];
    if (!isNonblankString(value.id)) {
        problems.push(`${label}.id must be a nonblank string`);
    } else if (seen.has(value.id)) {
        problems.push(
            `${label}: duplicate inventory fact id ${JSON.stringify(value.id)}`,
        );
    } else {
        seen.add(value.id);
    }
    if (!isNonblankString(value.label)) {
        problems.push(`${label}.label must be a nonblank string`);
    }
    const mentions = regexSourceField(label, "mentionPatterns", value);
    const obsolete = regexSourceField(label, "obsoleteCurrentPatterns", value);
    if (!mentions.nonempty && !obsolete.nonempty) {
        problems.push(
            `${label} (${String(value.id)}) needs nonempty mentionPatterns or obsoleteCurrentPatterns`,
        );
    }
    problems.push(...mentions.problems, ...obsolete.problems);
    return problems;
}

/**
 * Validate one scenario's preservation inventory.
 * @param label The dotted field path of the inventory.
 * @param value The raw inventory object.
 * @returns Problems; empty means valid.
 */
function inventoryProblems(label: string, value: unknown): string[] {
    if (!isPlainObject(value)) return [`${label} must be an object`];
    if (!Array.isArray(value.facts) || value.facts.length === 0) {
        return [`${label}.facts must be a nonempty array`];
    }
    const problems: string[] = [];
    const seen = new Set<string>();
    value.facts.forEach((fact, index) => {
        problems.push(
            ...inventoryFactProblems(`${label}.facts[${index}]`, fact, seen),
        );
    });
    if (!isStringArray(value.negationCues) || value.negationCues.length === 0) {
        problems.push(
            `${label}.negationCues must be a nonempty array of regex source strings`,
        );
    } else {
        problems.push(
            ...regexProblems(`${label}.negationCues`, value.negationCues),
        );
    }
    return problems;
}

/**
 * Validate one optional mutation policy.
 * @param label The dotted field path of the policy.
 * @param value The raw policy object.
 * @returns Problems; empty means valid.
 */
function mutationPolicyProblems(label: string, value: unknown): string[] {
    if (!isPlainObject(value)) {
        return [`${label} must be an object when present`];
    }
    const problems: string[] = [];
    if (!isStringArray(value.allowed) || value.allowed.length === 0) {
        problems.push(
            `${label}.allowed must be a nonempty array of path globs`,
        );
    }
    if (
        value.visibleConstraints !== undefined &&
        (!isStringArray(value.visibleConstraints) ||
            value.visibleConstraints.length === 0)
    ) {
        problems.push(
            `${label}.visibleConstraints must be a nonempty array of strings when present`,
        );
    }
    return problems;
}

/**
 * Validate the scenarios section: unique ids and well-formed inventories.
 * @param value The raw scenarios field.
 * @returns Problems; empty means valid.
 */
function scenariosProblems(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        return ["scenarios must be a nonempty array"];
    }
    const problems: string[] = [];
    const seen = new Set<string>();
    value.forEach((scenario, index) => {
        if (!isPlainObject(scenario)) {
            problems.push(`scenarios[${index}] must be an object`);
            return;
        }
        if (!isNonblankString(scenario.id)) {
            problems.push(`scenarios[${index}].id must be a nonblank string`);
        } else if (seen.has(scenario.id)) {
            problems.push(
                `duplicate scenario id ${JSON.stringify(scenario.id)}`,
            );
        } else {
            seen.add(scenario.id);
        }
        if (scenario.kind !== undefined && !isNonblankString(scenario.kind)) {
            problems.push(
                `scenarios[${index}].kind must be a nonblank string when present`,
            );
        }
        if (scenario.preservationInventory !== undefined) {
            problems.push(
                ...inventoryProblems(
                    `scenarios[${index}].preservationInventory`,
                    scenario.preservationInventory,
                ),
            );
        }
        if (scenario.mutationPolicy !== undefined) {
            problems.push(
                ...mutationPolicyProblems(
                    `scenarios[${index}].mutationPolicy`,
                    scenario.mutationPolicy,
                ),
            );
        }
    });
    return problems;
}

/**
 * Validate one slot's identity fields: positive slot number and unique stamp.
 * @param label The dotted field path of the slot.
 * @param entry The raw slot object.
 * @param slotNumbers Slot numbers seen so far.
 * @param stamps Stamps seen so far.
 * @returns Problems; empty means the identity fields are valid.
 */
function slotIdentityProblems(
    label: string,
    entry: Record<string, unknown>,
    slotNumbers: Set<number>,
    stamps: Set<string>,
): string[] {
    const problems: string[] = [];
    if (
        typeof entry.slot !== "number" ||
        !Number.isInteger(entry.slot) ||
        entry.slot < 1
    ) {
        problems.push(`${label}.slot must be a positive integer`);
    } else if (slotNumbers.has(entry.slot)) {
        problems.push(`duplicate slot number ${String(entry.slot)}`);
    } else {
        slotNumbers.add(entry.slot);
    }
    if (!isNonblankString(entry.stamp)) {
        problems.push(`${label}.stamp must be a nonblank string`);
    } else if (stamps.has(entry.stamp)) {
        problems.push(`duplicate stamp ${JSON.stringify(entry.stamp)}`);
    } else {
        stamps.add(entry.stamp);
    }
    return problems;
}

/**
 * Validate one slot's membership fields against the declared entities.
 * @param label The dotted field path of the slot.
 * @param entry The raw slot object.
 * @param armIds Declared arm ids.
 * @param scenarioIds Declared scenario ids.
 * @returns Problems; empty means membership is valid.
 */
function slotMembershipProblems(
    label: string,
    entry: Record<string, unknown>,
    armIds: string[],
    scenarioIds: string[],
): string[] {
    const problems: string[] = [];
    if (!isNonblankString(entry.scenario)) {
        problems.push(`${label}.scenario must be a nonblank string`);
    } else if (!scenarioIds.includes(entry.scenario)) {
        problems.push(
            `${label}.scenario ${JSON.stringify(entry.scenario)} is an undeclared scenario`,
        );
    }
    if (!isNonblankString(entry.arm)) {
        problems.push(`${label}.arm must be a nonblank string`);
    } else if (!armIds.includes(entry.arm)) {
        problems.push(
            `${label}.arm ${JSON.stringify(entry.arm)} is an undeclared arm`,
        );
    }
    if (
        typeof entry.repetition !== "number" ||
        !Number.isInteger(entry.repetition) ||
        entry.repetition < 0
    ) {
        problems.push(`${label}.repetition must be an integer >= 0`);
    }
    if (entry.pairId !== undefined && !isNonblankString(entry.pairId)) {
        problems.push(`${label}.pairId must be a nonblank string when present`);
    }
    return problems;
}

/**
 * Validate one slot's optional disposition.
 * @param label The dotted field path of the slot.
 * @param entry The raw slot object.
 * @returns Problems; empty means valid.
 */
function slotDispositionProblems(
    label: string,
    entry: Record<string, unknown>,
): string[] {
    if (
        entry.disposition !== undefined &&
        !(DISPOSITIONS as readonly string[]).includes(String(entry.disposition))
    ) {
        return [
            `${label}.disposition must be one of ${DISPOSITIONS.join("|")} when present`,
        ];
    }
    return [];
}

/**
 * Validate one slot.
 * @param label The dotted field path of the slot.
 * @param entry The raw slot value.
 * @param armIds Declared arm ids.
 * @param scenarioIds Declared scenario ids.
 * @param slotNumbers Slot numbers seen so far.
 * @param stamps Stamps seen so far.
 * @returns Problems; empty means valid.
 */
function slotProblems(
    label: string,
    entry: unknown,
    armIds: string[],
    scenarioIds: string[],
    slotNumbers: Set<number>,
    stamps: Set<string>,
): string[] {
    if (!isPlainObject(entry)) return [`${label} must be an object`];
    return [
        ...slotIdentityProblems(label, entry, slotNumbers, stamps),
        ...slotMembershipProblems(label, entry, armIds, scenarioIds),
        ...slotDispositionProblems(label, entry),
    ];
}

/**
 * Validate one declared pair: exactly two slots, distinct arms, one scenario
 * and repetition. Pairing is by declared identity, never array position, so
 * the check reads only the declared fields.
 * @param pairId The declared pair id.
 * @param group The slots carrying that pair id.
 * @returns Problems; empty means the pair is coherent.
 */
function pairGroupProblems(pairId: string, group: unknown[]): string[] {
    const label = `pair ${pairId}`;
    if (group.length !== 2) {
        return [`${label} must hold exactly 2 slots, found ${group.length}`];
    }
    const fields = (name: string) =>
        group.map((slot) => (isPlainObject(slot) ? slot[name] : undefined));
    const arms = fields("arm");
    if (arms[0] === arms[1]) {
        return [
            `${label} must pair distinct arms, found ${JSON.stringify(arms[0])} twice`,
        ];
    }
    if (fields("scenario")[0] !== fields("scenario")[1]) {
        return [
            `${label} must pair one scenario, found ${JSON.stringify(fields("scenario"))}`,
        ];
    }
    if (fields("repetition")[0] !== fields("repetition")[1]) {
        return [
            `${label} must pair one repetition, found ${JSON.stringify(fields("repetition"))}`,
        ];
    }
    return [];
}

/**
 * Validate pair membership across the schedule.
 * @param slots The raw slot values.
 * @returns Problems; empty means every declared pair is coherent.
 */
function pairProblems(slots: unknown[]): string[] {
    const groups = new Map<string, unknown[]>();
    for (const entry of slots) {
        if (!isPlainObject(entry)) continue;
        const pairId = entry.pairId;
        if (!isNonblankString(pairId)) continue;
        const group = groups.get(pairId) ?? [];
        group.push(entry);
        groups.set(pairId, group);
    }
    const problems: string[] = [];
    for (const [pairId, group] of groups) {
        problems.push(...pairGroupProblems(pairId, group));
    }
    return problems;
}

/**
 * Validate the schedule section, including pair coherence.
 * @param value The raw schedule field.
 * @param armIds Declared arm ids.
 * @param scenarioIds Declared scenario ids.
 * @returns Problems; empty means valid.
 */
function scheduleProblems(
    value: unknown,
    armIds: string[],
    scenarioIds: string[],
): string[] {
    if (!isPlainObject(value)) return ["schedule must be an object"];
    if (!Array.isArray(value.slots)) return ["schedule.slots must be an array"];
    const problems: string[] = [];
    const slotNumbers = new Set<number>();
    const stamps = new Set<string>();
    value.slots.forEach((entry, index) => {
        problems.push(
            ...slotProblems(
                `schedule.slots[${index}]`,
                entry,
                armIds,
                scenarioIds,
                slotNumbers,
                stamps,
            ),
        );
    });
    problems.push(...pairProblems(value.slots));
    return problems;
}

/**
 * Validate the evidence section: a known layout, a relative root per arm,
 * and any layout-required inputs.
 * @param value The raw evidence field.
 * @param armIds Declared arm ids.
 * @returns Problems; empty means valid.
 */
function evidenceProblems(value: unknown, armIds: string[]): string[] {
    if (!isPlainObject(value)) return ["evidence must be an object"];
    const problems: string[] = [];
    if (
        !isNonblankString(value.layout) ||
        !(EVIDENCE_LAYOUTS as readonly string[]).includes(value.layout)
    ) {
        problems.push(
            `evidence.layout must be one of ${EVIDENCE_LAYOUTS.join("|")}`,
        );
    }
    const roots = value.resultRoots;
    if (!isPlainObject(roots)) {
        problems.push("evidence.resultRoots must be an object keyed by arm id");
        return problems;
    }
    for (const arm of armIds) {
        const root = roots[arm];
        if (!isNonblankString(root)) {
            problems.push(
                `evidence.resultRoots.${arm} must be a nonblank relative path`,
            );
        } else {
            problems.push(
                ...relativePathProblems(`evidence.resultRoots.${arm}`, root),
            );
        }
    }
    for (const key of Object.keys(roots)) {
        if (!armIds.includes(key)) {
            problems.push(`evidence.resultRoots.${key} is not a declared arm`);
        }
    }
    problems.push(...inputsProblems(value.inputs));
    return problems;
}

/**
 * Validate the optional named inputs record. Named inputs are portable,
 * relative evidence paths; an input this analyser does not read produces no
 * effect rather than being silently treated as present.
 * @param inputs The raw inputs field.
 * @returns Problems; empty means valid.
 */
function inputsProblems(inputs: unknown): string[] {
    if (inputs === undefined) return [];
    if (!isPlainObject(inputs)) {
        return ["evidence.inputs must be an object keyed by input name"];
    }
    const problems: string[] = [];
    for (const [name, path] of Object.entries(inputs)) {
        if (!isNonblankString(path)) {
            problems.push(
                `evidence.inputs.${name} must be a nonblank relative path`,
            );
        } else {
            problems.push(
                ...relativePathProblems(`evidence.inputs.${name}`, path),
            );
        }
    }
    return problems;
}

/**
 * Validate the assessment section: the selection policy must be a known id.
 * @param value The raw assessment field.
 * @returns Problems; empty means valid.
 */
function assessmentProblems(value: unknown): string[] {
    if (!isPlainObject(value)) return ["assessment must be an object"];
    if (
        !isNonblankString(value.selectionPolicy) ||
        !(SELECTION_POLICIES as readonly string[]).includes(
            value.selectionPolicy,
        )
    ) {
        return [
            `assessment.selectionPolicy must be one of ${SELECTION_POLICIES.join("|")}`,
        ];
    }
    if (
        "attemptId" in value &&
        (typeof value.attemptId !== "string" ||
            !/^attempt-\d{3}$/.test(value.attemptId))
    ) {
        return ['assessment.attemptId must match "attempt-NNN"'];
    }
    return [];
}

/**
 * Validate the utility weights: all five keys, each a finite number.
 * @param value The raw weights field.
 * @returns Problems; empty means valid.
 */
function weightsProblems(value: unknown): string[] {
    if (!isPlainObject(value)) return ["policy.weights must be an object"];
    const problems: string[] = [];
    for (const key of WEIGHT_KEYS) {
        if (!isFiniteNumber(value[key])) {
            problems.push(`policy.weights.${key} must be a finite number`);
        }
    }
    return problems;
}

/**
 * Validate the guardrails section: unique ids and known kinds.
 * @param value The raw guardrails field.
 * @returns Problems; empty means valid.
 */
function guardrailsProblems(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        return ["policy.guardrails must be a nonempty array"];
    }
    const problems: string[] = [];
    const seen = new Set<string>();
    value.forEach((guardrail, index) => {
        if (!isPlainObject(guardrail)) {
            problems.push(`policy.guardrails[${index}] must be an object`);
            return;
        }
        const id = guardrail.id;
        if (!isNonblankString(id)) {
            problems.push(
                `policy.guardrails[${index}].id must be a nonblank string`,
            );
        } else if (seen.has(id)) {
            problems.push(`duplicate guardrail id ${JSON.stringify(id)}`);
        } else {
            seen.add(id);
        }
        if (
            !isNonblankString(guardrail.kind) ||
            !(GUARDRAIL_KINDS as readonly string[]).includes(guardrail.kind)
        ) {
            problems.push(
                `policy.guardrails[${index}].kind must be a known guardrail kind (${GUARDRAIL_KINDS.join("|")})`,
            );
        }
        if (!isNonblankString(guardrail.requirement)) {
            problems.push(
                `policy.guardrails[${index}].requirement must be a nonblank string`,
            );
        }
    });
    return problems;
}

/**
 * Validate the optional selection rule.
 * @param value The raw selection field.
 * @param armIds Declared arm ids.
 * @returns Problems; empty means valid.
 */
function selectionProblems(value: unknown, armIds: string[]): string[] {
    if (value === undefined) return [];
    if (!isPlainObject(value)) {
        return ["policy.selection must be an object when present"];
    }
    const problems: string[] = [];
    for (const side of ["controlArm", "candidateArm"] as const) {
        const arm = value[side];
        if (!isNonblankString(arm) || !armIds.includes(arm)) {
            problems.push(`policy.selection.${side} must be a declared arm id`);
        }
    }
    if (
        value.controlArm !== undefined &&
        value.controlArm === value.candidateArm
    ) {
        problems.push(
            "policy.selection.controlArm and candidateArm must be distinct arms",
        );
    }
    if (!isFiniteNumber(value.threshold)) {
        problems.push("policy.selection.threshold must be a finite number");
    }
    if (typeof value.requireCompleteCoverage !== "boolean") {
        problems.push(
            "policy.selection.requireCompleteCoverage must be a boolean",
        );
    }
    return problems;
}

/**
 * Validate the optional sensitivity grid.
 * @param value The raw sensitivity field.
 * @returns Problems; empty means valid.
 */
function sensitivityProblems(value: unknown): string[] {
    if (value === undefined) return [];
    if (!isPlainObject(value)) {
        return ["policy.sensitivity must be an object when present"];
    }
    const problems: string[] = [];
    for (const field of ["usefulWeights", "transientPenalties"] as const) {
        const grid = value[field];
        if (!Array.isArray(grid) || grid.length === 0) {
            problems.push(
                `policy.sensitivity.${field} must be a nonempty array`,
            );
        } else if (!grid.every(isFiniteNumber)) {
            problems.push(
                `policy.sensitivity.${field} must hold finite numbers`,
            );
        }
    }
    return problems;
}

/**
 * Validate the optional screening configuration.
 * @param value The raw screening field.
 * @returns Problems; empty means valid.
 */
function screeningProblems(value: unknown): string[] {
    if (value === undefined) return [];
    if (!isPlainObject(value)) {
        return ["policy.screening must be an object when present"];
    }
    const problems: string[] = [];
    if (!isNonblankString(value.rulesVersion)) {
        problems.push(
            "policy.screening.rulesVersion must be a nonblank string",
        );
    }
    for (const field of [
        "transientWordingPatterns",
        "durableCounterexamplePatterns",
    ] as const) {
        problems.push(
            ...regexSourceField("policy.screening", field, value).problems,
        );
    }
    return problems;
}

/**
 * Validate the policy section.
 * @param value The raw policy field.
 * @param armIds Declared arm ids.
 * @returns Problems; empty means valid.
 */
function policyProblems(value: unknown, armIds: string[]): string[] {
    if (!isPlainObject(value)) return ["policy must be an object"];
    const problems: string[] = [];
    if (!isNonblankString(value.policyId)) {
        problems.push("policy.policyId must be a nonblank string");
    }
    problems.push(
        ...weightsProblems(value.weights),
        ...guardrailsProblems(value.guardrails),
        ...selectionProblems(value.selection, armIds),
        ...sensitivityProblems(value.sensitivity),
        ...screeningProblems(value.screening),
    );
    return problems;
}

/**
 * Parse and validate one manifest value.
 *
 * The parse is total: junk input yields problems instead of an exception.
 * The returned value is cast only after every field has been validated, so
 * the cast carries the guarantee the validators establish.
 * @param value The raw manifest value (as parsed from JSON).
 * @returns The validated manifest, or every problem found.
 */
export function parseManifest(value: unknown): ManifestParseResult {
    if (!isPlainObject(value)) {
        return { problems: ["manifest must be a JSON object"] };
    }
    if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
        return {
            problems: [
                `manifest.schemaVersion must be ${MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(value.schemaVersion)}`,
            ],
        };
    }
    const armIds = declaredIds(value.arms);
    const scenarioIds = declaredIds(value.scenarios);
    const problems: string[] = [
        ...campaignProblems(value.campaign),
        ...armsProblems(value.arms),
        ...scenariosProblems(value.scenarios),
        ...scheduleProblems(value.schedule, armIds, scenarioIds),
        ...evidenceProblems(value.evidence, armIds),
        ...assessmentProblems(value.assessment),
        ...policyProblems(value.policy, armIds),
    ];
    if (problems.length > 0) return { problems };
    return { value: value as unknown as CampaignManifest, problems: [] };
}
