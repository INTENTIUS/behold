# @intentius/behold-graph

Read a directory of infrastructure files into behold's graph and print it,
with no server and no browser. It is the `behold graph` command of
[`@intentius/behold`](https://www.npmjs.com/package/@intentius/behold), in a
package without behold's server, MCP and Kubernetes dependencies, for a CI
job, an editor extension or an agent tool.

```sh
npx @intentius/behold-graph ./infra --json | jq '.nodes | length'
npx @intentius/behold-graph ./infra --ir -o graph.json --detail 3
```

- `--json` (the default) prints the `behold-graph/1` document, whose schema is
  published at https://intentius.io/behold/schemas/graph/v1/graph.schema.json.
- `--ir` prints the unversioned `{ir, meta}` snapshot behold's `/api/graph`
  answers, without its SVG.
- `-o <file>` writes the file instead of stdout. `--detail 0..3` picks the
  zoom. `--source` keeps each card's source text, which is left out by
  default. `--every-card` turns off the stacking of alike cards.

A directory is a folder of `.tf` files, a chant workspace root, a choudoufu
estate or a chant project. No output holds an absolute path, and a root that
does not parse is one card naming the file and line.

As a library:

```js
import { graphView, graphDocument, documentOptions } from "@intentius/behold-graph";

const view = await graphView("./infra", { detail: 2 });
const document = documentOptions({ projectDir: "./infra", workspace: view.read.workspace, behold: "0.31.0" });
const doc = graphDocument({ view, document, source: false });
```

`readGraph(dir, opts)` is the read without the lenses, and `toDocument` turns
any `{ir, meta}` into the document.

## Budget

The install is checked in behold's CI by installing the packed tarball into an
empty directory (`npm run check:graph-package` in the behold repository). It
fails above the size and package count in `packages/graph/budget.json`, on a dependency that
is not on its allowlist, or when the tree holds `hono`, `@hono/node-server`,
`@modelcontextprotocol/sdk` or `@kubernetes/client-node`. The first
measurement was 127 MB in 55 packages. Most of that is chant (73 MB) and the
TypeScript compiler chant loads project configs with (23 MB).
