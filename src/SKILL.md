# Docs

Durable knowledge lives in **lakes**: **find** it (search, then read), or
**record** one focused doc at the narrowest true scope. Call the `docs` tool;
inside `execute` it is `tools.docs.docs_search(…)`, same verbs.

## Classes

| Class              | Where                       | Use it for                              | Writes        |
| ------------------ | --------------------------- | --------------------------------------- | ------------- |
| **Instructions**   | nested `README.md`          | build, run, test, deploy this code      | never         |
| **RepoContext**    | `<repo>/docs`               | this repo's traps, decisions, landmines | yes           |
| **MachineContext** | personal lake (`~/doclake`) | tooling and traps across your machines  | yes           |
| **GlobalContext**  | organisation lake           | standards and integrations across repos | yes, reviewed |
| **Wiki**           | human-readable wiki         | narrative for humans                    | read-only     |

Record at the **narrowest scope where the whole claim is true**. Two scopes
means two docs; one omnibus doc is out of place everywhere.

## Find it

A **blank `search`** lists recent docs, one line each; a **`search`** ranks
them, falling back to `Closest matches` and matching terms as **substrings** —
so a typo finds nothing and terms under `MIN_TERM_LENGTH` (3) are ignored.
`help` lists the lakes and ranking.

Open the match with `read`: the root-relative path, or `lake:path` when several
lakes exist. A README result is `instructions:path` and opens with the built-in
`read`. Consult matching docs before a broad grep; a tie ranks repo,
instructions, global, machine, wiki. Excluded areas: `plans/`, `requirements/`
and `wiki/`.

## Record it

Write to `<area>/<title>.md` under the right lake; `CONVENTION.md` is
authoritative.

1. **Read first, never duplicate.** Read the docs relevant to the task: the same
   area, keyword hits on its entities, or links from touched docs.
2. **Choose one class** from the table — the narrowest that holds the claim.
3. **Reconcile, then add.** Edit before add; merge near-twins; split a bloated
   doc per topic; after a split, merge or move, repoint inbound references and
   delete the emptied doc — no superseded stubs.

One artifact per topic and class, never one dump; the compaction nudge shapes
`Record with docs add:` blocks for this.

Record through the typed `add`: metadata (`Area`, `Keywords`, `Summary`) and a
body with an `H1` and a claim section — Facts, Inferred, Tested, Failed approaches, Open questions. Omit `path` to create `<Area>/<slug>.md`; pass `path` to replace **wholesale**, so omitted body content is lost and the near-twin reconcile is skipped. Refused: blank metadata, traversal, a non-`.md` or symlinked target, no claim section, and — only when `path` is omitted — a same-area near-twin.

A doc is current or deleted; no `Status` or `Supersedes`. A failed attempt is
valid knowledge when it records what was tried, why it failed, what is true now,
and what not to retry.

Lead with the actionable fact, keeping the reason, limits and evidence that
affect using it; drop chronology, repeated conclusions and empty sections. Keep
the service names, errors, paths and commands someone will search for. A
`Summary` decides whether to open the file.

Never record secrets, credentials, tokens or customer data — name the vault or
variable, never the value — and no personal data in GlobalContext or Wiki.

## Check it

`check` audits the lakes: front-matter, an `H1`, a claim section, no
hand-maintained `Date`, a distinctive identity, near-twins and broken relative
links. Obsolete fields, long docs and missing roots are **notes**, not findings;
wiki lakes are not validated. `add` enforces the structural rules at the write
boundary; cross-document audits stay with `check`. `maxDocLines` (default 200,
`0` disables) is a soft size signal, not a refusal.

Run the project's tests and typecheck before proposing a commit, fixing
failures rather than papering over them. Prepare the commit and **wait for
explicit approval** — recording findings is not commit approval. Never push.
