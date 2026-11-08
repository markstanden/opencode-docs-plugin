---
Area: testing
Keywords: fingerprint, generation, stale, force, reservation, staging, concurrency, workers, resume
Summary: Generated fixtures carry fingerprints a run refuses to reuse or silently regenerate; result directories are atomically reserved and judging resumes on identical inputs.
---

# Generation fingerprints, atomic reservations and resumable judging

### Facts

- `generate` writes `generation.json` beside each fixture ( hashes of the
  case definition, model, plugin identity, variant flags and generator
  version, plus the certificate of the outputs it wrote). Reuse needs both a
  matching fingerprint and intact outputs; any mismatch refuses with
  `stale`/`incomplete` and survives untouched until `--force`.
- A `run` never regenerates shared inputs: it validates the prepared
  generation on the run-visible surfaces (prompt, config, fingerprint
  agreement) and refuses a mismatch/absence with a one-line reason.
- Result directories are claimed by an exclusive `.reservation` marker file
  (a pre-staged empty mount point is claimable; recorded evidence or a
  rival's reservation refuses). Trials judge concurrency via `--jobs`/
  `--judge-jobs` (serial default) with per-stamp staging
  (`RUN_FIXTURES/<stamp>/<case>/`) and a corpus-hash-keyed redacted list, so
  parallel workers cannot share staging paths.
- Judging resumes when answer, rubric, judge prompt and judge model all
  match a prior attempt; otherwise the next attempt is appended.

### Tested

- `tests/harness.test.ts` F03 + P4 groups: unchanged keep, stale/incomplete
  refusal without touching fixtures, plugin-path sensitivity, missing/tampered
  prompts and config refusing a run, forced regeneration, overlapping
  parallel workers with the fake delay, atomic double-run refusal, resume
  reuse and fresh attempts on a changed judge model. Pre-fix reproduction
  covered the primary five.

### Open questions

- The in-container run treats a read-only stamp root as host-frozen (the
  wrapper always ran `describe` first). A documented requirement: direct
  container runs without a prior host-side describe render as legacy.
