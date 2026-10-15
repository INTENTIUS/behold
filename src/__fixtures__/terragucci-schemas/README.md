The three JSON Schemas `@intentius/terragucci` 0.4.4 ships in its `dist/`
(Apache-2.0, INTENTIUS/terragucci), copied unchanged so the tests can check
behold's schema path without installing terragucci.

`audit.schema.json` is `terragucci.audit/v1`, one line of `audit.jsonl`, copied
unchanged from INTENTIUS/terragucci `packages/terragucci/src/report/audit.schema.json`
at `b0b7e144` (main, `@intentius/terragucci` 0.4.7), which ships it as
`dist/audit.schema.json` (#506).

`run.schema.json` is `terragucci.run/v1`, the run view at
`<prefix>/<project>/runs/<commit>/run.json`, copied unchanged from
INTENTIUS/terragucci `packages/terragucci/src/report/run.schema.json` at
`f85b3db1` (main, `@intentius/terragucci` 0.4.7, `waves[].progress` since
INTENTIUS/terragucci#786), which ships it as `dist/run.schema.json` (#509, #511).

#568: every `*.schema.json` in INTENTIUS/terragucci
`packages/terragucci/src/report/` refreshed, unchanged, from main at
`29b62a4d` (`@intentius/terragucci` 0.4.9, report schema minor 34). That
brings `report.schema.json` and `estate.schema.json` up to minor 34 and adds
`changes`, `dora`, `history`, `inventory`, `state-edges` and `state-versions`.
The demo fixtures in `../terragucci-demo/` (a pull request's tf-plan
`report.json` and the run views of its waves) are written against these, at
minor 34.

#568 step 2: every `*.schema.json` refreshed again, unchanged, from
INTENTIUS/terragucci main at `3bf6287c` (`@intentius/terragucci` 0.4.9, report
schema minor 36). Minor 35 (INTENTIUS/terragucci#1015) adds `totals_roots` to
`report.schema.json` and `waves[].totals` and `waves[].totals_roots` to
`run.schema.json`; minor 36 (INTENTIUS/terragucci#1016) adds `depth` to each
`blast.resources[].reaches[]`. The demo fixtures carry these fields, at minor 36.

#568 step 3: every `*.schema.json` refreshed again, unchanged, from
INTENTIUS/terragucci main at `11647640` (`@intentius/terragucci` 0.4.9, report
schema minor 38). Minor 38 (INTENTIUS/terragucci#1013, `waves.compose`) adds
`compose`, `waves[].composed`, `roots[].composed` and `roots[].reads[].composed`
to `report.schema.json`, and `roots[].composed` and `waves[].composed` to
`run.schema.json`. `../terragucci-demo-composed/` holds the same change as a
composed run: a pull request's tf-plan `report.json`, wave 1's tf-apply
`report.json` after a failure part way, and the run views of the run waiting on
an unknown read, applying, applied and failed part way. Every fixture in both
directories validates against these schemas.
