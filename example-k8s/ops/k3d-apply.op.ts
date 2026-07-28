import { ApplyOp } from "@intentius/chant-lexicon-temporal";

// code → local k3d (chant#704), no cloud account. scripts/local/local-up.sh
// (run by `npm run demo:k8s` before behold starts serving) brings the cluster
// up; behold's Run button on this Op deploys the declared app to it —
// build → plan (live diff) → server-side apply, field manager
// "chant:behold-k3d-demo" (chant#1074/#1075). Deletes are owned-only: a
// marker-scoped prune that never touches anything chant didn't declare — the
// same path chant#1179 wants a live E2E for; this Op exercises it, but isn't
// that test.
const { op } = ApplyOp({
  name: "k3d-apply",
  env: "local",
  target: "kubectl",
  output: "app.yaml",
  delete: "owned-only",
});
export default op;
