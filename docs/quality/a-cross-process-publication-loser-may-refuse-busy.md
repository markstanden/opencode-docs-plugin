---
Area: quality
Keywords: cross-process publication, target lock, busy refusal, racing replace, R11, bounded contention, opencode-docs-plugin
Summary: A losing writer that arrives while the winner still holds the target lock legitimately refuses busy, and a race assertion that only accepts staleness or conflict flakes on slow two-core CI runners.
---

# A cross-process publication loser may refuse busy, not stale

Recorded 2026-11-06 while pinning down the second post-merge red after the revision work (PR #19).

## Facts

- The guarded publication protocol refuses bounded in three ways: the bytes no longer match `expectedRevision` (stale), the replace target is gone (conflict), or another writer holds the target's lock at the instant of acquisition (busy). A manual steal would be the error; the refusal naming the owner is intended (R16).
- Two real child processes racing one replacement cross a file barrier and then act. On a loaded two-core runner the loser often reaches the lock a few milliseconds behind the winner and sees **busy**, not staleness — the winner has not released the lock yet. On a fast machine the loser usually arrives after the release and sees staleness, which is why the first 13 runs at home went green.
- R11 originally asserted the loser's message matches only staleness or conflict. The first `taskset -c 0,1` coverage run reproduced the CI flake exactly: at most one success, the winner's bytes whole and correct, and the loser refusing busy — the test was wrong, not the protocol.

## Tested

- Fixed assertion accepts all three bounded refusals; two-core gate soak then 5/5 clean (plus the earlier 13-run green history on the faster box), and main's post-merge (17cbeae) returned to green with no further suite change.

## Inferred

- Any future test that races the publication protocol must treat busy as a correct loser outcome. The essence of the race guarantees is elsewhere: exactly one winner, the winner's bytes an entire submitted version, and the loser never waiting or overwriting.

## Open questions

- None. If lock behaviour changes (e.g. automatic recovery in a future version), R16 and this note must move together.
