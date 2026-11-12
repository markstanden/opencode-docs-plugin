// Campaign-local judge credential loading. The key never enters the repo or
// the evidence: it comes from the environment, a named file, or the campaign
// root's own .env (which is never committed).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
        const match = /^\s*ZAI_API_KEY\s*=\s*(.*)\s*$/.exec(line);
        if (match === null) continue;
        const value = (match[1] ?? "").replace(/^["']|["']$/g, "").trim();
        if (value !== "") {
            process.env.ZAI_API_KEY = value;
            return "campaign .env";
        }
    }
    return null;
}
