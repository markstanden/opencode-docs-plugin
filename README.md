# opencode-docs-plugin

An [OpenCode](https://opencode.ai) V2 plugin that gives an agent a knowledge
tree it can actually use: a `docs` tool and a `/docs` command over the
configured docs root's `*.md` files (the `root` plugin option; default
`<location>/docs`), plus the writing convention those docs follow.

- `docs` (tool) — blank search lists the 10 most recently changed docs
  (`path — Area — date — Summary`); a search ranks docs over their
  front-matter, path and body identifiers, falling back to the closest
  matches rather than a dead end; `add` writes knowledge through a typed DTO;
  `check` validates the tree against the convention.
- `/docs` (command) — the same core, driven from the prompt:
  `search <text>` (bare text searches too), `add <text>`, `check`, `help`.
- The plugin also registers the `docs` skill, so the convention travels with
  the tool rather than living in always-loaded prose.

Reading a matched doc stays OpenCode's built-in `read`.

## Status

Standalone extract of the docs tooling, under active development.

## Development

```bash
npm install
npm test          # node --test
npm run typecheck
npm run lint
defined comply    # the gate: bootstrap, repair and verify
```

Tests run the plugin source directly under Node's type-stripping (`noEmit`,
`erasableSyntaxOnly`), so the file OpenCode loads is the file under test.

`tests/fixtures/docs-corpus.json` is a hand-authored synthetic corpus the
ranking harness pins behaviour against — edit it directly. It holds invented
paths and summaries only; never snapshot a real docs tree into it.

## Licence

MIT — see [LICENSE](LICENSE).
