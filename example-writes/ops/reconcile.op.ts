import { ReconcileOp } from "@intentius/chant-lexicon-temporal";

// cloud → code. Snapshot live prod, diff vs source, open a PR for drift/orphans.
// Scoped to chant-owned resources. behold's Adopt button triggers this.
const { op } = ReconcileOp({ name: "prod-reconcile", env: "prod", onDrift: "pull-request", scope: { owned: true } });
export default op;
