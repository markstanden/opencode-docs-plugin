#!/usr/bin/env bash
# Generate both arms' prompts, sandbox fixtures and rubrics. No model call.
set -euo pipefail
ROOT="${CAMPAIGN_ROOT:?missing CAMPAIGN_ROOT}"
MODEL="opencode-go/deepseek-v4.1-flash"

for arm in a b; do
    repo="$ROOT/arms/$arm"
    base="$ROOT/gen/$arm"
    cases="$repo/tests/fixtures/placement-harness/prod014/cases.json"
    mkdir -p "$base/prompts" "$base/fixtures" "$base/rubrics" "$base/results" "$base/run-fixtures"
    echo "generating arm $arm"
    env \
        PLACEMENT_CASES="$cases" \
        PLACEMENT_PROMPTS="$base/prompts" \
        PLACEMENT_FIXTURES="$base/fixtures" \
        PLACEMENT_RUBRICS="$base/rubrics" \
        PLACEMENT_RESULTS="$base/results" \
        PLACEMENT_RUN_FIXTURES="$base/run-fixtures" \
        TRIAL_TIMEOUT_MS=600000 \
        "$repo/tests/fixtures/placement-harness/container-run.sh" generate \
        --model "$MODEL"
done
