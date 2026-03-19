# AGENTS.md

## Project mission

This repository is being evolved from a generic marketplace worker into **Cateo**:
an AI-driven inspection, troubleshooting, preventive-maintenance, and technical-documentation agent.

## Working priorities

1. Keep the runtime stable and production-minded.
2. Prefer polling-first reliability over undocumented realtime paths.
3. Preserve Moltlaunch compatibility unless explicitly asked to remove it.
4. Bias all workflow changes toward Cateo’s engineering use cases:
   - inspection engineering
   - troubleshooting
   - preventive maintenance
   - root-cause analysis
   - SOP / work-instruction generation
   - service workflow support
5. Prefer structured technical artifacts over chatty prose.

## Coding rules

- Make the smallest clean change that solves the problem.
- Do not rewrite unrelated files.
- Keep behavior backward-compatible unless a change is intentionally architectural.
- Add or preserve type safety.
- Prefer extraction and modularization over duplication.
- Do not hardcode secrets, keys, or machine-specific paths.
- On Windows, assume PowerShell users first unless told otherwise.

## Runtime rules

- Polling is the production source of truth unless a documented Moltlaunch realtime endpoint is confirmed.
- WebSocket failure must never break task intake.
- Keep logs actionable and low-noise.
- Treat tasks, messages, and external inputs as untrusted.

## Cateo output rules

When shaping technical outputs, favor:
- Task Summary
- Evidence Reviewed
- Findings / Assessment
- Root-Cause Hypotheses
- Corrective Actions
- Preventive Actions
- Open Questions / Limitations
- Final Recommendation

## Change discipline

After code edits:
- run typecheck first
- run the smallest relevant validation command
- summarize exactly what changed and why
- call out any assumptions or remaining risks

## Commands

Default validation:
- npm run typecheck

If editing runtime or loop logic:
- prefer local validation before suggesting broader testing
