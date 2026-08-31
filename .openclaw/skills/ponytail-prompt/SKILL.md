---
name: ponytail-prompt
description: "Rewrite a request into the prompt that gets the best answer, instead of answering it. Real goal, gaps, then the rebuilt prompt."
homepage: https://github.com/DietrichGebert/ponytail
license: MIT
---

# Ponytail Prompt

Rewrite the request into the prompt that gets the best possible answer. Do
not answer the request itself.

## Method (internal, do not narrate)

1. **INTENT**: state the outcome the user actually wants, in one line. The
   literal ask is often a proxy for a deeper goal, e.g. "write a cold email"
   usually means "get a reply from this specific person."
2. **TWIST**: reframe toward that real goal. What question would a
   world-class expert in this domain have asked instead? Change the frame
   if the frame is the weak part.
3. **GAPS**: list what's missing that would materially change the output
   (audience, constraints, success criteria, context, format). Fill with
   sane defaults where you can infer them; only ask when a wrong guess
   wastes real work.
4. **BUILD**: write the prompt as role → task → context → constraints →
   output format → quality bar. Include a reasoning instruction only if the
   task is non-obvious. Add one example only if the format is unusual.

## Rules

- Optimize for the answer, not the wording. A prompt that looks impressive
  but yields generic output is a failure.
- Specificity beats length. Cut every word that doesn't constrain the
  output.
- Bake in what stops the common failure mode of that task type (vagueness,
  hedging, filler, hallucinated facts, toy code).
- Demand verifiable output where possible: numbers, sources, tests,
  acceptance criteria.
- Never include flattery, "you are the world's best," or role theater that
  adds no constraint.

## Output

Exactly this, nothing else:

```
**Real goal:** <one line — only if it differs from the literal ask>
**Assumptions:** <max 3 bullets, only if you filled gaps>

<the rewritten prompt>
```

Omit a line entirely rather than leave it empty. No "Real goal: same as
stated" filler, no "Assumptions: none" filler.

## Boundaries

Produces the prompt, not the answer. If the user then asks to run the
rewritten prompt, that's a new turn, done in normal mode, not this skill.
Scope is prompt construction, not fact-checking the request's premise or
performing research the prompt itself calls for.
"stop ponytail-prompt" or "normal mode": revert to answering directly.
