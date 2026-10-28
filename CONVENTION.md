# Knowledge-doc convention

This plugin owns this convention: it is what the `docs` tool's `add` writes,
what `check` validates, and what the registered `docs` skill teaches. A
repository that adopts the plugin takes the convention with it.

## Classes and scope

Every doc belongs to exactly one class. The class is fixed by the lake it lives
in, so a doc cannot mix scopes.

| Class              | Where                               | Reader                       | Writes                                |
| ------------------ | ----------------------------------- | ---------------------------- | ------------------------------------- |
| **Instructions**   | nested `README.md` files            | code-local how-to            | never by the tool                     |
| **RepoContext**    | `<repo>/docs` by default            | this repo                    | yes                                   |
| **MachineContext** | a personal lake such as `~/doclake` | this person, across machines | yes                                   |
| **GlobalContext**  | an organisation lake                | every team, every repo       | yes, lock down with `writable: false` |
| **Wiki**           | a human-readable wiki checkout      | humans first, agents second  | no                                    |

Place at the **narrowest scope where the whole claim is true**:

1. Command or step to build, run, test, deploy → Instructions.
2. True only for this repo → RepoContext.
3. True for you across machines → MachineContext.
4. True for the org across repos → GlobalContext.
5. Human-facing narrative → Wiki.

Two answers mean two focused docs, one per class. A doc that needs a placement
debate is not focused enough.

## Where knowledge lives

Durable knowledge is one Markdown file per topic under a lake root, grouped by
area: `<area>/<name>.md`. The default repo lake is `<location>/docs`; its docs
are RepoContext. A repo adds other local roots in
`.opencode/docs-lakes.json`; a personal or managed base file lists the
machine, global and wiki lakes.

The excluded areas — never scanned, never validated in a knowledge lake — are
`plans/` (scratch, gitignored, deleted when the work lands), `requirements/`
and `wiki/` (vendored mirrors). The wiki profile has no such exclusions; only
dot-directories and `node_modules` are skipped there.

Search also covers `README.md` files nested in the project tree, so an agent
finds the map beside the code. They are indexed as they stand (H1 title,
headings and code spans) and are **search-only**: they are never written by
`add`, validated by `check`, or eligible as near-twins. `.gitignore` decides
which directories are skipped; outside git, dependency and build directories
are skipped by name.

## Front-matter

Every knowledge doc opens with a `---` front-matter block. The fields, in
canonical order:

| Field      | Required | Meaning                                                                                                     |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `Area`     | yes      | One top-level path segment; the doc's group.                                                                |
| `Keywords` | yes      | Comma-separated search terms; the second half of the doc's identity.                                        |
| `Summary`  | yes      | One self-contained sentence that lets a reader decide whether to open the file — not a second introduction. |

`Date` is **derived, never written**: the file's last git commit date, falling
back to mtime. A hand-maintained `Date` is a finding, not a field.

There is no lifecycle field. `Status` and `Supersedes` are **obsolete**; `check`
reports them as notes so an existing lake can be cleaned once. A doc is current
or deleted: git is the archive.

The tool serialises the front-matter — never copy it by hand.

Wiki pages carry no front-matter. ADO renders YAML as raw text, and a human wiki
should read cleanly. The wiki profile derives the title from the H1, the area
from the folder, the summary from the first prose paragraph, and the date from
git. Optional invisible metadata may be added later; it is not required.

## Body

- An `H1` title: the first half of the doc's identity.
- At least one claim section as an `H2`/`H3` heading — `Facts`, `Inferred`,
  `Tested`, `Failed approaches`, `Open questions` — so a reader knows how much
  to rely on each claim. Group claims by section rather than mixing them.
- Include only the sections the doc actually needs. An empty heading is noise;
  leave it out.
- Write so the next reader decides fast: lead with the actionable fact, include
  its reason, limits and evidence where they affect its use, and omit discovery
  chronology, repeated conclusions and empty sections. Under `Tested`, record
  the check, its result and the conditions that mattered.
- A failed attempt is a valid current doc or section: state what was tried, why
  it failed, what is true now, and what not to retry. Do not keep a doc whose
  claims are no longer true.

## Identity and duplicates

- A doc's identity is its `H1` plus its `Keywords`, and it must carry a term of
  at least `MIN_TERM_LENGTH` (3) characters. A shorter identity is too weak to
  search and is rejected.
- `check` flags **near-twins**: docs in the same area whose identities overlap.
  `add` refuses a near-twin write and returns the candidates to reconcile
  against — edit before add, merge near-twins, split a bloated doc into
  per-topic files.
- The reconcile applies to a **create**: with `path` omitted, the target is
  derived and the near-twin guard runs. An explicit `path` is the update
  contract and skips it, which is how you replace a doc in place. Passing an
  explicit _new_ path is therefore a deliberate override, not a protected
  write.
- Near-twins are per lake. The same topic at repo and global scope is
  legitimate; the narrower doc states its delta and links up.

## Focus, ownership and promotion

- One question per doc. One topic per doc.
- More than one H2 aimed at different topics or audiences means split.
- Never write an omnibus notes doc to avoid choosing a class.
- The narrowest true scope owns the claim. A broader class owns the general
  rule; the narrower doc states only its delta and links up.
- Do not copy between knowledge classes. Move or link.
- Instructions own commands. Knowledge docs own reasons and link to the
  command. Knowledge docs link to the wiki page for human narrative.
- Wiki duplication is expected, not a defect. If a wiki page drifts from a
  knowledge doc, report it and name both pages; do not edit the wiki.
- Promotion is a move: the general claim goes up, the local delta stays. Delete
  the emptied doc and repoint every in-repo link. No superseded stubs. An
  unrepointable external link is reported for a human to fix.
- A soft note appears when a body exceeds `maxDocLines` (default 200,
  configurable). A note, not a refusal. Reference tables are judged by review.

## Safety

- No secrets, credentials, tokens, or customer data. Name the vault or variable,
  never the value.
- No personal data in GlobalContext or Wiki.
- The wiki profile is read-only to the tool. Its own owners review changes.

## Lifecycle

A doc is current or deleted. Correct a wrong doc by replacing it in place with
`add` and an explicit `path`. Delete an obsolete doc through the shell with
explicit approval; there is no `delete` verb. A failed attempt is still valid
knowledge when it records the outcome and the current truth.

## Adopting it

Run `check` to audit an existing tree, and the project's own tests before
proposing a commit. `add` enforces the per-doc structural rules at the write
boundary — front-matter, `H1`, claim section, identity term floor, and the
near-twin guard on a create — while the cross-document audits (near-twin pairs
and relative links) stay with `check`. A missing lake root is a note, not an
error: the plugin scans what is there, search and help flag the absent path, and
`add` refuses rather than creating a tree at a mistyped root. Create the
directory deliberately. Wiki lakes are read-only and are reported as not
validated, never silently skipped.
