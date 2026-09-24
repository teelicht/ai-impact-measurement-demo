# AI impact measurement demo

An independent, local-first companion to the paper's fictional API-team report. The default run is **synthetic**, not a live team result. It does not establish that AI caused a change in output or that AI generated a financial return.

## Quickstart

Requires Node.js 22+ and npm. From this repository:

```sh
npm ci
npm run demo
```

Open `output/api-team.html` directly in a browser. The same run writes `output/api-team-evidence.json`. The HTML is self-contained: it does not request a Jira service, Git host, CSS, chart library, or remote images. Both artifacts come from the same validated report model.

The evidence JSON includes `monthly` rows with per-row `measureStatus`, plus source coverage, exclusions, period boundaries and unassessed outcomes. Status is `available`, `partial`, or `unavailable`: a numeric value with `partial` is incomplete, a null value with `unavailable` is not zero, and a numeric zero with `available` is an observed zero. For a single-month report, `periods` is empty but `monthly` still contains that month and its statuses.

To select your own sources and output directory:

```sh
npm run report -- --config ./examples/config.json --out ./output/local
```

This produces `output/local/example-api-team.html` and `output/local/example-api-team-evidence.json` for the example scope. Configured filenames use a lowercase scope slug: runs of non-ASCII letters, punctuation, spaces and path separators become `-`, leading/trailing `-` are removed, and a scope without ASCII letters or digits uses `team-report`. The synthetic default keeps `api-team.*`. Config and input paths are local; relative input paths resolve from the config file. `--out` names a directory and defaults to `output`; repeating `--out` is an error, even when the first value is `output`. Without `--config`, `npm run report` uses the synthetic records. With `--config`, omitted sources remain unavailable; a missing or invalid configured source fails with a nonzero exit and never falls back to the default report. The example config has only one month of tickets, not a twelve-month comparison. Set complete calendar-month bounds for the period you actually have; periods split the selected months into two groups, and a single month has no comparison.

## What the dashboard shows

The renderer ports the **dark dashboard and chart pattern** from the local `team-output-ai-delta` blueprint: a team/service, AI-use and repository-evidence overview above compact KPIs, monthly trends, issue-type mix, comparison markers and a ledger. It does **not** reuse the blueprint's live Jira integration, significance badges or automatic AI-effect claims. There is no decision verdict at the top; the report profile records scope, ownership, context, questions and evidence limits, while follow-up actions remain after the evidence. Configured context is optional and missing fields read "Not supplied", never copied from the synthetic example. Utilization contrasts monthly created issue counts with monthly input-plus-output token totals on separate scales; sharing a month does not attribute tokens to a task. The default synthetic data has no model, input/output/cache, retry or work-item breakdown. Configured detailed usage can show those fields when the records support them. An approval requires a qualifying release event, created issues are distinct from approved work, and commit counts are only activity signals. Missing effort, lead time, linked escaped defects and total AI cost remain unassessed. Tool spend is not total AI cost or ROI. A configured time boundary alone is not an AI adoption event.

## Bring your own records

See [the adapter guide](docs/adapters.md) for a local Git revision, structured ticket JSON, optional usage and billing exports, and trusted custom modules. [The example fixtures](examples/README.md) describe normalized record fields and coverage reconciliation. No credentials, network access or live Jira connection are needed for the default report. Review source coverage and the original records before using a configured report for a decision; complete records do not by themselves establish causality.

```sh
npm test
```
