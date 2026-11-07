# opencode-docs-plugin

An [OpenCode](https://opencode.ai) V2 plugin that gives an agent a set of
knowledge **lakes** it can actually use: a `docs` tool and a `/docs` command
over configured Markdown trees, nested `README.md` files in the project, and the
writing convention those docs follow.

Docs are grouped by **scope** (config values never change; labels are how the
tool presents them):

| Scope            | Config value                | Where                           | Use it for                                      | Writes        |
| ---------------- | --------------------------- | ------------------------------- | ----------------------------------------------- | ------------- |
| **Repository**   | `repo` / nested `README.md` | `<repo>/docs` by default        | this repo's traps, decisions, landmines         | yes           |
| **Personal**     | `machine`                   | personal lake, e.g. `~/doclake` | a person's devices, accounts and setup          | yes           |
| **Organisation** | `global`                    | organisation lake               | standards and integrations, with their boundary | yes, reviewed |
| **Instructions** | implicit                    | nested `README.md`              | build, run, test, deploy this code              | never         |
| **Wiki**         | `wiki`                      | human-readable wiki checkout    | narrative for humans                            | read-only     |

Place knowledge at the **narrowest justified scope**. Identify the claim and
what it depends on: this repo → Repository; a person's device, account or
setup → Personal; an established shared rule → Organisation, stating its
actual team boundary; operational steps → the README workflow; human
narrative → the wiki's owners. Reusability alone is not organisational
ownership, and unresolved ownership stays an explicit question — never a
guessed destination. The full rulebook is [CONVENTION.md](CONVENTION.md); the
registered `docs` skill carries the working version.

## The tool and command

- `docs` (tool) — blank search lists the most recently changed docs
  (`path — Area — date — Summary`); a search ranks docs over their front-matter,
  path and body identifiers (plus wiki prose), falling back to the closest
  matches rather than a dead end; `read` returns a doc verbatim and accepts a
  `lake` or `lake:path`; `add` writes knowledge through a typed DTO with an
  explicit `mode`; `check`
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
lake; for a personal or organisation lake, use `lakes` with the class instead.
Its name follows the root folder unless you set the `name` option beside it,
and `description` documents what belongs there the same way:

```jsonc
{
    "plugins": [
        {
            "package": "@markstanden/opencode-docs-plugin",
            "options": {
                "root": "documentation",
                "name": "doclake",
                "description": "This repository's decisions and traps.",
            },
        },
    ],
}
```

`name` and `description` only apply to `root`; inside `lakes`, set them on the
entry.

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
        {
            "class": "machine",
            "root": "~/doclake",
            "name": "doclake",
            "description": "Personal devices, workstation configuration and individual tooling preferences.",
        },
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

| Field         | Meaning                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `class`       | `repo`, `machine`, `global` or `wiki`; default `repo`. Presented as Repository, Personal, Organisation, Wiki.                                                                                                       |
| `root`        | The lake root. Required for `machine`/`global`/`wiki`; defaults to `<location>/docs` for `repo`.                                                                                                                    |
| `name`        | Lower-case dashes; defaults to the root folder name. `instructions` is reserved.                                                                                                                                    |
| `description` | Optional. What belongs in this particular destination; shown in `help` and refusal candidate lists. Trimmed, blank counts as absent, non-string fails at startup. Descriptive data only — never indexed for search. |
| `writable`    | Defaults true for knowledge classes, fixed false for `wiki`.                                                                                                                                                        |

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
returns the inner lake's entry and a bare `read` resolves to it. `add` never
infers a destination from nesting: an omitted `lake` needs exactly one
configured writable knowledge lake (see below), and a write addressed through
an outer route that physically resolves inside a nested lake's tree refuses,
naming its physical owner. Two lakes that do not nest holding the same
relative path stay a refusal — pass `lake`. Near-twin checks apply inside one
lake and never pair across the nesting boundary.

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

### Choosing a write destination

`add` writes through the `lake` selector deliberately; it never guesses.

- An explicit `lake` selects exactly that lake: an unknown, read-only, or
  missing-root lake refuses — it never falls back to another.
- With exactly one configured writable knowledge lake, an omitted `lake` uses
  it. That is a convenience, not a classification: check the destination fits
  before writing.
- With several writable knowledge lakes (two `machine` lakes included), an
  omitted `lake` refuses before writing and lists **every** writable
  candidate — name, scope label and config value, root, availability,
  description. Nesting, class, configuration order and missing roots change
  nothing: folder depth cannot infer the semantic owner of a claim, and no
  candidate is auto-selected for being the deepest.
- With no writable knowledge lake, `add` refuses; wiki and read-only lakes are
  never written. A temporarily missing root still counts as a candidate, so
  dormancy cannot silently change the destination.
- Searching and checking never need a destination; they run across all lakes.

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
Correct a wrong doc by replacing it in place with `mode: "replace"`. A failed
attempt is valid knowledge when it records the outcome and what is true now.

## Creating and replacing

`add` carries an explicit mutation `mode`; the implicit path-based update of
earlier versions is intentionally unsupported.

```jsonc
// Create: path is optional — omitted derives <Area>/<slug>.md from the H1.
{
    "add": {
        "mode": "create",
        "metadata": { "Area": "decisions", "Keywords": ["queue"], "Summary": "Why Kafka." },
        "body": "# Queue choice\n\n### Facts\n\n- Kafka, for the replay window.\n"
    }
}

// Replace: path is required and must name an existing doc, and
// expectedRevision must match the doc's current bytes — the token your last
// read (or write) returned. The body is wholesale: omitted content is lost.
// A stale token refuses; read again, reconcile, resubmit.
{
    "add": {
        "mode": "replace",
        "path": "decisions/queue-choice.md",
        "expectedRevision": "<sha256 from the read>",
        "metadata": { "Area": "decisions", "Keywords": ["queue"], "Summary": "Why Kafka." },
        "body": "# Queue choice\n\n### Facts\n\n- Kafka, for the replay window.\n"
    }
}
```

A `read` of a knowledge lake doc carries the token in its metadata alongside
the resolved target — `{ read, lake, path, revision }` — and a successful
create or replace returns the new content's revision the same way. The result
text also ends with a `docs: revision …` line, so the token is visible to a
model call and to Code Mode JavaScript, not only in the stored metadata a
host may treat as UI-only. Wiki reads carry no revision: they promise no
write-capable workflow.

- **Create never overwrites.** A target that already exists refuses, even with
  an `allowNearTwinReason`; pass `mode: "replace"` deliberately.
- **Every create reconciles.** An explicit path gets the same structural and
  same-area near-twin checks as a derived path. A genuine near-twin refusal is
  answered by `mode: "replace"` — or, for a deliberate distinct doc, a
  non-blank `allowNearTwinReason`, which bypasses only that semantic guard,
  never target existence, path safety, metadata validation, writability or
  destination ambiguity.
- **Replace never creates.** A missing target refuses; it is never an
  implicit create.
- **Revisions are content, not history.** A revision is the SHA-256 of the
  doc's exact stored bytes; if the same bytes return later, the token matches
  again. Create takes no `expectedRevision` — its precondition is that the
  target does not exist.

## Concurrency limits

Publications of one target are serialised by a per-target lock file in a
hidden `.docs-lock/` directory **beside the target's directory on the real
filesystem**, keyed on the target's canonical physical path: two
configurations reaching the same tree by different routes — including a
permitted symlinked configured root — resolve the same lock location, however
each runtime's lakes are configured. The lock directory is only ever created
inside an already-existing ancestor, existing symlinked or non-directory
objects refuse without being touched, and abandoned locks are never stolen
automatically (confirm the owner is gone, then remove the named file). Older
plugin versions lock at the configured root instead: quiesce or restart them
before relying on this protocol — no automatic migration, and any unknown
existing locks are left alone.

A replacement re-reads and re-checks the revision under the lock and publishes
through a **temp file this operation exclusively creates** (an ordinary
pathname create that never follows a pre-existing symlink or truncates a
foreign file) and an atomic whole-file rename — the all-or-nothing swap is a
**replacement-only guarantee**. A create opens the target exclusively and then
writes its bytes, so a reader inside that window can observe the new file
before every byte is stored; a create's promise is exclusive naming plus
eventually-complete bytes, not atomic first visibility. A physically
addressed write that reaches a nested lake's tree through an outer route is
refused with that lake named, so a writable outer lake cannot make read-only
nested content writable.

The guarantee covers **cooperating plugin writers** and pre-existing
operational-path symlinks — the native tool, the Code Mode twin and `/docs`
all use the same guarded route. It is not armour against an arbitrary local
attacker who can swap directories between individual syscalls, and a manual
editor or unrelated program that ignores the protocol can still race a
publication; changes visible before the guarded commit are detected, but this
is not a filesystem-wide compare-and-swap. A busy lock refuses with its
recorded owner instead of waiting indefinitely.

## Status

Standalone extract of the docs tooling, under active development.

## Development

```bash
npm install
npm test          # node --test
npm run typecheck
```

Testing instructions, the behavioural placement trials and their container
live in [TESTING.md](TESTING.md).

Tests run the plugin source directly under Node's type-stripping (`noEmit`,
`erasableSyntaxOnly`), so the file OpenCode loads is the file under test.

`tests/fixtures/docs-corpus.json` is a hand-authored synthetic corpus the
ranking harness pins behaviour against — edit it directly. It holds invented
paths and summaries only; never snapshot a real docs tree into it.

`tests/fixtures/placement-cases.json` is a synthetic evaluation fixture for
the placement guidance (cases E01–E17, each with a claim, evidence,
destinations, expected scope or action, acceptable rationale and tempting
wrong answer). `tests/fixtures/placement-harness/harness.mjs` runs the cases
behaviourally: `generate` materialises one prompt, one pristine fixture tree
and one out-of-band rubric per case (defaults `~/tmp/docs-placement/` for
prompts, rubrics and results, `~/test-dir/docs-placement/` for fixtures),
`run` copies one case into a stamped results directory and drives a headless
`opencode run` session there, `judge` scores each answer against the case
rubric with a second, plugin-free model call (`--judge-model` names a stronger
judge than the workhorse), and `export` bundles a sweep into one `dossier.md`
for deep review by an external model. Trials judge placement from the supplied
finding: the sandbox denies shell, edits and reads outside the workspace, and
a per-case run container sees only that case's sandbox, prompt and result.
`container-run.sh` runs the harness inside a Debian-slim trial container
(Node LTS, current `@opencode/cli`, read-only root filesystem) so trials see
no host filesystem at all; the harness can also run directly on the host.
Runs modify neither the repository nor the fixture trees. The first
behavioural sweep is recorded: sweep-1 (2026-11-07, plugin 0.12.0 at main
`f5a5882`), decision-only prompts with the `docs` skill in session, workhorse
`opencode-go/deepseek-v4.1-flash` in the trial container — 14/17 under the
workhorse judge, 17/17 under `zai-coding-plan/glm-5.3-flash`, with the three
disagreements resolved by manual review in favour of rewording the fixture
and rubric (E09, E06) rather than the guidance; see [TESTING.md](TESTING.md).
The principle stands: a fixture that merely asserts expected answers in Node
is not evidence a model follows the guidance. In this repository,
`/placement` (workflow in
`.opencode/skills/placement-trials/`) drives the harness: trials run on the
workhorse model, judging defaults to the current session model, and `export`
bundles a sweep for a stronger external reviewer.

## Licence

MIT — see [LICENSE](LICENSE).
