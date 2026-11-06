---
Area: quality
Keywords: publication lock, physical target, docs-lock, lost update, target-locking
Summary: One physical target needs one publication lock: sit it in a .docs-lock beside the target's real directory and key it by the target's resolved physical identity, never under a configured root.
---

# A publication lock only coordinates when it sits beside its physical target

### Facts

- The reviewed publication protocol keyed the lock by the target's physical
  identity but placed the lock file under the **selected lake's configured
  root** (`join(root, ".docs-lock", hash + ".lock")`). Two writable roots
  reaching one file — `outer:nested/aa/doc.md` and `inner:aa/doc.md` — put the
  same hash in two directories, so both routes could hold a lock and pass the
  same expected revision; the reproduced result was a silent lost update
  (both `written: true`, last writer's bytes win).
- The fix keys **both identity and location off the physical target**: the
  lock directory is a hidden `.docs-lock` inside the deepest existing
  ancestor of the target (`targetLockDirectory`), and the name hashes the
  canonical physical key (`physicalTargetKey`). No part of the location
  derives from the current runtime's lake list, so processes with different
  configured lakes coordinate on the same file.
- The physical key is stable across the missing-target transition: the
  existing prefix is real-pathed and the missing tail joined, so creating the
  target's parent between two operations yields the same key string. The lock
  _directory_ location may drift when the target's directory comes into
  existence mid-race; the create path is then protected by the exclusive
  `wx` open rather than the lock, which is sufficient — creates never
  overwrite.

### Tested

- L01: alias routes (outer, inner, symlinked root) return one lock path.
- L02 (cross-process, critical-section coordinated by a verified-pause seam):
  with the outer route holding a live lock mid-publication, an inner-route
  process knowing only the inner configured root refuses busy; the final bytes
  are one complete submitted version. Under the route-rooted mutation this
  test goes red with both publications succeeding — the reviewed lost update.
- L03/L04/L05/L07/L08 in tests/publication.test.ts cover held-lock busy
  refusal, symlinked-root aliasing, cross-config creates, stale retry and
  failure recovery.

### Failed approaches

- Re-hashing the target without moving the location (the reviewed code's own
  flaw) — the mutation where the lock stays under the configured root still
  loses L02.
- An in-process pause cannot interleave two publications (the guard's own fs
  work is synchronous and single-threaded); a manual lock stand-in plus the
  cross-process seam proved the real interleaving instead.

### Open questions

- Old plugin versions lock under the configured root: they must be quiesced
  or restarted before this protocol is relied on. No automatic migration,
  and no unknown existing lock is ever erased.
