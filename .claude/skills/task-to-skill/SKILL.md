---
name: task-to-skill
description: Turn a repetitive task into a reusable Claude Code skill and test it on a real example. Use when the user says "make this a skill", "turn this into a skill", "maak hier een skill van", "I keep doing this", or describes a workflow they repeat.
---

# Task → Skill

## Inputs
- The task + steps as the user does it by hand. If they just did it in this session, extract the steps from the conversation instead of asking.
- One real example input to test on.

## Workflow
1. **Interview briefly** (max 3 questions, only what you can't infer): exact phrases they use to ask for it, what varies per run, what "done" looks like.
2. **Decide scope**: project skill (`.claude/skills/<name>/SKILL.md`) if repo-specific; personal skill (`~/.claude/skills/<name>/SKILL.md`) if used across projects.
3. **Write SKILL.md**:
   - Frontmatter `name` (kebab-case) and `description`: what it does + the literal trigger phrases (Dutch and English if the user uses both). The description is what makes it trigger — be specific.
   - Body: inputs (ask vs infer), numbered workflow, the user's conventions (naming, formats, tools), edge cases, definition of done, stop conditions.
   - Keep it under ~200 lines. Move long reference material or scripts into files next to SKILL.md and reference them.
4. **Dry-run** on the real example in a fresh context if possible. Compare output to how the user does it by hand.
5. **Refine** until it matches: fix wrong assumptions, add missed edge cases, tighten the trigger description. Max 3 iterations, then show the diff to the user.

## Done when
The skill triggers on the user's own phrasing and produces output the user would accept without edits.
