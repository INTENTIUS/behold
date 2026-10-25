import { describe, expect, it } from "vitest";
import { ATMOS_TIP, CHANT_TIPS, DEFAULT_TIPS, EDGE, LINK_RESUME_MS, TERRAGRUNT_TIP, TIP_FADE_MS, TIP_MIN_MS, TIP_QUIET_MS, TIP_WAIT_MS, actTip, createTipSequencer, dockCorner, holdMs, safeLink, shouldDismiss } from "./kiosk-ask-tips.js";

function rig(opts = {}) {
  const log = [];
  let t = 0;
  const timers = [];
  const seq = createTipSequencer({
    show: (tip) => log.push(["show", tip.title, t]),
    hide: () => log.push(["hide", t]),
    setTimer: (f, ms) => {
      const x = { f, at: t + ms };
      timers.push(x);
      return x;
    },
    clearTimer: (x) => {
      const i = timers.indexOf(x);
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => t,
    ...opts,
  });
  const advance = (ms) => {
    const to = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      t = next.at;
      next.f();
    }
    t = to;
  };
  return { seq, log, advance };
}
const tips = [1, 2, 3].map((n) => ({ title: `T${n}`, body: `B${n}` }));
const busy = (id, extra = {}) => ({ busy: true, id, cycle: 1, scenario: "s", step: "applying", tips: null, ...extra });
const idle = { busy: false, id: null, tips: null };
const shows = (log) => log.filter((x) => x[0] === "show");

describe("tip cards: the terminal wins", () => {
  it("waits for the busy line to have run 6 s, then shows the step's first tip", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { tips }));
    advance(TIP_WAIT_MS - 1);
    expect(log).toEqual([]);
    advance(1);
    expect(log).toEqual([["show", "T1", TIP_WAIT_MS]]);
  });
  it("shows nothing for a busy line shorter than the wait (a prompt's 1.2 s think)", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { tips }));
    advance(1_200);
    seq.busy(idle);
    advance(60_000);
    expect(log).toEqual([]);
  });
  it("takes the tip down the moment the busy line ends, or any new line starts", () => {
    for (const end of [(s) => s.busy(idle), (s) => s.line(), (s) => s.busy(busy("b"))]) {
      const { seq, log, advance } = rig();
      seq.busy(busy("a", { tips }));
      advance(TIP_WAIT_MS + 1_000);
      end(seq);
      expect(log).toEqual([["show", "T1", TIP_WAIT_MS], ["hide", TIP_WAIT_MS + 1_000]]);
    }
  });
  it("starts no tip in the 2 s after a terminal event, even when the busy line is old enough", () => {
    const { seq, log, advance } = rig({ pick: () => ({ title: "D", body: "d" }) });
    seq.busy(busy("a"));
    advance(TIP_WAIT_MS - 500);
    seq.line();
    advance(TIP_QUIET_MS - 1);
    expect(log).toEqual([]);
    advance(1);
    expect(log).toEqual([["show", "D", TIP_WAIT_MS - 500 + TIP_QUIET_MS]]);
  });
  it("keeps a tip its reading time while the wait lasts, then hides it and shows no other", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { tips }));
    advance(TIP_WAIT_MS + TIP_MIN_MS);
    expect(log).toEqual([["show", "T1", TIP_WAIT_MS], ["hide", TIP_WAIT_MS + TIP_MIN_MS]]);
    advance(120_000);
    expect(log).toHaveLength(2);
  });
  it("shows one tip per act: later waits of the same scenario show none, the next scenario's do", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { tips }));
    advance(30_000);
    seq.busy(busy("b", { tips }));
    advance(30_000);
    seq.busy(busy("c", { tips, step: "applied" }));
    advance(30_000);
    expect(shows(log)).toHaveLength(1);
    seq.busy(busy("d", { tips, scenario: "s2" }));
    advance(TIP_WAIT_MS);
    expect(shows(log)).toHaveLength(2);
    seq.busy(busy("e", { tips, cycle: 2 }));
    advance(TIP_WAIT_MS);
    expect(shows(log)).toHaveLength(3);
  });
  it("keeps the act's tip for a later wait when there was no room for it", () => {
    let room = false;
    const { seq, log, advance } = rig();
    const r = rig({ show: (tip) => (room ? (log.push(["show", tip.title]), true) : false) });
    r.seq.busy(busy("a", { tips }));
    r.advance(30_000);
    expect(log).toEqual([]);
    room = true;
    r.seq.busy(busy("b", { tips }));
    r.advance(TIP_WAIT_MS);
    expect(log).toEqual([["show", "T1"]]);
    expect(seq.current()).toBe(null);
    advance(0);
  });
  it("holds a long card longer than the minimum: about 3 words a second", () => {
    expect(holdMs({ title: "Hi", body: "short" })).toBe(TIP_MIN_MS);
    const long = { title: "All at once", body: "word ".repeat(30).trim() };
    expect(holdMs(long)).toBe(3_000 + 33 * 330);
  });
  it("ignores a repeat of the same busy line, and shows nothing while the Tips switch is off", () => {
    let on = false;
    const { seq, log, advance } = rig({ enabled: () => on });
    seq.busy(busy("a", { tips }));
    advance(30_000);
    expect(log).toEqual([]);
    on = true;
    seq.busy(busy("b", { tips }));
    advance(TIP_WAIT_MS - 1);
    seq.busy(busy("b", { tips }));
    advance(1);
    expect(shows(log)).toHaveLength(1);
    seq.off();
    expect(log.at(-1)[0]).toBe("hide");
  });
  it("a card the viewer closed is gone without a second hide, and the act is spent", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { tips }));
    advance(TIP_WAIT_MS);
    seq.dismiss();
    seq.busy(idle);
    seq.busy(busy("b", { tips }));
    advance(60_000);
    expect(log).toEqual([["show", "T1", TIP_WAIT_MS]]);
  });
  it("fades well inside 400 ms", () => {
    expect(TIP_FADE_MS).toBeLessThan(400);
  });
});

describe("tip cards: one built-in tip per act", () => {
  it("gives a create act the known-after-apply card and any other act the tool's card", () => {
    expect(actTip("choudoufu-compose-create")).toBe(DEFAULT_TIPS[0]);
    expect(actTip("choudoufu-compose-edit")).toBe(DEFAULT_TIPS[2]);
    expect(actTip("b-composed").title).toBe("choudoufu");
    expect(actTip("chant-compose-create")).toBe(CHANT_TIPS[1]);
    expect(actTip("chant-compose-edit")).toBe(CHANT_TIPS[0]);
    expect(actTip("terragrunt-choudoufu-create")).toBe(TERRAGRUNT_TIP);
    expect(actTip("atmos-choudoufu-create")).toBe(ATMOS_TIP);
    expect(actTip("terragrunt-choudoufu-edit").title).toBe("choudoufu");
  });
  it("uses the act's built-in tip when the step has none of its own", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { scenario: "chant-compose-edit" }));
    advance(TIP_WAIT_MS);
    expect(log).toEqual([["show", "One plan, one note", TIP_WAIT_MS]]);
  });
  it("keeps other products' names off the Terragrunt, Atmos and chant demos' cards", () => {
    for (const sc of ["terragrunt-choudoufu-create", "terragrunt-choudoufu-edit", "atmos-choudoufu-create", "atmos-choudoufu-edit"]) expect(`${actTip(sc).title} ${actTip(sc).body}`).not.toMatch(/terragucci/);
    expect(`${ATMOS_TIP.body}`).not.toMatch(/terragrunt|same apply|one apply/i);
    expect(`${TERRAGRUNT_TIP.body}`).not.toMatch(/atmos/i);
    for (const sc of ["chant-compose-edit", "chant-compose-create"]) expect(`${actTip(sc).title} ${actTip(sc).body} ${actTip(sc).link.url}`).not.toMatch(/choudoufu|terragucci|terragrunt|atmos|opentofu/i);
  });
  it("shows a plain string tip as a body with no title, and drops a tip with no body", () => {
    const shown = [];
    const seq = createTipSequencer({ show: (t) => shown.push(t), hide() {}, pick: () => null, waitMs: 0, quietMs: 0, setTimer: (f) => (f(), 1), clearTimer() {}, now: () => 0 });
    seq.busy({ busy: true, id: "b1", cycle: 1, scenario: "atmos-choudoufu-edit", tips: ["Plain words.", { title: "T", body: "B" }, { title: "No body" }, 4] });
    expect(shown).toEqual([{ body: "Plain words." }]);
  });
});

describe("tip cards: links", () => {
  it("allows only https on intentius.io or github.com/INTENTIUS in a step's own tips", () => {
    expect(safeLink({ label: "L", url: "https://intentius.io/a/" })).toEqual({ label: "L", url: "https://intentius.io/a/" });
    expect(safeLink({ url: "https://www.intentius.io/a" }).label).toBe("Read how");
    expect(safeLink({ url: "https://github.com/INTENTIUS/choudoufu" })).not.toBeNull();
    for (const url of ["http://intentius.io/", "https://evil.example/", "https://intentius.io.evil.example/", "https://github.com/other/x", "https://github.com/INTENTIUSX/x", "https://user@intentius.io/", "javascript:alert(1)", "nope"]) {
      expect(safeLink({ label: "L", url })).toBeNull();
    }
    expect(safeLink(null)).toBeNull();
  });
  it("drops a bad link from a step's own tip and keeps the card", () => {
    const shown = [];
    const r = rig({ show: (tip) => shown.push(tip), waitMs: 0, quietMs: 0 });
    r.seq.busy(busy("a", { tips: [{ title: "T", body: "b", link: { label: "x", url: "https://evil.example/" } }] }));
    r.advance(0);
    expect(shown).toEqual([{ title: "T", body: "b" }]);
  });
  it("gives the built-in links their exact URLs", () => {
    const by = Object.fromEntries(DEFAULT_TIPS.map((t) => [t.title, t.link]));
    expect(by["All at once"]).toEqual({ label: "How it plans across estates", url: "https://intentius.io/choudoufu/how-it-works/across-estates/" });
    expect(by.choudoufu).toEqual({ label: "How the locking works", url: "https://intentius.io/choudoufu/how-it-works/locking/" });
    expect(TERRAGRUNT_TIP.link.url).toBe("https://docs.terragrunt.com/features/stacks/run-queue/#saving-opentofuterraform-plan-output");
    expect(ATMOS_TIP.link.url).toBe("https://atmos.tools/functions/yaml/terraform.output");
  });
  it("keeps the audited wording of the built-in bodies", () => {
    const by = Object.fromEntries(DEFAULT_TIPS.map((t) => [t.title, t.body]));
    expect(by["All at once"]).toBe("Every estate plans together. The plan marks where the new subnet's id goes, and the same apply fills it in. With separate state runs, a downstream root sees that id only after its upstream applies.");
    expect(by.choudoufu).toBe("choudoufu is a fork of OpenTofu. A root that calls your estates as modules plans and applies them in one pass, and each estate keeps its own records. Resource-level locking at the cloud level.");
    expect(TERRAGRUNT_TIP.body).toBe("Terragrunt plans a unit whose upstream isn't applied yet with mock outputs. With choudoufu, the plan shows the real subnet id as known after apply. One apply fills it in.");
    expect(ATMOS_TIP.body).toBe("Atmos plans each component against its upstream's last applied outputs, or a mock default. With choudoufu, one plan covers every component. The merge applies each one exactly as reviewed.");
    for (const t of [...DEFAULT_TIPS, TERRAGRUNT_TIP, ATMOS_TIP, ...CHANT_TIPS]) expect(t.body).not.toMatch(/atomic|transaction/i);
  });
  it("hover pauses a linked card; leaving resumes with at least 3 s left", () => {
    const { seq, log, advance } = rig({ waitMs: 0, quietMs: 0 });
    seq.busy(busy("a", { tips: [{ title: "A", body: "a", link: { label: "L", url: "https://intentius.io/a/" } }] }));
    advance(2_000);
    seq.pause();
    advance(60_000);
    expect(log).toHaveLength(1);
    seq.resume();
    advance(TIP_MIN_MS - 2_000 - 1);
    expect(log).toHaveLength(1);
    advance(1);
    expect(log.at(-1)[0]).toBe("hide");
  });
  it("gives at least 3 s after leaving when little was left, and does not pause a card without a link", () => {
    const { seq, log, advance } = rig({ waitMs: 0, quietMs: 0 });
    seq.busy(busy("a", { tips: [{ title: "A", body: "a", link: { label: "L", url: "https://intentius.io/a/" } }] }));
    advance(TIP_MIN_MS - 500);
    seq.pause();
    advance(5_000);
    seq.resume();
    advance(LINK_RESUME_MS - 1);
    expect(log).toHaveLength(1);
    advance(1);
    expect(log).toHaveLength(2);
    const r = rig({ waitMs: 0, quietMs: 0 });
    r.seq.busy(busy("a", { tips }));
    r.advance(0);
    r.seq.pause();
    r.advance(TIP_MIN_MS);
    expect(r.log.at(-1)[0]).toBe("hide");
  });
});

describe("tip cards: the dock", () => {
  const area = { left: 0, top: 0, width: 1000, height: 500 };
  it("docks top right when nothing lit is there", () => {
    expect(dockCorner(area, 300, 100, [])).toEqual({ corner: "top-right", left: 1000 - EDGE - 300, top: EDGE });
  });
  it("moves to the next clear corner when a lit box (or its lines) is in the way", () => {
    expect(dockCorner(area, 300, 100, [{ left: 800, top: 30, width: 100, height: 40 }]).corner).toBe("top-left");
    expect(dockCorner(area, 300, 100, [{ left: 800, top: 30, width: 100, height: 40 }, { left: 50, top: 50, width: 60, height: 40 }]).corner).toBe("bottom-right");
    // A box under the card's foot still counts: its attribute lines hang below it.
    expect(dockCorner(area, 300, 100, [{ left: 800, top: 140, width: 100, height: 10 }]).corner).toBe("top-right");
    expect(dockCorner(area, 300, 100, [{ left: 800, top: 70, width: 100, height: 10 }]).corner).toBe("top-left");
  });
  it("gives no corner when every one is covered or the card does not fit", () => {
    expect(dockCorner(area, 300, 100, [{ left: 0, top: 0, width: 1000, height: 500 }])).toBeNull();
    expect(dockCorner({ left: 0, top: 0, width: 200, height: 500 }, 300, 100, [])).toBeNull();
    expect(dockCorner(null, 300, 100, [])).toBeNull();
  });
});

describe("tip cards: a press outside closes", () => {
  const host = {};
  const inside = { closest: (sel) => (sel.includes(".eh-modal") ? {} : null) };
  const outside = { closest: () => null };
  it("closes on a press outside the card, not on one inside (its link)", () => {
    expect(shouldDismiss(outside, host)).toBe(true);
    expect(shouldDismiss(inside, host)).toBe(false);
    expect(shouldDismiss(null, host)).toBe(false);
  });
});

describe("tip cards: a wait about to end", () => {
  it("shows no tip when the busy line is due to end before it could be read, and keeps the act's tip", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { tips, until: TIP_WAIT_MS + 1_000 }));
    advance(30_000);
    expect(log).toEqual([]);
    seq.busy(busy("b", { tips, until: 30_000 + TIP_WAIT_MS + TIP_MIN_MS + 1 }));
    advance(TIP_WAIT_MS);
    expect(shows(log)).toHaveLength(1);
  });
  it("shows the tip when the due time has passed (the driver is late) or is unknown", () => {
    const { seq, log, advance } = rig();
    advance(10_000);
    seq.busy(busy("a", { tips, until: 5_000 }));
    advance(TIP_WAIT_MS);
    expect(shows(log)).toHaveLength(1);
  });
});
