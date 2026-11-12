// Close an offline campaign from its durable evidence, without a model call.
//
// Accounting is derived from the frozen schedule, launch claims, result
// directories and each attempt's own trail. A partial campaign closes at its
// real scope; a closed campaign is never reopened. Human-review packets are
// generated only once, and only for observed retrieval opportunities.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parseCampaignLedger } from "../runner/ledger.ts";
import { readClaims } from "../runner/budget.ts";
import { closeCampaign, deriveClosure } from "../runner/closure.ts";

const ROOT = process.env.CAMPAIGN_ROOT;
if (!ROOT) throw new Error("CAMPAIGN_ROOT is required");
const EVIDENCE = join(ROOT, "evidence");
const LEDGER = join(EVIDENCE, "ATTEMPTS.jsonl");
const schedule = JSON.parse(readFileSync(join(EVIDENCE, "schedule.json"), "utf8"));
const measurement = JSON.parse(
    readFileSync(join(EVIDENCE, "measurement-spec.json"), "utf8"),
);
const slots = schedule.slots;
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const frozen = readJson(join(EVIDENCE, "FROZEN.json"));
const write = (path, body) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
};
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const ledger = (entry) =>
    appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

const caseDir = (slot) =>
    join(ROOT, "gen", slot.arm.toLowerCase(), "results", slot.stamp, slot.scenario);

/** Sum one JSONL trail's step and per-field token evidence. */
function usageOf(path) {
    if (!existsSync(path)) return { steps: null, tokens: null, durationMs: null };
    const text = readText(path);
    if (text.trim() === "")
        return {
            steps: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 },
            durationMs: null,
        };
    let steps = 0;
    const fields = { input: [], output: [], reasoning: [], cacheRead: [] };
    for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }
        if (event.type !== "step_finish") continue;
        steps += 1;
        const tokens = event.part?.tokens ?? {};
        fields.input.push(typeof tokens.input === "number" ? tokens.input : null);
        fields.output.push(typeof tokens.output === "number" ? tokens.output : null);
        fields.reasoning.push(
            typeof tokens.reasoning === "number" ? tokens.reasoning : null,
        );
        fields.cacheRead.push(
            typeof tokens.cache?.read === "number" ? tokens.cache.read : null,
        );
    }
    if (steps === 0) return { steps: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 }, durationMs: null };
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
        durationMs: null,
    };
}

/** One judge attempt's evidence. */
function judgeAttemptOf(dir) {
    const meta = readJson(join(dir, "meta.json"));
    const judgement = readJson(join(dir, "judgement.json"));
    const usage = usageOf(join(dir, "output.jsonl"));
    const status =
        judgement?.status ??
        (meta?.status === "started" ? "started" : "unknown");
    return {
        attemptId: dir.split("/").at(-1),
        spawned: meta !== null || usage.steps !== null,
        reachedInference: (usage.steps ?? 0) > 0,
        steps: usage.steps,
        tokens: usage.tokens,
        status,
        durationMs:
            typeof meta?.durationMs === "number" ? meta.durationMs : null,
    };
}

/** The observations deriveClosure reads. */
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
        readClaims(EVIDENCE, "trial").some((claim) => claim.stamp === slot.stamp) ||
        parseCampaignLedger(readText(LEDGER)).events.some(
            (event) => event.event === "launch" && event.stamp === slot.stamp,
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

const ledgerParse = parseCampaignLedger(readText(LEDGER));
const report = deriveClosure({
    scheduledSlots: slots.length,
    observations,
    trialClaims: readClaims(EVIDENCE, "trial"),
    judgeClaims: readClaims(EVIDENCE, "judge"),
    ceilings: {
        trial: Number(frozen?.budget?.plannedTrials ?? 16),
        judge: Number(frozen?.budget?.plannedJudgeAttempts ?? 16),
    },
    closed: ledgerParse.state === "closed",
});

const observed = observations.filter(
    (slot) => slot.launched || slot.recorded || slot.judgeAttempts.length > 0,
);
const runSlots = observed;
const unrunSlots = slots.filter(
    (slot) => !observed.some((one) => one.slot === slot.slot),
);

const trialTokens = report.trial.tokens;
const judgeTokens = report.judge.tokens;
const rate = (tokens, usdPerMillion) =>
    tokens === null ? null : (tokens / 1_000_000) * usdPerMillion;
const trialEstimate =
    rate(trialTokens.input, 0.15) === null ||
    rate(trialTokens.output, 0.6) === null
        ? null
        : rate(trialTokens.input, 0.15) +
          rate(trialTokens.output, 0.6) +
          rate(trialTokens.reasoning, 0.6) +
          rate(trialTokens.cacheRead, 0.003);
const judgeEstimate =
    rate(judgeTokens.input, 0.0334) === null
        ? null
        : rate(judgeTokens.input, 0.0334) +
          rate(judgeTokens.output, 0.1163) +
          rate(judgeTokens.reasoning, 0.1163) +
          rate(judgeTokens.cacheRead, 0.0081);

const reconciliation = {
    at: new Date().toISOString(),
    campaign: schedule.campaign,
    closedAt: report.stoppedAt,
    scheduledSlots: report.scheduledSlots,
    observedSlots: report.observedSlots,
    completedPairs: new Set(
        slots
            .filter((slot) =>
                observed.some(
                    (one) => one.slot === slot.slot && one.recorded,
                ),
            )
            .map((slot) => slot.pairId),
    ).size,
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
    unrunSlots: unrunSlots.map((slot) => ({
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
            estimated: trialEstimate === null ? null : Number(trialEstimate.toFixed(4)),
            kind: "catalogue estimate from recorded tokens; no invoice",
        },
        judge: {
            model: "zai-coding-plan/glm-5.3-flash",
            basis: "coding-plan subscription; catalogue rates shown for scale only",
            estimated: judgeEstimate === null ? null : Number(judgeEstimate.toFixed(4)),
            kind: "plan credits, not a separate invoice",
        },
        actualInvoice: "unknown/not available",
    },
};
write(join(EVIDENCE, "RECONCILIATION.json"), `${JSON.stringify(reconciliation, null, 2)}\n`);

if (ledgerParse.state === "closed") {
    console.log(JSON.stringify(reconciliation, null, 2));
    process.exit(0);
}

const decision = closeCampaign(report);
if (!decision.ok) {
    console.error(decision.problems.join("\n"));
    process.exit(1);
}

ledger({ ...decision.event, reason: "derived from durable evidence" });
for (const slot of unrunSlots) {
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

// Arm-blinded human-review packets are a separate derived step; generate them
// once, and only for retrieval opportunities the campaign actually observed.
const packetDir = join(EVIDENCE, "human-review/packets");
if (!existsSync(packetDir)) {
    const affected = runSlots.filter((slot) =>
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
        [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
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

Target note: \`${declaration.note}\`

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
    ledger({ event: "human-review-packets", packets: map.length, seed: 20261111 });
}

console.log(JSON.stringify(reconciliation, null, 2));
