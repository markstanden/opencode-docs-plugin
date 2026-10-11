import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    CLAIM_SECTIONS,
    EXCLUDED_AREAS,
    FRONT_MATTER_FIELDS,
    MIN_TERM_LENGTH,
} from "../src/index.ts";

/** Read a doctrine file relative to this test file. */
function doctrine(relative: string): string {
    return readFileSync(join(import.meta.dirname, relative), "utf8");
}

/**
 * The doctrine ships in two places: `CONVENTION.md` (the human-facing
 * authority) and `src/SKILL.md` (the content the plugin registers as the
 * `docs` skill). Both must stay in step with the code constants, or the text
 * silently describes a convention the tool no longer enforces.
 */
const DOCTRINE = {
    "CONVENTION.md": doctrine("../CONVENTION.md"),
    "SKILL.md": doctrine("../src/SKILL.md"),
};

describe("convention alignment", () => {
    for (const [file, text] of Object.entries(DOCTRINE)) {
        describe(file, () => {
            it("names every front-matter field", () => {
                for (const { name } of FRONT_MATTER_FIELDS) {
                    assert.match(
                        text,
                        new RegExp(`\\b${name}\\b`),
                        `${file} does not name the ${name} field`,
                    );
                }
            });

            it("names every claim section", () => {
                for (const section of CLAIM_SECTIONS) {
                    assert.ok(
                        text.includes(section),
                        `${file} does not name the ${section} section`,
                    );
                }
            });

            it("names every excluded area", () => {
                for (const area of EXCLUDED_AREAS) {
                    assert.ok(
                        text.includes(`${area}/`),
                        `${file} does not name the ${area}/ area`,
                    );
                }
            });

            it("states the identity term floor", () => {
                const floor = "`MIN_TERM_LENGTH` (" + MIN_TERM_LENGTH + ")";

                assert.ok(
                    text.includes(floor),
                    `${file} does not state ${floor}`,
                );
            });
        });
    }
});
