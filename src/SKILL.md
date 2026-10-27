# Docs

Durable knowledge lives in **lakes**. The plugin reads every configured lake
and the project's nested `README.md` files. This skill covers both halves of the
loop: **find** (search, then read) and **record** (write or update a focused
doc at the narrowest true scope).

Call the `docs` tool at top level. Inside `execute` (Code Mode) the same tool
is reachable as the twin `tools.docs.docs_search(…)` — same verbs, same lakes —
so batch it with the rest of the catalog there.

## Classes

| Class              | Where                       | Use it for                              | Writes        |
| ------------------ | --------------------------- | --------------------------------------- | ------------- |
| **Instructions**   | nested `README.md`          | build, run, test, deploy this code      | never         |
| **RepoContext**    | `<repo>/docs`               | this repo's traps, decisions, landmines | yes           |
| **MachineContext** | personal lake (`~/doclake`) | tooling and traps across your machines  | yes           |
| **GlobalContext**  | organisation lake           | standards and integrations across repos | yes, reviewed |
| **Wiki**           | human-readable wiki         | narrative for humans                    | read-only     |

Record at the **narrowest scope where the whole claim is true**. Two scopes
means two focused docs. Never one omnibus doc that is out of place.

## Find it

Call the `docs` tool:

- **blank `search`** — the most recently changed docs, one line per doc
  (`path — Area — date — Summary`).
- **a `search`** — docs ranked over title, path, keywords, body headings and
  code spans, area, summary and wiki prose. When no doc contains every term it
  returns the closest matches under a `Closest matches` header rather than a
  dead end. A term must appear as a **substring** to match — a typo returns
  nothing, by design. Terms shorter than `MIN_TERM_LENGTH` (3) are ignored
  unless they are the whole query.
- **every call** reserves up to `perLakeQuota` results per source (default 3),
  caps at `MAX_RESULTS` (10), and ends with `… and N more not shown.` when
  anything was cut. The reservation keeps a broad wiki from burying a focused
  repo doc.
- **exactly `help`** — the configured lakes, their classes and writability,
  then the ranking rules.

Then open the match with the tool's `read` verb — pass the root-relative path,
or `lake:path` when several lakes are configured. `/docs [search]` runs the same
search into the session (`/docs search <text>` is the explicit form).

Every `*.md` under a knowledge lake is covered except the excluded areas —
scratch (`plans/`) and vendored mirrors (`requirements/`, `wiki/`). `Area` comes
from the path, `date` from git. Wiki lakes are read-only; their pages are
indexed as prose and tables, and their summaries are derived from the first
paragraph. A README is search-only and is never validated.

## Read it

- Consult matching docs before a broad grep: they are the curated knowledge.
- Class precedence on a tie is repo, instructions, global, machine, wiki. A
  non-primary lake is prefixed (`global:platform/regions.md`,
  `wiki:Integrations/Billing.md`).
- A `Summary` is a self-contained sentence — enough to decide whether to open
  the file.

## Record it

Write durable findings and task documentation to `<area>/<title>.md` under the
right lake so the next human or agent skips the rediscovery. The convention is
this plugin's `CONVENTION.md`, restated here.

Before writing:

1. **Read first, never duplicate.** Search the tree and read the docs relevant
   to the task: the same `<area>/` neighbourhood, keyword hits on the task's
   entities (service names, file paths, error strings, class names), or links
   from touched docs.
2. **Choose one class.** Repo-specific goes to RepoContext. Personal setup goes
   to MachineContext. Cross-repo org knowledge goes to GlobalContext. How-to
   commands stay in the README. Human narrative goes to the wiki, read-only.
3. **Reconcile, then add.** Edit before add; merge near-twins; split a bloated
   doc into per-topic files; after any split, merge or move, grep for inbound
   references and repoint them. Delete the emptied doc — no superseded stubs.

One artifact per topic, one class per artifact: a session's findings land as
several focused docs, never one session dump — a compaction nudge hands you
`Record with docs add:` blocks already shaped for this.

Then record through the `docs` tool's typed `add`: metadata (`Area`, `Keywords`
as a list, `Summary`) plus a body carrying an `H1` and a claim section (`Facts`,
`Inferred`, `Tested`, `Failed approaches`, `Open questions`). The tool
serialises the front-matter — never copy it — and derives the target
(`<Area>/<slug>.md`) when `path` is omitted; pass `path` to update an existing
doc, replacing its body wholesale. Its guardrails refuse blank metadata, path
traversal, a body without an `H1`, a read-only wiki lake, and a same-area
near-twin (returning the candidates to reconcile against).

A doc is current or deleted. There is no `Status` or `Supersedes` field. A
failed attempt is valid knowledge when it records what was tried, why it failed,
what is true now, and what not to retry. `check` reports the old fields as
obsolete notes so a lake can be cleaned once.

## Check it

To audit the knowledge lakes instead of writing them, call the tool's `check`
(`/docs check` runs it into the session): it validates required front-matter, an
`H1`, at least one claim section, no hand-maintained `Date`, an `H1`+`Keywords`
identity with a term of `MIN_TERM_LENGTH` (3) or longer, same-area near-twins,
and broken relative `.md` links. Obsolete fields, long docs and unversioned or
missing roots are **notes**, not findings. Wiki lakes are read-only and are
reported as not validated. `add` enforces the same structural rules at the
trust boundary.

Finally, run the repo's gate (`defined comply` where `.defined.json` exists,
else what its README documents) before proposing a commit. Fix failures; never
paper over a red gate with a docs commit. Prepare the commit and **wait for
explicit approval** — recording findings is not commit approval. Never push.
