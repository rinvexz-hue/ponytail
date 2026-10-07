---
name: dead-code-cleanup
description: Find and safely delete dead code, unused dependencies and assets in small verified commits. Use when the user says "clean up", "dead code", "opruimen", "remove unused", "slim down the repo", or after a big refactor/AI-generated build.
---

# Dead Code Cleanup

## Inputs
- Scope: whole repo or a folder (default whole repo, excluding vendored/generated dirs).
- Build + test commands: detect from package.json scripts / Makefile / pyproject. Ask only if none exist.

## Detection (use tools, then verify by hand)
- JS/TS: `npx knip` (unused files, exports, deps), `npx depcheck`, `tsc --noEmit` for unreachable code warnings.
- Python: `vulture . --min-confidence 80`, `pip-extra-reqs` / `deptry`.
- Also look for: commented-out blocks, unreachable branches, feature flags hardcoded always-on/off, duplicate utilities doing the same thing, unused CSS classes, assets not referenced anywhere.

## Safety rules — before EVERY deletion
- `grep -rn` the symbol/file name across the repo including strings: dynamic imports, `require(variable)`, route files picked up by convention (Next.js `app/`, `pages/`), config files, CMS/templates, test fixtures, scripts, CI files.
- Framework entry points are not dead even with zero imports (pages, API routes, middleware, migrations, CLI entry points, exported public API of a library).
- Unsure = do not delete. Put it on the uncertain list.

## Workflow
1. Make sure the working tree is clean and build + tests pass *before* starting (baseline).
2. Group deletions by category; one small commit per group (`chore: remove unused X`).
3. After each commit: run build + tests. If red, revert that commit and move the items to the uncertain list.
4. Merge duplicates only when behavior is identical; otherwise list them.

## Output
- Lines removed, files removed, dependencies removed (with bundle/install size saved if measurable).
- Uncertain list: item, why it might still be used, how to verify.
