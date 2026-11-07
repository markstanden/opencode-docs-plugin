#!/usr/bin/env bash
# Run the placement harness inside its trial container (see Containerfile).
#
# The container is the controlled environment: a read-only root filesystem,
# the plugin mounted read-only, and only the current case's fixture, prompt
# and result directory visible. `run` starts one container per case, so a
# trial cannot read another case's rubric, answer or workspace.
# It shares the host network namespace, so the host's loopback provider proxy
# is reachable directly and the host's OPENCODE_CONFIG_CONTENT overlay passes
# through unchanged — no routes or credentials are baked into this repository.
#
# Usage:
#   ./container-run.sh all                 # full sweep: generate + per-case run + host judge
#   ./container-run.sh generate            # prompts, fixtures and rubrics
#   ./container-run.sh run E01             # one case, isolated container
#   ./container-run.sh judge               # host-side judging (provider keys)
#   ./container-run.sh export              # dossier from the latest stamp
# Extra flags pass through to harness.mjs (--model, --judge-model, --stamp...).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
IMAGE="${PLACEMENT_IMAGE:-localhost/opencode-placement-trials}"
PROMPTS="${PLACEMENT_PROMPTS:-${HOME}/tmp/docs-placement/prompts}"
FIXTURES="${PLACEMENT_FIXTURES:-${HOME}/test-dir/docs-placement}"
RUBRICS="${PLACEMENT_RUBRICS:-${HOME}/tmp/docs-placement/rubrics}"
RESULTS="${PLACEMENT_RESULTS:-${HOME}/tmp/docs-placement/results}"
RUN_FIXTURES="${PLACEMENT_RUN_FIXTURES:-${HOME}/tmp/docs-placement/run-fixtures}"
CASES="${PLACEMENT_CASES:-$REPO/tests/fixtures/placement-cases.json}"
CASES_RUN="${HOME}/tmp/docs-placement/cases-run.json"

command -v podman >/dev/null 2>&1 || {
    echo "podman is required" >&2
    exit 1
}
command -v node >/dev/null 2>&1 || {
    echo "node is required for the host-side judge" >&2
    exit 1
}

# Same provider routes as the host session; the container shares the host
# network, so the loopback proxy overlay works as-is.
overlay="${OPENCODE_CONFIG_CONTENT:-}"

podman build -q \
    --build-arg "HOST_UID=$(id -u)" \
    --build-arg "HOST_GID=$(id -g)" \
    --network host \
    -t "$IMAGE" \
    "$HERE" >&2

mkdir -p "$PROMPTS" "$FIXTURES" "$RUBRICS" "$RESULTS" "$RUN_FIXTURES"

IMAGE_ID="$(podman image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
TIMEOUT_ENV=()
if [ -n "${TRIAL_TIMEOUT_MS:-}" ]; then
    TIMEOUT_ENV=(-e "TRIAL_TIMEOUT_MS=$TRIAL_TIMEOUT_MS")
fi
PLUGIN_COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
PLUGIN_STATUS="$(git -C "$REPO" status --porcelain 2>/dev/null || true)"
PLUGIN_DIRTY=""
if [ -n "$PLUGIN_STATUS" ]; then
    PLUGIN_DIRTY=1
fi
FIXTURE_HASH="$(sha256sum "$CASES" | awk '{print $1}')"

CONTAINER_ENV=(
    --rm
    --network host
    --userns=keep-id
    --read-only
    --tmpfs "/tmp:rw,nosuid,size=768m"
    -e "OPENCODE_CONFIG_CONTENT=$overlay"
    -e "PLACEMENT_IMAGE=$IMAGE"
    -e "PLACEMENT_IMAGE_ID=$IMAGE_ID"
    -e "PLACEMENT_PLUGIN_COMMIT=$PLUGIN_COMMIT"
    -e "PLACEMENT_PLUGIN_DIRTY=$PLUGIN_DIRTY"
    -e "PLACEMENT_FIXTURE_HASH=$FIXTURE_HASH"
    "${TIMEOUT_ENV[@]}"
    -e "XDG_CONFIG_HOME=/tmp/agent-home/.config"
    -e "XDG_DATA_HOME=/tmp/agent-home/.local/share"
    -e "XDG_CACHE_HOME=/tmp/agent-home/.cache"
)

# The full repo is only mounted while generating: it writes prompts, sandbox
# fixtures and rubrics to the host mounts.
run_generate() {
    podman run "${CONTAINER_ENV[@]}" \
        -v "$REPO:/repo:ro" \
        -v "$PROMPTS:/prompts" \
        -v "$FIXTURES:/fixtures" \
        -v "$RUBRICS:/rubrics" \
        -v "$RESULTS:/results" \
        "$IMAGE" \
        node /repo/tests/fixtures/placement-harness/harness.mjs \
        generate \
        --plugin /repo \
        --fixture /repo/tests/fixtures/placement-cases.json \
        --prompts /prompts \
        --fixtures /fixtures \
        --rubrics /rubrics \
        --results /results \
        "$@"
}

# The run fixture is the work/lakes/config-home sandbox only. Rubrics and
# cases never enter it, even when an older generation left them behind.
prepare_case_fixture() {
    local id="$1"
    local source="$FIXTURES/$id"
    local target="$RUN_FIXTURES/$id"
    [ -d "$source" ] || {
        echo "missing fixture $source; run generate first" >&2
        return 1
    }
    rm -rf "$target"
    mkdir -p "$target"
    local part
    for part in work lakes config-home; do
        [ -e "$source/$part" ] && cp -a "$source/$part" "$target/$part"
    done
}

# A redacted case list gives the run harness ids and expected scopes without
# exposing the claims, evidence or rubric text.
prepare_cases_run() {
    mkdir -p "$(dirname "$CASES_RUN")"
    node -e '
        const fs = require("node:fs");
        const cases = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const redacted = cases.map(({ id, expected }) => ({ id, expected }));
        fs.writeFileSync(process.argv[2], JSON.stringify(redacted, null, 2) + "\n");
    ' "$CASES" "$CASES_RUN"
}

parse_run_args() {
    STAMP=""
    IDS=()
    RUN_ARGS=()
    while [ "$#" -gt 0 ]; do
        case "$1" in
        --stamp)
            STAMP="$2"
            shift 2
            ;;
        --stamp=*)
            STAMP="${1#*=}"
            shift
            ;;
        --model | --judge-model | --opencode)
            RUN_ARGS+=("$1" "$2")
            shift 2
            ;;
        --allow-writes | --no-judge)
            RUN_ARGS+=("$1")
            shift
            ;;
        E[0-9]*)
            IDS+=("$1")
            shift
            ;;
        *)
            echo "run: unsupported argument $1" >&2
            return 2
            ;;
        esac
    done
    if [ "${#IDS[@]}" -eq 0 ]; then
        local prompt
        for prompt in "$PROMPTS"/E*.md; do
            [ -e "$prompt" ] && IDS+=("$(basename "$prompt" .md)")
        done
    fi
    if [ "${#IDS[@]}" -eq 0 ]; then
        echo "run: no cases selected; run generate first" >&2
        return 2
    fi
    [ -n "$STAMP" ] || STAMP="$(date +%Y%m%d-%H%M%S)"
}

# One container per case: only that case's sandbox, prompt and result dir are
# mounted, and the plugin is a curated package rather than the whole repo.
run_cases() {
    parse_run_args "$@"
    prepare_cases_run
    local overall=0
    local id status result_case name
    for id in "${IDS[@]}"; do
        prepare_case_fixture "$id" || {
            overall=1
            continue
        }
        result_case="$RESULTS/$STAMP/$id"
        mkdir -p "$result_case"
        status=0
        podman run "${CONTAINER_ENV[@]}" \
            --tmpfs /fixtures \
            -v "$RUN_FIXTURES/$id:/fixtures/$id:ro" \
            -v "$CASES_RUN:/fixtures/cases.json:ro" \
            -v "$PROMPTS/$id.md:/prompts/$id.md:ro" \
            -v "$result_case:/results/$STAMP/$id" \
            -v "$HERE:/harness:ro" \
            -v "$REPO/package.json:/repo/package.json:ro" \
            -v "$REPO/src:/repo/src:ro" \
            -v "$REPO/node_modules:/repo/node_modules:ro" \
            -v "$REPO/CONVENTION.md:/repo/CONVENTION.md:ro" \
            "$IMAGE" \
            node /harness/harness.mjs \
            run "$id" \
            --plugin /repo \
            --fixture /fixtures/cases.json \
            --prompts /prompts \
            --fixtures /fixtures \
            --results /results \
            --stamp "$STAMP" \
            "${RUN_ARGS[@]}" || status=$?
        # Copy rubric/case only after the container exits. The run container
        # never sees this directory.
        for name in rubric.md case.json; do
            if [ -f "$result_case/meta.json" ] &&
                [ ! -f "$result_case/$name" ] &&
                [ -f "$RUBRICS/$id/$name" ]; then
                cp "$RUBRICS/$id/$name" "$result_case/$name"
            fi
        done
        if [ "$status" -ne 0 ]; then
            overall="$status"
        fi
    done
    return "$overall"
}

# Judging needs provider keys, so it runs on the host against the result tree.
run_judge() {
    node "$HERE/harness.mjs" \
        judge \
        --results "$RESULTS" \
        --fixture "$CASES" \
        --rubrics "$RUBRICS" \
        "$@"
}

run_summary() {
    node "$HERE/harness.mjs" \
        summary \
        --results "$RESULTS" \
        --fixture "$CASES" \
        --rubrics "$RUBRICS" \
        "$@"
}

run_export() {
    node "$HERE/harness.mjs" \
        export \
        --results "$RESULTS" \
        --fixture "$CASES" \
        --rubrics "$RUBRICS" \
        "$@"
}

SUBCOMMAND="${1:-}"
shift || true
case "$SUBCOMMAND" in
generate)
    run_generate "$@"
    ;;
run)
    run_cases "$@"
    ;;
judge)
    run_judge "$@"
    ;;
summary)
    run_summary "$@"
    ;;
export)
    run_export "$@"
    ;;
all)
    run_generate "$@"
    overall=0
    run_cases "$@" || overall=$?
    run_judge --stamp "$STAMP" "$@" || overall=$?
    run_summary --stamp "$STAMP" "$@" || true
    run_export --stamp "$STAMP" "$@" || true
    exit "$overall"
    ;;
*)
    echo "first argument must be a harness subcommand: generate|run|judge|summary|export|all" >&2
    exit 2
    ;;
esac
