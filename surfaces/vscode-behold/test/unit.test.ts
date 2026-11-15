import { describe, expect, it, vi } from "vitest";
import { fileTarget, readSelect } from "../src/file-target.ts";
import { makeNonce, panelCsp, panelHtml } from "../src/panel-html.ts";
import { affectsGraph, Refresher } from "../src/refresh.ts";
import { themeMessage, themeNameFor, VSCODE_VARS } from "../src/theme.ts";

describe("theme", () => {
  it("maps VS Code's four colour theme kinds to the viewer's two palettes", () => {
    expect([1, 2, 3, 4].map(themeNameFor)).toEqual(["light", "dark", "dark", "light"]);
  });
  it("sends variables the viewer accepts (a --pin token, no declaration-ending characters)", async () => {
    const { cssVars } = await import("../../../src/viewer/options.ts");
    const m = themeMessage(2);
    expect(m.type).toBe("behold:theme");
    expect(cssVars(m.vars)).toEqual(VSCODE_VARS);
  });
});

describe("panel html", () => {
  const html = panelHtml({ cspSource: "https://x.vscode-cdn.net", nonce: "abc123", scriptUri: "https://x.vscode-cdn.net/viewer.js", styleUri: "https://x.vscode-cdn.net/viewer.css" });
  it("allows scripts by nonce only and starts from default-src none", () => {
    const csp = panelCsp("https://x.vscode-cdn.net", "abc123");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc123'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).not.toMatch(/connect-src/);
  });
  it("carries the policy, one script with the nonce, and no inline script", () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect([...html.matchAll(/<script/g)]).toHaveLength(1);
    expect(html).toContain('<script nonce="abc123" src="https://x.vscode-cdn.net/viewer.js"></script>');
    expect(html).toContain('id="behold-graph"');
  });
  it("escapes what it is given in an attribute", () => {
    const bad = panelHtml({ cspSource: "x", nonce: 'n"><script>', scriptUri: 'a"b', styleUri: "c" });
    expect(bad).not.toContain('"><script>');
    expect(bad).toContain("&quot;");
  });
  it("makes a nonce of 32 allowed characters", () => {
    const n = makeNonce((len) => Uint8Array.from({ length: len }, (_, i) => i * 7));
    expect(n).toMatch(/^[A-Za-z0-9]{32}$/);
  });
});

describe("file target", () => {
  const nodes = [{ id: "a", file: "infra/main.tf", line: 12 }, { id: "b", file: "infra/b.tf" }];
  it("reads a select message and nothing else", () => {
    expect(readSelect({ type: "behold:select", id: "a", file: "x.tf" })).toEqual({ id: "a", file: "x.tf" });
    expect(readSelect({ type: "behold:select", id: "a", file: null })).toEqual({ id: "a", file: null });
    expect(readSelect({ type: "behold:ready" })).toBeNull();
    expect(readSelect("behold:select")).toBeNull();
  });
  it("resolves a repository-relative file against the repository root, with the document's line", () => {
    expect(fileTarget({ id: "a", file: "infra/main.tf" }, "/repo", nodes)).toEqual({ path: "/repo/infra/main.tf", line: 12 });
    expect(fileTarget({ id: "b", file: "infra/b.tf" }, "/repo", nodes)).toEqual({ path: "/repo/infra/b.tf" });
  });
  it("opens nothing for a box (no file) or a path that leaves the repository", () => {
    expect(fileTarget({ id: "stack:x", file: null }, "/repo", nodes)).toBeUndefined();
    for (const file of ["../secret", "infra/../../secret", "/etc/hosts", "..", ".", "a\0b"]) {
      expect(fileTarget({ id: "a", file }, "/repo", nodes), file).toBeUndefined();
    }
  });
  it("does not take a line from a node with another file", () => {
    expect(fileTarget({ id: "a", file: "other.tf" }, "/repo", nodes)).toEqual({ path: "/repo/other.tf" });
  });
});

describe("affectsGraph", () => {
  it("is true for source under the folder and false for the rest", () => {
    expect(affectsGraph("/w/infra/main.tf", "/w")).toBe(true);
    expect(affectsGraph("/w/chant.workspace.json", "/w")).toBe(true);
    expect(affectsGraph("/w/.terraform.lock.hcl", "/w")).toBe(true);
    expect(affectsGraph("/w/README.md", "/w")).toBe(false);
    expect(affectsGraph("/w/node_modules/x/index.ts", "/w")).toBe(false);
    expect(affectsGraph("/w/.terraform/modules/a.tf", "/w")).toBe(false);
    expect(affectsGraph("/other/main.tf", "/w")).toBe(false);
    expect(affectsGraph("/wx/main.tf", "/w")).toBe(false);
  });
});

describe("Refresher", () => {
  it("reads once for a burst of saves, and once more for a save during a read", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const reads: number[] = [];
    const r = new Refresher(
      () =>
        new Promise<void>((done) => {
          reads.push(reads.length + 1);
          release = done;
        }),
      100,
    );
    r.request();
    r.request();
    r.request();
    await vi.advanceTimersByTimeAsync(150);
    expect(reads).toEqual([1]);
    r.request(); // saved while the first read runs
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(reads).toEqual([1, 2]);
    release();
    await vi.advanceTimersByTimeAsync(500);
    expect(reads).toEqual([1, 2]);
    r.dispose();
    vi.useRealTimers();
  });
});
