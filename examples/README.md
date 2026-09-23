# Structured source imports

`config.json` selects a version 1 ticket file; `module-config.json` selects the
trusted local ESM example. Paths are resolved relative to the config file. Call
`loadConfigured(configPath)` from `src/adapters/load.ts`. Set scope, complete
month bounds, IANA timezone, extraction timestamp with offset, currency and a
completeness attestation in the config. Declare each supplied source under
`sources` as `tickets`, `commits`, `usage`, or `charges`. A missing selector stays
unavailable, while a missing configured file is an error. A `git` selector
reads a pinned revision of a local repository without fetching; see
`docs/adapters.md` for a config example.

Ticket JSON uses `{ "version": 1, "tickets": [...] }`. Each ticket requires a
unique `id`, `type`, ISO `createdAt` timestamp with offset, and ordered
`statusEvents`. Each event has `at` and `status` (`open` or `approved`). Every
approval event also requires `releaseId`; repeated releases remain separate
events. Optional fields are `parentId` (an existing acyclic ticket), `startedAt`,
`emergency`, and `production` (boolean). Empty status history means unknown,
not approved. File provenance is generated from the local ticket ID.

Usage JSON uses `{ "version": 1, "usage": [...] }`. A monthly-only record needs
`kind: "monthly-total"`, a unique `id`, `month` (`YYYY-MM`), and safe nonnegative
integer `tokens`; one record describes one month. No category, model, attempt or
ticket link is inferred. Alternatively, each detailed event needs `id`, `at`,
`model`, integer `inputTokens`, `cachedInputTokens`, `outputTokens`, `attempt`
(starting at 1), and `outcome` (`success` or `failed`); `ticketId` is optional.
Do not combine monthly and event records in one source. Cached input is part of
input, not an extra token category. Billing JSON uses
`{ "version": 1, "charges": [...] }`. Each charge needs `id`, `billId`,
`billTotal`, `allocatedTo`, `month` (`YYYY-MM`), `currency`, `category`, `amount`,
and `allocationKey`. All files and module records pass the shared bundle
validator; malformed records fail with source and record ID.

A trusted local `.mjs` module exports async `loadSource(config)` and returns a
partial normalized `SourceBundle`: records for its selected source with
`provenance: { source, recordId }`, plus explicit coverage for that source.
Modules are executable code; only select modules you trust. Coverage fields are
`source`, `status`, `eligible`, `extracted`, `linked`, `excluded`, `missing`, and
`reason`. Each file selector must declare `coverage` with all fields except
`source`, which is taken from the selector name. Do not mark a file `available`
unless its completeness has been verified. Declare `partial` with a nonempty
reason and the known missing count for an incomplete export. For files,
`extracted` must equal the exported array length, and `eligible` must equal
`extracted - excluded + missing`. A complete file must have `missing: 0`.
Modules must return their own coverage entry, whose `extracted` count must also
equal the returned source array length. The returned bundle retains declared
selectors in `sources`.
