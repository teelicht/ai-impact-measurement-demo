# Local input guide

Run `npm run report -- --config ./examples/config.json --out ./output/local`. The version 1 JSON config names scope, full-month `startDate` and `endDate` (`YYYY-MM-DD`), IANA `timezone`, offset-aware `extractedAt`, `currency`, `completenessAttestation`, and a `sources` map. Supported keys are `tickets`, `commits`, `usage`, and `charges`. Paths are resolved relative to the config file, not the current shell directory. Missing selectors are unavailable. Configured synthetic selectors are rejected: the fixture cannot be relabeled to a different period or team, or combined with live inputs. Run without `--config` for the synthetic demo. A broken configured input fails the command rather than silently substituting synthetic records.

An optional `context` object supplies the report profile, not calculated findings. The [runnable example config](../examples/config.json) omits it to demonstrate the explicit "Not supplied" state. Add context when the owner can stand behind it:

```json
"context": {
  "owner": "Service lead",
  "updatedAt": "2026-04-02",
  "description": "Example checkout service",
  "includedWork": "Parent Stories and Tasks approved for release",
  "excludedWork": "Emergency fixes",
  "aiUse": "Known approved AI-assisted steps; unknown exposure stays unknown",
  "concurrentChanges": "Staffing and tool changes under review",
  "question": "What changed in output, quality, workload and spending?",
  "controls": "Guardrails not yet assessed",
  "resourceLimits": "Affordability limit not recorded",
  "repositories": ["Example service history"]
}
```

`updatedAt` is the report owner's update date, not `extractedAt`, which describes data extraction. All fields are optional; supplied strings must be nonblank and dates valid. Repository labels are inert display names, not Git paths, URLs or links. Do not copy real repository names or team descriptions into the synthetic default. The evidence JSON includes the supplied context; the monthly CSV contains numerical measures and statuses only.

## Local Git history

In a config file beside a locally available repository, select a revision explicitly:

```json
{
  "version": 1,
  "scope": "Example service",
  "startDate": "2026-03-01",
  "endDate": "2026-03-31",
  "timezone": "UTC",
  "extractedAt": "2026-04-01T00:00:00Z",
  "currency": "EUR",
  "completenessAttestation": "Local history at a reviewed revision; ticket source not supplied.",
  "sources": {
    "commits": {
      "kind": "git", "path": "../my-local-repo", "revision": "HEAD",
      "ticketPattern": "TKT-[0-9]+", "botAuthors": ["automation-bot"]
    }
  }
}
```

Pin `revision` to a commit hash for repeatable extraction. The adapter reads local history without fetching or modifying the repository, records the resolved revision and Git extraction time in commit coverage, marks shallow history partial, excludes bots and merges from eligible counts, and counts test touches by changed path. The report-wide `extractedAt` stays as declared in the config, including when a ticket file was extracted earlier than Git. The optional pattern extracts candidate ticket IDs; without a ticket source links are unverified. A stale local clone is not repaired automatically. Do not treat commits, churn, or contributors as hours worked or AI-assisted changes.

## Ticket JSON

Use `examples/config.json` and `examples/tickets.json` as runnable examples. A ticket file has `{ "version": 1, "tickets": [...] }`. Each ticket needs a unique `id`, `type`, offset-aware `createdAt`, and chronological `statusEvents`. A release approval event needs `status: "approved"`, `at`, and `releaseId`; an open event has `status: "open"` and `at`. Optional `parentId`, `startedAt`, `emergency`, and `production` fields make exclusion and timing rules auditable. An empty event list is unknown, not an approval. The loader counts eligible parent Stories and Tasks on first qualifying release approval, not creation date or affected version.

File selectors require explicit `coverage` with `status` (`available`, `partial`, `unavailable`), `eligible`, `extracted`, `linked`, `excluded`, `missing`, and `reason`. For every source type, `extracted` must equal the record count and `eligible = extracted - excluded + missing`, with `linked` no greater than either `eligible` or `extracted - excluded`. Missing records require `partial` or `unavailable` with a meaningful reason; `available` requires `missing: 0`. See [the structured file contract](../examples/README.md) for validation and provenance details.

## Optional consumption and billing

Omit either source when unavailable. If present, select a file with declared coverage like tickets:

```json
"sources": {
  "usage": { "kind": "file", "path": "usage.json", "coverage": {
    "status": "available", "eligible": 1, "extracted": 1,
    "linked": 0, "excluded": 0, "missing": 0, "reason": ""
  } },
  "charges": { "kind": "file", "path": "charges.json", "coverage": {
    "status": "available", "eligible": 1, "extracted": 1,
    "linked": 0, "excluded": 0, "missing": 0, "reason": ""
  } }
}
```

For totals available only by month, use `usage.json` as `{ "version": 1, "usage": [{ "kind": "monthly-total", "id": "march-total", "month": "2026-03", "tokens": 12000000 }] }`. One record represents one month's input-plus-output total. The report cannot infer model, cached input, retry counts or work-item links from it. Declare any omitted months as `partial` coverage with the correct missing count; do not combine rollups and detailed events in one usage source.

When actual event records are available, `usage.json` may instead be `{ "version": 1, "usage": [{ "id": "use-1", "at": "2026-03-10T12:00:00Z", "model": "model-a", "inputTokens": 100, "cachedInputTokens": 20, "outputTokens": 30, "attempt": 1, "outcome": "success" }] }`. Optional `ticketId` identifies a work item but does not prove AI contribution. Cached input is included in input, not added again. `charges.json` is `{ "version": 1, "charges": [{ "id": "charge-1", "billId": "bill-1", "billTotal": 10, "allocatedTo": "Example service", "month": "2026-03", "currency": "EUR", "category": "usage", "amount": 10, "allocationKey": "service" }] }`. Allocation and currency must reconcile. Recorded charges still cannot establish total AI cost without human and platform costs.

## Trusted custom module

`examples/module-config.json` selects `examples/custom-adapter.mjs`, which exports `async loadSource(config)` and returns normalized records and exactly one coverage entry for its selected source. Run it with `npm run report -- --config ./examples/module-config.json --out ./output/module`. Modules execute local code with your permissions: only load modules you trust. Normalized records need `provenance: { source, recordId }`; module coverage must reconcile `extracted` with returned records. The same bundle validator checks built-in and module data. Do not include secrets or personal data in report inputs that will be rendered or exported.
