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
