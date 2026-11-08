---
Area: Testing
Keywords: family-campaign, tool-present, placement-trials, explicit-read-control, code-mode, deepseek, crouton, glm-judge
Summary: Tool-present family campaign after PR #43 — both workhorses passed the native access gate and reused the seeded doc 2/2, but DeepSeek leaned on unobservable Code Mode while Crouton failed both defer-placement cases and rarely wrote; full evidence under /home/mark/tmp/docs-family-c20261108-tool-present.
---

# Tool-present family campaign — 2026-11-08

## Facts

- Frozen code revision for the campaign:
  `0f75a84d8b6fdcae3522d7a9567c0adaefacd1b3`, on `main` after PR #43
  (`62bd83e`). Two local review fixes preceded it: `f493a07` evaluates a
  diagnostic case's declared read criterion through the existing operation
  verifier, and `0f75a84` forwards `PLACEMENT_PROMPTS` / `PLACEMENT_FIXTURES`
  to host harness commands so standalone `describe` validates the intended
  generation. Validation: 664 tests, clean typecheck, `defined comply`
  compliant.
- Trial models `opencode-go/deepseek-v4.1-flash` and
  `opencode-go/crouton-alpha-free`; judge `opencode-go/glm-5.3-flash`
  (serial). Image
  `58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb`;
  CLI `v2.2.6`.
- Six control sessions and 40 natural family trials (10 cases × 2
  repetitions × 2 models). Conditions: A01 with no condition, explicit read
  with `explicit-read-control`, natural tasks with `C`. Separate fixture/cache
  roots per model and condition; unique stamps.
- Both models passed the access gate. A01 and both explicit reads per model
  had matching invoked cwd, child PWD and logged host cwd, observed plugin
  load, and successful operation evidence. The explicit reads returned the
  exact seeded `kb/test-commands.md` bytes and revision `1193e96a…` (the
  seed's SHA-256); controls made zero writes and zero help calls.
- Natural outcomes (judged passes / trials): DeepSeek 7/20, Crouton 6/20.
  Gate-blocked before judging: 13 and 11. Semantic fails: 0 and 3. One
  DeepSeek trial was invalid (CLI cancelled an unanswerable Web Search
  request). Judge calls 16, judge errors 0.
- REUSE-01 (R01) passed 2/2 for both models with a native read of the seed
  and its revision. PLACE-19 (R04) split cleanly: DeepSeek 2/2 pass, Crouton
  0/2 fail (no focused question).
- DeepSeek made 27 Code Mode docs attempts against 67 verified native ops;
  Crouton made 19 against 57. Code Mode nested operations are wrapper-only
  evidence and never satisfy the deterministic gate. Three trials mutated the
  filesystem (two DeepSeek replacements via Code Mode, one Crouton creation);
  policy violations were zero. The Crouton creation was blocked by the gate
  treating the plugin's `.docs-lock` runtime directory as an unrelated
  surface change.
- All step records report cost zero; DeepSeek and the judge carry non-zero
  list prices, so this is not proof of zero billed cost. Judge token/cost
  telemetry was not captured.

## Inferred

- The access gate is no longer the explanation for low tool use: every
  natural session loaded the plugin with matching cwd/PWD/host.
- DeepSeek's true docs use is under-credited by the native-operation measure
  because it often routes through Code Mode; the gap is measurement, not
  necessarily non-use.
- Crouton's shift from the prior README workflow to a native REUSE-01 read
  (2/2) suggests the earlier 0/2 was route choice, not inability, but two
  repetitions cannot settle disposition.

## Tested

- The two review fixes and their focused regressions; the repository suite,
  typecheck and compliance on the final tree.
- Full control and family runs through `container-run.sh`
  generate/run/judge/summary/export with `--print-logs`, preserving prompt
  bytes, seeds, rubrics and run descriptions.
- Deterministic gates ran before semantic judging; diagnostic cases consumed
  no judge calls.

## Failed approaches

- None newly attempted in this campaign. The prior PWD/redacted-cache
  inference is not repeated: access is established per session here, and the
  earlier pre-fix zero-use numbers are not pooled with these results.

## Open questions

- Should the harness credit completed Code Mode nested docs calls (currently
  wrapper-only), and should `.docs-lock` be a permitted runtime artefact in
  the recording gate? Both affect future measurement more than this run.
- Does DeepSeek's Code Mode preference persist beyond two repetitions?

## Evidence

`/home/mark/tmp/docs-family-c20261108-tool-present/` — `RESULTS.md`,
`results/<stamp>/<case>/` (trail, answer, writes, verdict, invocation, logs),
`family-analysis.json`, `per-case-*.tsv`, `IDENTITY.txt`, corpus/prompt/run
hashes, and generation identities under each model/condition root.
