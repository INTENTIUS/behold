/**
 * How a vendored icon file becomes the geometry a card paints (#227): its
 * viewBox and its inner markup. src/generate-icons.ts runs this over every file
 * under `web/icons` and writes the result into src/icons.generated.ts, so the
 * painter reads no file at load and bundles for a browser (#1069).
 */

/** One vendored icon: the inner markup of its root `<svg>`, and that root's viewBox. */
export interface VendoredIcon {
  body: string;
  viewBox: string;
}

/**
 * Drop the namespace prefixes the body can no longer resolve. A vendored file
 * declares `xmlns:inkscape`/`xmlns:sodipodi`/`xmlns:xlink` on its root `<svg>`,
 * and that root is exactly what {@link splitVendoredSvg} throws away, so every
 * surviving `inkscape:*` attribute becomes an unbound prefix in the document
 * pinhole splices the body into, and the whole SVG stops being well-formed XML.
 * The browser's HTML parser shrugs; an `image/svg+xml` consumer (a downloaded
 * `↓ SVG` export, a snapshot opened directly) does not.
 *
 * `inkscape:*`/`sodipodi:*` are editor state (Inkscape's own parametrics live
 * alongside the real `d`), so dropping them is lossless. `xlink:href` is a live
 * reference (the Argo mark's `<use>`), rewritten to the plain SVG 2 `href`
 * every current browser resolves.
 */
export function unprefix(body: string): string {
  return body
    .replace(/\s(?:inkscape|sodipodi):[\w-]+\s*=\s*(["'])[\s\S]*?\1/g, "")
    .replace(/\sxlink:href\s*=/g, " href=");
}

/** Split a vendored SVG file into its viewBox and its inner markup. `rel` names it in errors. */
export function splitVendoredSvg(raw: string, rel: string): VendoredIcon {
  const open = raw.indexOf("<svg");
  const openEnd = raw.indexOf(">", open);
  const close = raw.lastIndexOf("</svg");
  if (open < 0 || openEnd < 0 || close < 0) throw new Error(`malformed vendored icon: ${rel}.svg`);

  const viewBox = /\bviewBox\s*=\s*(["'])(.*?)\1/.exec(raw.slice(open, openEnd))?.[2];
  if (!viewBox) throw new Error(`vendored icon has no viewBox: ${rel}.svg`);

  return { body: unprefix(raw.slice(openEnd + 1, close).trim()), viewBox };
}
