# Agent instructions

## Commands

- `npm test` builds, then runs `node --test dist/tests/*.test.js`
- `npm run typecheck` runs `tsc --noEmit`
- `npm run lint` runs `biome check --write`
- `npm run demo` regenerates the sample reports in `output/`

Run `npm test`, `npm run typecheck` and `npm run lint` before you finish.

## Test suite: keep it slim

The tests guard logic and layout. They do not guard wording.

**What to test**

- Logic: aggregation, validation, adapters, finance, Git extraction.
- Data integrity: no zero or complete value is invented from missing or partial sources.
- Security: HTML escaping, no repository paths, no emails or other PII.
- Layout structure: section order, nav targets, `data-*` hooks, and the embedded `report-data` JSON.

**What not to test**

- Do not assert headings, captions, labels, notes, tooltips, or the prose in error or reason messages.
- A wording change in `src/` must never require a test edit. If it does, the test is wrong. Fix the test so it checks structure or data.
- Error assertions may match only record identifiers and field names, such as `/tickets API-1: status/`. They must not match explanations.

**How to change tests**

- Change tests only when logic or layout changes. Do not change them for individual text elements.
- Prefer extending an existing test with a table-driven case over adding a new test.
- Do not duplicate coverage across files. For example, validation rules belong in `validate.test.ts` and should not be repeated in adapter or finance tests.
- Keep fixtures minimal and inline. Delete tests that no longer guard distinct behaviour.
