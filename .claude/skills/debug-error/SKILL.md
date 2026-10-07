---
name: debug-error
description: Evidence-based debugging of an error or stack trace, fixing the root cause with a regression test. Use when the user pastes an error, stack trace or traceback, or says "debug this", "it's broken", "werkt niet", "fix this error", "why does this fail".
---

# Debug an Error — no guessing

## Inputs
- Full error + stack trace (if only a summary was given, ask for the full output or reproduce it yourself)
- Steps to reproduce. If missing, try to reproduce from the stack trace before asking.

## Workflow
1. **Read** the stack trace bottom-up; open every file:line in the user's code it references. Ignore library frames unless the bug is there.
2. **Reproduce**: run the failing command/test. If you cannot reproduce, say so and add targeted logging instead of guessing.
3. **State** expected vs actual in one line.
4. **Hypotheses**: list 3, ranked by likelihood, each with the evidence that would confirm or kill it.
5. **Test each**: add a log, assertion, or minimal test. Record result: confirmed / killed. No fix until one is confirmed.
6. **Fix the root cause**, not the symptom. A try/except, null-check or retry that hides the error is not a fix unless the root cause *is* an expected failure.
7. **Search the repo** for the same pattern (grep the faulty call/shape). If it breaks here, it breaks there: fix or list each occurrence.
8. **Regression test** that fails without the fix and passes with it. Verify both directions.
9. Remove temporary debug logging.

## Output
- Two lines: why it broke, and why it cannot break this way again.
- Files changed, other occurrences found, test added.

## Stop conditions
If 3 hypotheses are killed, stop and report findings + next hypotheses instead of thrashing. If the fix needs a design change (schema, API contract), propose it before making it.
