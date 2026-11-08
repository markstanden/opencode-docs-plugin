---
Area: quality
Keywords: front-matter, metadata, multiline, line break, crlf, summary, keywords, serialize
Summary: Multiline metadata values corrupt serialized front-matter; add refuses them at the boundary with a single-line requirement.
---

# Metadata must be single-line, or the write refuses

### Facts

- The doc convention's serialized front-matter is flat `Key: value` lines.
  A `Summary` or `Keywords` element carrying `\n` (or `\r`) writes a second
  front-matter line that parses as another field — historically a forged
  hand-maintained `Date:` (which `check` later flagged) or a shadowed
  `Keywords`.
- `prepareAdd` now refuses any required metadata field (scalars and every
  Keywords element) containing a line break, before any structural or
  twin work takes the write further; the message explains the serialization
  shape and corrects towards Deliberate multi-element Keywords.

### Tested

- `tests/docs.test.ts` `prepareAdd single-line metadata` block: LF and CRLF
  scalars, delimited and element-level Keywords breaks, delimiter-shaped
  Summary shadowing, purity (no Fs interactions), and the positive
  round-trip: serialize → parse reproduces single-line values and the
  written file passes `validateDoc`.
