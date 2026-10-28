// behold#1036: an app and its add-ons in one frame, and the app's two
// requests in its inspect pane. The frame is data; the pane and the Templates
// form are drawn into a small stand-in document (no DOM library in this repo).
import { describe, expect, it } from "vitest";
import { appButtons, appFrames, frameOf, frameTitle, postUpgrade, renderAppSection, templateShort } from "./template-apps.js";
import { startTemplates } from "./templates.js";

class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.attributes = {};
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
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  addEventListener(type, f) {
    (this.listeners[type] ||= []).push(f);
  }
  fire(type) {
    for (const f of this.listeners[type] || []) f({ preventDefault() {} });
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  text() {
    return [this.textContent, ...this.children.map((c) => c.text())].join("");
  }
}
const doc = { createElement: (tag) => new Node(tag) };
const buttons = (host) => host.all().filter((n) => n.tagName === "BUTTON");

const orders = {
  app: "orders",
  root: "apps/orders",
  template: "acme/bucket/aws",
  version: "1.2.0",
  upgrade: "1.3.0",
  yanked: false,
  addons: [{ name: "cache", template: "acme/cache/aws", version: "0.3.0", upgrade: null, yanked: false }],
  actions: [],
};
const apps = { schema: 1, command: "templates", exit: 0, status: "ok", results: [orders] };

// chant's graph of the checkout: the root `apps/orders` is member `infra`'s root `orders`.
const roots = [{ member: "infra", name: "orders", path: "apps/orders" }];
const node = (id) => ({ id, kind: "aws_s3_bucket", attrs: { root: id.split("/")[1] } });
const nodes = [
  node("infra/orders/module.app/aws_s3_bucket.this"),
  node("infra/orders/module.app/aws_s3_bucket_versioning.this"),
  node("infra/orders/module.cache/aws_elasticache_cluster.this"),
  node("infra/orders/aws_iam_role.extra"),
  node("infra/billing/module.app/aws_s3_bucket.this"),
];
const drift = { verdict: "drift", action: "update", words: "changed outside Terraform", addresses: ["module.cache.aws_elasticache_cluster.this"], run: { stage: "tf-drift", finished: "2026-10-28T06:04:00Z" } };

describe("an app's frame on the graph (behold#1036)", () => {
  it("draws one frame titled `orders (bucket 1.2.0)` holding the module.app and module.cache cards", () => {
    const frames = appFrames(apps.results, nodes, { roots });
    expect(frames).toHaveLength(1);
    expect(frames[0].title).toBe("orders (bucket 1.2.0)");
    expect(frames[0].ids).toEqual(["infra/orders/module.app/aws_s3_bucket.this", "infra/orders/module.app/aws_s3_bucket_versioning.this", "infra/orders/module.cache/aws_elasticache_cluster.this"]);
    expect(frames[0].header).toBe("orders (bucket 1.2.0)");
    expect(frameTitle({ app: "x", template: "acme/bucket/aws", version: null })).toBe("x (bucket)");
    expect(templateShort("acme/cache/aws")).toBe("cache");
  });

  it("reads `1 drifted` in the header when a module.cache card carries a drift mark", () => {
    const cards = { "infra/orders/module.cache/aws_elasticache_cluster.this": [drift], "infra/orders/aws_iam_role.extra": [drift] };
    const [f] = appFrames(apps.results, nodes, { roots, cards });
    expect(f.drifted).toBe(1);
    expect(f.drift).toBe("1 drifted");
    expect(f.header).toBe("orders (bucket 1.2.0) · 1 drifted");
  });

  it("finds the root by the cards' attrs.root without a roots table, and draws no frame for an app with no card", () => {
    expect(appFrames(apps.results, nodes)[0].ids).toHaveLength(3);
    expect(appFrames([{ ...orders, app: "search", root: "apps/search" }], nodes, { roots })).toEqual([]);
    expect(frameOf(appFrames(apps.results, nodes, { roots }), "infra/orders/module.cache/aws_elasticache_cluster.this").app.app).toBe("orders");
    expect(frameOf(appFrames(apps.results, nodes, { roots }), "infra/orders/aws_iam_role.extra")).toBeNull();
  });
});

describe("the app's inspect pane (behold#1036)", () => {
  const frame = () => appFrames(apps.results, nodes, { roots })[0];

  it("shows Add an add-on; clicking it opens the Templates form with only add-on templates and app=orders set", async () => {
    const catalog = {
      schema: 1,
      command: "templates",
      exit: 0,
      status: "ok",
      results: [
        { template: "acme/bucket/aws", kind: "app", latest: "1.2.0", versions: [{ version: "1.2.0", attestation: "signed" }], fields: [{ name: "bucket_name", kind: "string", required: true }] },
        { template: "acme/cache/aws", kind: "addon", description: "A cache beside an app", latest: "0.3.0", versions: [{ version: "0.3.0", attestation: "signed" }], fields: [{ name: "subnet_ids", kind: "list", of: "string", required: true }] },
      ],
    };
    const posts = [];
    const fetchJson = async (url, init) => {
      if (url === "/api/templates") return catalog;
      if (url === "/api/templates/request") {
        posts.push(JSON.parse(init.body));
        return { dispatched: true, id: "r1", branch: "request/cache/orders/cache" };
      }
      return { id: "r1", state: "dispatched" };
    };
    const tab = new Node("section");
    const t = startTemplates(tab, { fetchJson, doc });
    await new Promise((r) => setTimeout(r, 0));

    const pane = new Node("div");
    renderAppSection(pane, frame(), { addAddon: (a) => t.ui.forApp(a.app), upgrade() {} }, {}, doc);
    const add = buttons(pane).find((b) => b.textContent === "Add an add-on");
    expect(add).toBeTruthy();
    add.fire("click");

    expect(t.state.forApp).toBe("orders");
    expect(tab.text()).toContain("acme/cache/aws");
    expect(tab.text()).not.toContain("acme/bucket/aws");
    const request = buttons(tab).filter((b) => b.textContent === "Request");
    expect(request).toHaveLength(1);
    request[0].fire("click");
    expect(tab.text()).toContain("into the app orders");
    expect(tab.text()).toContain("Add-on name (required)");
    const field = (n) => tab.all().find((x) => (x.tagName === "INPUT" || x.tagName === "TEXTAREA") && x.name === n);
    for (const [n, v] of [["name", "cache"], ["subnet_ids", "app.private_subnets"]]) {
      field(n).value = v;
      field(n).fire("input");
    }
    tab.all().find((n) => n.tagName === "FORM").fire("submit");
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual([{ template: "acme/cache/aws", version: "0.3.0", name: "cache", app: "orders", inputs: { subnet_ids: "app.private_subnets" } }]);
  });

  it("with upgrade 1.3.0 shows Upgrade to 1.3.0, which posts the app and version; without upgrade there is no button", async () => {
    const pane = new Node("div");
    const pressed = [];
    renderAppSection(pane, frame(), { addAddon() {}, upgrade: (a, body) => pressed.push(body) }, {}, doc);
    const up = buttons(pane).find((b) => b.textContent === "Upgrade to 1.3.0");
    expect(up).toBeTruthy();
    up.fire("click");
    expect(pressed).toEqual([{ app: "orders", version: "1.3.0" }]);

    const seen = [];
    await postUpgrade(async (url, init) => (seen.push([url, init.method, JSON.parse(init.body)]), { dispatched: true }), pressed[0]);
    expect(seen).toEqual([["/api/templates/upgrade", "POST", { app: "orders", version: "1.3.0" }]]);

    const none = new Node("div");
    renderAppSection(none, { ...frame(), app: { ...orders, upgrade: null } }, { addAddon() {}, upgrade() {} }, {}, doc);
    expect(buttons(none).map((b) => b.textContent)).toEqual(["Add an add-on"]);
  });

  it("draws neither button in a public view, an embed or a static export", () => {
    for (const opts of [{ publicMode: true }, { embed: true }, { staticMode: true }]) {
      expect(appButtons(orders, opts)).toEqual([]);
      const pane = new Node("div");
      renderAppSection(pane, frame(), { addAddon() {}, upgrade() {} }, opts, doc);
      expect(buttons(pane)).toEqual([]);
      expect(pane.text()).toContain("orders (bucket 1.2.0)");
    }
  });
});
