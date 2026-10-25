// terraform and pulumi are listed for the azure and aws components'
// member-outputs steps: the terraform lexicon is what reads a choudoufu
// member's outputs, and the pulumi lexicon a Pulumi member's (chant#4455,
// pulumiOutputSource, which runs plunge for a member on plunge). terraform's
// one root is the azure estate, so a change under ../azure names the azure
// component as a changed unit and brings dns into the change with it.
export default {
  lexicons: ["aws", "terraform", "pulumi"],
  sourceDir: "src",
  environments: [{ name: "local", endpoint: "http://localhost:4566" }],
  terraform: { binary: "choudoufu", roots: { azure: { dir: "../azure" } } },
};
