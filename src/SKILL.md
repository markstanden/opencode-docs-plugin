# Docs

Durable knowledge lives in **lakes**: **find** it, or **record** one focused
doc at the narrowest justified scope. Call the `docs` tool; inside `execute`
it is `tools.docs.docs_search(…)`, same verbs.

## Scopes

| Scope            | Config    | Where                       | Use it for                        | Writes        |
| ---------------- | --------- | --------------------------- | --------------------------------- | ------------- |
| **Repository**   | `repo`    | `<repo>/docs`               | this repo's traps and decisions   | yes           |
| **Personal**     | `machine` | personal lake (`~/doclake`) | a person's devices and setup      | yes           |
| **Organisation** | `global`  | organisation lake           | shared standards and integrations | yes, reviewed |
| **Instructions** | implicit  | nested `README.md`          | build, run, test, deploy          | never         |
| **Wiki**         | `wiki`    | human-readable wiki         | narrative for humans              | read-only     |

Place by dependency: this repo's code or decisions → Repository; a person's
device, account or setup (a named host counts) → Personal; an established
shared rule → Organisation, boundary stated — reusability alone is not
ownership; operational steps → the README workflow; human narrative → the
wiki's owners. Split only for claims with different owners; unresolved
ownership stays an explicit proposal, never a guessed destination.

`help` lists each lake's scope and description; `add` writes to the sole
writable knowledge lake when `lake` is omitted, and refuses with candidates
when several could take it — pass `lake`.

## Find it

A **blank `search`** lists recent docs; a **`search`** ranks them, matching
terms as **substrings** (a typo finds nothing) and falling back to
`Closest matches`. Terms shorter than `MIN_TERM_LENGTH` (3) are dropped
when longer terms exist; otherwise all query terms are kept.

Open the match with `read` (root-relative path, or `lake:path`); a README
result is `instructions:path` and opens with the built-in `read`. Consult
matching docs before a broad grep; a tie ranks repo, instructions, global,
machine, wiki. Knowledge lakes exclude `plans/`, `requirements/` and `wiki/`
at the root; wiki lakes exclude only dot-directories and `node_modules`.

## Record it

Record to `<area>/<title>.md` under the right lake (`CONVENTION.md` is
authoritative):

1. **Read first, never duplicate:** the same area, keyword hits on its
   entities, or links from touched docs.
2. **Choose one scope** from the table — the narrowest that holds the claim.
3. **Reconcile, then add:** edit before add; merge near-twins; split per topic,
   repoint references, delete the emptied doc — no superseded stubs.

One artifact per topic and scope, never one dump.

Record through the typed `add`: metadata (`Area`, `Keywords`, `Summary`) plus a
body with an `H1` and a claim section — Facts, Inferred, Tested, Failed approaches, Open questions. Omit `path` to create `<Area>/<slug>.md`; pass `path` to replace **wholesale** (omitted content is lost, the near-twin reconcile skipped). Refused: blank metadata, traversal, a non-`.md` or symlinked target, no claim section, and a same-area near-twin on a derived path.

A doc is current or deleted; no `Status` or `Supersedes`. A failed attempt is
valid knowledge: what was tried, why it failed, what is true now, what not to
retry.

Lead with the actionable fact plus the reason, limits and evidence that affect
its use; drop chronology and empty sections. Keep the
service names, errors, paths and commands someone will search for; the
`Summary` decides whether to open the file.

Never record secrets, credentials, tokens or customer data — name the vault or
variable, never the value — and no personal data in Organisation or Wiki.

## Check it

`check` audits the **writable** knowledge lakes: front-matter, an `H1`, a claim
section, no hand-maintained `Date`, a distinctive identity, near-twins and broken
relative links. Obsolete fields, long docs (`maxDocLines`, default 200, `0`
disables) and missing roots are **notes**, not findings. Validation follows
writability — read-only lakes, wiki lakes and READMEs are not validated, and
skipped lakes are named; a very large report is capped with an `and N more
lines not shown` tail. `add` enforces the structural rules at the write
boundary; cross-document audits stay with `check`.

Run the project's tests and typecheck before proposing a commit; prepare it
and **wait for explicit approval** — recording findings is not commit
approval. Never push.
