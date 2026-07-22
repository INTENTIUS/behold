// Synthetic two-stack chant project (#76 fixture). `stacks[]` declares two
// independently-deployed CloudFormation stacks, each pointing at its own
// source tree — the `{ name, src }[]` shape `src/project.ts`'s `readStacks`
// expects. Backs the stack-picker resolution tests in src/chant.test.ts
// (`graphPath`), src/project.test.ts (`detectProject`), and src/server.test.ts
// (`/api/project`'s `stacks` field).
//
// Deliberately tiny: no `@intentius/chant` lexicons wired up, no `ChantConfig`
// type import, and each stack's source tree (below) is just a placeholder
// file — this fixture backs graph *resolution* (which source tree a picked
// stack points at), not a real `chant graph`/`chant lint` build. It does not
// need `npm install` to be usable by those tests.
export default {
  lexicons: ["aws"],
  stacks: [
    { name: "api", src: "stacks/api" },
    { name: "web", src: "stacks/web" },
  ],
};
