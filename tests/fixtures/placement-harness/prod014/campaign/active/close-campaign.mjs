// Close an offline campaign from its durable evidence, without a model call.
//
// Order matters: the ledger is parsed first, a malformed ledger publishes
// nothing, an already-closed ledger preserves every prior artefact byte, and a
// close lock serialises against dispatches. Accounting is derived from the
// frozen schedule, launch claims, result directories and each attempt's own
// trail. A partial campaign closes at its real scope; human-review packets are
// generated once, and only for observed retrieval opportunities.
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parseCampaignLedger } from "../runner/ledger.ts";
import { readClaims, restartDisposition } from "../runner/budget.ts";
import { closeCampaign, deriveClosure } from "../runner/closure.ts";

const ROOT = process.env.CAMPAIGN_ROOT;
if (!ROOT) throw new Error("CAMPAIGN_ROOT is required");
const EVIDENCE = join(ROOT, "evidence");
const LEDGER = join(EVIDENCE, "ATTEMPTS.jsonl");
const RECONCILIATION = join(EVIDENCE, "RECONCILIATION.json");
const LOCK = join(EVIDENCE, "CLOSING.lock");

const readJson = (path) =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const write = (path, body) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, path);
};
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const ledger = (entry) =>
    appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

const caseDir = (slot) =>
    join(ROOT, "gen", slot.arm.toLowerCase(), "results", slot.stamp, slot.scenario);

/**
 * Sum one JSONL trail's step and per-field token evidence.
 *
 * A malformed line makes the whole trail unreadable: steps and tokens become
 * unknown rather than a plausible zero.
 */
function usageOf(path) {
    if (!existsSync(path)) return { steps: null, tokens: null, malformed: false };
    const text = readText(path);
    if (text.trim() === "") {
        return {
            steps: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
            malformed: false,
        };
    }
    let steps = 0;
    let malformed = false;
    const fields = { input: [], output: [], reasoning: [], cacheRead: [] };
    for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            malformed = true;
            continue;
        }
        if (event.type !== "step_finish") continue;
        steps += 1;
        const tokens = event.part?.tokens ?? {};
        fields.input.push(typeof tokens.input === "number" ? tokens.input : null);
        fields.output.push(
            typeof tokens.output === "number" ? tokens.output : null,
        );
        fields.reasoning.push(
            typeof tokens.reasoning === "number" ? tokens.reasoning : null,
        );
        fields.cacheRead.push(
            typeof tokens.cache?.read === "number" ? tokens.cache.read : null,
        );
    }
    if (malformed) return { steps: null, tokens: null, malformed: true };
    if (steps === 0) {
        return {
            steps: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
            malformed: false,
        };
    }
    const sum = (values) =>
        values.length === 0 || values.includes(null)
            ? null
            : values.reduce((total, value) => total + value, 0);
    return {
        steps,
        tokens: {
            input: sum(fields.input),
            output: sum(fields.output),
            reasoning: sum(fields.reasoning),
            cacheRead: sum(fields.cacheRead),
        },
        malformed: false,
    };
}

/** One judge attempt's evidence, including whether its judgement is usable. */
function judgeAttemptOf(dir) {
    const meta = readJson(join(dir, "meta.json"));
    const judgement = readJson(join(dir, "judgement.json"));
    const resolution = readJson(join(dir, "resolution.json"));
    const usage = usageOf(join(dir, "output.jsonl"));
    const usable =
        judgement?.status === "judged" || resolution?.status === "judged";
    const status = usable
        ? "judged"
        : (judgement?.status ??
          (meta?.status === "started" ? "started" : "unknown"));
    return {
        attemptId: dir.split("/").at(-1),
        spawned: meta !== null || usage.steps !== null,
        reachedInference: (usage.steps ?? 0) > 0,
        steps: usage.steps,
        tokens: usage.tokens,
        usable,
        status,
        durationMs:
            typeof meta?.durationMs === "number" ? meta.durationMs : null,
    };
}

/** Whether one slot has a usable judge attempt. */
const hasUsableJudgement = (slot) =>
    slot.judgeAttempts.some((attempt) => attempt.usable);

/** Pairs whose two recorded slots both carry a usable judgement. */
function completedPairsOf(observations) {
    const byPair = new Map();
    for (const slot of observations) {
        if (slot.pairId === null) continue;
        const entry = byPair.get(slot.pairId) ?? [];
        entry.push(slot);
        byPair.set(slot.pairId, entry);
    }
    let complete = 0;
    for (const slots of byPair.values()) {
        if (
            slots.length === 2 &&
            slots.every((slot) => slot.recorded && hasUsableJudgement(slot))
        ) {
            complete += 1;
        }
    }
    return complete;
}

/**
 * A catalogue estimate, or null when any subtotal is unknown. An unknown is
 * never coerced to zero.
 */
function estimate(tokens, rates) {
    const fields = ["input", "output", "reasoning", "cacheRead"];
    if (fields.some((field) => tokens[field] === null)) return null;
    return fields.reduce(
        (total, field) => total + (tokens[field] / 1_000_000) * rates[field],
        0,
    );
}

const ledgerText = readText(LEDGER);
const ledgerParse = parseCampaignLedger(
    existsSync(LEDGER) ? ledgerText : undefined,
);
if (ledgerParse.state === "malformed") {
    console.error(
        `ledger is malformed; nothing is published: ${ledgerParse.problems.join("; ")}`,
    );
    process.exit(1);
}
if (ledgerParse.state === "closed") {
    const prior = readText(RECONCILIATION);
    if (prior !== "") {
        process.stdout.write(prior);
    } else {
        console.log(JSON.stringify({ state: "closed", reconciliation: null }));
    }
    process.exit(0);
}

const schedule = JSON.parse(readFileSync(join(EVIDENCE, "schedule.json"), "utf8"));
const measurement = JSON.parse(
    readFileSync(join(EVIDENCE, "measurement-spec.json"), "utf8"),
);
const slots = schedule.slots;
const frozen = readJson(join(EVIDENCE, "FROZEN.json"));

let lockHeld = false;
try {
    writeFileSync(LOCK, `${String(process.pid)}\n`, {
        encoding: "utf8",
        flag: "wx",
    });
    lockHeld = true;
} catch {
    console.error(
        "a campaign close is already in progress (or was interrupted); inspect evidence/CLOSING.lock before retrying",
    );
    process.exit(1);
}

try {
    const trialClaims = readClaims(EVIDENCE, "trial");
    const judgeClaims = readClaims(EVIDENCE, "judge");
    const unresolved = [...trialClaims, ...judgeClaims].filter(
        (claim) => restartDisposition(claim) !== null,
    );
    if (unresolved.length > 0) {
        console.error(
            `${String(unresolved.length)} reservation(s) never closed; a campaign with unknown spend cannot close`,
        );
        process.exit(1);
    }

    const observations = slots.map((slot) => {
        const dir = caseDir(slot);
        const acDir = join(dir, "ac");
        const attempts = existsSync(acDir)
            ? readdirSync(acDir)
                  .filter((name) => /^attempt-\d{3}$/.test(name))
                  .sort()
                  .map((name) => judgeAttemptOf(join(acDir, name)))
            : [];
        const meta = readJson(join(dir, "meta.json"));
        const usage = usageOf(join(dir, "stdout.jsonl"));
        const launched =
            existsSync(dir) ||
            trialClaims.some(
                (claim) =>
                    claim.stamp === slot.stamp && claim.state !== "reserved",
            ) ||
            ledgerParse.events.some(
                (event) =>
                    event.event === "launch" && event.stamp === slot.stamp,
            );
        return {
            slot: slot.slot,
            pairId: slot.pairId ?? null,
            stamp: slot.stamp,
            arm: slot.arm,
            scenario: slot.scenario,
            launched,
            recorded: meta !== null,
            trialSteps: usage.steps,
            trialTokens: usage.tokens,
            trialDurationMs:
                typeof meta?.timings?.totalMs === "number"
                    ? meta.timings.totalMs
                    : null,
            judgeAttempts: attempts,
        };
    });

    const report = deriveClosure({
        scheduledSlots: slots.length,
        observations,
        trialClaims,
        judgeClaims,
        ceilings: {
            trial: Number(frozen?.freeze?.ceilings?.trial ?? 0),
            judge: Number(frozen?.freeze?.ceilings?.judge ?? 0),
        },
        closed: false,
    });

    const observed = observations.filter(
        (slot) => slot.launched || slot.recorded || slot.judgeAttempts.length > 0,
    );
    const decision = closeCampaign(report);
    if (!decision.ok) {
        console.error(decision.problems.join("\n"));
        process.exit(1);
    }

    const trialEstimate = estimate(report.trial.tokens, {
        input: 0.15,
        output: 0.6,
        reasoning: 0.6,
        cacheRead: 0.003,
    });
    const judgeEstimate = estimate(report.judge.tokens, {
        input: 0.0334,
        output: 0.1163,
        reasoning: 0.1163,
        cacheRead: 0.0081,
    });

    const reconciliation = {
        at: new Date().toISOString(),
        campaign: schedule.campaign,
        closedAt: report.stoppedAt,
        scheduledSlots: report.scheduledSlots,
        observedSlots: report.observedSlots,
        completedPairs: completedPairsOf(observations),
        trialLaunches: report.trialLaunches,
        trial: {
            attempts: report.trial.attempts,
            reachedInference: report.trial.inferred,
            steps: report.trial.steps,
            tokens: report.trial.tokens,
            tokenCoverage: report.trial.tokenCoverage,
            durationMs: report.trial.durationMs,
        },
        judge: {
            attempts: report.judge.attempts,
            reachedInference: report.judge.inferred,
            usableJudgements: report.judge.usableJudgements,
            unusableJudgements: report.judge.unusableJudgements,
            steps: report.judge.steps,
            tokens: report.judge.tokens,
            tokenCoverage: report.judge.tokenCoverage,
            durationMs: report.judge.durationMs,
        },
        unrunSlots: observations
            .filter((slot) => !observed.includes(slot))
            .map((slot) => ({
                slot: slot.slot,
                pairId: slot.pairId,
                stamp: slot.stamp,
                scenario: slot.scenario,
                arm: slot.arm,
            })),
        problems: report.problems,
        billing: {
            currency: "USD",
            trial: {
                model: "opencode-go/deepseek-v4.1-flash",
                basis: "catalogue rates 0.15 input / 0.60 output per Mtok, 0.003 cache-read",
                estimated:
                    trialEstimate === null
                        ? null
                        : Number(trialEstimate.toFixed(4)),
                kind: "catalogue estimate from recorded tokens; no invoice",
            },
            judge: {
                model: "zai-coding-plan/glm-5.3-flash",
                basis: "coding-plan subscription; catalogue rates shown for scale only",
                estimated:
                    judgeEstimate === null
                        ? null
                        : Number(judgeEstimate.toFixed(4)),
                kind: "plan credits, not a separate invoice",
            },
            actualInvoice: "unknown/not available",
        },
    };

    // Publish only after the close decision succeeded.
    write(RECONCILIATION, `${JSON.stringify(reconciliation, null, 2)}\n`);
    ledger({ ...decision.event, reason: "derived from durable evidence" });
    for (const slot of reconciliation.unrunSlots) {
        ledger({
            event: "slot-unrun",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            scenario: slot.scenario,
            arm: slot.arm,
            reason: "campaign closed before launch",
        });
    }

    const packetDir = join(EVIDENCE, "human-review/packets");
    if (!existsSync(packetDir)) {
        const affected = observed.filter((slot) =>
            (measurement.retrievalOpportunities ?? []).includes(slot.scenario),
        );
        const mulberry32 = (seed) => {
            let state = seed >>> 0;
            return () => {
                state = (state + 0x6d2b79f5) >>> 0;
                let t = state;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        };
        const random = mulberry32(20261111);
        const shuffled = [...affected];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
            const swap = Math.floor(random() * (index + 1));
            [shuffled[index], shuffled[swap]] = [
                shuffled[swap],
                shuffled[index],
            ];
        }
        const map = shuffled.map((slot, index) => ({
            packet: `HR-${String(index + 1).padStart(2, "0")}`,
            stamp: slot.stamp,
            scenario: slot.scenario,
            arm: slot.arm,
        }));
        const operationsOf = (slot) =>
            readText(join(caseDir(slot), "docs-operations.jsonl"))
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) => {
                    const entry = JSON.parse(line);
                    const input = entry.input ?? {};
                    const target = input.read ?? input.add?.path ?? "";
                    const verb = input.add
                        ? `${input.add.mode ?? "write"} ${target}`
                        : input.read
                          ? `read ${target}`
                          : input.search
                            ? `search "${input.search}"`
                            : input.check
                              ? "check"
                              : "help";
                    return `- ${entry.surface ?? "native"} — ${entry.status ?? "unknown"} — ${verb}`;
                });
        for (const entry of map) {
            const slot = affected.find((one) => one.stamp === entry.stamp);
            const dir = caseDir(slot);
            const declaration = measurement.scenarios[slot.scenario].retrieval;
            const body = `# Human review packet ${entry.packet}

This packet is arm-blind. Assess only the evidence below.

## Task

${readText(join(dir, "prompt.md"))}

## Retrieval criterion

Target note: \`${declaration.lake}/${declaration.note}\`

Seeded detail: ${declaration.detail}

## Attributed docs operations

${operationsOf(slot).join("\n") || "- (none)"}

## Final answer

\`\`\`
${readText(join(dir, "final.md")).trim()}
\`\`\`
`;
            write(join(packetDir, `${entry.packet}.md`), body);
        }
        write(
            join(EVIDENCE, "human-review/MAPPING.json"),
            `${JSON.stringify(
                {
                    note: "Open only after every packet has been assessed.",
                    seed: 20261111,
                    packets: map,
                },
                null,
                2,
            )}\n`,
        );
        ledger({
            event: "human-review-packets",
            packets: map.length,
            seed: 20261111,
        });
    }

    console.log(JSON.stringify(reconciliation, null, 2));
} finally {
    if (lockHeld) rmSync(LOCK, { force: true });
}
