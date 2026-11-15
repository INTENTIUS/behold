import { describe, expect, it } from "vitest";
import { cssVars, originOf, readInbound, readOptions, sameOriginSrc, selectMessage, themeName } from "./options.ts";

describe("the viewer's options (behold#1070)", () => {
  it("reads the query string, and the host global where the query says nothing", () => {
    expect(readOptions("?theme=light&node=prod/aws_vpc.main&focus=prod,platform&host=https://h.example:8443/x&transport=post&src=graph.json")).toEqual({
      theme: "light",
      node: "prod/aws_vpc.main",
      focus: ["prod", "platform"],
      host: "https://h.example:8443",
      transport: "post",
      src: "graph.json",
    });
    expect(readOptions("?theme=dark", { theme: "light", node: "a", transport: "vscode" })).toEqual({ theme: "dark", node: "a", transport: "vscode" });
    expect(readOptions("", { focus: ["a", " ", "b"] })).toEqual({ focus: ["a", "b"] });
  });

  it("drops what it does not know", () => {
    expect(readOptions("?theme=solarized&transport=sse&host=not-an-origin")).toEqual({});
    expect(readOptions("?host=javascript:alert(1)")).toEqual({});
    expect(themeName("GitHub Light Default")).toBe("light");
    expect(themeName("blueprint")).toBe("blueprint");
  });

  it("gives vscode-webview an origin of its own, where URL.origin says null", () => {
    expect(originOf("vscode-webview://1abc2def/index.html?x=1")).toBe("vscode-webview://1abc2def");
    expect(originOf("http://localhost:4600/")).toBe("http://localhost:4600");
    expect(originOf("file:///tmp/viewer.html")).toBeUndefined();
  });

  it("fetches ?src= only from the page's own http origin", () => {
    expect(sameOriginSrc("graph.json", "https://h.example/view/index.html")).toBe("https://h.example/view/graph.json");
    expect(sameOriginSrc("https://other.example/graph.json", "https://h.example/index.html")).toBeUndefined();
    expect(sameOriginSrc("//other.example/graph.json", "https://h.example/index.html")).toBeUndefined();
    expect(sameOriginSrc("graph.json", "file:///tmp/index.html")).toBeUndefined();
  });

  it("reads the three messages in, and ignores anything else", () => {
    expect(readInbound({ type: "behold:graph", document: { schema: "behold-graph/1" }, icons: { "aws/vpc": { body: "<path/>", viewBox: "0 0 1 1" }, bad: 3 } })).toEqual({
      type: "graph",
      document: { schema: "behold-graph/1" },
      icons: { "aws/vpc": { body: "<path/>", viewBox: "0 0 1 1" } },
    });
    expect(readInbound({ type: "behold:theme", theme: "light", vars: { "--pin-bg0": "#fff", "--x": "red; background: url(x)", color: "red" } })).toEqual({
      type: "theme",
      theme: "light",
      vars: { "--pin-bg0": "#fff" },
    });
    expect(readInbound({ type: "behold:view", node: "", focus: "a,b" })).toEqual({ type: "view", node: null, focus: ["a", "b"] });
    expect(readInbound({ type: "behold:graph" })).toBeNull();
    expect(readInbound({ type: "behold:select", id: "x" })).toBeNull();
    expect(readInbound("behold:graph")).toBeNull();
  });

  it("keeps a CSS value from ending its declaration", () => {
    expect(cssVars({ "--a": "1px", "--b": "}", "--c": "<x>", "--d": "a\\b" })).toEqual({ "--a": "1px" });
    expect(cssVars([])).toBeUndefined();
  });

  it("says what was picked as id, kind and file", () => {
    expect(selectMessage({ id: "prod/prod/aws_vpc.main", kind: "aws_vpc", file: "envs/prod/network.tf" })).toEqual({
      type: "behold:select",
      id: "prod/prod/aws_vpc.main",
      kind: "aws_vpc",
      file: "envs/prod/network.tf",
    });
    expect(selectMessage({ id: "stack:prod", kind: "stack" })).toEqual({ type: "behold:select", id: "stack:prod", kind: "stack", file: null });
  });
});
