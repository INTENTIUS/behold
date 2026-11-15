// Runs inside VS Code's extension host (scripts/test-vscode.mjs). Plain
// assert and a small runner: no test framework is loaded into the host.
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const vscode = require("vscode");

const workspace = process.env.BEHOLD_TEST_WORKSPACE;

async function until(what, fn, ms = 90_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let api;
const panel = () => api.panels().find((p) => p.dir === workspace);

test("no node is on PATH", () => {
  const r = spawnSync("node", ["--version"]);
  assert.ok(r.error && r.error.code === "ENOENT", `node must not resolve from PATH (${process.env.PATH})`);
  const npx = spawnSync("npx", ["--version"]);
  assert.ok(npx.error && npx.error.code === "ENOENT", "npx must not resolve from PATH");
});

test("the command draws a folder of .tf files", async () => {
  const ext = vscode.extensions.getExtension("intentius.behold");
  assert.ok(ext, "the extension under development is installed");
  api = await ext.activate();
  await vscode.commands.executeCommand("behold.showGraph", vscode.Uri.file(workspace));
  await until("the viewer to report ready", () => panel()?.ready);
  const p = await until("the first draw", () => {
    if (panel()?.error) throw new Error(`the read failed: ${panel().error}`);
    return panel()?.draws ? panel() : undefined;
  });
  // 2 resources, and the stack box the painter counts with them
  assert.ok(p.drawnCards >= 2, `drawn cards: ${p.drawnCards}`);
  assert.strictEqual(p.refused, undefined);
});

test("saving a file that adds a resource adds its card", async () => {
  const before = panel().drawnCards;
  const file = join(workspace, "main.tf");
  const doc = await vscode.workspace.openTextDocument(file);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, new vscode.Position(doc.lineCount, 0), '\nresource "aws_sns_topic" "alerts" {\n  name = "alerts"\n}\n');
  assert.ok(await vscode.workspace.applyEdit(edit));
  assert.ok(await doc.save(), "the document saves");
  await until("a redraw with one more card", () => panel().drawnCards === before + 1);
});

test("a card's file opens, at its line; a path outside the folder opens nothing", async () => {
  // main.tf is open from the last test; park its cursor on line 1 so a move shows the click's effect.
  const file = join(workspace, "main.tf");
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  const openBefore = vscode.window.visibleTextEditors.length;
  api.receive(workspace, { type: "behold:select", id: "x", kind: "aws_s3_bucket", file: "../../etc/hosts" });
  api.receive(workspace, { type: "behold:select", id: "x", kind: "aws_s3_bucket", file: "/etc/hosts" });
  await new Promise((r) => setTimeout(r, 1000));
  assert.strictEqual(vscode.window.visibleTextEditors.length, openBefore, "a path outside the folder opens nothing");
  assert.strictEqual(vscode.window.activeTextEditor.selection.active.line, 0);
  api.receive(workspace, { type: "behold:select", id: "tf-folder/tf-folder/aws_s3_bucket.logs", kind: "aws_s3_bucket", file: "main.tf" });
  await until("the cursor to move to the card's line", () => vscode.window.activeTextEditor?.selection.active.line === 8);
  assert.ok(vscode.window.activeTextEditor.document.uri.fsPath.endsWith("main.tf"));
});

exports.run = async function run() {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n${err && err.stack ? err.stack : err}`);
    }
  }
  if (failed) throw new Error(`${failed} of ${tests.length} failed`);
};
