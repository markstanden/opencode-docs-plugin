# Docs

Durable knowledge lives under the configured docs root (the plugin's `root`
option; default `<location>/docs`). This skill covers both
halves of the loop: **find** (discover with the `docs` tool, read the match) and
**record** (write or update a doc for the current task).

Call the `docs` tool at top level. Inside `execute` (Code Mode) the same tool
is reachable as the twin `tools.docs.docs_search(…)` — same verbs, same lake —
so batch it with the rest of the catalog there.

## Find it

Call the `docs` tool:

- **blank `search`** — the most recently changed docs, one line per doc
  (`path — Area — date — Summary`).
- **a `search`** — those docs ranked over title, path, keywords, body headings
  and code spans, area and summary. When no doc contains every term it returns
  the closest matches under a `Closest matches` header rather than a dead end.
  A term must appear as a **substring** to match — a typo returns nothing, by
  design. Terms shorter than `MIN_TERM_LENGTH` (3) are ignored unless they are
  the whole query, so filler words cannot drag in the catalogue.
- **every call** caps at `MAX_RESULTS` (10), preferring the best matches and
  then the most recent edits, and ends with `… and N more not shown.` when
  anything was cut.
- **exactly `help`** — plain text explaining the weights, the hit qualities and
  the outcomes, instead of a search.

Then open the match: either the built-in `read` tool (project files and
READMEs), or the tool's own `read` verb — pass the root-relative path and it
returns the doc verbatim, front-matter and body, in one call.
`/docs [search]` runs the same search into the session (`/docs search <text>`
is the explicit form).

Every `*.md` under the root is covered except the excluded areas — scratch (`plans/`)
and vendored mirrors (`requirements/`, `wiki/`). `Area` comes from the path,
`date` from git. A doc marked `Status: superseded` carries a `(superseded)`
marker in results and ranks below an active doc on a tie.

Search also covers nested `README.md` files in the project tree — the map lives
beside the code. They are indexed as they stand (H1 title, headings, code
spans) and are **search-only**: `add` and `check` never touch them.
`.gitignore` decides which directories are skipped; outside git, dependency and
build directories are skipped by name. The lake root is skipped when it sits
inside the project, since those READMEs are already knowledge docs.

## Read it

- Consult matching docs before a broad grep: they are the curated knowledge.
- A `Summary` is a self-contained sentence — enough to decide whether to open
  the file.

## Record it

Write durable findings and task documentation to `<area>/<title>.md` under the
root so the
next human or agent skips the rediscovery. The convention is this plugin's
`CONVENTION.md`, restated here.

Before writing:

1. **Read first, never duplicate.** List the tree with the `docs` tool and read
   the docs relevant to the task: the same `<area>/` neighbourhood, keyword
   hits on the task's entities (service names, file paths, error strings, class
   names), or links from touched docs.
2. **Reconcile, then add.** Edit before add; merge near-twins; split a bloated
   doc into per-topic files; after any split, merge or move, grep for inbound
   references and repoint them, leaving a stub if needed.

One artifact per topic: a session's findings land as several focused docs,
never one session dump — a compaction nudge hands you `Record with docs add:`
blocks already shaped for this.

Then record through the `docs` tool's typed `add`: metadata (`Area`, `Keywords`
as a list, `Summary`; optionally `Status`/`Supersedes`) plus a body carrying an
`H1` and the claim sections (`Facts`, `Inferred`, `Tested`, `Open questions`).
The tool serialises the front-matter — never copy it — and derives
the target (`<Area>/<slug>.md`) when `path` is omitted; pass `path` to
update an existing doc, replacing its body wholesale. Its guardrails refuse
blank metadata, path traversal, a body without an `H1`, and a same-area
near-twin (returning the candidates to reconcile against). A plan for an
in-flight effort is scratch, not a doc — a `plans/` area, excluded from the
index and deleted when the work lands. `/docs add <text>` runs this record
loop for a fact supplied inline.

## Check it

To audit the tree instead of writing it, call the tool's `check` (`/docs check`
runs it into the session): it validates every doc against the convention —
required front-matter, an `H1`, at least one claim section, no hand-maintained
`Date`, an `H1`+`Keywords` identity with a term of `MIN_TERM_LENGTH` (3) or
longer, a `Supersedes` naming a doc in the tree, and same-area near-twins — and
reports findings per doc. An empty report means compliant. `add` enforces the
same rules at the trust boundary.

Finally, run the repo's gate (`defined comply` where `.defined.json` exists,
else what its README documents) before proposing a commit. Fix failures; never
paper over a red gate with a docs commit. Prepare the commit and **wait for
explicit approval** — recording findings is not commit approval. Never push.
