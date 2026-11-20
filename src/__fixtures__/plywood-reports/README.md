A plywood reports bucket in chant's report-store format (behold#1228), laid
out as `plywood estate` writes one with `reports.bucket` set:

- `estate/estate.json`, `estate/estate.html` and `estate/dora.json`: written by
  chant's own `buildLedgerEstate` and `estateFiles` with plywood's product words
  and `schemas: "neutral"` (`chant.estate/v1` and `chant.dora/v1`, each with
  `product: "plywood"`), over chant's estate ledger fixture
  (`packages/core/src/__fixtures__/estate-ledger.ts`, members `network` and
  `web`), at INTENTIUS/chant `d86a73b0d`.
- `audit.jsonl`: five `chant.audit/v1` lines written by chant's
  `auditLinesFromLedger` for product `plywood` and project `shop-infra` (the
  repository's directory, as plywood names it): an approval request, an
  approval, an update, an override and a revocation.

`../sql-yodeler-audit.jsonl` is sql-yodeler's own `audit.jsonl`, copied
unchanged from INTENTIUS/chant `packages/core/src/report-store/__fixtures__/`
at `d86a73b0d`, where its README says how sql-yodeler wrote it.
