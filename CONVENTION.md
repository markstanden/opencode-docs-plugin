# Knowledge-doc convention

This plugin owns this convention: it is what the `docs` tool's `add` writes,
what `check` validates, and what the registered `docs` skill teaches. A
repository that adopts the plugin takes the convention with it.

## Where knowledge lives

Durable knowledge is one Markdown file per topic under the docs root, grouped by
area: `<area>/<name>.md` (the root is the plugin's `root` option; default
`<location>/docs`). The excluded areas — never scanned, never validated —
are `plans/` (scratch, gitignored, deleted when the work lands),
`requirements/` and `wiki/` (vendored mirrors).

Search also covers `README.md` files nested in the project tree, so an agent
finds the map beside the code. They are indexed as they stand (H1 title,
headings and code spans) and are **search-only**: they are never written by
`add`, validated by `check`, or eligible as near-twins. `.gitignore` decides
which directories are skipped; outside git, dependency and build directories
are skipped by name.

## Front-matter

Every doc opens with a `---` front-matter block. The fields, in canonical order:

| Field        | Required | Meaning                                                                 |
| ------------ | -------- | ----------------------------------------------------------------------- |
| `Area`       | yes      | One top-level path segment; the doc's group.                            |
| `Keywords`   | yes      | Comma-separated search terms; the second half of the doc's identity.    |
| `Summary`    | yes      | One self-contained sentence: enough to decide whether to open the file. |
| `Status`     | no       | `active` (the default) or `superseded`.                                 |
| `Supersedes` | no       | The doc this one replaces.                                              |

`Date` is **derived, never written**: the file's last git commit date, falling
back to mtime. A hand-maintained `Date` is a finding, not a field.

The tool serialises the front-matter — never copy it by hand.

## Body

- An `H1` title: the first half of the doc's identity.
- At least one claim section as an `H2`/`H3` heading — `Facts`, `Inferred`,
  `Tested`, `Open questions` — so a reader knows how much to rely on each claim.
  Group claims by section rather than mixing them.

## Identity and duplicates

- A doc's identity is its `H1` plus its `Keywords`, and it must carry a term of
  at least `MIN_TERM_LENGTH` (3) characters. A shorter identity is too weak to
  search and is rejected.
- `check` flags **near-twins**: docs in the same area whose identities overlap.
  `add` refuses a near-twin write and returns the candidates to reconcile
  against — edit before add, merge near-twins, split a bloated doc into
  per-topic files.

## Lifecycle

`Status` and `Supersedes` are load-bearing, not decoration. A doc marked
`Status: superseded` is flagged `(superseded)` in search results and ranks below
an active doc on a tie; `check` flags a `Supersedes` that names no doc in the
tree.

## Adopting it

Run `check` to audit an existing tree, and the gate's `defined comply` before
proposing a commit. A missing docs root is not an error: the plugin scans
what is there and reports per-doc findings for what is not.
