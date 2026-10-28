// behold#1035: the Templates tab. The pure half is tested as data; the form is
// drawn into a small stand-in document (no DOM library in this repo), enough
// to read each control's tag and type, type into it and press Submit.
import { describe, expect, it } from "vitest";
import { canSubmit, fieldControl, formInputs, renderTemplates, requestWords, REQUESTED_WORDS, rowFacts, startTemplates } from "./templates.js";

class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.textContent = "";
    this.className = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
  }
  appendChild(n) {
    this.children.push(n);
    return n;
  }
  replaceChildren(...n) {
    this.children = n;
  }
  addEventListener(type, f) {
    (this.listeners[type] ||= []).push(f);
  }
  fire(type) {
    for (const f of this.listeners[type] || []) f({ preventDefault() {} });
  }
  /** Every node below this one, depth first. */
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  text() {
    return [this.textContent, ...this.children.map((c) => c.text())].join("");
  }
}
const doc = { createElement: (tag) => new Node(tag) };

const row = {
  template: "acme/bucket/aws",
  kind: "app",
  description: "A private bucket for one app's data",
  latest: "1.2.0",
  versions: [{ version: "1.2.0", attestation: "signed" }],
  fields: [
    { name: "bucket_name", kind: "string", label: "Bucket name", required: true },
    { name: "retention_days", kind: "number", label: "Days to keep objects", default: 30, required: false },
    { name: "versioned", kind: "bool", label: "Keep old versions", default: false, required: false },
    { name: "kms_key", kind: "string", label: "KMS key", required: false, sensitive: true },
  ],
};
const answer = { schema: 1, command: "templates", exit: 0, status: "ok", results: [row] };

const inputs = (host) => host.all().filter((n) => n.tagName === "INPUT" || n.tagName === "TEXTAREA");
const submitOf = (host) => host.all().find((n) => n.className === "tp-submit");
const formOf = (host) => host.all().find((n) => n.tagName === "FORM");

/** fetchJson answering the catalog, the dispatch's 202 and the run's record. */
function server(record) {
  const posts = [];
  const fetchJson = async (url, init) => {
    if (url === "/api/templates") return answer;
    if (url === "/api/templates/request") {
      posts.push(JSON.parse(init.body));
      return { dispatched: true, id: "r1", branch: "request/bucket/orders" };
    }
    if (url === "/api/templates/requests/r1") return record();
    throw new Error(url);
  };
  return { fetchJson, posts };
}

describe("the Templates tab (behold#1035)", () => {
  it("lists a row with the template's title, kind, newest version and attestation", () => {
    expect(rowFacts(row)).toEqual({ title: "A private bucket for one app's data", template: "acme/bucket/aws", kind: "app", version: "1.2.0", attestation: "signed" });
    const host = new Node("section");
    renderTemplates(host, { answer, open: null, raw: {} }, { open() {} }, doc);
    expect(host.text()).toContain("acme/bucket/aws · app · 1.2.0 · signed");
    expect(host.all().some((n) => n.tagName === "BUTTON" && n.textContent === "Request")).toBe(true);
  });

  it("draws a text input for a string, a number input for a number and a checkbox for a bool, and no field for a sensitive input", async () => {
    const host = new Node("section");
    const { fetchJson } = server(() => ({}));
    const t = startTemplates(host, { fetchJson, doc });
    await new Promise((r) => setTimeout(r, 0));
    t.ui.open("acme/bucket/aws");
    const fields = inputs(host).filter((n) => n.name !== "name");
    expect(fields.map((n) => [n.name, n.tagName, n.type])).toEqual([
      ["bucket_name", "INPUT", "text"],
      ["retention_days", "INPUT", "number"],
      ["versioned", "INPUT", "checkbox"],
    ]);
    expect(host.text()).toContain("Bucket name (required)");
    expect(host.text()).not.toContain("KMS key");
    expect(fieldControl({ kind: "list", of: "string" })).toBe("lines");
  });

  it("keeps Submit disabled until the required field has a value, then posts typed inputs; a 202 and a run with pull_request 7 show a link to #7", async () => {
    let record = { id: "r1", state: "dispatched", branch: "request/bucket/orders" };
    const host = new Node("section");
    const { fetchJson, posts } = server(() => record);
    const t = startTemplates(host, { fetchJson, doc });
    await new Promise((r) => setTimeout(r, 0));
    t.ui.open("acme/bucket/aws");
    const byName = (n) => inputs(host).find((x) => x.name === n);
    const type = (n, v) => {
      byName(n).value = v;
      byName(n).fire("input");
    };
    expect(submitOf(host).disabled).toBe(true);
    type("name", "orders");
    expect(submitOf(host).disabled).toBe(true);
    type("bucket_name", "orders-data");
    expect(submitOf(host).disabled).toBe(false);
    type("bucket_name", "");
    expect(submitOf(host).disabled).toBe(true);
    type("bucket_name", "orders-data");
    type("retention_days", "7");

    formOf(host).fire("submit");
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual([{ template: "acme/bucket/aws", version: "1.2.0", name: "orders", inputs: { bucket_name: "orders-data", retention_days: 7 } }]);
    expect(host.text()).toContain(REQUESTED_WORDS);

    record = { id: "r1", state: "ended", conclusion: "success", branch: "request/bucket/orders", pull_request: 7, url: "https://github.com/acme/infra/pull/7" };
    const listeners = {};
    // The run's end arrives as a template-request event naming the request.
    const events = { addEventListener: (type, f) => (listeners[type] = f) };
    const host2 = new Node("section");
    const t2 = startTemplates(host2, { fetchJson, events, doc });
    await new Promise((r) => setTimeout(r, 0));
    t2.ui.open("acme/bucket/aws");
    Object.assign(t2.state, { name: "orders", raw: { bucket_name: "orders-data" } });
    await t2.ui.submit(row, { bucket_name: "orders-data" });
    listeners["template-request"]({ data: "r1" });
    await new Promise((r) => setTimeout(r, 0));
    const link = host2.all().find((n) => n.tagName === "A");
    expect(link.textContent).toBe("#7");
    expect(link.href).toBe("https://github.com/acme/infra/pull/7");
  });

  it("words a refusal with its reason code", () => {
    expect(requestWords({ error: "inputs.bucket_name is required", code: "missing-input" }, null)).toEqual({ text: "missing-input: inputs.bucket_name is required", refused: true });
    expect(requestWords({ dispatched: true, id: "r1" }, { state: "running" })).toEqual({ text: REQUESTED_WORDS });
  });

  it("reads the form's values by kind, leaving an empty optional field to its default", () => {
    const f = [...row.fields, { name: "readers", kind: "list", of: "string", required: false }];
    expect(formInputs(f, { bucket_name: "b", retention_days: "", versioned: true, readers: "a\n\n b \n" })).toEqual({ bucket_name: "b", versioned: true, readers: ["a", "b"] });
    expect(canSubmit(f, { bucket_name: "b" }, "Orders")).toBe(false);
  });
});
