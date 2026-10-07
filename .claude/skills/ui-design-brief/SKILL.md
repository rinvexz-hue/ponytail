---
name: ui-design-brief
description: Write a full UI/UX design brief for a screen or flow before building it. Use when the user says "design brief", "UX brief", "ontwerp dit scherm", "design this flow", or asks to plan UI before coding.
---

# UI/UX Design Brief

## Inputs (ask only for what is missing; infer the rest from the repo)
1. Screen or flow to design
2. Audience (who, device, context of use)
3. Brand: colors, fonts, vibe. First check the repo for existing tokens (tailwind.config, CSS variables, theme files) and reuse them.
4. 2-3 reference products for direction (patterns only, never copy layouts or assets)

## Workflow
1. Scan the codebase: existing components, design tokens, routing, UI library. The brief must fit what exists.
2. Write the brief to `docs/design/<flow-name>.md` with these sections:
   - **Goal + success metric**: what the user must accomplish, how we know it worked
   - **User journey**: numbered steps, entry point to completion, including back/cancel paths
   - **Layout per screen**: visual hierarchy (what is seen 1st/2nd/3rd), spacing scale, breakpoints (mobile 375, tablet 768, desktop 1280)
   - **Component inventory**: table of component × states (default, hover, focus, active, disabled, loading, empty, error, success). Mark which already exist in the repo.
   - **Tokens**: typography scale (size/line-height/weight) and color tokens with semantic names (`--color-danger`, not `--red-500`)
   - **Motion**: what animates, duration (100-300ms UI, ≤500ms page), easing, and `prefers-reduced-motion` fallback
   - **Accessibility**: contrast ≥4.5:1 body text, keyboard order, focus visibility, ARIA roles, touch targets ≥44px, error announcements
   - **Edge cases**: long text, zero data, slow network, offline, permission denied
   - **Open questions**: decisions that need the user
3. List the reference patterns used and what was deliberately done differently.

## Done when
Brief file exists, every screen has all states defined, and open questions are surfaced to the user. Do not start implementing until the user approves.
