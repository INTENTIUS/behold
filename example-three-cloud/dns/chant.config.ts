// terraform is listed for the azure component's member-outputs step: the
// terraform lexicon is what reads a choudoufu member's outputs (chant#4455).
// Its one root is the azure estate, so a change under ../azure names the
// azure component as a changed unit and brings dns into the change with it.
export default {
  lexicons: ["aws", "terraform"],
  sourceDir: "src",
  environments: [{ name: "local", endpoint: "http://localhost:4566" }],
  terraform: { binary: "choudoufu", roots: { azure: { dir: "../azure" } } },
};
