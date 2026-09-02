# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Ponytail is a portable "lazy senior dev" persona/skill distribution for AI coding agents: it pushes an agent toward YAGNI, stdlib/native-platform-first, and the shortest correct diff. The actual behavior lives once in `skills/*/SKILL.md` and `AGENTS.md`; every other top-level dotfolder (`.claude-plugin/`, `.codex-plugin/`, `.cursor/`, `.windsurf/`, `.clinerules/`, `.kiro/`, `.qoder/`, `.qoder-plugin/`, `.grok-plugin/`, `.devin-plugin/`, `.opencode/`, `.openclaw/`, `.agents/`, `.github/plugin/`, `pi-extension/`, `plugin.yaml`/`__init__.py` for Hermes, `gemini-extension.json`) is a thin adapter that points a specific host agent at that shared source. See `docs/agent-portability.md` for the full host-by-host adapter table and `docs/platform-native.md` for the reference table of native-platform alternatives to common libraries that the skill draws on.

**This repo's own convention (from `AGENTS.md`) applies to work done in it**: be the lazy senior dev when editing ponytail's own code too. Don't add abstractions, dependencies, or boilerplate beyond what's asked; prefer deletion; keep diffs minimal once you've actually understood the change.

## Architecture: source of truth vs. copies

- **`skills/*/SKILL.md`** — the six skills (`ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`) are the canonical, longest-form behavior definitions. `skills/ponytail/SKILL.md` is the runtime source of truth for the core ruleset.
- **`AGENTS.md`** — a compact, always-on version of the same ruleset for hosts without skill support (read by Codex, Antigravity, CodeWhale, Swival, Zed, Junie, Amp, Jules, and others).
- **Compact rule copies** — `.cursor/rules/ponytail.mdc`, `.windsurf/rules/ponytail.md`, `.clinerules/ponytail.md`, `.agents/rules/ponytail.md`, `.qoder/rules/ponytail.md`, `.github/copilot-instructions.md`, `.kiro/steering/ponytail.md` must all byte-match `AGENTS.md` (frontmatter stripped where the host requires it). **`scripts/check-rule-copies.js` enforces this in CI** — if you edit the ruleset in `AGENTS.md`, update every copy in the same change, and vice versa. It also asserts that a fixed set of "invariant" phrases (the ladder rung about reusing existing code, the ceiling-comment rule, the one-check-per-change rule, the four "not lazy about" safety carve-outs) survive verbatim in both `skills/ponytail/SKILL.md` and `AGENTS.md`, since `SKILL.md` is longer and can't be diffed byte-for-byte against the compact files.
- **`hooks/`** — shared Node logic used by the Claude/Codex/Copilot/Qoder hook manifests: `ponytail-config.js` (mode resolution: `PONYTAIL_DEFAULT_MODE` env var → `~/.config/ponytail/config.json` → `full`), `ponytail-instructions.js` (builds the injected ruleset text per intensity level), `ponytail-runtime.js` (hook I/O, host detection), `ponytail-activate.js` (SessionStart hook), `ponytail-subagent.js` (SubagentStart hook), `ponytail-mode-tracker.js` (UserPromptSubmit hook, tracks `/ponytail` and "stop ponytail"/"normal mode"). `ponytail-mcp/` and `pi-extension/` both reuse this same instruction-building logic so every host emits an identical ruleset.
- **Intensity levels**: `off`, `lite`, `full` (default), `ultra`, plus a session-only `review` mode — never a valid *default* (enforced in `ponytail-config.js`, see issue #377).

## Commands

```bash
npm test                          # full suite: root tests + pi-extension + ponytail-mcp
node --test tests/*.test.js       # just the root test files
node --test tests/hooks.test.js   # a single test file
node scripts/check-rule-copies.js # verify AGENTS.md / rule copies / SKILL.md invariants are in sync
node scripts/check-versions.js    # verify all version-bearing manifests share one semver
```

Root tests mix two styles: plain top-level `assert` scripts that throw on failure (e.g. `tests/hooks.test.js`), and `node:test`-based files using `test()` blocks (e.g. `tests/behavior.test.js`). Both run fine under `node --test`. `pi-extension/` and `ponytail-mcp/` are separate npm packages with their own `package.json`/tests, run via `npm test --prefix <dir>`; `ponytail-mcp` needs `npm install --prefix ponytail-mcp` first (CI does this). `tests/correctness.test.js` shells out to `python3`/`node` to actually execute generated code snippets (see `benchmarks/correctness.js`); its CSV-sum check imports `pandas`, so `pip install pandas` is needed before `npm test` will pass locally (CI does this too, see `.github/workflows/test.yml`).

No build/lint/typecheck step — this is plain, unbundled Node.js (CommonJS in `hooks/` and `tests/`, no transpilation).

## Release conventions

- **Version consistency**: the project version is declared independently in eight files (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.devin-plugin/plugin.json`, `.github/plugin/plugin.json`, `.qoder-plugin/plugin.json`, `gemini-extension.json`, `package.json`, `ponytail-mcp/package.json`) and must be bumped together — `scripts/check-versions.js` fails CI if they disagree, and on a `vX.Y.Z` tag push also fails if the shared version doesn't match the tag.
- **CI** (`.github/workflows/test.yml`): runs `check-rule-copies.js`, `check-versions.js`, then `npm test`, on every push to `main` and every PR.
- **Publish** (`.github/workflows/publish.yml`): on a `v*` tag push, publishes to npm via OIDC trusted publishing (no token).

## Code conventions specific to this repo

- **`ponytail:` comments**: mark a deliberate simplification that cuts a real corner, naming the ceiling and the upgrade path, e.g. `// ponytail: global lock, per-account locks if throughput matters`. This convention is used throughout the repo's own source (`hooks/ponytail-config.js`, `scripts/check-rule-copies.js`, etc.) — follow it when you leave a similar shortcut.
- Non-obvious fixes and safety-relevant logic reference their GitHub issue number in a comment (e.g. `(#377)`, `(#200)`, `(#324)`) — do the same for a fix whose motivation isn't obvious from the code alone.
- Adding a new host adapter: keep it thin — point the host at existing `skills/` and `hooks/` files rather than duplicating logic, then add a row to the table in `docs/agent-portability.md` (see "Adapter Rule" there).
