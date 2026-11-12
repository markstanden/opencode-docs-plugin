// One recovery judgement per preserved block-1 trial, written to
// `attempt-002`. The failed `attempt-001` stays untouched.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { credentialFileProblem, loadJudgeKey } from "./env.mts";
import {
    errorText,
    filesUnder,
    freezeRecordOf,
    manifestOf,
    readJson,
    readText,
    recordOf,
    scheduleOf,
} from "./contracts.mts";
import { parseCampaignLedger, type LedgerParse } from "../runner/ledger.ts";
import { advanceClaim, claimBudget, releaseClaim } from "../runner/budget.ts";
import { resolveRecoverySelection } from "../runner/selector.ts";
import { spendFreezeProblem, verifyFreeze } from "../runner/freeze.ts";

const ROOT = process.env.CAMPAIGN_ROOT;
if (!ROOT) throw new Error("CAMPAIGN_ROOT is required");
const EVIDENCE = join(ROOT, "evidence");
const MEASUREMENT = join(ROOT, "measurement");
const AC = join(MEASUREMENT, "tests/fixtures/placement-harness/ac/run.mts");
const LEDGER = join(EVIDENCE, "ATTEMPTS.jsonl");
const JUDGE = "zai-coding-plan/glm-5.3-flash";
const argv = process.argv.slice(2);
const selectionFlag = (name: string): string | undefined =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const schedule = scheduleOf(join(EVIDENCE, "schedule.json")).slots;
const slots = schedule.filter((slot) => Number(slot.pairId.slice(1)) <= 4);
const ledger = (entry: Record<string, unknown>): void =>
    appendFileSync(
        LEDGER,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );

const manifest = manifestOf(join(ROOT, "prepare/manifest.json"));
const selection = resolveRecoverySelection({
    manifestAttemptId: manifest?.assessment?.attemptId ?? null,
    recoveryAttemptId: selectionFlag("--attempt-id") ?? "attempt-002",
});
if (!selection.ok) {
    console.error(`BLOCKER: ${selection.problems.join("; ")}`);
    process.exit(2);
}
const attemptId = selection.selection.attemptId;
const frozen = recordOf(readJson(join(EVIDENCE, "FROZEN.json")), "FROZEN.json");
const freezeRecord = freezeRecordOf(frozen.freeze);
const judgeCeiling = Number(freezeRecord?.ceilings?.judge ?? 0);
const MAIN = process.env.CAMPAIGN_SOURCE_REPO ?? process.cwd();
const capture = (command: string, args: string[]): string => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    return result.status === 0 ? String(result.stdout ?? "").trim() : "";
};
const premiseProblems = (): string[] => {
    const record = freezeRecord;
    if (record === null) return ["no freeze record"];
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
const ledgerParse = (): LedgerParse => {
    try {
        return parseCampaignLedger(
            existsSync(LEDGER) ? readText(LEDGER) : undefined,
        );
    } catch (error) {
        return {
            state: "malformed",
            events: [],
            problems: [`ledger is unreadable: ${errorText(error)}`],
            closedAt: null,
        };
    }
};

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
const usableJudgement = (dir: string): boolean => {
    const judgement = recordOf(
        readJson(join(dir, "judgement.json")),
        `${dir}/judgement.json`,
    );
    if (judgement.status === "judged") return true;
    const resolution = recordOf(
        readJson(join(dir, "resolution.json")),
        `${dir}/resolution.json`,
    );
    return resolution.status === "judged";
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
            console.log(
                `${slot.stamp}: ${attemptId} already judged, preserved`,
            );
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
    const meta = recordOf(
        readJson(join(caseDir, "meta.json")),
        `${caseDir}/meta.json`,
    );
    if (meta.answerValid !== true || meta.exit !== 0) {
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
        key: `${slot.stamp}|${attemptId}`,
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
    const closedAfterClaim = spendRefusal();
    if (closedAfterClaim !== null) {
        releaseClaim(claim.claim);
        ledger({
            event: "slot-blocked",
            slot: slot.slot,
            stamp: slot.stamp,
            arm: slot.arm,
            attemptId,
            reason: closedAfterClaim,
        });
        console.error(`BLOCKER: ${closedAfterClaim}`);
        process.exit(2);
    }
    const result = spawnSync(
        process.execPath,
        [
            AC,
            "judge",
            "--base",
            base,
            "--stamp",
            slot.stamp,
            "--case",
            slot.scenario,
            "--truth",
            join(
                ROOT,
                "arms/a/tests/fixtures/placement-harness/prod014/truth.json",
            ),
            "--spec",
            join(EVIDENCE, "measurement-spec.json"),
            "--attempt",
            attemptId,
            "--launcher",
            join(
                MEASUREMENT,
                "tests/fixtures/placement-harness/ac/judge-launcher.sh",
            ),
            "--model",
            JUDGE,
            "--workdir",
            join(EVIDENCE, "ac-runs"),
            "--timeout",
            "600000",
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
    if (!existsSync(join(attemptDir, "dispatch.json"))) {
        releaseClaim(claim.claim);
        ledger({
            event: "judge-refused",
            slot: slot.slot,
            stamp: slot.stamp,
            arm: slot.arm,
            attemptId,
            recovery: true,
            exit: result.status,
            reason:
                String(result.stderr ?? "")
                    .trim()
                    .split("\n")
                    .at(-1) ?? "",
        });
        console.error(
            `BLOCKER: ${slot.stamp} recovery wrapper refused before dispatch`,
        );
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
    advanceClaim(claim.claim, "closed");
    const judgement = recordOf(
        readJson(join(attemptDir, "judgement.json")),
        `${attemptDir}/judgement.json`,
    );
    loggerExit(slot, result, judgement);
    const retrieval =
        typeof judgement.retrievalApplication === "object" &&
        judgement.retrievalApplication !== null
            ? ((judgement.retrievalApplication as Record<string, unknown>)
                  .state ?? "n/a")
            : "n/a";
    if (judgement.status !== "judged") {
        console.error(
            `BLOCKER: ${slot.stamp} recovery judgement is ${String(judgement.status ?? "missing")}`,
        );
        process.exit(2);
    }
    judged += 1;
    console.log(
        `${slot.stamp}: ${String(judgement.documentationOutcome)}; retrieval ${String(retrieval)}`,
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
function loggerExit(
    slot: (typeof slots)[number],
    result: ReturnType<typeof spawnSync>,
    judgement: Record<string, unknown> | null,
): void {
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
        retrieval:
            typeof judgement?.retrievalApplication === "object" &&
            judgement.retrievalApplication !== null
                ? ((judgement.retrievalApplication as Record<string, unknown>)
                      .state ?? null)
                : null,
    });
}
