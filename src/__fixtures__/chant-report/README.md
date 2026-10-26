Copied from INTENTIUS/chant at 9f099d4 (main, the merge of chant#4471 that carries chant#4439), without a change:

- `tf-plan/report.json`, `tf-plan/change-set.json` from `lexicons/terraform/src/__fixtures__/report/tf-plan/`
- `tf-apply/report.json`, `tf-apply/change-set.json` from `lexicons/terraform/src/__fixtures__/report/tf-apply/`
- `plan.show.json`, `applied.show.json` from `lexicons/terraform/src/__fixtures__/report/` (the `show -json` inputs)

chant's `lexicons/terraform/src/__fixtures__/report/generate.ts` writes the four stage files from the two inputs with
`chant terraform report`. behold draws `report.json` (terragucci.report/v1 minor 48, `compose.estate`) through the
terragucci estate scene, as ruled on behold#1008; src/chant-report-scene.test.ts renders both stages. The bare
`change-set.json` files are kept beside their reports for reference and are not read.
