# Knowledge-doc convention

This plugin owns this convention: it is what the `docs` tool's `add` writes,
what `check` validates, and what the registered `docs` skill teaches. A
repository that adopts the plugin takes the convention with it.

## Scopes and classes

Every doc belongs to exactly one scope. The scope is fixed by the lake it
lives in, so a doc cannot mix scopes. The config values below never change;
the labels are how the tool presents them.

| Scope        | Config value       | Where                               | Reader                  | Meaning                                                                                       | Writes                                |
| ------------ | ------------------ | ----------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- |
| Repository   | `repo`             | `<repo>/docs` by default            | this repo               | understanding or maintaining this particular repository                                       | yes                                   |
| Personal     | `machine`          | a personal lake such as `~/doclake` | one person, any machine | tied to a person's devices, accounts, preferences or individual setup — one named host counts | yes                                   |
| Organisation | `global`           | an organisation lake                | the owning teams        | established shared standards, services or integrations, with their boundary stated            | yes, lock down with `writable: false` |
| Instructions | nested `README.md` | the project tree                    | code-local how-to       | build, run, test, deploy this code                                                            | never by the tool                     |
| Wiki         | `wiki`             | a human-readable wiki checkout      | humans first            | human-facing reference and narrative                                                          | no                                    |

Place at the **narrowest justified scope**:

1. Identify the claim, what it depends on and its evidence. Where the session
   happened is not itself a destination.
2. Depends on this repository's implementation, architecture or decisions →
   Repository.
3. Depends on a person's device, account or individual setup → Personal.
4. An established shared rule or integration → Organisation, recording its
   actual team/service boundary. It need not apply to every team to belong
   there.
5. Reusability alone is not organisational ownership: a possible
   generalisation from one repo stays with the repo that observed it, and its
   conditions, until broader applicability or ownership is established.
6. Operational procedures belong to the README editing workflow — `add`
   cannot write them. A knowledge doc may keep the minimal diagnostic
   commands that substantiate its claim and link to the maintained procedure;
   commands are not banned from knowledge docs.
7. Human narrative follows the wiki's owner workflow. The wiki being
   read-only to the tool is not a reason to write a knowledge lake instead.
8. Split only when there are independently useful claims with different
   owners or topics. A shared rule plus a genuine repo exception may need two
   linked docs; an uncertain owner does not make a doc unfocused.
9. If ownership cannot be established, keep an explicitly unresolved proposal
   in the handover and ask a focused question. Never guess a broader scope or
   silently write to a substitute lake.

Two answers with different owners means two focused docs, one per scope.
Configured lakes may carry a `description` saying what belongs in that
particular destination; when several writable lakes exist, `add` requires an
explicit `lake` choice.

## Where knowledge lives

Durable knowledge is one Markdown file per topic under a lake root, grouped by
area: `<area>/<name>.md`. The default repo lake is `<location>/docs`; its docs
are Repository scope. A repo adds other local roots in
`.opencode/docs-lakes.json`; a personal or managed base file lists the
personal, organisation and wiki lakes.

Lakes are named, and several per class are supported. A root nested inside
another lake's root belongs to the **narrowest enclosing lake**: the outer lake
skips it, search returns the inner lake's entry, and a bare `read` resolves
there. Nesting resolves the physical owner of an already identified target; it
never infers the semantic owner of a new claim — `add` without a `lake`
selector requires exactly one configured writable knowledge lake, and any
other number refuses with the candidate list. Nesting is decided on
real paths, so reaching one root through a symlink cannot defeat containment,
and a write addressed through an outer route that physically resolves inside
a nested lake's tree refuses and names its physical owner. Two lakes that do
not nest holding the same relative path stay a refusal — pass `lake`.
Near-twin checks apply inside one lake and never pair across the nesting
boundary.

Lake notes — a missing root, or a root outside version control — are computed
per call, not captured at startup: create, remove or version a root and the
next `check`, `search` and help reflect it without a restart.

Validation follows writability: `check` validates only writable knowledge lakes.
A read-only lake is indexed for search and never validated, and the report names
it as skipped.

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
- The reconcile applies to every **create**, derived and explicit paths alike:
  `add` refuses a near-twin and returns the candidates to reconcile against.
  A non-blank `allowNearTwinReason` overrides that guard alone, for a
  deliberate distinct doc; it never bypasses target existence or the
  structural checks. Replacement is `mode: "replace"` with the existing
  doc's path — wholesale, and never an implicit create.
- Near-twins are per lake. The same topic at repo and global scope is
  legitimate; the narrower doc states its delta and links up.

## Focus, ownership and promotion

- One question per doc. One topic per doc.
- More than one H2 aimed at different topics or audiences means split.
- Never write an omnibus notes doc to avoid choosing a scope.
- The narrowest justified scope owns the claim. A broader scope owns the
  general rule; the narrower doc states only its delta and links up.
- Do not copy between knowledge scopes. Move or link.
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
- No personal data in Organisation or Wiki.
- The wiki profile is read-only to the tool. Its own owners review changes.

## Lifecycle

A doc is current or deleted. Correct a wrong doc by replacing it in place with
`mode: "replace"`, the doc's path, and the revision token your last read or
write returned in its result text — a stale token refuses rather than
overwriting a newer edit. Delete
an obsolete doc through the shell with
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
