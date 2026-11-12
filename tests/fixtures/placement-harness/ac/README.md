# Structured recording measurement

Support for the 2026-11-10 six-arm native-description comparison. It turns
recorded trials into one weighted documentation outcome per trial without
relying on the harness's binary recording gate.

## What it measures

Each completed trial gets exactly one documentation outcome, judged from an
arm-blind packet: task, standing permission, scenario truth, knowledge-lake
documents before and after, changed paths, the pristine primary-check result,
verified docs operations and the final answer.

| Outcome         | Score | Meaning                                                          |
| --------------- | ----- | ---------------------------------------------------------------- |
| `useful-create` | +5    | needed, accurate, supported, well-placed durable addition        |
| `useful-update` | +5    | needed correction or material extension preserving valid content |
| `transient`     | −1    | supported but without future value                               |
| `duplicate`     | −2    | repetition without material new value                            |
| `misleading`    | −5    | materially incorrect or unjustified claim                        |
| `none`          | 0     | no documentation change; restraint or missed opportunity         |
| primary failure | −5    | the independent pristine check failed                            |

The primary result is the harness's, never the judge's. A judgement that
contradicts the recorded mutation facts (for example `none` when a document
changed) is invalid and is never silently corrected.

Weights, the selection rule and the sensitivity grid are frozen in the
campaign plan under `docs/testing/`.

## Commands

All state lives outside the repository; `--root` points at the campaign root.

```sh
# Regenerate the frozen schedule from the seed.
node tests/fixtures/placement-harness/ac/run.mts schedule --out schedule.json

# Record the harness's deterministic gate verdict (no model call).
node tests/fixtures/placement-harness/ac/run.mts gate \
  --repo "$ROOT/arms/b" --base "$ROOT/gen/b" \
  --cases "$ROOT/arms/b/tests/fixtures/trial-cases.json" \
  --stamps fr-B-s1-NOTE-01

# One first-attempt structured judgement.
node tests/fixtures/placement-harness/ac/run.mts judge \
  --base "$ROOT/gen/b" --stamp fr-B-s1-NOTE-01 --case NOTE-01 \
  --truth tests/fixtures/held-out-truth.json \
  --launcher tests/fixtures/placement-harness/ac/judge-launcher.sh \
  --model opencode-go/glm-5.3-flash --workdir "$ROOT/evidence/ac-runs"

# Deterministic re-parse of answers whose only defect was trailing prose.
node tests/fixtures/placement-harness/ac/run.mts resolve --base "$ROOT/gen/b"

# Aggregate one stage (schedule and finalist selection are campaign inputs).
node tests/fixtures/placement-harness/ac/run.mts report \
  --root "$ROOT" --stage screening --schedule schedule.json \
  --finalist "$ROOT/evidence/finalist.json" --out-dir "$ROOT/evidence"

# Hash or verify the evidence tree (signing keys are never hashed).
node tests/fixtures/placement-harness/ac/run.mts manifest --root "$ROOT" --write
node tests/fixtures/placement-harness/ac/run.mts manifest --root "$ROOT" --verify
```

`judge` and `gate` take a stage base directory: `gen/<arm>` for screening and
`gen/<arm>/holdout` for confirmation.

`report` is the legacy campaign calculator, kept unchanged so the published
2026-11-10 analyses stay reproducible. The supported route for future campaigns
is the manifest-driven analyser in `../analysis/analyse.mts` (`--campaign`,
`--evidence-root`, `--out`), documented in `TESTING.md`.

## Isolation

`judge-launcher.sh` runs the judge in a read-only container with only an empty
working directory and an isolated config home mounted; tool permissions deny
everything. The packet builder refuses any text matching an arm, stamp,
campaign or host-path pattern. Residual risk is the shared network namespace
the provider proxy needs, and tool-layer rather than namespace-level denial.

## What it does not do

- It does not call the harness's semantic judge; `--gate-only` keeps the
  deterministic gate verdict as separate evidence.
- It does not retry a failed judgement or re-score a recorded one.
- It does not verify delivery of a tool description to a session that never
  calls the tool; that limitation is stated in the findings.

## Reproduce the published tables

The committed review packet under `docs/testing/assets/` carries the sanitised
88-trial table, and `tests/ac-review-packet.test.ts` recomputes the published
totals from it. Raw sessions, generated run directories, signing keys and
machine paths stay outside the repository; the packet's evidence index records
where they live and that they are dev-box only.
