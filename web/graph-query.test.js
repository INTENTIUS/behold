// behold#1027: the graph pane page's pure helpers.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { STATIC_SEARCH_LINE, answerDrawing, candidateItems, circleLayout, columnLayout, derivedLegend, drawLayout, drawSvg, keyColumns, keyName, labelBox, labelOverlaps, noteLines, queryUrl, refusalText, resolveUrl, rowsTable, sourceLines, templateControl, templateUrl } from "./graph-query.js";

describe("the routes the page asks", () => {
  it("are GETs with the query in the URL", () => {
    expect(queryUrl("MATCH (r) RETURN r", { k: "x" })).toBe(`/api/graphdb/query?${new URLSearchParams({ cypher: "MATCH (r) RETURN r", params: '{"k":"x"}' })}`);
    expect(queryUrl("MATCH (r) RETURN r")).not.toContain("params");
    expect(resolveUrl("arn:aws:s3:::b")).toBe("/api/graphdb/resolve?ref=arn%3Aaws%3As3%3A%3A%3Ab");
    expect(templateUrl("paths-to-kind", "web/a", { kind: "aws_vpc" })).toBe("/api/graphdb/template?name=paths-to-kind&node=web%2Fa&in.kind=aws_vpc");
  });
});

describe("what an answer shows", () => {
  it("one line per source, saying when it was observed or that it is declared", () => {
    const lines = sourceLines([
      { scopeKey: "chant/web", source: "chant", name: "chant", member: "web", observedAt: null, readAt: "r", nodes: 2, edges: 1 },
      { scopeKey: "engine/choudoufu/web", source: "engine", name: "choudoufu", version: "0.33.0", observedAt: "2026-10-26T12:00:00Z", readAt: "r", nodes: 6, edges: 2 },
    ]);
    expect(lines[0]).toMatch(/^web: chant .*declared source, not observed/);
    expect(lines[1]).toMatch(/choudoufu 0.33.0 .*observed 2026-10-26T12:00:00Z/);
  });

  it("draws nodes and the edges among them, derived edges dashed with their rule", () => {
    const svg = drawSvg({
      nodes: [
        { key: "a", kind: "k", name: "a", source: "chant", scopeKey: "chant/x" },
        { key: "b", kind: "k", name: "b", source: "engine", scopeKey: "engine/y" },
      ],
      edges: [{ from: "a", to: "b", viaAttr: "arn", origin: "derived", rule: "identity:arn" }],
    });
    expect(svg).toContain('class="g-edge derived"');
    expect(svg).toContain("identity:arn");
    expect(svg.match(/<circle/g)).toHaveLength(2);
    expect(drawSvg({ nodes: [], edges: [] })).toBe("");
    // behold#1163: each node carries its key, and the keys asked for are lit.
    const lit = drawSvg({ nodes: [{ key: "a", kind: "k", name: "a", source: "chant", scopeKey: "s" }, { key: "b", kind: "k", name: "b", source: "index", scopeKey: "s" }], edges: [] }, 520, ["b"]);
    expect(lit).toContain('<g class="g-node chant" data-key="a">');
    expect(lit).toContain('<g class="g-node index lit" data-key="b">');
    expect(Object.keys(circleLayout([{ key: "a" }, { key: "b" }, { key: "c" }]))).toEqual(["a", "b", "c"]);
  });

  it("draws both ends of each row that pairs two keys, an edge labelled with the second key's column (#1190)", () => {
    // The ask demo's DNS question, as recorded: the drawing names the records alone.
    const node = (key, name, scopeKey) => ({ key, kind: "k", name, source: "chant", scopeKey });
    const known = new Map([
      ["dns/gcpOrigin", node("dns/gcpOrigin", "gcp.three-cloud.example.", "chant/dns")],
      ["dns/gcpRecord", node("dns/gcpRecord", "www.three-cloud.example.", "chant/dns")],
      ["gcp/webRule", node("gcp/webRule", "webRule", "chant/gcp")],
      ["gcp/webProxy", node("gcp/webProxy", "webProxy", "chant/gcp")],
    ]);
    const body = {
      columns: ["key", "record", "reaches", "kind"],
      rows: [
        { key: "dns/gcpOrigin", record: "gcp.three-cloud.example.", reaches: "gcp/webProxy", kind: "GCP::Compute::TargetHTTPProxy" },
        { key: "dns/gcpOrigin", record: "gcp.three-cloud.example.", reaches: "gcp/webRule", kind: "GCP::Compute::ForwardingRule" },
        { key: "dns/gcpRecord", record: "www.three-cloud.example.", reaches: "gcp/webRule", kind: "GCP::Compute::ForwardingRule" },
      ],
      keys: ["dns/gcpOrigin", "dns/gcpRecord"],
      draw: { nodes: [known.get("dns/gcpOrigin"), known.get("dns/gcpRecord")], edges: [{ from: "dns/gcpRecord", to: "dns/gcpOrigin", viaAttr: "ResourceRecords", origin: "derived", rule: "r" }] },
    };
    // Only the columns whose every value is a known key: not names or kinds, however they look.
    expect(keyColumns(body.columns, body.rows, known)).toEqual(["key", "reaches"]);
    expect(keyColumns(["k"], [{ k: null }], known)).toEqual([]);
    expect(keyColumns(["k"], [{ k: "dns/gcpOrigin" }, { k: "gcp/nowhere" }], known)).toEqual([]);
    const d = answerDrawing(body, known);
    expect(d.keyColumns).toEqual(["key", "reaches"]);
    expect(d.nodes.map((n) => n.key)).toEqual(["dns/gcpOrigin", "dns/gcpRecord", "gcp/webProxy", "gcp/webRule"]);
    expect(d.lit).toEqual(d.nodes.map((n) => n.key));
    expect(d.edges).toEqual([
      body.draw.edges[0],
      { from: "dns/gcpOrigin", to: "gcp/webProxy", origin: "row", column: "reaches" },
      { from: "dns/gcpOrigin", to: "gcp/webRule", origin: "row", column: "reaches" },
      { from: "dns/gcpRecord", to: "gcp/webRule", origin: "row", column: "reaches" },
    ]);
    // The records on the left, what they reach on the right.
    const lay = columnLayout(d, 520);
    expect(lay.at["dns/gcpOrigin"].x).toBeLessThan(lay.at["gcp/webRule"].x);
    expect(lay.at["dns/gcpRecord"].side).toBe("left");
    expect(lay.at["gcp/webProxy"].side).toBe("right");
    const svg = drawSvg(d, 420, d.lit);
    expect(svg.match(/class="g-edge row" data-label="reaches"/g)).toHaveLength(3);
    // behold#1204: the column's name once, heading the nodes it reaches.
    expect(svg.match(/<text class="g-edge-label"[^>]*>reaches<\/text>/g)).toHaveLength(1);
    expect(svg).toContain("www.three-cloud.example.");
    // A REF edge between two nodes a row pairs keeps its line and takes the label.
    const ref = answerDrawing({ ...body, rows: [{ key: "dns/gcpRecord", reaches: "dns/gcpOrigin" }], columns: ["key", "reaches"] }, known);
    expect(ref.edges).toEqual([{ ...body.draw.edges[0], column: "reaches" }]);
    // Without the page's rows, only what the answer's drawing names: no row edge to a node it lacks.
    expect(answerDrawing(body).edges).toEqual(body.draw.edges);
    expect(answerDrawing({}).nodes).toEqual([]);
  });

  describe("its labels (#1204)", () => {
    const root = new URL("../ask-demo/", import.meta.url);
    const narration = JSON.parse(readFileSync(new URL("narration.json", root), "utf8"));
    const graphdb = JSON.parse(readFileSync(new URL("estate/graphdb.json", root), "utf8"));
    const known = new Map((graphdb.rows?.resources ?? []).map((r) => [r.key, { key: r.key, kind: r.kind, name: r.name, source: r.source, scopeKey: r.scopeKey }]));
    const turns = narration.turns.filter((t) => t.draw);
    const inside = (b, box) => b.x0 >= box.x && b.y0 >= box.y && b.x1 <= box.x + box.width && b.y1 <= box.y + box.height;

    it("never overlap one another, and every one is inside the view, in each recorded answer and on the /graph page's size", () => {
      expect(turns.length).toBeGreaterThan(3);
      for (const t of turns)
        for (const size of [420, 520]) {
          const lay = drawLayout(answerDrawing(t, known), size);
          expect(labelOverlaps(lay.labels), `${t.id} at ${size}`).toEqual([]);
          for (const l of lay.labels) expect(inside(labelBox(l), lay.box), `${t.id}: ${l.text}`).toBe(true);
        }
    });

    it("write a column name every edge to a group of nodes shares once, heading the group", () => {
      const dns = turns.find((t) => t.id === "dns-cross-cloud");
      const d = answerDrawing(dns, known);
      const lay = drawLayout(d, 420);
      expect(lay.labels.filter((l) => l.text === "reaches")).toHaveLength(1);
      const heading = lay.labels.find((l) => l.kind === "heading");
      // Above every node it heads.
      for (const k of ["gcp/webAddress", "gcp/webProxy", "gcp/webRule", "gcp/webUrlMap"]) expect(heading.y).toBeLessThan(lay.at[k].y);
      // Two names, two groups, each headed once.
      const two = { nodes: [{ key: "a" }, { key: "b" }, { key: "c" }].map((n) => ({ ...n, name: n.key })), edges: [{ from: "a", to: "b", origin: "row", column: "role" }, { from: "a", to: "c", origin: "row", column: "bucket" }] };
      const lay2 = columnLayout(two, 520);
      expect(lay2.headings.map((h) => h.text)).toEqual(["role", "bucket"]);
      expect(lay2.headings[0].y).toBeLessThan(lay2.at.b.y);
      expect(lay2.at.b.y).toBeLessThan(lay2.headings[1].y);
      expect(lay2.headings[1].y).toBeLessThan(lay2.at.c.y);
    });

    it("draw the dotted edge only from the answer's own edges, with the attribute it was derived from and a legend", () => {
      const dns = turns.find((t) => t.id === "dns-cross-cloud");
      // The DNS answer's dotted edge is the REF edge its drawing carries: www's ResourceRecords holds gcp's record.
      expect(dns.draw.edges).toEqual([expect.objectContaining({ from: "dns/gcpRecord", to: "dns/gcpOrigin", origin: "derived", viaAttr: "ResourceRecords" })]);
      const d = answerDrawing(dns, known);
      const svg = drawSvg(d, 420, d.lit);
      // Between two records in one column, it bows into the space between the columns rather than over them.
      expect(svg.match(/<path class="g-edge derived" d="M[^"]+ Q[^"]+"/g)).toHaveLength(1);
      expect(svg).toMatch(/<text class="g-edge-label"[^>]*>ResourceRecords<\/text>/);
      expect(svg).toContain(derivedLegend(["ResourceRecords"]).replace("'", "&#39;"));
      expect(derivedLegend(["ResourceRecords"])).toBe("dashed: derived from ResourceRecords, a value holding the other's cloud id");
      // With no derived edge in the answer, none is drawn and there is no legend.
      const bare = answerDrawing({ ...dns, draw: { ...dns.draw, edges: [] } }, known);
      const plain = drawSvg(bare, 420, bare.lit);
      expect(plain).not.toContain("derived");
      expect(plain).not.toContain("g-legend");
      // An attribute several derived edges share is named once, in the legend, not on each edge.
      const owned = turns.find((t) => t.id === "aws-account-unmanaged");
      const lo = drawLayout(answerDrawing(owned, known), 420);
      const attr = lo.edges.find((e) => e.origin === "derived").viaAttr;
      expect(lo.edges.filter((e) => e.viaAttr === attr).length).toBeGreaterThan(1);
      expect(lo.labels.filter((l) => l.text === attr)).toEqual([]);
      expect(lo.legend).toBe(derivedLegend([attr]));
    });

    it("on a circle, sit on each node's outer side, moving above or below a name already there", () => {
      const nodes = ["a", "b", "c", "d"].map((k) => ({ key: k, name: `${k}-a-long-resource-name`, source: "chant" }));
      const lay = drawLayout({ nodes, edges: [] }, 520);
      const at = (k) => lay.labels.find((l) => l.key === k);
      // b sits on the right, d on the left; a and c on the axis.
      expect(at("b").anchor).toBe("start");
      expect(at("d").anchor).toBe("end");
      expect(labelOverlaps(lay.labels)).toEqual([]);
      // Two names that would collide: the second moves.
      const crowd = drawLayout({ nodes: Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, name: `subnet-default-us-east-1-${i}`, source: "index" })), edges: [] }, 520);
      expect(labelOverlaps(crowd.labels)).toEqual([]);
    });

    it("fit the view to what is drawn, so one node is not a large empty square", () => {
      const lay = drawLayout({ nodes: [{ key: "k", name: "orders-api", source: "chant" }], edges: [] }, 520);
      expect(lay.box.width).toBeLessThan(200);
      expect(lay.box.height).toBeLessThan(60);
      expect(drawSvg({ nodes: [{ key: "k", name: "orders-api", source: "chant" }], edges: [] })).toMatch(/<svg viewBox="[-\d]+ [-\d]+ \d+ \d+" width="\d+" height="\d+"/);
    });
  });

  it("names a key column's cells readably, the whole key on hover (#1206)", () => {
    const sa = "cloud/kubernetes/kind-x/eb3c/kubernetes/kind-x/orders/v1%2FServiceAccount/orders/orders-api";
    const role = "cloud/aws/000000000000/db1d/aws/000000000000/global/AWS::IAM::Role/orders-reader";
    // The resource's name when the page knows it, else the key's last segment, decoded.
    expect(keyName(role, new Map([[role, { name: "orders-reader" }]]))).toBe("orders-reader");
    expect(keyName(sa)).toBe("orders-api");
    expect(keyName("a/b%2Fc")).toBe("b/c");
    // A chant member's key reads as its id, which a row's name column does not repeat.
    expect(keyName("dns/gcpOrigin", new Map([["dns/gcpOrigin", { name: "gcp.three-cloud.example." }]]))).toBe("gcpOrigin");
    expect(keyName("engine/choudoufu/x@azure/vm", new Map([["engine/choudoufu/x@azure/vm", { name: "web-vm" }]]))).toBe("web-vm");
    expect(keyName("a/%E0")).toBe("%E0");
    expect(keyName("plain")).toBe("plain");
    const html = rowsTable(["key", "role", "via"], [{ key: sa, role: "orders-reader", via: "metadata.annotations.x" }], { keys: ["key"] });
    expect(html).toContain(`<td class="g-key" title="${sa}">orders-api</td>`);
    expect(html).toContain('<td title="orders-reader">orders-reader</td>');
    // Without key columns, every cell shows its value as before (the server's /graph page).
    expect(rowsTable(["key"], [{ key: sa }])).toContain(`<td title="${sa}">${sa}</td>`);
  });

  it("escapes what it draws", () => {
    expect(rowsTable(["k"], [{ k: "<script>" }])).toContain("&lt;script&gt;");
    expect(drawSvg({ nodes: [{ key: "<x>", kind: "k", name: "<x>", source: "chant", scopeKey: "s" }], edges: [] })).not.toContain("<x>");
  });

  it("a refusal without the peer shows the install line and what still works", () => {
    const t = refusalText({ error: "needs the peer", code: "graph-peer-missing", install: "npm i -g @ladybugdb/core", stillWorks: ["chant search"] });
    expect(t).toContain("Install: npm i -g @ladybugdb/core");
    expect(t).toContain("Still works: chant search");
  });
});

describe("the resolve answer's candidates", () => {
  const cand = (key, source) => ({ key, kind: "aws:ec2/subnet:Subnet", source, matchedBy: "cloud-id" });
  it("can each be opened when a cloud id names several nodes, and not when it lands on one", () => {
    const many = candidateItems({ resolved: false, candidates: [cand("aws/aws/subnet", "chant"), cand("aws/plunge/subnet", "engine")] });
    expect(many).toEqual([
      { key: "aws/aws/subnet", label: "aws/aws/subnet (aws:ec2/subnet:Subnet, chant, matched by cloud-id)", open: true },
      { key: "aws/plunge/subnet", label: "aws/plunge/subnet (aws:ec2/subnet:Subnet, engine, matched by cloud-id)", open: true },
    ]);
    expect(candidateItems({ resolved: true, candidates: [cand("aws/aws/subnet", "chant")] })[0].open).toBe(false);
    expect(candidateItems({ resolved: false, candidates: [] })).toEqual([]);
  });
});

describe("a template's button (behold#1180)", () => {
  const search = { name: "dependents", title: "What depends on it", language: "search", available: true, inputs: [], expanded: { query: "->*web/aws_instance.web" } };
  const cypher = { name: "same-cloud-id", title: "Same cloud id", language: "cypher", available: true, inputs: [] };
  const missing = { ...cypher, available: false, refusal: "LadybugDB is not installed.", install: "npm i @ladybugdb/core" };

  it("on the server, runs every available template as before, search ones too", () => {
    expect(templateControl(search, undefined)).toEqual({ label: "What depends on it", disabled: false, title: "", staticSearch: false });
    expect(templateControl(cypher, undefined)).toEqual({ label: "Same cloud id (Cypher)", disabled: false, title: "", staticSearch: false });
    expect(templateControl(missing, undefined)).toMatchObject({ disabled: true, title: "LadybugDB is not installed. npm i @ladybugdb/core" });
    expect(templateControl({ ...cypher, origin: "project" }, undefined).label).toBe("Same cloud id (Cypher), this project's");
  });

  it("in a bundle, runs Cypher, and disables a search the estate view was not captured for", () => {
    const plain = { estate: { href: "./" }, searches: [] };
    expect(templateControl(cypher, plain)).toMatchObject({ disabled: false, staticSearch: false });
    const off = templateControl(search, plain);
    expect(off).toMatchObject({ disabled: true, staticSearch: true });
    expect(off.title).toMatch(/^Runs on behold serve; the Cypher templates run in this page\./);
    expect(off.title).toContain('behold export --q "->*web/aws_instance.web"');
    // No estate view (the ask demo): no capture hint, as nothing would open it.
    expect(templateControl(search, { estate: null, searches: ["->*web/aws_instance.web"] })).toMatchObject({ disabled: true, title: "Runs on behold serve; the Cypher templates run in this page." });
    // A template with inputs expands only when asked, so a bundle cannot know it was captured.
    expect(templateControl({ ...search, inputs: [{ name: "kind" }], expanded: undefined }, { estate: { href: "./" }, searches: ["x"] })).toMatchObject({ disabled: true, staticSearch: true });
    expect(STATIC_SEARCH_LINE).toBe("Search templates run on behold serve; the Cypher templates run in this page.");
  });

  it("in a bundle with an estate view, opens a search --q captured", () => {
    expect(templateControl(search, { estate: { href: "./" }, searches: ["->*web/aws_instance.web"] })).toMatchObject({ disabled: false, staticSearch: false, title: expect.stringMatching(/estate view/) });
  });
});

describe("the server's /graph page (behold#1180)", () => {
  it("starts the pane and the diff with no bundle options, keeps the diff section, and links back to /", () => {
    const html = readFileSync(new URL("./graph.html", import.meta.url), "utf8");
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    expect(script).toMatch(/initGraphPane\(\);/);
    expect(script).toMatch(/initIndexDiff\(\);/);
    expect(html).toContain('<div id="d-section">');
    expect(html).toContain('<a id="g-back" href="/">Back to the estate</a>');
    expect(html).not.toContain("g-bundle");
  });
});

describe("the status notes (#1177)", () => {
  const scope = "cloud/aws/000000000000/db1d7f66ad8c";
  const cannot = (t) => `${scope}: Cloud Control cannot list ${t}: HTTP 400: UnsupportedActionException: ListResources is not supported for resource type ${t}.`;
  it("groups a source's cannot-list notes that share an answer, naming the types", () => {
    const lead = `${scope}: Cloud Control lists one type per call.`;
    expect(noteLines([lead, cannot("AWS::DynamoDB::Table"), cannot("AWS::EC2::InternetGateway"), "other: a note"])).toEqual([
      lead,
      `${scope}: Cloud Control cannot list 2 types (AWS::DynamoDB::Table, AWS::EC2::InternetGateway). Each answered HTTP 400: UnsupportedActionException: ListResources is not supported for resource type <type>.`,
      "other: a note",
    ]);
  });
  it("keeps a lone note, different answers and other sources apart", () => {
    expect(noteLines([cannot("AWS::SQS::Queue")])).toEqual([cannot("AWS::SQS::Queue")]);
    const other = `${scope}: Cloud Control cannot list AWS::Logs::LogGroup: HTTP 500: InternalFailure.`;
    const elsewhere = cannot("AWS::SQS::Queue").replace(scope, "cloud/aws/111111111111/x");
    expect(noteLines([cannot("AWS::SQS::Queue"), other, elsewhere])).toEqual([cannot("AWS::SQS::Queue"), other, elsewhere]);
    expect(noteLines(undefined)).toEqual([]);
  });
});
