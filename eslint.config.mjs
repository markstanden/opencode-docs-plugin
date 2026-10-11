import eslintConfigPrettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
    { ignores: ["**/node_modules/", "**/coverage/**"] },
    {
        files: ["**/*.{ts,mjs}"],
        extends: [tseslint.configs.recommended],
        rules: {
            // The doc convention's front-matter keys are PascalCase on purpose
            // (Area, Keywords, Summary), so properties and type properties
            // allow PascalCase alongside the usual forms.
            "@typescript-eslint/naming-convention": [
                "error",
                {
                    selector: "default",
                    format: ["camelCase"],
                    leadingUnderscore: "allow",
                },
                {
                    selector: "variable",
                    format: ["camelCase", "UPPER_CASE"],
                },
                { selector: "function", format: ["camelCase"] },
                { selector: "typeLike", format: ["PascalCase"] },
                {
                    selector: "property",
                    format: [
                        "camelCase",
                        "UPPER_CASE",
                        "snake_case",
                        "PascalCase",
                    ],
                },
                {
                    selector: "typeProperty",
                    format: ["camelCase", "snake_case", "PascalCase"],
                },
                // Quoted keys (e.g. a path literal as an object key) are not
                // identifiers, so no naming format applies to them.
                {
                    selector: "property",
                    modifiers: ["requiresQuotes"],
                    format: null,
                },
            ],
        },
    },
    {
        // Tool-config files are not source: rule keys like
        // "@typescript-eslint/naming-convention" aren't identifiers to enforce.
        files: ["*.config.{mjs,ts,mts}"],
        rules: { "@typescript-eslint/naming-convention": "off" },
    },
    eslintConfigPrettier,
);
