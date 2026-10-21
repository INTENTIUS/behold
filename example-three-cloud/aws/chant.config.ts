// The aws member's stack is named for the workspace, so it doesn't share the
// stack named after the environment ("local") with the dns member.
export default {
  lexicons: ["aws"],
  sourceDir: "src",
  environments: ["local"],
  stacks: [{ name: "three-cloud-aws", src: "src" }],
};
