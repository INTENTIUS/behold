/**
 * The page a graph panel loads. It names the viewer's script and stylesheet by
 * the webview URIs the host made for them, carries one nonce, and sets the
 * policy VS Code's webview guide starts from: nothing by default, scripts only
 * by nonce, styles and images from the extension's own files. `unsafe-inline`
 * is on styles alone, for the painted SVG's style attributes (the viewer's own
 * browser test runs under the same style rule, src/viewer/viewer-browser.test.ts).
 */
export interface PanelHtmlInput {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
}

const attr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function panelCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
  ].join("; ");
}

export function panelHtml(i: PanelHtmlInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${attr(panelCsp(i.cspSource, i.nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>behold</title>
<link rel="stylesheet" href="${attr(i.styleUri)}">
</head>
<body>
<main id="behold-viewer">
<p id="behold-status" role="status">Loading the viewer.</p>
<div id="behold-graph"></div>
</main>
<script nonce="${attr(i.nonce)}" src="${attr(i.scriptUri)}"></script>
</body>
</html>
`;
}

/** A nonce: 32 characters from the alphabet a CSP source list allows. */
export function makeNonce(random: (n: number) => Uint8Array): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(random(32), (b) => abc[b % abc.length]).join("");
}
