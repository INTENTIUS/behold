import { ApplyOp } from "@intentius/chant-lexicon-temporal";

// code → cloud. Additive apply (no gate) runs one-shot on the local executor —
// behold's Sync button shells `chant run prod-apply`. Target cloudformation;
// output defaults to template.json (matching this project's `build` script).
const { op } = ApplyOp({ name: "prod-apply", env: "prod", target: "cloudformation" });
export default op;
