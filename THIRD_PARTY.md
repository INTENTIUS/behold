# Third-party bundled data

## Color themes (`web/themes.js`)

The full corpus of color schemes vendored in [`web/themes.js`](./web/themes.js) is generated
from **[iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)** (MIT) — the
collection bundled by the [Ghostty](https://ghostty.org) terminal — at a pinned commit (see the
header of `web/themes.js` for the exact revision and source URL).

The bundled license is retained verbatim at
[`licenses/iTerm2-Color-Schemes-LICENSE`](./licenses/iTerm2-Color-Schemes-LICENSE).

Individual theme families — **Catppuccin, Dracula, Nord, Gruvbox, Tokyo Night, Solarized,
Rosé Pine**, and many others — are the work of their respective authors and carry their own
licenses; iTerm2-Color-Schemes aggregates them with attribution. Nothing here is modified: the
palettes are used as published.

## Kubernetes resource icons (`web/icons/k8s/`)

The 30 SVGs in [`web/icons/k8s/`](./web/icons/k8s) are the unlabeled resource set from
**[kubernetes/community](https://github.com/kubernetes/community)**, taken from
`icons/svg/resources/unlabeled/` at pinned revision
[`920f1d89`](https://github.com/kubernetes/community/tree/920f1d89cb3d0a7ff0591ef9223864c552f9e589/icons/svg/resources/unlabeled).
The set is dual-licensed **Apache-2.0 OR CC-BY-4.0**; behold uses it under **Apache-2.0**.
The bundled license is retained verbatim at
[`licenses/kubernetes-icons-LICENSE`](./licenses/kubernetes-icons-LICENSE).

The Kubernetes logo and name are trademarks of The Linux Foundation, used here only to
identify Kubernetes resources. behold is not affiliated with, sponsored by, or endorsed by
the Kubernetes project or The Linux Foundation.

What is modified: lightly minified, otherwise as published. The XML prolog, comments and
Inkscape editor state (`<metadata>`, `<sodipodi:namedview>`) are dropped, inter-tag whitespace
is collapsed, and `id`/`class` names are namespaced per file so several icon bodies inlined
into one document cannot collide. No geometry is touched; every path is byte-identical to
upstream. [`scripts/vendor-icons.mjs`](./scripts/vendor-icons.mjs) re-fetches the corpus at
the pinned revision, and `--check` asserts the working tree still matches it.

At render time one further step happens to the copy in memory, never to the file on disk:
[`src/icon-packs.ts`](./src/icon-packs.ts) splices each body into the graph SVG without its
root `<svg>`, so the remaining `inkscape:`/`sodipodi:` attributes — which that root declared
the namespaces for — are dropped and `xlink:href` becomes the plain SVG 2 `href`. Editor
state only; nothing that paints.

## Flux, Argo and Helm project marks (`web/icons/cncf/`)

The three marks in [`web/icons/cncf/`](./web/icons/cncf) are the color icon variants from
**[cncf/artwork](https://github.com/cncf/artwork)** at pinned revision
[`bad6b7fd`](https://github.com/cncf/artwork/tree/bad6b7fd04344be33d79b4ad60d9ea83321d690c),
taken from `projects/flux/icon/color/`, `projects/argo/icon/color/` and
`projects/helm/icon/color/`.

cncf/artwork makes its artwork available under the **Linux Foundation trademark usage
guidelines**, retained verbatim at
[`licenses/cncf-artwork-LICENSE.md`](./licenses/cncf-artwork-LICENSE.md). behold's use is
nominative: each mark appears only on the graph node for a resource of that project, to say
which project the resource belongs to. Flux, Argo and Helm are trademarks of The Linux
Foundation, and their appearance here implies no affiliation with, sponsorship by, or
endorsement from those projects, the CNCF, or The Linux Foundation.

What is modified: the same light minification and per-file namespacing as the Kubernetes set,
described above. No geometry, no color and no proportion is altered, which is what the usage
guidelines require.

At render time the Helm mark alone is given a background, never the file on disk (#246). The
`icon/color` variants are drawn for a light ground, and the Helm one is the only mark in the
set that is line art on transparent rather than a filled badge — so at the 22px card slot it
would read against whatever the graph card happens to be, which on a dark theme is near-black.
[`src/icon-packs.ts`](./src/icon-packs.ts) therefore paints an opaque white square behind it
and scales the mark uniformly to sit inside, with clear space on all four sides. The mark's
geometry, its color and its proportions are untouched; it is placed on the ground it was
drawn for.

See [`CREDITS.md`](./CREDITS.md) for prior-art acknowledgements, including the theme engine this
one is adopted from.

## Forge and tool marks (`web/forge-mark.js`, `web/tool-mark.js`)

Each wave box of the Components view, and each job row of the kiosk's runs pane, names the
forge that runs the pipeline and the tools the job runs, as text, with the owner's own mark
beside the name where the owner's published rules allow that use (behold#571). Each mark is
inline SVG geometry in the module, or a PNG under `web/vendors/`; nothing is fetched. The
module comments quote the rule each decision rests on.

- **Forgejo**: the official logo by Caesar Schinas, **CC BY-SA 4.0**, from
  [codeberg.org/forgejo/meta](https://codeberg.org/forgejo/meta/src/branch/readme/branding)
  (`logo/forgejo.svg`), geometry and colours as published. The same licence applies to this
  copy.
- **GitHub**: Octicons `mark-github` (16px), **MIT**, from
  [primer/octicons](https://github.com/primer/octicons/blob/ea8e6bb79894cc7e85564ee9b53d86b418738d04/icons/mark-github-16.svg),
  filled in the text colour. The licence is retained at
  [`licenses/octicons-LICENSE`](./licenses/octicons-LICENSE).
- **GitLab**: the tanuki behold has drawn since #58.
- **Terragrunt**: Gruntwork's logomark,
  [gruntwork.io](https://gruntwork.io/_assets/media/gruntwork-logomark-white.svg), filled in
  the text colour, per Gruntwork's [Website Terms](https://gruntwork.io/legal/website-terms).
- **CDK Terrain**: the mark [cdktn.io](https://cdktn.io/favicon.svg) publishes.
- **Atmos**: Cloud Posse's mark, from
  [cloudposse/atmos](https://github.com/cloudposse/atmos/blob/ee2aa74cfef0a677422d556ef5b54f59416f29cf/website/static/img/slides/atmos-intro/cloudposse-logo.svg),
  in Cloud Posse's own white and dark colours.
- **OpenTofu**: the colour icon from
  [cncf/artwork](https://github.com/cncf/artwork/blob/bd7f51052b704482f03f7dcb40b09a02b2cc9e7f/projects/opentofu/icon/color/opentofu-icon-color.svg),
  under the Linux Foundation trademark usage guidelines, as the Flux, Argo and Helm marks above.
- **Terraform**: the name alone. HashiCorp's
  [trademark policy](https://www.hashicorp.com/trademark-policy) asks for written approval of
  this use of its logos.
- **chant**, **choudoufu** and **SQL Yodeler**: Intentius's own marks.

Each name and mark belongs to its owner and is used only to say which forge runs a pipeline
or which tool a job runs. Its appearance here implies no affiliation with, sponsorship by, or
endorsement from its owner.
