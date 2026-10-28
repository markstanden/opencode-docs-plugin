import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { DOCS_INPUT } from "../src/index.ts";

/**
 * The recurring context budget: text the host loads on every request, or ships
 * in the skill catalog. These ceilings are editorial, set once by hand after
 * the 0.5.2 prose rewrite — never derived from the current output, or the test
 * would ratify whatever it is handed. Their purpose is to stop a rule creeping
 * back into a surface that already states it, not to prove the prose is good.
 *
 * Separate surfaces, separate ceilings: the native description is always
 * loaded, the twin's is in every `execute` catalog, and the skill body is
 * on-demand but shipped whole.
 */
const BUDGETS = {
    /** The native `docs` description: routing only, no ranking inventory. */
    nativeDescription: 600,
    /** The Code Mode twin's catalog line. */
    twinDescription: 500,
    /** The skill discovery description the host lists. */
    skillDescription: 420,
    /** The shipped `src/SKILL.md` body. */
    skillBody: 4600,
    /** The tool description plus every schema annotation it carries. */
    descriptionPlusAnnotations: 2100,
} as const;

const REPO = join(import.meta.dirname, "..");

/** What `setup` registered, captured from a minimal fake context. */
interface Registered {
    tools: Array<{ name: string; description: string }>;
    skills: Array<{ description: string }>;
}

/**
 * Run the plugin's `setup` against a fake context so the test measures the
 * strings the host actually receives, not a copy pasted from the source.
 * @param directory The project location the plugin resolves its lakes against.
 * @returns The registered tools and skills.
 */
async function registered(directory: string): Promise<Registered> {
    const bucket: Registered = { tools: [], skills: [] };
    const domain = (target: unknown[]) => ({
        hook: async () => ({ dispose: async () => {} }),
        transform: async (callback: (editor: unknown) => void) => {
            callback({
                add: (definition: unknown) => void target.push(definition),
            });
        },
    });
    await plugin.setup({
        options: {},
        location: { directory },
        tool: domain(bucket.tools),
        command: domain([]),
        skill: domain(bucket.skills),
        session: {
            hook: async () => ({ dispose: async () => {} }),
            prompt: async () => {},
        },
    } as never);
    return bucket;
}

/**
 * Every `description` annotation reachable from the input schema — the payload
 * a model reads in the tool definition alongside the description itself, so
 * prose cannot migrate into annotations to evade the budget.
 * @returns The annotation strings.
 */
function annotationDescriptions(): string[] {
    const found: string[] = [];
    const seen = new Set<unknown>();
    const walk = (node: unknown): void => {
        if (typeof node !== "object" || node === null || seen.has(node)) {
            return;
        }
        seen.add(node);
        const annotations = (node as { annotations?: unknown }).annotations;
        if (typeof annotations === "object" && annotations !== null) {
            const { description } = annotations as { description?: unknown };
            if (typeof description === "string") {
                found.push(description);
            }
        }
        for (const value of Object.values(node)) {
            if (typeof value === "function") {
                continue;
            }
            if (Array.isArray(value)) {
                value.forEach(walk);
            } else {
                walk(value);
            }
        }
    };
    walk((DOCS_INPUT as { ast?: unknown }).ast);
    return found;
}

describe("model-facing prose budget", () => {
    const directory = mkdtempSync(join(tmpdir(), "docs-plugin-budget-"));

    // One setup for the whole suite: registration is what is measured.
    const pending = registered(directory);

    process.on("exit", () =>
        rmSync(directory, { recursive: true, force: true }),
    );

    it("keeps the native description within its ceiling", async () => {
        const { tools } = await pending;
        const native = tools.find((tool) => tool.name === "docs");

        assert.ok(native, "the native tool was not registered");
        assert.ok(
            native.description.length <= BUDGETS.nativeDescription,
            `native description is ${native.description.length} chars, ` +
                `over the ${BUDGETS.nativeDescription} ceiling`,
        );
    });

    it("keeps the twin description within its ceiling", async () => {
        const { tools } = await pending;
        const twin = tools.find((tool) => tool.name === "docs_search");

        assert.ok(twin, "the Code Mode twin was not registered");
        assert.ok(
            twin.description.length <= BUDGETS.twinDescription,
            `twin description is ${twin.description.length} chars, ` +
                `over the ${BUDGETS.twinDescription} ceiling`,
        );
    });

    it("keeps the skill discovery description within its ceiling", async () => {
        const { skills } = await pending;
        const [skill] = skills;

        assert.ok(skill, "the skill was not registered");
        assert.ok(
            skill.description.length <= BUDGETS.skillDescription,
            `skill description is ${skill.description.length} chars, ` +
                `over the ${BUDGETS.skillDescription} ceiling`,
        );
    });

    it("keeps the shipped skill body within its ceiling", () => {
        const body = readFileSync(join(REPO, "src", "SKILL.md"), "utf8");

        assert.ok(
            body.length <= BUDGETS.skillBody,
            `SKILL.md is ${body.length} chars, over the ` +
                `${BUDGETS.skillBody} ceiling`,
        );
    });

    it("keeps the description plus schema annotations within their ceiling", async () => {
        const { tools } = await pending;
        const native = tools.find((tool) => tool.name === "docs");

        assert.ok(native, "the native tool was not registered");
        const payload =
            native.description.length +
            annotationDescriptions().join(" ").length;
        assert.ok(
            payload <= BUDGETS.descriptionPlusAnnotations,
            `description + annotations are ${payload} chars, over the ` +
                `${BUDGETS.descriptionPlusAnnotations} ceiling`,
        );
    });
});
