# UI smoke (#199)

`web/` has no unit tests — every `*.test.ts` is server-side. This directory is
the regression net for the SPA: a stub backend (`stub.mjs`) that serves `web/`
verbatim plus canned JSON for every read endpoint, and a headless-Chrome
driver (`ui-smoke.mjs`) that boots the real SPA against it and walks the whole
panel surface — every tab, drag-snap to a corner, collapse/expand, the ⌘K
palette, a Ghostty theme flip.

```sh
npm run smoke:ui
```

No chant, no Docker, no estate. Failures exit 1 and name the check;
screenshots land in `smoke/shots/` (gitignored) for eyeballing.

Browser resolution: the OS Chrome first (`channel: "chrome"` — preinstalled on
the GitHub ubuntu runners and most dev machines), falling back to playwright's
own chromium if you've run `npx playwright install chromium`.

When you change `web/`, run this. When you add UI surface, add a check — the
stub's canned shapes (a pinhole-shaped SVG with `g[data-node-id]` groups and
`var(--pin-*)` fills; `/api/project` with envs/tiers/targets/recents) are the
place to extend fixtures.
