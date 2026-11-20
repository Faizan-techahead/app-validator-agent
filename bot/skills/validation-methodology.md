---
description: Coverage rules for app validation — Excel vs brief gaps, scoring, and failure analysis without inventing UI or APIs.
---

# Validation methodology

## Sources of truth

1. Application brief fields the user provided.
2. Excel/CSV/JSON cases after `import_excel_cases` (mapped columns).
3. Runner evidence from `run_web_chrome` / `run_mobile_emulator`.

Do not add steps that reference screens, APIs, or data that never appear in (1) or (2).

## Catalog construction

- Keep every Excel case unless it is empty after import.
- Add gap cases only when the brief names a critical flow with no sheet coverage.
- Label gaps `source: generated`.
- Prefer severity from the sheet; default `medium`.

## Scoring

| Status | When |
| --- | --- |
| Pass | Runner evidence meets the stated expected result or navigation-only load succeeds |
| Fail | Evidence contradicts the expected result |
| Blocked | Missing columns, offline emulator, Chrome failure, or interactive steps without selectors |
| Not Run | Case not routed to a runner or insufficient automation detail |

## Failure analysis

For each Fail: state the expected check, the observed evidence, and the smallest missing fact that would unblock a re-run. Do not speculate beyond evidence.

## Logs and screenshots

- Every executed case must keep redacted execution logs (no secrets).
- On Fail only: capture a screenshot of the screen at failure (Chrome page or emulator).
- If screenshot capture is unavailable, record `screenshot_blocked_reason` — do not invent an image.
- Logs and failure screenshots go in the **same PDF** as the summary.

## Mobile

Ask Android vs iOS at run time. Emulator work belongs on the machine that hosts the emulator.

## Secrets

Refuse to echo secrets. PDF appendix uses a fingerprint hash only.
