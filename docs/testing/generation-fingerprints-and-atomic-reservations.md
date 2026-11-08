---
Area: testing
Keywords: fingerprint, generation, stale, force, reservation, staging, concurrency, workers, resume
Summary: Generated fixtures carry fingerprints a run refuses to reuse or silently regenerate; result directories are atomically reserved and judging resumes on identical inputs.
---

# Generation fingerprints, atomic reservations and resumable judging

### Facts

- `generate` writes `generation.json` beside each fixture (schema v2): the
  inputs hash (case definition, model, plugin identity, variant flags and
  generator version), hashes of the prompt/config/rubric it wrote, and a
  prepared-tree certificate — a deterministic identity of every generated
  sandbox file (path, kind, content hash or symlink target, no transient
  timestamps or permission bits, `.git` excluded). Reuse needs the matching
  fingerprint, intact outputs AND an unmutated prepared tree; any mismatch
  refuses with `stale`/`incomplete` and survives untouched until `--force`.
- A `run` never regenerates shared inputs: it validates the prepared
  generation — prompt/config (and host-visible rubric) hashes, the
  recomputed inputs fingerprint on full-corpus flows (so a changed case,
  model, plugin or variant refuses rather than running the stale prompt),
  the redacted corpus's embedded generation hash in container flows, and
  the prepared-tree certificate (an edited, missing or unrecorded fixture
  file refuses the run).
- Result directories are claimed by an exclusive `.reservation` marker file
  (a pre-staged empty mount point is claimable; recorded evidence or a
  rival's reservation refuses). Trials judge concurrency via `--jobs`/
  `--judge-jobs` (serial default) with per-stamp staging
  (`RUN_FIXTURES/<stamp>/<case>/`) and a corpus-hash-keyed redacted list
  that embeds each case's generation inputs hash, so parallel workers
  cannot share staging paths and containers verify staged generations.
- Judging resumes when answer, rubric, judge prompt and judge model all
  match a prior attempt; otherwise the next attempt is appended.
- The stamp's run.json is written atomically (temp file + rename) and
  re-verified in full on a host run: model, variant, timeout, authorisation,
  case ids, fixture/plugin identities and each case's full definition.
  A conflicting same-stamp invocation refuses instead of relabelling.

### Tested

- `tests/harness.test.ts` F03 + P4 + M02 groups: unchanged keep, stale/
  incomplete refusal without touching fixtures, plugin-path sensitivity,
  missing/tampered prompts and config refusing a run, forced regeneration,
  overlapping parallel workers with the fake delay, atomic double-run
  refusal, resume reuse and fresh attempts on a changed judge model;
  changed-case/changed-plugin runs refusing, mutated/missing/added
  prepared files refusing, unchanged inputs staying reusable, and
  conflicting same-stamp invocations (model or definition) refusing.

### Open questions
