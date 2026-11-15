/**
 * VS Code's colours as a `behold:theme` message (src/viewer/options.ts). The
 * viewer's painter has a light and a dark palette; the extension picks the one
 * the editor's colour theme is closest to and points the page, background,
 * text and selection at the editor's own colour variables, which a webview
 * defines on its root. A custom colour theme therefore reaches the graph's
 * page and text, and the cards keep the painter's palette.
 */

/** `vscode.ColorThemeKind`: Light 1, Dark 2, HighContrast 3, HighContrastLight 4. */
export function themeNameFor(kind: number): "light" | "dark" {
  return kind === 1 || kind === 4 ? "light" : "dark";
}

/** The viewer's `--pin-*` tokens, each set to a VS Code colour variable (the webview resolves them). */
export const VSCODE_VARS: Readonly<Record<string, string>> = {
  "--pin-bg0": "var(--vscode-editor-background)",
  "--pin-bg1": "var(--vscode-sideBar-background, var(--vscode-editor-background))",
  "--pin-text": "var(--vscode-editor-foreground)",
  "--pin-textMuted": "var(--vscode-descriptionForeground, var(--vscode-editor-foreground))",
  "--pin-selectedStroke": "var(--vscode-focusBorder, var(--vscode-editorCursor-foreground))",
};

export function themeMessage(kind: number): { type: "behold:theme"; theme: "light" | "dark"; vars: Record<string, string> } {
  return { type: "behold:theme", theme: themeNameFor(kind), vars: { ...VSCODE_VARS } };
}
