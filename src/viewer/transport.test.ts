import { describe, expect, it } from "vitest";
import type { Inbound } from "./options.ts";
import { MCP_APPS_PROTOCOL, openTransport, pickTransport, type MessageEventLike, type WindowLike } from "./transport.ts";

/** A window stand-in: a parent that records what it is sent, and a way to deliver a message event. */
function stage(over: Partial<WindowLike> = {}, href = "https://viewer.example/index.html") {
  const sent: Array<{ message: unknown; origin: string }> = [];
  const parent = { postMessage: (message: unknown, origin: string) => sent.push({ message, origin }) };
  let listener: ((e: MessageEventLike) => void) | undefined;
  const win: WindowLike = {
    parent,
    location: { href },
    addEventListener: (_type, fn) => {
      listener = fn;
    },
    ...over,
  };
  const deliver = (data: unknown, origin: string, source: unknown = parent) => listener?.({ data, origin, source });
  return { win, parent, sent, deliver };
}

const DOC = { schema: "behold-graph/1", nodes: [], edges: [], groups: [], notes: [] };

describe("the viewer's transports (behold#1070)", () => {
  it("picks VS Code's API, then a named host, then MCP Apps when framed, else none", () => {
    expect(pickTransport(stage({ acquireVsCodeApi: () => ({ postMessage() {} }) }).win, {})).toBe("vscode");
    expect(pickTransport(stage().win, { host: "https://h.example" })).toBe("post");
    expect(pickTransport(stage().win, {})).toBe("mcp");
    const top = stage().win;
    top.parent = top;
    expect(pickTransport(top, {})).toBe("none");
    expect(pickTransport(stage().win, { transport: "none" })).toBe("none");
  });

  it("post: reads only the host's messages from the parent, and sends only to the host", () => {
    const s = stage();
    const got: Inbound[] = [];
    const t = openTransport(s.win, { host: "https://h.example" }, (m) => got.push(m));
    s.deliver({ type: "behold:graph", document: DOC }, "https://evil.example");
    s.deliver({ type: "behold:graph", document: DOC }, "https://h.example", {});
    s.deliver({ type: "behold:graph", document: DOC }, "https://h.example");
    expect(got).toEqual([{ type: "graph", document: DOC }]);
    t.send({ type: "behold:select", id: "a", kind: "aws_vpc", file: null });
    expect(s.sent).toEqual([{ message: { type: "behold:select", id: "a", kind: "aws_vpc", file: null }, origin: "https://h.example" }]);
  });

  it("vscode: acquires the API once, sends through it, and reads the webview's own messages", () => {
    let acquired = 0;
    const out: unknown[] = [];
    const s = stage(
      {
        acquireVsCodeApi: () => {
          acquired++;
          return { postMessage: (m: unknown) => out.push(m) };
        },
      },
      "vscode-webview://1abc/index.html?id=x",
    );
    const got: Inbound[] = [];
    const t = openTransport(s.win, {}, (m) => got.push(m));
    expect(t.name).toBe("vscode");
    s.deliver({ type: "behold:theme", theme: "light" }, "vscode-webview://1abc");
    s.deliver({ type: "behold:theme", theme: "dark" }, "https://evil.example");
    expect(got).toEqual([{ type: "theme", theme: "light" }]);
    t.send({ type: "behold:ready" });
    expect(out).toEqual([{ type: "behold:ready" }]);
    expect(acquired).toBe(1);
  });

  it("mcp: initializes, takes the theme and the tool result, and sends a pick as model context", () => {
    const s = stage();
    const got: Inbound[] = [];
    const t = openTransport(s.win, {}, (m) => got.push(m), "0.31.0");
    expect(t.name).toBe("mcp");
    const init = s.sent[0]!.message as { id: number; method: string; params: { protocolVersion: string; appInfo: unknown } };
    expect(init).toMatchObject({ jsonrpc: "2.0", method: "ui/initialize", params: { protocolVersion: MCP_APPS_PROTOCOL, appInfo: { name: "behold-viewer", version: "0.31.0" } } });

    s.deliver({ jsonrpc: "2.0", id: init.id, result: { hostContext: { theme: "light", styles: { variables: { "--color-background-primary": "#fff" } } } } }, "null");
    expect(s.sent[1]!.message).toEqual({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    s.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [], structuredContent: { document: DOC } } }, "null");
    // From anywhere but the parent window, nothing is read.
    s.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: DOC } }, "null", {});
    s.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark" } }, "null");
    expect(got).toEqual([
      { type: "theme", theme: "light", vars: { "--color-background-primary": "#fff" } },
      { type: "graph", document: DOC },
      { type: "theme", theme: "dark" },
    ]);

    t.send({ type: "behold:select", id: "prod/prod/aws_vpc.main", kind: "aws_vpc", file: "envs/prod/network.tf" });
    expect(s.sent[2]!.message).toMatchObject({
      jsonrpc: "2.0",
      method: "ui/update-model-context",
      params: { structuredContent: { selected: { id: "prod/prod/aws_vpc.main", kind: "aws_vpc", file: "envs/prod/network.tf" } } },
    });
    s.deliver({ jsonrpc: "2.0", id: 99, method: "ui/resource-teardown", params: {} }, "null");
    expect(s.sent[3]!.message).toEqual({ jsonrpc: "2.0", id: 99, result: {} });
  });
});
