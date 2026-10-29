import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
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
 * The JSON Schema the host derives from a tool input schema — the supported
 * conversion, rather than Effect's internal AST. Missing or unreadable output
 * fails here instead of silently measuring nothing.
 * @param schema The tool input schema.
 * @returns The root JSON Schema object.
 */
function schemaDocument(schema: unknown): Record<string, unknown> {
    if (schema === undefined || schema === null) {
        throw new Error("the tool input schema is absent");
    }
    const document = Schema.toJsonSchemaDocument(schema as never) as {
        readonly schema?: unknown;
    };
    if (typeof document.schema !== "object" || document.schema === null) {
        throw new Error("the tool input schema has no readable JSON Schema");
    }
    return document.schema as Record<string, unknown>;
}

/**
 * Every `description` annotation reachable from the converted input schema —
 * the payload a model reads in the tool definition alongside the description
 * itself, so prose cannot migrate into annotations to evade the budget.
 * @param schema The tool input schema.
 * @returns The annotation strings.
 */
function annotationDescriptions(schema: unknown): string[] {
    const found: string[] = [];
    const seen = new Set<unknown>();
    const walk = (node: unknown): void => {
        if (typeof node !== "object" || node === null || seen.has(node)) {
            return;
        }
        seen.add(node);
        const { description } = node as { description?: unknown };
        if (typeof description === "string") {
            found.push(description);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                value.forEach(walk);
            } else {
                walk(value);
            }
        }
    };
    walk(schemaDocument(schema));
    return found;
}

/** A path through the converted JSON Schema: object keys and array indices. */
type SchemaPath = ReadonlyArray<string | number>;

/** The node at `path`, or a clear failure when the shape is unexpected. */
function nodeAt(root: unknown, path: SchemaPath): unknown {
    let current = root;
    for (const key of path) {
        if (typeof key === "number") {
            if (!Array.isArray(current)) {
                throw new Error(`${path.join(".")}: expected an array`);
            }
            current = current[key];
        } else {
            if (typeof current !== "object" || current === null) {
                throw new Error(`${path.join(".")}: expected an object`);
            }
            current = (current as Record<string, unknown>)[key];
        }
    }
    return current;
}

/** The description annotation at `path`, or a clear failure when absent. */
function descriptionAt(root: unknown, path: SchemaPath): string {
    const node = nodeAt(root, path);
    if (typeof node !== "object" || node === null) {
        throw new Error(`${path.join(".")}: expected an object`);
    }
    const { description } = node as { description?: unknown };
    if (typeof description !== "string") {
        throw new Error(`${path.join(".")}: no description annotation`);
    }
    return description;
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

    it("discovers representative top-level and nested annotations", () => {
        const root = schemaDocument(DOCS_INPUT);
        const add = ["properties", "add", "anyOf", 0] as const;
        const paths: readonly SchemaPath[] = [
            ["properties", "search", "anyOf", 0],
            ["properties", "lake", "anyOf", 0],
            add,
            [...add, "properties", "path", "anyOf", 0],
            [...add, "properties", "metadata"],
            [...add, "properties", "body"],
            ["properties", "check", "anyOf", 0],
            ["properties", "read", "anyOf", 0],
        ];
        const discovered = annotationDescriptions(DOCS_INPUT);

        for (const path of paths) {
            assert.ok(
                discovered.includes(descriptionAt(root, path)),
                `the walk missed the annotation at ${path.join(".")}`,
            );
        }
    });

    it("measures a synthetic nested description large enough to exceed the budget", () => {
        const huge = "x".repeat(BUDGETS.descriptionPlusAnnotations + 1);
        const synthetic = Schema.Struct({
            outer: Schema.Struct({
                inner: Schema.String.annotate({ description: huge }),
            }),
        });

        const discovered = annotationDescriptions(synthetic);
        const payload = discovered.join(" ").length;

        assert.ok(
            discovered.includes(huge),
            "the nested synthetic annotation was not measured",
        );
        assert.ok(
            payload > BUDGETS.descriptionPlusAnnotations,
            `synthetic annotation payload is ${payload} chars; the measurement ` +
                `did not cross the ${BUDGETS.descriptionPlusAnnotations} ceiling`,
        );
    });

    it("fails clearly when the schema representation is absent", () => {
        assert.throws(
            () => annotationDescriptions(undefined),
            /tool input schema/,
        );
        assert.throws(() => schemaDocument(null), /tool input schema/);
    });

    it("keeps the description plus schema annotations within their ceiling", async () => {
        const { tools } = await pending;
        const native = tools.find((tool) => tool.name === "docs");

        assert.ok(native, "the native tool was not registered");
        const payload =
            native.description.length +
            annotationDescriptions(DOCS_INPUT).join(" ").length;
        assert.ok(
            payload <= BUDGETS.descriptionPlusAnnotations,
            `description + annotations are ${payload} chars, over the ` +
                `${BUDGETS.descriptionPlusAnnotations} ceiling`,
        );
    });
});
