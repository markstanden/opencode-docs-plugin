---
Area: quality
Keywords: behavioural trials, placement cases, trial container, permission deny, sandbox, judge model, keyless routing
Summary: The placement-trial harness runs trials in a read-only-rootfs container because session permission denies proved unreliable to enforce across run contexts; trials route keyless through the loopback proxy while judging runs host-side where provider keys live.
---

# The trial container is the sandbox, not the session permissions

### Facts

- The behavioural placement harness (`tests/fixtures/placement-harness/`)
  exists because a fixture asserting expected answers in Node cannot prove a
  model follows the placement guidance; only real sessions can.
- Trial sessions must not see the host filesystem: an unsandboxed E01 trial
  spent 7–9 minutes exploring the real repository and the host home
  directory (including personal folders), which contaminates the trial and
  the stored transcript.
- The container (Debian slim, Node LTS, `@opencode/cli` installed at build
  time, root filesystem read-only, repository mounted read-only, only
  prompts/fixtures/results writable) is the physical boundary. With it, the
  same E01 trial took ~11 seconds, touched no host path, and answered
  correctly.
- Trials use the keyless workhorse route (provider reached through the host
  loopback proxy, whose key never enters the container), so the container
  shares the host network namespace by design. Judges use the current
  session model, whose provider key lives with the host session — so judging
  runs host-side against the same results directory.
- Configured session permission denies (`shell`, `edit`,
  `external_directory`) fired in isolated probes (the tool disappeared from
  the session) but did not enforce in harness-spawned `run` sessions with an
  identical project config — the session still used shell. Same config, same
  binary, different outcome across run contexts.

### Inferred

- Permission enforcement inconsistency is an upstream OpenCode behaviour, not
  a property of this project's configuration; the correct engineering
  response here is to treat the container as the only load-bearing boundary
  and the permission rules as best-effort defence in depth.

### Tested

- Host E01 trial without container: correct answer, but the tool trail shows
  host-home exploration (shell, glob, reads outside the workspace); 7–9
  minutes.
- Container E01 trial: correct answer (`docs`, Repository, one document),
  tool trail contains no host paths, `writes.txt` says none, ~11 seconds.
- Host judge pass with a stronger GLM (`zai-coding-plan/glm-5.3-flash`)
  returned a reasoned `pass` naming both tempting wrong answers as rejected;
  the same judge model inside the container fails with `ZAI_API_KEY is not
set`, which is what pins judging to the host.

### Open questions

- Report the permission-enforcement inconsistency upstream, with the probe
  that shows the deny removing the tool in one context and not another.
- Whether the container should also pin the CLI version per stamp instead of
  `@latest` when sweeps must be comparable across months.
