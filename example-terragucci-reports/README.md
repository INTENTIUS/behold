# example-terragucci-reports

A terragucci reports bucket for terragucci's own example estate
(`terragucci/example`: three environments of five roots, 15 roots), laid out
key for key as terragucci writes one. `behold serve <terragucci>/example
--terragucci example-terragucci-reports` paints that estate from it.

Every `report.json`, `index.json` and `estate.json` here was written by
terragucci's own code (`buildReport`, `uploadReport` against a store that
writes files, `buildEstate`) at terragucci `cb2381d2` (main, 2026-10-09), and
each validates against the JSON Schemas `@intentius/terragucci` 0.4.4 ships.
`scripts/terragucci-example-reports.ts` is the script that wrote it; it only
supplies plans shaped like `tofu show -json` for the tutorial's scenarios:

| Run | Finished (UTC) | What it found |
|---|---|---|
| tf-drift | 2026-10-07 06:04 | nothing drifted |
| tf-drift | 2026-10-08 06:04 | staging orders' jobs queue deleted outside Terraform; prod payments failed to plan |
| tf-plan, PR #11 | 2026-10-08 08:00 | prod search replaces its records table (`hash_key` → `sku`) |
| tf-plan, PR #12 | 2026-10-08 09:00 | dev orders keeps unclaimed jobs for seven days |
| tf-apply wave 1 | 2026-10-08 09:30 | dev, applied (no approval required) |
| tf-apply wave 2 | 2026-10-08 09:31 | staging, waiting for an approval; destroys staging email's records table |

`audit.jsonl` is the audit record `terragucci audit` would write for these
runs (wave 1's apply, wave 2's approval request and its waiting apply). It is
written by hand, field for field on terragucci's `report/audit.ts` at
`b0b7e144`, with report entries' ids computed the way it computes them, and
validates against that commit's `audit.schema.json`
(`src/__fixtures__/terragucci-schemas/`, #506).

The project is `github.com/acme/shop`. The plans' resource names are made up;
the addresses are the example's own. Plan text files hold a placeholder line.

To write it again (the clock is fixed, so the files come out the same):

```sh
TERRAGUCCI=/path/to/terragucci \
  /path/to/terragucci/node_modules/.bin/tsx scripts/terragucci-example-reports.ts
```
