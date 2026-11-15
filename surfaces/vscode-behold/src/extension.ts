/**
 * behold in VS Code: one command, "behold: Show infrastructure graph", that
 * draws the workspace folder from its files in a panel beside the editor.
 *
 * The read runs here, in the extension host: `@intentius/behold-graph`
 * bundled into dist/extension.js, with the part of chant that reads a
 * Terraform folder staged in dist/node_modules (scripts/stage-chant.mjs). That chant
 * runs as this host's own binary acting as Node (BEHOLD_CHANT_BIN,
 * src/chant.ts), so the machine needs no `node`, no `npx` and no network. The
 * viewer (dist/viewer, built from src/viewer/) draws in the webview from the
 * `behold:graph` message this posts; it opens no connection of its own.
 */
import { randomFillSync } from "node:crypto";
import { join } from "node:path";
import * as vscode from "vscode";
import { fileTarget, readSelect } from "./file-target.ts";
import { makeNonce, panelHtml } from "./panel-html.ts";
import { readFolder, type FolderRead } from "./read.ts";
import { affectsGraph, Refresher } from "./refresh.ts";
import { ReadGraphError } from "./behold.ts";
import { themeMessage } from "./theme.ts";

const COMMAND = "behold.showGraph";

class GraphPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly refresher: Refresher;
  private readonly subscriptions: vscode.Disposable[] = [];
  private ready = false;
  private latest: FolderRead | undefined;
  private warned = false;
  /** What the viewer last reported, for the extension's tests (a webview's page is not readable from the host). */
  readonly seen = { ready: false, drawnCards: undefined as number | undefined, draws: 0, refused: undefined as string | undefined, posted: 0, error: undefined as string | undefined };

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly dir: string,
    private readonly onDispose: () => void,
  ) {
    const viewer = vscode.Uri.file(join(context.extensionPath, "dist", "viewer"));
    this.panel = vscode.window.createWebviewPanel("behold.graph", `behold: ${vscode.workspace.asRelativePath(dir, true)}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [viewer],
    });
    const web = this.panel.webview;
    web.html = panelHtml({
      cspSource: web.cspSource,
      nonce: makeNonce((n) => randomFillSync(new Uint8Array(n))),
      scriptUri: web.asWebviewUri(vscode.Uri.joinPath(viewer, "viewer.js")).toString(),
      styleUri: web.asWebviewUri(vscode.Uri.joinPath(viewer, "viewer.css")).toString(),
    });
    this.refresher = new Refresher(() => this.read());
    this.subscriptions.push(
      web.onDidReceiveMessage((m: unknown) => this.onMessage(m)),
      vscode.window.onDidChangeActiveColorTheme((t) => this.ready && void web.postMessage(themeMessage(t.kind))),
      vscode.workspace.onDidSaveTextDocument((d) => affectsGraph(d.uri.fsPath, this.dir) && this.refresher.request()),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  /** Bring an open panel forward and draw the folder again. */
  reveal(): void {
    this.panel.reveal(undefined, true);
    this.refresher.request();
  }

  /** A message as if the viewer had sent it. The extension's own tests use it to click a card. */
  receive(m: unknown): void {
    this.onMessage(m);
  }

  private onMessage(m: unknown): void {
    const type = m && typeof m === "object" ? (m as { type?: unknown }).type : undefined;
    if (type === "behold:drawn") {
      this.seen.draws++;
      this.seen.drawnCards = Number((m as { cards?: unknown }).cards);
      this.seen.refused = undefined;
      return;
    }
    if (type === "behold:refused") {
      this.seen.refused = String((m as { error?: unknown }).error);
      void vscode.window.showErrorMessage(`behold: the viewer refused the document: ${this.seen.refused}`);
      return;
    }
    if (type === "behold:ready") {
      this.ready = true;
      this.seen.ready = true;
      void this.panel.webview.postMessage(themeMessage(vscode.window.activeColorTheme.kind));
      if (this.latest) this.post(this.latest);
      else void this.refresher.now();
      return;
    }
    const select = readSelect(m);
    if (!select || !this.latest) return;
    const target = fileTarget(select, this.latest.repoRoot, this.latest.document.nodes);
    if (!target) return;
    const line = target.line ? target.line - 1 : 0;
    void vscode.window.showTextDocument(vscode.Uri.file(target.path), {
      viewColumn: vscode.ViewColumn.One,
      selection: new vscode.Range(line, 0, line, 0),
    });
  }

  private post(read: FolderRead): void {
    this.seen.posted++;
    void this.panel.webview.postMessage({ type: "behold:graph", document: read.document, icons: read.icons });
  }

  private async read(): Promise<void> {
    try {
      const read = await readFolder(this.dir, String(this.context.extension.packageJSON.version));
      this.latest = read;
      this.seen.error = undefined;
      if (this.ready) this.post(read);
      if (read.document.nodes.length === 0 && !this.warned) {
        this.warned = true;
        const note = read.document.notes.map((n) => n.text).join(" ");
        void vscode.window.showInformationMessage(
          `behold found nothing to draw in ${this.dir}. A Terraform root is a folder with a terraform, provider or backend block.${note ? ` ${note}` : ""}`,
        );
      } else if (read.document.nodes.length > 0) this.warned = false;
    } catch (err) {
      const text = err instanceof ReadGraphError ? `${err.refusal.error} ${err.refusal.remedy}` : err instanceof Error ? err.message : String(err);
      this.seen.error = text;
      void vscode.window.showErrorMessage(`behold could not read ${this.dir}: ${text}`);
    }
  }

  dispose(): void {
    this.refresher.dispose();
    for (const s of this.subscriptions.splice(0)) s.dispose();
    this.panel.dispose();
    this.onDispose();
  }
}

async function pickFolder(arg: unknown): Promise<string | undefined> {
  if (arg instanceof vscode.Uri) return arg.fsPath;
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage("behold draws a folder: open one first.");
    return undefined;
  }
  if (folders.length === 1) return folders[0]!.uri.fsPath;
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath })),
    { placeHolder: "Which folder should behold draw?" },
  );
  return pick?.description;
}

/** What `activate` returns: a read-only view for the extension's own tests. */
export interface BeholdApi {
  panels(): Array<{ dir: string; ready: boolean; drawnCards: number | undefined; draws: number; posted: number; refused: string | undefined; error: string | undefined }>;
  /** Deliver `message` to the panel for `dir` as if its viewer had sent it. */
  receive(dir: string, message: unknown): void;
}

export function activate(context: vscode.ExtensionContext): BeholdApi {
  // The staged chant, run by this host's own binary (see the header).
  process.env.BEHOLD_CHANT_BIN = join(context.extensionPath, "dist", "node_modules", "@intentius", "chant", "dist", "cli", "main.js");
  const panels = new Map<string, GraphPanel>();
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND, async (arg?: unknown) => {
      const dir = await pickFolder(arg);
      if (!dir) return;
      const open = panels.get(dir);
      if (open) return open.reveal();
      const panel = new GraphPanel(context, dir, () => panels.delete(dir));
      panels.set(dir, panel); // its first read starts when the viewer says it is ready
    }),
    { dispose: () => [...panels.values()].forEach((p) => p.dispose()) },
  );

  // A status bar entry where the workspace holds Terraform; the activation event is the same test.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  item.text = "$(type-hierarchy) behold";
  item.tooltip = "Show the infrastructure graph";
  item.command = COMMAND;
  void vscode.workspace.findFiles("**/*.tf", "**/{node_modules,.terraform}/**", 1).then((found) => found.length > 0 && item.show());
  context.subscriptions.push(item);
  return {
    panels: () => [...panels.values()].map((p) => ({ dir: p.dir, ...p.seen, ready: p.seen.ready })),
    receive: (dir, message) => panels.get(dir)?.receive(message),
  };
}

export function deactivate(): void {}
