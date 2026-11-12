// Campaign-local judge credential loading. The key never enters the repo or
// the evidence: it comes from the environment, a named file, or the campaign
// root's own .env (which is never committed).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Mode bits that must be clear on a file holding a credential. */
const SHARED_BITS = 0o077;

/**
 * Load `ZAI_API_KEY` for the judge if the caller has not already exported it.
 * @param root The campaign root.
 * @returns The source description, or null when no key is available.
 */
export function loadJudgeKey(root) {
    if (process.env.ZAI_API_KEY) return "environment";
    const named = process.env.ZAI_API_KEY_FILE;
    if (named !== undefined && existsSync(named)) {
        process.env.ZAI_API_KEY = readFileSync(named, "utf8").trim();
        return "named file";
    }
    const envPath = join(root, ".env");
    if (!existsSync(envPath)) return null;
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
        const equals = line.indexOf("=");
        if (equals < 0) continue;
        if (line.slice(0, equals).trim() !== "ZAI_API_KEY") continue;
        const value = line
            .slice(equals + 1)
            .replace(/^["']|["']$/g, "")
            .trim();
        if (value !== "") {
            process.env.ZAI_API_KEY = value;
            return "campaign .env";
        }
    }
    return null;
}

/**
 * Why a campaign credential file is unsafe to read, or null.
 *
 * A key read from disk must not be readable by another user. The check is on
 * the source file, before its value is loaded, so an unsafe file never enters
 * the process environment.
 * @param root The campaign root.
 * @returns A problem naming the file and its mode, or null.
 */
export function credentialFileProblem(root) {
    const candidates = [join(root, ".env")];
    const named = process.env.ZAI_API_KEY_FILE;
    if (named !== undefined) candidates.push(named);
    for (const path of candidates) {
        if (!existsSync(path)) continue;
        const mode = statSync(path).mode & 0o777;
        if ((mode & SHARED_BITS) !== 0) {
            return `${path} is readable beyond its owner (mode ${mode.toString(8)}); chmod 600 it before use`;
        }
    }
    return null;
}
