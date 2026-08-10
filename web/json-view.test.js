// #259: the pure half of web/json-view.js, tested the way web/layout-store.js
// is (#245) — no DOM, no jsdom, no browser. Everything renderJson() decides
// (what a value reads as, what a collapsed subtree says about itself, whether
// it starts folded, exactly what the copy control writes) lives in a function
// that takes data and returns data, so it is checkable here; the DOM half —
// the toggle, the keyboard, the copy click — is smoke/ui-smoke.mjs's job.
import { describe, it, expect } from "vitest";
import {
  BIG_ENTRIES,
  INDENT,
  MAX_STRING,
  OPEN_DEPTH,
  collapsedByDefault,
  countOf,
  entriesOf,
  escapeString,
  isContainer,
  kindOf,
  rawJson,
  scalarText,
  summaryOf,
  truncateString,
} from "./json-view.js";

describe("kindOf — JSON's vocabulary, with arrays split from objects", () => {
  it("names every JSON type", () => {
    expect(kindOf(null)).toBe("null");
    expect(kindOf([])).toBe("array");
    expect(kindOf({})).toBe("object");
    expect(kindOf("s")).toBe("string");
    expect(kindOf(3)).toBe("number");
    expect(kindOf(false)).toBe("boolean");
  });
  it("null is not an object — typeof would say otherwise, and the tree would try to expand it", () => {
    expect(isContainer(null)).toBe(false);
    expect(isContainer([])).toBe(true);
    expect(isContainer({})).toBe(true);
    expect(isContainer("{}")).toBe(false);
  });
  it("undefined survives (a sliced payload can hold one; JSON has no spelling for it)", () => {
    expect(kindOf(undefined)).toBe("undefined");
    expect(scalarText(undefined)).toBe("undefined");
  });
});

describe("entriesOf — key order is the order received, never sorted", () => {
  it("keeps insertion order for objects", () => {
    const o = { zeta: 1, alpha: 2, mid: 3 };
    expect(entriesOf(o).map(([k]) => k)).toEqual(["zeta", "alpha", "mid"]);
  });
  it("keeps it after a JSON round trip — which is how every payload here arrives", () => {
    const parsed = JSON.parse('{"status":"Running","spec":{},"apiVersion":"v1"}');
    expect(entriesOf(parsed).map(([k]) => k)).toEqual(["status", "spec", "apiVersion"]);
  });
  it("indexes arrays by position", () => {
    expect(entriesOf(["a", "b"])).toEqual([
      ["0", "a"],
      ["1", "b"],
    ]);
  });
  it("a scalar has no entries", () => {
    expect(entriesOf("nope")).toEqual([]);
    expect(entriesOf(null)).toEqual([]);
    expect(countOf(7)).toBe(0);
  });
});

describe("summaryOf — what a collapsed container says about itself", () => {
  it("counts keys and items, singular and plural", () => {
    expect(summaryOf({ a: 1, b: 2 })).toBe("2 keys");
    expect(summaryOf({ a: 1 })).toBe("1 key");
    expect(summaryOf([1, 2, 3])).toBe("3 items");
    expect(summaryOf([1])).toBe("1 item");
    expect(summaryOf({})).toBe("0 keys");
  });
});

describe("scalarText — one value as JSON source text", () => {
  it("quotes and escapes strings, so a payload's quotes are visible as escapes", () => {
    expect(scalarText('he said "hi"')).toBe('"he said \\"hi\\""');
    expect(scalarText("C:\\tmp")).toBe('"C:\\\\tmp"');
    expect(scalarText("line\nbreak")).toBe('"line\\nbreak"');
  });
  it("markup in a payload stays a string — nothing here builds HTML", () => {
    // The renderer sets textContent, so this is belt and braces: the escaped
    // form is what a JSON reader expects, and it is inert either way.
    expect(scalarText("<script>alert(1)</script>")).toBe('"<script>alert(1)</script>"');
  });
  it("names the values JSON.stringify would quietly turn into null", () => {
    expect(scalarText(NaN)).toBe("NaN");
    expect(scalarText(Infinity)).toBe("Infinity");
    expect(JSON.stringify(NaN)).toBe("null"); // …which is the thing being avoided
  });
  it("renders the rest as JSON source", () => {
    expect(scalarText(null)).toBe("null");
    expect(scalarText(true)).toBe("true");
    expect(scalarText(0)).toBe("0");
    expect(scalarText(-1.5)).toBe("-1.5");
  });
});

describe("escapeString — JSON's escaping without the quotes (for the truncated form)", () => {
  it("escapes the inner text only", () => {
    expect(escapeString('a"b')).toBe('a\\"b');
    expect(escapeString("tab\there")).toBe("tab\\there");
  });
  it("wrapping it in quotes reproduces scalarText", () => {
    for (const s of ['q"q', "back\\slash", "nl\n", "plain"]) expect(`"${escapeString(s)}"`).toBe(scalarText(s));
  });
});

describe("rawJson — exactly what the copy control writes", () => {
  const payload = { kind: "Deployment", spec: { replicas: 3, ports: [80, 443] } };

  it("is 2-space pretty printed", () => {
    expect(INDENT).toBe("  ");
    expect(rawJson(payload).split("\n")[1]).toBe('  "kind": "Deployment",');
    expect(rawJson(payload)).toContain('\n    "replicas": 3');
  });
  it("round-trips: what you paste back parses to what you copied", () => {
    expect(JSON.parse(rawJson(payload))).toEqual(payload);
  });
  it("copies the SUBTREE, not the document — the point of a per-node copy", () => {
    expect(JSON.parse(rawJson(payload.spec))).toEqual({ replicas: 3, ports: [80, 443] });
    expect(rawJson(payload.spec)).not.toContain("Deployment");
  });
  it("copies a scalar as its own JSON source", () => {
    expect(rawJson("just a string")).toBe('"just a string"');
    expect(rawJson(42)).toBe("42");
    expect(rawJson(null)).toBe("null");
  });
  it("survives what JSON.stringify refuses", () => {
    const cycle = { name: "loop" };
    cycle.self = cycle;
    expect(() => rawJson(cycle)).not.toThrow();
    expect(rawJson(undefined)).toBe("undefined");
  });
});

describe("truncateString — long strings shrink, and give the rest back on demand", () => {
  it("leaves anything within the budget alone", () => {
    expect(truncateString("short", 10)).toEqual({ head: "short", rest: "", truncated: false });
    expect(truncateString("x".repeat(MAX_STRING)).truncated).toBe(false);
  });
  it("splits at the budget, losing nothing", () => {
    const long = "x".repeat(MAX_STRING + 40);
    const { head, rest, truncated } = truncateString(long);
    expect(truncated).toBe(true);
    expect(head.length).toBe(MAX_STRING);
    expect(head + rest).toBe(long); // the expander re-joins these
  });
  it("splits the RAW string, so an escape is never cut in half", () => {
    // Escaping first would split `\n` into a lone backslash. The raw split
    // keeps the character whole and the renderer escapes each half after.
    const { head } = truncateString("a\nb", 2);
    expect(head).toBe("a\n");
    expect(escapeString(head)).toBe("a\\n");
  });
});

describe("collapsedByDefault — deep OR large, and nothing else", () => {
  const small = { a: 1 };
  const wide = Object.fromEntries(Array.from({ length: BIG_ENTRIES + 1 }, (_, i) => [`k${i}`, i]));

  it("opens the root and the depth-1 tier", () => {
    expect(OPEN_DEPTH).toBe(1);
    expect(collapsedByDefault(small, 0)).toBe(false);
    expect(collapsedByDefault(small, 1)).toBe(false);
  });
  it("folds everything below it", () => {
    expect(collapsedByDefault(small, 2)).toBe(true);
    expect(collapsedByDefault(small, 5)).toBe(true);
  });
  it("folds a large container wherever it sits, root included", () => {
    expect(countOf(wide)).toBeGreaterThan(BIG_ENTRIES);
    expect(collapsedByDefault(wide, 0)).toBe(true);
    expect(collapsedByDefault(wide, 1)).toBe(true);
    expect(collapsedByDefault(Array.from({ length: BIG_ENTRIES + 1 }, (_, i) => i), 0)).toBe(true);
  });
  it("never folds an empty container — `{}` has nothing to hide", () => {
    expect(collapsedByDefault({}, 9)).toBe(false);
    expect(collapsedByDefault([], 9)).toBe(false);
  });
  it("never folds a scalar", () => {
    expect(collapsedByDefault("a string long enough to matter", 9)).toBe(false);
    expect(collapsedByDefault(null, 9)).toBe(false);
  });
  it("takes the caller's tiers — the /api error card opens nothing (openDepth -1)", () => {
    expect(collapsedByDefault(small, 0, { openDepth: -1 })).toBe(true);
    expect(collapsedByDefault(small, 4, { openDepth: 6 })).toBe(false);
    expect(collapsedByDefault({ a: 1, b: 2 }, 0, { big: 1 })).toBe(true);
  });
});

describe("a real observed payload, end to end through the pure half", () => {
  // The shape /api/diff hands renderObserved: a k8s object's attributes.
  const observed = {
    type: "k8s::Deployment",
    attributes: {
      replicas: 3,
      spec: { template: { metadata: { labels: { app: "api", tier: "web" } } } },
      conditions: ["Available=True", "Progressing=True"],
    },
  };

  it("the deep label map is folded, its grandparent is not", () => {
    expect(collapsedByDefault(observed.attributes.spec, 0)).toBe(false); // a dd's own root
    expect(collapsedByDefault(observed.attributes.spec.template, 1)).toBe(false);
    expect(collapsedByDefault(observed.attributes.spec.template.metadata, 2)).toBe(true);
  });
  it("copying the fold copies only the fold", () => {
    expect(JSON.parse(rawJson(observed.attributes.spec.template.metadata))).toEqual({ labels: { app: "api", tier: "web" } });
  });
  it("the conditions array reads as items, in order", () => {
    expect(summaryOf(observed.attributes.conditions)).toBe("2 items");
    expect(entriesOf(observed.attributes.conditions)[0]).toEqual(["0", "Available=True"]);
  });
});
