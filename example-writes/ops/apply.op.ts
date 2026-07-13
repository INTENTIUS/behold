import { ApplyOp } from "@intentius/chant-lexicon-temporal";

// code → cloud. behold's Sync button triggers `chant run prod-apply` on your
// executor; behold holds no apply creds. Gated/durable applies use Temporal
// (`--temporal` + the generated worker); an additive apply runs on the local
// executor. delete:"gated" scopes deletes to chant-owned resources behind approval.
const { op } = ApplyOp({ name: "prod-apply", env: "prod", target: "cloudformation", delete: "gated" });
export default op;
