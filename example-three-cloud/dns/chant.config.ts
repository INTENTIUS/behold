import { terraformRootSchema } from "@intentius/chant-lexicon-terraform/config";

// terraform and pulumi are listed for the azure and aws components'
// member-outputs steps: the terraform lexicon is what reads a choudoufu
// member's outputs, and the pulumi lexicon a Pulumi member's (chant#4455,
// pulumiOutputSource, which runs plunge for a member on plunge). terraform's
// one root is the azure estate, so a change under ../azure names the azure
// component as a changed unit and brings dns into the change with it.
//
// The azure root is the azure member's, not dns's, so it is marked
// signalOnly (chant#4484): change detection still counts it, and chant
// neither builds it nor reads it live as dns's own. chant 0.124.52 and older
// predate the key, and their strict root schema refuses it, so the key is
// dropped below when the installed terraform lexicon's root schema does not
// take it. With that chant, dns draws the azure root as its own, as it did
// before the key existed. The key is written as a literal so chant's static
// config read, which never runs this file, sees it too.
const AZURE_ROOT: { dir: string; signalOnly?: boolean } = { dir: "../azure", signalOnly: true };
if (!terraformRootSchema.safeParse(AZURE_ROOT).success) delete AZURE_ROOT.signalOnly;

export default {
  lexicons: ["aws", "terraform", "pulumi"],
  sourceDir: "src",
  environments: [{ name: "local", endpoint: "http://localhost:4566" }],
  terraform: { binary: "choudoufu", roots: { azure: AZURE_ROOT } },
};
