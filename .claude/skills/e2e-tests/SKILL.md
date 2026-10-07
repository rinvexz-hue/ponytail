---
name: e2e-tests
description: Write and run Playwright end-to-end tests for user flows, money paths first. Use when the user says "e2e tests", "playwright", "test the flow", "test my app end to end", "eindtest", or before a launch/deploy.
---

# Playwright E2E Tests

## Inputs (infer from repo first)
- Flow(s) to test. Default priority: signup/login → checkout/payment → the app's core action.
- Stack (detect from package.json / framework config) and CI (detect `.github/workflows`).

## Setup (only if missing)
- `npm i -D @playwright/test && npx playwright install --with-deps chromium`
- `playwright.config.ts`: `baseURL` from env, `webServer` that starts the app, `retries: process.env.CI ? 2 : 0`, `use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' }`, headless by default (headed locally via `--headed`).
- Tests in `e2e/`, one file per flow.

## Rules for every test
- Test what the user sees: assert on visible text, URLs, enabled states — not internal state or CSS classes.
- Selectors: `getByRole`, `getByLabel`, `getByText`, then `getByTestId` as last resort. Never chained CSS/XPath.
- No `waitForTimeout`. Use web-first assertions (`await expect(...).toBeVisible()`).
- Independent: each test seeds its own data (API call, fixture, or unique email like `e2e+${Date.now()}@test.local`) and works in any order, in parallel.
- Auth: log in once via `storageState` setup project; don't re-login via UI in every test.
- Per flow, at least one unhappy path: invalid input, network failure (`page.route(..., r => r.abort())`), expired session (clear cookies mid-flow).
- Payments: use the provider's test mode/test cards only. Never hit live keys.

## CI (GitHub Actions default)
Add `.github/workflows/e2e.yml`: install, `npx playwright install --with-deps chromium`, run, upload `playwright-report/` as artifact on failure.

## Workflow
1. Write tests → 2. run `npx playwright test` → 3. show pass/fail summary → 4. fix failures (if the app is wrong, fix the app and say so; if the test is wrong, fix the test) → 5. re-run until green, run 3× to detect flakiness.

## Output
Results table, bugs found in the app, and an explicit **"Not covered"** list (flows, browsers, edge cases skipped).
