---
name: security-audit
description: Attack-minded security audit of a codebase with ranked findings and fixes. Use when the user says "security audit", "find security gaps", "is this safe", "beveiligingscheck", "pentest my code", or before deploying anything that handles auth, payments, user data or API keys.
---

# Security Audit

Mindset: you are an attacker who wants in. Assume every input is hostile.

## Inputs
- Focus areas (default: auth, payments, user data, API keys/wallets). Ask only if the repo has none of these.
- Expensive endpoints (LLM calls, paid APIs, trading/order execution). Infer from code: anything calling OpenAI/Anthropic/exchange/Stripe SDKs.

## Workflow
1. **Map the attack surface**: list routes/endpoints, auth middleware, external APIs, env vars, file uploads, webhooks, cron jobs. Write it down before hunting.
2. **Secrets**
   - `git log -p --all | grep -iE "(api[_-]?key|secret|private[_-]?key|password|token)\s*[:=]"` plus scan current files and `.env*` committed files.
   - Check `.gitignore` covers `.env*`, keys, wallets. Check client bundles: no secret in `NEXT_PUBLIC_*` / `VITE_*`.
   - A secret found in history = compromised. Rotate it; deleting the commit is not enough.
3. **Injection**: SQL (string-built queries), XSS (`dangerouslySetInnerHTML`, `innerHTML`, unescaped templates), command (`exec`, `subprocess(shell=True)`), path traversal (user input in file paths), SSRF (user-supplied URLs fetched server-side).
4. **Auth**: every route without an auth check, weak/long-lived sessions, JWT without expiry or with `alg:none`, open redirects (`?next=` without allowlist), missing CSRF on cookie auth.
5. **IDOR**: for every endpoint taking an ID, verify ownership is checked server-side (can user A read/modify user B's record?). Check Supabase/Firebase row-level rules.
6. **Input validation + uploads**: schema validation (zod/pydantic) on every form and API body; upload type/size limits, no execution from upload dir.
7. **Dependencies**: run `npm audit --omit=dev` / `pip-audit` / `cargo audit`. Read results; only report what is reachable.
8. **Rate limiting**: on login, signup, password reset and every expensive endpoint. Missing = cost/abuse risk; quantify (e.g. "unlimited LLM calls → €X/hour worst case").
9. **Leaks**: stack traces to clients, verbose error messages, secrets/PII in logs, debug routes enabled in prod, permissive CORS (`*` with credentials).

## Output
Findings table ranked Critical → High → Medium → Low:

| # | Severity | file:line | Issue | Exploit scenario | Fix |

Then:
- **Fix all Critical now** (small, separate commits; run tests after each).
- High and below as tickets: title, file:line, fix, effort estimate (S <1h, M <4h, L >4h).
- End with what you could NOT verify (runtime config, infra, third-party dashboards).

## Rules
- Never print full secret values; show first 4 chars + `…`.
- No false confidence: mark findings "suspected" when not proven.
