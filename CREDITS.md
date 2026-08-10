# Credits & acknowledgements

Bundled third-party data and any assets that carry their own license are listed in
[`THIRD_PARTY.md`](./THIRD_PARTY.md).

## Color themes & theme engine

behold's theming (issue #62) is adopted from **spicypath**'s theme engine (`src/theme.js`,
FG-040): the color math, OKLCH perceptual model, luminance-based text contrast, and the
"derive semantic UI tokens from a 16-color terminal palette" approach are the same shape.

The color-scheme corpus itself is vendored from
**[iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)** (MIT), the
collection bundled by the **[Ghostty](https://ghostty.org)** terminal. Theme families
(Catppuccin, Dracula, Nord, Gruvbox, Tokyo Night, and others) are the work of their respective
authors and carry their own licenses; the attribution model and bundled license are detailed
in [`THIRD_PARTY.md`](./THIRD_PARTY.md).

## Lexicon icons

The resource icons behold paints on k8s nodes (issue #227) are the official set from the
**[Kubernetes community](https://github.com/kubernetes/community/tree/master/icons)** repo,
used under Apache-2.0. The Flux, Argo and Helm marks are each project's own artwork from
**[cncf/artwork](https://github.com/cncf/artwork)**, used nominatively to identify that
project's resources. Both are vendored at pinned revisions with their licenses retained
verbatim under [`licenses/`](./licenses); see [`THIRD_PARTY.md`](./THIRD_PARTY.md) for the
revisions, the trademark notices, and exactly what the vendoring changes.
