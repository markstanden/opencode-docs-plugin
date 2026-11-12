// One recovery judgement per preserved block-1 trial, written to
// `attempt-002`. The failed `attempt-001` stays untouched.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    readdirSync,
    readFileSync,
} from "node:fs";
import { join } from "node:path";
import { credentialFileProblem, loadJudgeKey } from "./env.mjs";
import { parseCampaignLedger } from "../runner/ledger.ts";
import { advanceClaim, claimBudget } from "../runner/budget.ts";
import { resolveRecoverySelection } from "../runner/selector.ts";
import { spendFreezeProblem, verifyFreeze } from "../runner/freeze.ts";

const ROOT = process.env.CAMPAIGN_ROOT;
if (!ROOT) throw new Error("CAMPAIGN_ROOT is required");
const EVIDENCE = join(ROOT, "evidence");
const MEASUREMENT = join(ROOT, "measurement");
const AC = join(MEASUREMENT, "tests/fixtures/placement-harness/ac/run.mjs");
const LEDGER = join(EVIDENCE, "ATTEMPTS.jsonl");
const JUDGE = "zai-coding-plan/glm-5.3-flash";
const argv = process.argv.slice(2);
const selectionFlag = (name) =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const schedule = JSON.parse(
    readFileSync(join(EVIDENCE, "schedule.json"), "utf8"),
).slots;
const slots = schedule.filter((slot) => Number(slot.pairId.slice(1)) <= 4);
const readJson = (path) =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const ledger = (entry) =>
    appendFileSync(
        LEDGER,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

const manifest = readJson(join(ROOT, "prepare/manifest.json"));
const selection = resolveRecoverySelection({
    manifestAttemptId: manifest?.assessment?.attemptId ?? null,
    recoveryAttemptId: selectionFlag("--attempt-id") ?? "attempt-002",
});
if (!selection.ok) {
    console.error(`BLOCKER: ${selection.problems.join("; ")}`);
    process.exit(2);
}
const attemptId = selection.selection.attemptId;
const frozen = readJson(join(EVIDENCE, "FROZEN.json"));
const freezeRecord = frozen?.freeze ?? null;
const judgeCeiling = Number(freezeRecord?.ceilings?.judge ?? 0);
const MAIN = process.env.CAMPAIGN_SOURCE_REPO ?? process.cwd();
const capture = (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    return result.status === 0 ? String(result.stdout ?? "").trim() : "";
};
const filesUnder = (dir) => {
    if (!existsSync(dir)) return [];
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...filesUnder(path));
        else if (entry.isFile()) found.push(path);
    }
    return found.sort();
};

const premiseProblems = () => {
    const record = frozen?.freeze ?? null;
    const unusable = spendFreezeProblem(record);
    if (unusable !== null) return [unusable];
    const files = record.files.map((file) => {
        const path = join(ROOT, file.path);
        return {
            path: file.path,
            sha256: existsSync(path)
                ? createHash("sha256").update(readFileSync(path)).digest("hex")
                : "missing",
        };
    });
    const inventories = record.inventories.map((inventory) => ({
        path: inventory.path,
        files: filesUnder(join(ROOT, inventory.path)).map((path) => ({
            path: path.slice(ROOT.length + 1),
            sha256: createHash("sha256")
                .update(readFileSync(path))
                .digest("hex"),
        })),
    }));
    const revision = spawnSync("git", ["-C", MAIN, "rev-parse", "HEAD"], {
        encoding: "utf8",
    });
    return verifyFreeze(record, {
        files,
        inventories,
        imageId: capture("podman", [
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            record.imageId,
        ]),
        containerCli: capture("podman", ["--version"]),
        sourceRevision:
            revision.status === 0 ? String(revision.stdout).trim() : "",
    });
};

/** The parsed ledger: a malformed or closed ledger permits no spend. */
const ledgerParse = () =>
    parseCampaignLedger(existsSync(LEDGER) ? readText(LEDGER) : undefined);

/** Why recovery spend is refused now, or null. */
const spendRefusal = () => {
    const parsed = ledgerParse();
    if (parsed.state === "malformed") {
        return `attempt ledger is malformed: ${parsed.problems.join("; ")}`;
    }
    if (parsed.state === "closed") {
        return "campaign is closed; no judge event or child process is permitted";
    }
    return null;
};

/** Whether an existing recovery attempt carries a usable judgement. */
const usableJudgement = (dir) => {
    const judgement = readJson(join(dir, "judgement.json"));
    if (judgement?.status === "judged") return true;
    const resolution = readJson(join(dir, "resolution.json"));
    return resolution?.status === "judged";
};

const refusal = spendRefusal();
if (refusal !== null) {
    console.error(`BLOCKER: ${refusal}`);
    process.exit(2);
}

const premise = premiseProblems();
if (premise.length > 0) {
    console.error(`BLOCKER: frozen premise changed: ${premise.join("; ")}`);
    process.exit(2);
}

const keyProblem = credentialFileProblem(ROOT);
if (keyProblem !== null) {
    console.error(`BLOCKER: ${keyProblem}`);
    process.exit(2);
}

if (loadJudgeKey(ROOT) === null) {
    console.error("BLOCKER: no ZAI_API_KEY");
    process.exit(2);
}

let judged = 0;
for (const slot of slots) {
    const base = join(ROOT, "gen", slot.arm.toLowerCase());
    const caseDir = join(base, "results", slot.stamp, slot.scenario);
    const attemptDir = join(caseDir, "ac", attemptId);
    if (existsSync(attemptDir)) {
        if (usableJudgement(attemptDir)) {
            console.log(`${slot.stamp}: ${attemptId} already judged, preserved`);
            continue;
        }
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            attemptId,
            reason: "preserved recovery attempt has no usable judgement",
        });
        console.error(
            `BLOCKER: ${slot.stamp} has a preserved ${attemptId} attempt with no usable judgement`,
        );
        process.exit(2);
    }
    const meta = readJson(join(caseDir, "meta.json"));
    if (meta === null || meta.answerValid !== true || meta.exit !== 0) {
        console.error(`${slot.stamp}: trial is not a usable recorded result`);
        process.exit(2);
    }
    const changed = premiseProblems();
    if (changed.length > 0) {
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            attemptId,
            reason: `frozen premise changed at judge dispatch: ${changed.join("; ")}`,
        });
        console.error(
            `BLOCKER: ${slot.stamp} frozen premise changed at judge dispatch: ${changed.join("; ")}`,
        );
        process.exit(2);
    }
    const claim = claimBudget(EVIDENCE, "judge", judgeCeiling, {
        stamp: slot.stamp,
        attemptId,
    });
    if (!claim.ok) {
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            pairId: slot.pairId,
            stamp: slot.stamp,
            arm: slot.arm,
            attemptId,
            reason: claim.reason,
        });
        console.error(`BLOCKER: ${claim.reason}`);
        process.exit(2);
    }
    ledger({
        event: "judge-launch",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        attemptId,
        recovery: true,
    });
    advanceClaim(claim.claim, "spawned");
    const result = spawnSync(
        process.execPath,
        [
            AC,
            "judge",
            "--base", base,
            "--stamp", slot.stamp,
            "--case", slot.scenario,
            "--truth", join(
                ROOT,
                "arms/a/tests/fixtures/placement-harness/prod014/truth.json",
            ),
            "--spec", join(EVIDENCE, "measurement-spec.json"),
            "--attempt", attemptId,
            "--launcher", join(
                MEASUREMENT,
                "tests/fixtures/placement-harness/ac/judge-launcher.sh",
            ),
            "--model", JUDGE,
            "--workdir", join(EVIDENCE, "ac-runs"),
            "--timeout", "600000",
        ],
        {
            encoding: "utf8",
            timeout: 720000,
            env: {
                ...process.env,
                PLACEMENT_IMAGE: freezeRecord?.imageId ?? "",
                PLACEMENT_TRIAL_IMAGE_ID: freezeRecord?.imageId ?? "",
            },
        },
    );
    advanceClaim(claim.claim, "closed");
    const judgement = readJson(join(attemptDir, "judgement.json"));
    loggerExit(slot, result, judgement);
    if (judgement?.status !== "judged") {
        console.error(
            `BLOCKER: ${slot.stamp} recovery judgement is ${judgement?.status ?? "missing"}`,
        );
        process.exit(2);
    }
    judged += 1;
    console.log(
        `${slot.stamp}: ${judgement.documentationOutcome}; retrieval ${judgement.retrievalApplication?.state ?? "n/a"}`,
    );
}

ledger({ event: "recovery-complete", attempted: slots.length, judged });
console.log(`recovery complete: ${judged} judgement(s)`);

/**
 * Record one recovery judge outcome without ever recording the key.
 * @param slot The scheduled slot.
 * @param result The spawned process result.
 * @param judgement The parsed judgement pointer.
 */
function loggerExit(slot, result, judgement) {
    ledger({
        event: "judge-exit",
        slot: slot.slot,
        pairId: slot.pairId,
        stamp: slot.stamp,
        arm: slot.arm,
        scenario: slot.scenario,
        attemptId,
        recovery: true,
        exit: result.status,
        status: judgement?.status ?? "missing",
        outcome: judgement?.documentationOutcome ?? null,
        retrieval: judgement?.retrievalApplication?.state ?? null,
    });
}
