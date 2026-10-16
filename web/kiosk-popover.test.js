import { describe, expect, it } from "vitest";
import { MAX_LINES, PIN_HOLD_MS, WORDS, attributeLine, placePopover, popReduce, popState, resourcePopover, rootPopover, valueWords } from "./kiosk-popover.js";

// behold#571: the shape /api/terragucci answers (src/terragucci-overlay.ts):
// the checkout's roots, the marks on each card with each attribute's values,
// and what the newest applied wave wrote.
const run = (o = {}) => ({ stage: "tf-plan", finished: "2026-10-20T10:01:40.000Z", commit: "a1b2c3d4", pull_request: "41", report: "r.html", ...o });
const answer = (o = {}) => ({
  roots: [
    { member: "repo", name: "network", path: "network", plan: { changes: 1 } },
    { member: "repo", name: "app", path: "app", plan: { changes: 1 } },
    { member: "repo", name: "other", path: "other" },
  ],
  pull_request: { roots: ["network", "app"] },
  cards: {
    "repo/network/terraform_data.http_proxy_port": [
      {
        verdict: "plan",
        action: "update",
        words: "would update",
        addresses: ["terraform_data.http_proxy_port"],
        attributes: ["input"],
        values: [{ address: "terraform_data.http_proxy_port", path: "input", before: 8080, after: 9090 }],
        run: run(),
      },
    ],
    "repo/app/terraform_data.listener_port": [
      {
        verdict: "plan",
        action: "update",
        words: "would update",
        addresses: ["terraform_data.listener_port"],
        attributes: ["input"],
        values: [{ address: "terraform_data.listener_port", path: "input", before: 8070, unknown: true }],
        run: run(),
      },
    ],
  },
  applied: {},
  ...o,
});

describe("what the popover says about a resource (behold#571)", () => {
  it("says a change one attribute a line, before -> after, and that the left is what is applied now", () => {
    const p = resourcePopover(answer(), "repo/network/terraform_data.http_proxy_port");
    expect(p).toMatchObject({ address: "terraform_data.http_proxy_port", root: "network", head: "The plan changes this resource.", change: true, unknown: false, more: 0 });
    expect(p.lines).toEqual([{ text: "input: 8080 -> 9090", tone: null }]);
    expect(p.note).toBe(WORDS.leftIsApplied);
    expect(p.applied).toBeNull();
  });

  it("says an attribute known only after apply in the unknown tone", () => {
    const p = resourcePopover(answer(), "repo/app/terraform_data.listener_port");
    expect(p.unknown).toBe(true);
    expect(p.lines).toEqual([{ text: "input: 8070 -> known after apply", tone: "unknown" }]);
    expect(attributeLine({ path: "input", unknown: true })).toEqual({ text: "input: known after apply", tone: "unknown" });
  });

  it("says no change for a card the plan leaves alone, and that a root the plan does not hold is untouched", () => {
    const a = answer();
    expect(resourcePopover(a, "repo/network/terraform_data.release")).toMatchObject({ address: "terraform_data.release", head: WORDS.same, lines: [], change: false });
    expect(resourcePopover(a, "repo/other/terraform_data.backup_schedule")).toMatchObject({ root: "other", head: WORDS.untouched, change: false });
    expect(resourcePopover({ roots: a.roots, cards: {} }, "repo/other/terraform_data.backup_schedule").head).toBe(WORDS.noPlan);
    expect(resourcePopover(a, "elsewhere/x")).toBeNull();
    expect(resourcePopover({ error: "no" }, "repo/network/terraform_data.release")).toBeNull();
  });

  it("caps the lines at six and counts the rest", () => {
    const values = Array.from({ length: 9 }, (_, i) => ({ address: "terraform_data.http_proxy_port", path: `a${i}`, before: i, after: i + 1 }));
    const a = answer();
    a.cards["repo/network/terraform_data.http_proxy_port"][0].values = values;
    const p = resourcePopover(a, "repo/network/terraform_data.http_proxy_port");
    expect(p.lines).toHaveLength(MAX_LINES);
    expect(p.more).toBe(3);
  });

  it("shows what the newest applied wave wrote for the attributes that change, when it applied after the plan", () => {
    const applied = { "repo/network/terraform_data.http_proxy_port": { values: [{ address: "terraform_data.http_proxy_port", path: "input", before: 8080, after: 9090 }, { address: "x", path: "unrelated", after: 1 }], run: run({ stage: "tf-apply", wave: 1, finished: "2026-10-20T10:04:10.000Z" }) } };
    const p = resourcePopover(answer({ applied }), "repo/network/terraform_data.http_proxy_port", new Date("2026-10-20T11:00:00Z"));
    expect(p.applied).toEqual({ when: "The applied state holds these values now, from wave 1 at 10:04 UTC.", lines: [{ text: "input: 9090", tone: null }] });
    expect(p.note).toBeNull();
    // An apply older than the plan says nothing of now.
    const old = { "repo/network/terraform_data.http_proxy_port": { ...applied["repo/network/terraform_data.http_proxy_port"], run: run({ stage: "tf-apply", wave: 1, finished: "2026-10-19T00:00:00.000Z" }) } };
    expect(resourcePopover(answer({ applied: old }), "repo/network/terraform_data.http_proxy_port").applied).toBeNull();
  });

  it("writes values plainly: a string bare, the rest as JSON, cut short", () => {
    expect(valueWords("http://app:9080")).toBe("http://app:9080");
    expect(valueWords("")).toBe('""');
    expect(valueWords(null)).toBe("null");
    expect(valueWords({ a: "x".repeat(60) })).toHaveLength(40);
    expect(attributeLine({ path: "input", after: 1 }).text).toBe("input: none yet -> 1");
    expect(attributeLine({ path: "input", before: 1 }).text).toBe("input: 1 -> gone");
    expect(attributeLine({ path: "policy", long: true }).text).toBe("policy: too long to show here");
  });
});

describe("what the popover says about a root, in Roots by wave (behold#571)", () => {
  it("lists its resources, each changes, no change or known after apply, and counts the changes", () => {
    const resources = [
      { kind: "terraform_remote_state", id: "app/data.terraform_remote_state.network" },
      { kind: "terraform_data", id: "app/terraform_data.listener_port" },
    ];
    const p = rootPopover(answer(), "app", resources);
    expect(p.head).toBe("1 of 2 resources change.");
    expect(p.rows).toEqual([
      { address: "data.terraform_remote_state.network", state: "same", words: "no change" },
      { address: "terraform_data.listener_port", state: "unknown", words: "known after apply" },
    ]);
    const net = rootPopover(answer(), "network", [{ kind: "terraform_data", id: "network/terraform_data.http_proxy_port" }]);
    expect(net.rows[0]).toMatchObject({ state: "change", words: "changes" });
    expect(net.head).toBe("1 of 1 resource changes.");
    expect(rootPopover(answer(), "other", [{ kind: "terraform_data", id: "other/terraform_data.backup_schedule" }]).head).toBe(WORDS.noRootChange);
    expect(rootPopover(answer(), "other", []).head).toBe(WORDS.noResources);
  });
});

describe("when the popover shows (behold#571)", () => {
  it("shows nothing until someone points, follows the pointer, and hides when it leaves", () => {
    let s = popState();
    expect(s.shown).toBeNull();
    s = popReduce(s, { type: "enter", id: "a" }, 0);
    expect(s).toEqual({ shown: "a", pinned: false, at: 0 });
    s = popReduce(s, { type: "enter", id: "b" }, 0);
    expect(s.shown).toBe("b");
    expect(popReduce(s, { type: "leave", id: "a" }, 0)).toBe(s);
    expect(popReduce(s, { type: "leave", id: "b" }, 0).shown).toBeNull();
  });

  it("pins on a click, keeps the pinned card while the pointer moves, and closes on a click elsewhere or Escape", () => {
    let s = popReduce(popState(), { type: "click", id: "a" }, 1000);
    expect(s).toEqual({ shown: "a", pinned: true, at: 1000 });
    expect(popReduce(s, { type: "enter", id: "b" }, 2000)).toBe(s);
    expect(popReduce(s, { type: "leave", id: "a" }, 2000)).toBe(s);
    expect(popReduce(s, { type: "outside" }, 2000)).toEqual(popState());
    expect(popReduce(s, { type: "escape" }, 2000)).toEqual(popState());
    // Another card's click moves the pin to it.
    s = popReduce(s, { type: "click", id: "b" }, 3000);
    expect(s).toEqual({ shown: "b", pinned: true, at: 3000 });
  });

  it("lets a pin go 90 seconds after the click, as the view toggle's hold does", () => {
    expect(PIN_HOLD_MS).toBe(90_000);
    const s = popReduce(popState(), { type: "click", id: "a" }, 1000);
    expect(popReduce(s, { type: "tick" }, 1000 + PIN_HOLD_MS - 1)).toBe(s);
    expect(popReduce(s, { type: "tick" }, 1000 + PIN_HOLD_MS)).toEqual(popState());
    const hovered = popReduce(popState(), { type: "enter", id: "a" }, 0);
    expect(popReduce(hovered, { type: "tick" }, 10 * PIN_HOLD_MS)).toBe(hovered);
  });
});

describe("where the popover goes (behold#571)", () => {
  const frame = { width: 900, height: 700 };
  const pop = { width: 300, height: 160 };
  const overlaps = (a, b) => !(a.left + a.width <= b.left || a.left >= b.left + b.width || a.top + a.height <= b.top || a.top >= b.top + b.height);
  const inside = (p) => p.left >= 0 && p.top >= 0 && p.left + pop.width <= frame.width && p.top + pop.height <= frame.height;

  it("sits right of the card when it fits, else left, else below, else above, never over the card", () => {
    for (const card of [
      { left: 100, top: 100, width: 200, height: 60 },
      { left: 560, top: 100, width: 200, height: 60 },
      { left: 300, top: 100, width: 320, height: 60 },
      { left: 300, top: 600, width: 320, height: 60 },
      { left: 10, top: 640, width: 200, height: 50 },
    ]) {
      const p = placePopover(card, pop, frame);
      expect(overlaps({ ...p, ...pop }, card)).toBe(false);
      expect(inside(p)).toBe(true);
    }
    expect(placePopover({ left: 100, top: 100, width: 200, height: 60 }, pop, frame).side).toBe("right");
    expect(placePopover({ left: 560, top: 100, width: 200, height: 60 }, pop, frame).side).toBe("left");
    expect(placePopover({ left: 300, top: 100, width: 320, height: 60 }, pop, frame).side).toBe("below");
    expect(placePopover({ left: 300, top: 500, width: 320, height: 160 }, pop, frame).side).toBe("above");
  });

  it("stays inside the frame when no side has room", () => {
    const p = placePopover({ left: 100, top: 100, width: 700, height: 500 }, pop, frame);
    expect(inside(p)).toBe(true);
  });
});
