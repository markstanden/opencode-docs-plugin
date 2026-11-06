# opencode-docs-plugin

An [OpenCode](https://opencode.ai) V2 plugin that gives an agent a set of
knowledge **lakes** it can actually use: a `docs` tool and a `/docs` command
over configured Markdown trees, nested `README.md` files in the project, and the
writing convention those docs follow.

Docs are grouped by **class**:

| Class              | Where                           | Use it for                              | Writes        |
| ------------------ | ------------------------------- | --------------------------------------- | ------------- |
| **Instructions**   | nested `README.md`              | build, run, test, deploy this code      | never         |
| **RepoContext**    | `<repo>/docs` by default        | this repo's traps, decisions, landmines | yes           |
| **MachineContext** | personal lake, e.g. `~/doclake` | tooling and traps across your machines  | yes           |
| **GlobalContext**  | organisation lake               | standards and integrations across repos | yes, reviewed |
| **Wiki**           | human-readable wiki checkout    | narrative for humans                    | read-only     |

Place knowledge at the narrowest scope where the whole claim is true. A doc that
spans scopes is split into focused docs, one per class. The full rulebook is
[CONVENTION.md](CONVENTION.md); the registered `docs` skill carries the working
version.

## The tool and command

- `docs` (tool) — blank search lists the most recently changed docs
  (`path — Area — date — Summary`); a search ranks docs over their front-matter,
  path and body identifiers (plus wiki prose), falling back to the closest
  matches rather than a dead end; `read` returns a doc verbatim and accepts a
  `lake` or `lake:path`; `add` writes knowledge through a typed DTO; `check`
  validates the knowledge lakes. Nested project `README.md` files are indexed
  too — `.gitignore` rules decide what is skipped — but only for search: `add`
  and `check` never touch them, and their results are prefixed `instructions:`
  and read with the built-in `read` tool. A Code Mode twin, `docs_search`,
  registers alongside it, so `execute` reaches the same lakes as
  `tools.docs.docs_search(…)`.
- `/docs` (command) — the same core, driven from the prompt:
  `search <text>` (bare text searches too), `add <text>`, `check`, `help`.
- The plugin also registers the `docs` skill, so the convention travels with
  the tool rather than living in always-loaded prose.

Reading a matched project file stays OpenCode's built-in `read`. The tool's own
`read` serves lake docs and wiki pages.

Every source reserves a few results (default 3 per source) before the rest of
the cap fills by score, so a broad wiki cannot bury a focused repo doc. The
cap is 10 results; the cut is counted.

## Installation

From npm:

```sh
opencode plugin add @markstanden/opencode-docs-plugin
```

or as a `plugins` entry in `opencode.json(c)` (global, project or `.opencode/`):

```jsonc
{
    "$schema": "https://opencode.ai/config.json",
    "plugins": ["@markstanden/opencode-docs-plugin"],
}
```

Unpinned entries update on the next server start or `opencode plugin update`;
an exact version (e.g. `@0.5.0`) stays pinned.

## Configuration

One docs plugin entry, in the global or managed config. **Do not repeat the
entry at project level**: the same package loads twice and both copies receive
the project options, losing the base lakes. Add per-repo lakes through the repo
file instead.

The simplest setup uses `root` — one repo lake:

```jsonc
{
    "plugins": [
        {
            "package": "@markstanden/opencode-docs-plugin",
            "options": {
                "root": "./docs",
            },
        },
    ],
}
```

`root` expands `~`, resolves a relative path against the location, and defaults
to `<location>/docs`. A blank value counts as unset. `root` declares a **repo**
lake; for a personal or global lake, use `lakes` with the class instead. Its
name follows the root folder unless you set the `name` option beside it:

```jsonc
{
    "plugins": [
        {
            "package": "@markstanden/opencode-docs-plugin",
            "options": { "root": "documentation", "name": "doclake" },
        },
    ],
}
```

`name` only applies to `root`; inside `lakes`, set it on the entry.

For several lakes, list them inline, in a base file, or both. The base file is
usually a personal or managed file; the repo file adds local lakes:

```jsonc
{
    "plugins": [
        {
            "package": "@markstanden/opencode-docs-plugin",
            "options": {
                "lakesFile": "~/.config/opencode/docs-lakes.json",
                "lakes": [{ "class": "repo", "root": "./docs" }],
                "maxDocLines": 200,
                "perLakeQuota": 3,
            },
        },
    ],
}
```

`~/.config/opencode/docs-lakes.json`:

```jsonc
{
    "lakes": [
        { "class": "machine", "root": "~/doclake", "name": "doclake" },
        { "class": "global", "root": "~/org-docs", "name": "global" },
        { "class": "wiki", "root": "~/org-wiki", "name": "wiki" },
    ],
}
```

A repo adds its own lakes in `.opencode/docs-lakes.json`, checked into the repo:

```jsonc
{
    "lakes": [
        { "root": "documentation", "name": "docs" },
        { "root": "reference", "name": "reference", "writable": false },
    ],
}
```

Repo-file rules:

- only `repo` lakes;
- roots must resolve inside the location;
- an absent file is ignored; a malformed file fails at startup.

A sibling repository's docs belong in the base `lakesFile`, not the repo file.

Merge order: base `lakesFile`, repo file, inline `lakes`, then `root`. Duplicate
lake names fail at startup. If no repo lake is configured, one implicit repo
lake at `<location>/docs` is added — so a repo needs no lake file unless its
docs live elsewhere.

Lake entries:

| Field      | Meaning                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `class`    | `repo`, `machine`, `global` or `wiki`; default `repo`.                                           |
| `root`     | The lake root. Required for `machine`/`global`/`wiki`; defaults to `<location>/docs` for `repo`. |
| `name`     | Lower-case dashes; defaults to the root folder name. `instructions` is reserved.                 |
| `writable` | Defaults true for knowledge classes, fixed false for `wiki`.                                     |

Validation follows writability: `check` validates a writable knowledge lake
only. A read-only knowledge lake, and every `wiki` lake, is indexed for search
and never validated — the plugin cannot write there, so findings could not be
fixed through it. Each skipped lake is named in the report, so "no findings" is
never mistaken for compliance.

Lake paths never follow symlinks: a symlinked doc is skipped by search and
`check`, refused by `read`, and refused by `add`. The configured `root` itself
may be a symlink; the content beneath it must be real.

A lake root nested inside another lake's root is indexed once. The outer lake
skips the nested root, so the doc is returned by the inner lake only — never
twice, and never under both roots. Class and writability make no difference: a
writable repo lake may sit inside a larger read-only wiki lake, and search,
`read` and `add` all resolve to the writable inner lake. The outer lake's class
only decides its own profile and defaults; `repo`, `machine`, `global` and
`wiki` all skip a nested root the same way.

The skip is decided on real paths: every configured root is resolved through
symlinks, junctions and mapped drives before the comparison, so the two
declarations may reach the tree by different routes and the nested doc is
still indexed once.

A doc belongs to the **narrowest enclosing lake**. With nested roots, `search`
returns the inner lake's entry and a bare `read` resolves to it; `add` writes
to the deepest writable knowledge lake, so an outer read-only wrapper never
hijacks the write. Two lakes that do not nest holding the same relative path
stay a refusal — pass `lake`. Near-twin checks apply inside one lake and never
pair across the nesting boundary.

```jsonc
{
    "plugins": [
        {
            "package": "@markstanden/opencode-docs-plugin",
            "options": {
                "lakes": [
                    {
                        "class": "wiki",
                        "root": "~/reference-wiki",
                        "name": "wiki",
                    },
                    {
                        "class": "repo",
                        "root": "~/reference-wiki/work/docs",
                        "name": "work",
                    },
                ],
            },
        },
    ],
}
```

`class` is one of `repo`, `machine`, `global` or `wiki`; `root` and `name` are
strings, and `writable` is a boolean that is fixed `false` for `wiki`. Do not
add `root` alongside `lakes` — they are mutually exclusive.

A missing lake root is flagged, never created. The lake stays dormant until the
directory exists: `search` appends a note naming the lake and path, `help` marks
it `— missing`, and `add` refuses with the path rather than bootstrapping a
tree. Create the directory deliberately. Area folders beneath an existing root
are still created on write.

Root and git notes are computed per call, not captured at startup: a root that
appears, disappears or gains a git checkout is reflected by the next `check`,
`search` and help without a restart.

`maxDocLines` (default 200, `0` disables) is a **soft** note on a long doc, not a
refusal. `perLakeQuota` (default 3, `0` disables) is the per-source result
reservation.

## Wiki lakes

Wiki pages are read-only reference. They carry no required front-matter: the
title comes from the H1, the area from the folder, the summary from the first
prose paragraph, and the date from git. Prose and tables are indexed so a page
that names an Azure region only in a table is still searchable. Wiki lakes are
never validated. If a wiki page drifts from a knowledge doc, report it; the
wiki's owners decide.

## Check

`check` validates the **writable** knowledge lakes: required front-matter, an H1,
at least one claim section (`Facts`, `Inferred`, `Tested`, `Failed approaches`,
`Open questions`), no hand-maintained `Date`, a distinctive H1+Keywords
identity, same-area near-twins, and broken relative `.md` links. Read-only
knowledge lakes and wiki lakes are searched in full but never validated; the
report names each skipped lake and why. Obsolete `Status`/`Supersedes` fields,
long docs, and unversioned or missing roots are **notes**, not findings. An
empty findings list means compliant. A very large report is capped with an
`and N more lines not shown` tail; narrow it with `lake`.

There is no lifecycle field. A doc is current or deleted; git is the archive.
Correct a wrong doc by replacing it in place. A failed attempt is valid
knowledge when it records the outcome and what is true now.

## Status

Standalone extract of the docs tooling, under active development.

## Development

```bash
npm install
npm test          # node --test
npm run typecheck
```

Tests run the plugin source directly under Node's type-stripping (`noEmit`,
`erasableSyntaxOnly`), so the file OpenCode loads is the file under test.

`tests/fixtures/docs-corpus.json` is a hand-authored synthetic corpus the
ranking harness pins behaviour against — edit it directly. It holds invented
paths and summaries only; never snapshot a real docs tree into it.

## Licence

MIT — see [LICENSE](LICENSE).
