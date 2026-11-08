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
#   ./container-run.sh summary             # host-side results table
#   ./container-run.sh export              # dossier from the selected stamp
#   ./container-run.sh describe --stamp X  # write the stamp's run.json host-side
# Extra flags pass through to harness.mjs (--model, --judge-model, --stamp...).
# `--no-judge` runs `all` without the judge stage. `--discovery` runs the
# discovery variant: prompts carry no destinations, so the lakes are
# reachable only through `docs help` (measured per case).
#
# One source of truth for the case corpus: --fixture/PLACEMENT_CASES picks
# the corpus that generation, selection, the redacted run list, the frozen
# run description and reporting all use. Host-only commands (judge, summary,
# export, describe) need no podman and dispatch before the container toolbox
# is even checked.
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

command -v node >/dev/null 2>&1 || {
    echo "node is required" >&2
    exit 1
}

# Same provider routes as the host session; the container shares the host
# network, so the loopback proxy overlay works as-is.
overlay="${OPENCODE_CONFIG_CONTENT:-}"

# ---------------------------------------------------------------- host-only
# Judging, reporting and run-description freezing need provider keys and the
# host's OpenCode binary, so they run on the host — no podman required. They
# dispatch BEFORE any container machinery so a podman-less machine can still
# score and export recorded evidence.
host_harness() {
    node "$HERE/harness.mjs" "$@" \
        --results "$RESULTS" \
        --fixture "$CASES" \
        --rubrics "$RUBRICS"
}

require_podman() {
    command -v podman >/dev/null 2>&1 || {
        echo "podman is required (host-only commands judge/summary/export/describe need none)" >&2
        exit 1
    }
}

prepare_image() {
    require_podman
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
}

# The full repo is only mounted while generating: it writes prompts, sandbox
# fixtures and rubrics to the host mounts. The selected corpus is mounted at
# one stable in-container path (F12): generation must hash the same corpus
# the run list, judging and reporting use.
run_generate() {
    prepare_image
    podman run "${CONTAINER_ENV[@]}" \
        -v "$REPO:/repo:ro" \
        -v "$CASES:/cases/cases.json:ro" \
        -v "$PROMPTS:/prompts" \
        -v "$FIXTURES:/fixtures" \
        -v "$RUBRICS:/rubrics" \
        -v "$RESULTS:/results" \
        "$IMAGE" \
        node /repo/tests/fixtures/placement-harness/harness.mjs \
        generate \
        --plugin /repo \
        --fixture /cases/cases.json \
        --prompts /prompts \
        --fixtures /fixtures \
        --rubrics /rubrics \
        --results /results \
        "$@"
}

# The run fixture is the work/lakes/config-home sandbox plus the case's
# generation fingerprint. Rubrics and cases never enter it, even when an
# older generation left them behind. Staging is per stamp+case, so parallel
# sweeps cannot stage over each other.
prepare_case_fixture() {
    local id="$1"
    local stamp="$2"
    local source="$FIXTURES/$id"
    local target="$RUN_FIXTURES/$stamp/$id"
    [ -d "$source" ] || {
        echo "missing fixture $source; run generate first" >&2
        return 1
    }
    rm -rf "$target"
    mkdir -p "$target"
    local part
    for part in work lakes config-home generation.json; do
        [ -e "$source/$part" ] && cp -a "$source/$part" "$target/$part"
    done
}

# An id-only case list gives the run harness the selection without exposing
# claims, evidence, rubric text or the expected answers. The case's mutation
# policy and docs criterion are instrumentation, not rubric content, so they
# survive redaction: the run container must enforce the same policy as the
# host.
prepare_cases_run() {
    local corpus_hash
    corpus_hash="$(sha256sum "$CASES" | awk '{print substr($1, 1, 16)}')"
    CASES_RUN="$RUN_FIXTURES/cases-$corpus_hash.json"
    [ -f "$CASES_RUN" ] && [ "$CASES_RUN" -nt "$CASES" ] && return 0
    node -e '
        const fs = require("node:fs");
        const cases = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const redacted = cases.map((doc) => ({
            id: doc.id,
            mutationPolicy: doc.mutationPolicy ?? null,
            docsCriterion: doc.docsCriterion ?? null,
        }));
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
        --jobs | --judge-jobs)
            RUN_ARGS+=("$1" "$2")
            shift 2
            ;;
        --allow-writes | --no-judge | --discovery)
            RUN_ARGS+=("$1")
            shift
            ;;
        [A-Za-z0-9]*)
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
        # Default selection comes from the corpus itself — any corpus works,
        # id namespaces are not restricted to E*.
        while IFS= read -r id; do
            [ -n "$id" ] && IDS+=("$id")
        done <<< "$(node -e '
                    const cases = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
                    for (const doc of cases) console.log(doc.id);
                ' "$CASES")"
    fi
    if [ "${#IDS[@]}" -eq 0 ]; then
        echo "run: no cases selected and the corpus is empty; run generate first" >&2
        return 2
    fi
    [ -n "$STAMP" ] || STAMP="$(date +%Y%m%d-%H%M%S)"
}

# One container per case: only that case's sandbox, prompt and result dir are
# mounted, and the plugin is a curated package rather than the whole repo.
# Before the loop, the stamp's run description is frozen host-side (whole
# corpus, real model, real plugin identity), so the id-only container runs
# can never relabel the evidence.
run_cases() {
    prepare_image
    parse_run_args "$@"
    prepare_cases_run
    node "$HERE/harness.mjs" \
        describe \
        --stamp "$STAMP" \
        --results "$RESULTS" \
        --fixture "$CASES" \
        --rubrics "$RUBRICS" \
        --plugin "$REPO" \
        ${RUN_ARGS[@]+"${RUN_ARGS[@]}"} \
        ${IDS[@]+"${IDS[@]}"} >&2 || return $?
    local overall=0
    local id status result_case name
    for id in "${IDS[@]}"; do
        prepare_case_fixture "$id" "$STAMP" || {
            overall=1
            continue
        }
        result_case="$RESULTS/$STAMP/$id"
        mkdir -p "$result_case"
        status=0
        podman run "${CONTAINER_ENV[@]}" \
            --tmpfs /fixtures \
            -v "$RUN_FIXTURES/$STAMP/$id:/fixtures/$id:ro" \
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

# Does this invocation say to skip the judge stage?
wants_no_judge() {
    local arg
    for arg in "$@"; do
        [ "$arg" = "--no-judge" ] && return 0
    done
    return 1
}

# Judge args: everything except --no-judge (meaningless to the judge stage).
judge_args() {
    local arg
    for arg in "$@"; do
        if [ "$arg" != "--no-judge" ]; then
            printf '%s\n' "$arg"
        fi
    done
}

SUBCOMMAND="${1:-}"
shift || true
case "$SUBCOMMAND" in
judge)
    host_harness judge "$@"
    ;;
summary)
    host_harness summary "$@"
    ;;
export)
    host_harness export "$@"
    ;;
describe)
    host_harness describe "$@" --plugin "$REPO"
    ;;
generate)
    run_generate "$@"
    ;;
run)
    run_cases "$@"
    ;;
all)
    run_generate "$@"
    overall=0
    run_cases "$@" || overall=$?
    # STAMP is a global resolved by parse_run_args inside run_cases.
    if ! wants_no_judge "$@"; then
        mapfile -t JARGS < <(judge_args "$@")
        host_harness judge --stamp "$STAMP" "${JARGS[@]}" || overall=$?
    fi
    host_harness summary --stamp "$STAMP" "$@" || true
    host_harness export --stamp "$STAMP" "$@" || true
    exit "$overall"
    ;;
*)
    echo "first argument must be a harness subcommand: generate|run|judge|summary|export|describe|all" >&2
    exit 2
    ;;
esac
