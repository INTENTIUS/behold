import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { demoProblem, readDemo } from "./terragucci-demo.ts";
import type { TerragucciSource } from "./terragucci-source.ts";

const FIXTURES = join(import.meta.dirname, "__fixtures__", "terragucci-demo");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;
const source = (doc: unknown): TerragucciSource => ({ kind: "dir", location: "fx", read: async () => JSON.stringify(doc) });
const about = { changes: "Network's port goes from 8080 to 9090.", watch: "Wave 2 fails partway.", shows: "Nothing here is atomic." };

describe("demo.json's about (behold#571)", () => {
  it("passes the scenario's card through", async () => {
    const a = await readDemo(source({ ...fixture("demo-failed.json"), about }));
    expect("demo" in a && a.demo && a.demo.about).toEqual(about);
  });

  it("reads a demo.json without about, or with null, as no card", async () => {
    for (const doc of [fixture("demo-failed.json"), { ...fixture("demo-reset.json"), about: null }]) {
      const a = await readDemo(source(doc));
      expect(a.demo).not.toBeNull();
      expect(a.demo!.about).toBeNull();
    }
  });

  it("keeps only the three fields", async () => {
    const a = await readDemo(source({ ...fixture("demo-failed.json"), about: { ...about, extra: "x" } }));
    expect(a.demo!.about).toEqual(about);
  });

  it("refuses an about that is not three non-empty strings", async () => {
    const base = fixture("demo-failed.json");
    expect(demoProblem({ ...base, about: "text" })).toMatch(/about is neither an object nor null/);
    expect(demoProblem({ ...base, about: [] })).toMatch(/about is neither an object nor null/);
    expect(demoProblem({ ...base, about: { ...about, watch: 3 } })).toMatch(/about\.watch/);
    expect(demoProblem({ ...base, about: { changes: about.changes, watch: about.watch } })).toMatch(/about\.shows/);
    expect(demoProblem({ ...base, about: { ...about, changes: "  " } })).toMatch(/about\.changes/);
    const a = await readDemo(source({ ...base, about: { ...about, shows: null } }));
    expect("error" in a && a.error).toMatch(/not the demo's format: about\.shows/);
  });
});

describe("demo.json's intro, name, scenarios and index (behold#571)", () => {
  const intro = "One change can touch many Terraform states, and this demo shows how terragucci applies them in order.";
  it("reads them when demo.json has them", async () => {
    const a = await readDemo(source({ ...fixture("demo-waiting.json"), intro: `  ${intro} `, name: "a new subnet", scenarios: 5, index: 2 }));
    expect(a.demo!.intro).toBe(intro);
    expect(a.demo!.name).toBe("a new subnet");
    expect(a.demo!.scenarios).toBe(5);
    expect(a.demo!.index).toBe(2);
  });
  it("reads a demo.json without them as null", async () => {
    const a = await readDemo(source(fixture("demo-waiting.json")));
    expect([a.demo!.intro, a.demo!.name, a.demo!.scenarios, a.demo!.index]).toEqual([null, null, null, null]);
  });
  it("reads the base's scenarios 0 and index null as none", async () => {
    const a = await readDemo(source({ ...fixture("demo-reset.json"), scenarios: 0, index: null, name: null }));
    expect([a.demo!.name, a.demo!.scenarios, a.demo!.index]).toEqual([null, null, null]);
  });
  it("leaves out one of the wrong type and keeps the narration", async () => {
    const a = await readDemo(source({ ...fixture("demo-waiting.json"), intro: "   ", name: 3, scenarios: "5", index: 0 }));
    expect(a.demo!.step).toBe("waiting");
    expect([a.demo!.intro, a.demo!.name, a.demo!.scenarios, a.demo!.index]).toEqual([null, null, null, null]);
  });
});

describe("demo.json's delivery line (behold#571)", () => {
  const delivery = "Counted from this demo loop's own runs, where the failure scenario fails on purpose each cycle.";
  it("reads it when demo.json has it, and null without it or of the wrong type", async () => {
    expect((await readDemo(source({ ...fixture("demo-waiting.json"), delivery: ` ${delivery} ` }))).demo!.delivery).toBe(delivery);
    expect((await readDemo(source(fixture("demo-waiting.json")))).demo!.delivery).toBeNull();
    const a = await readDemo(source({ ...fixture("demo-waiting.json"), delivery: 7 }));
    expect([a.demo!.step, a.demo!.delivery]).toEqual(["waiting", null]);
  });
});

describe("demo.json's next.from (behold#571)", () => {
  const next = { action: "approve wave-2", from: "2026-10-20T10:04:00Z", at: "2026-10-20T10:04:20Z" };

  it("passes from through, so the kiosk's bar fills from when the driver started waiting", async () => {
    const a = await readDemo(source({ ...fixture("demo-failed.json"), next }));
    expect(a.demo!.next).toEqual(next);
  });

  it("reads a next without from (drivers before terragucci 0.4.34) as before", async () => {
    const a = await readDemo(source({ ...fixture("demo-failed.json"), next: { action: next.action, at: next.at } }));
    expect(a.demo!.next).toEqual({ action: next.action, at: next.at });
  });

  it("refuses a from that is not a UTC time", () => {
    expect(demoProblem({ ...fixture("demo-failed.json"), next: { ...next, from: "soon" } })).toMatch(/next\.from/);
  });
});

describe("demo.json's ask, asks, opening and closing (behold#936)", () => {
  const ask = { prompt: "Show me everything.", action: null, reply: "{dependents} resources.", status: null, light: ["network/terraform_data.subnet"], paths: true, ghost: false };

  it("reads a demo.json without them as none", async () => {
    const a = await readDemo(source(fixture("demo-failed.json")));
    expect(a.demo).toMatchObject({ ask: null, asks: null, opening: null, closing: null });
  });

  it("passes an ask, asks, opening and closing through", async () => {
    const a = await readDemo(source({ ...fixture("demo-failed.json"), ask, asks: [ask, { action: "You approve.", prompt: null }], opening: " Three states. ", closing: "1 apply." }));
    expect(a.demo!.ask).toEqual(ask);
    expect(a.demo!.asks).toHaveLength(2);
    expect(a.demo!.asks![1]).toEqual({ prompt: null, action: "You approve.", reply: null, status: null, light: null, paths: null, ghost: null });
    expect(a.demo!.opening).toBe("Three states.");
    expect(a.demo!.closing).toBe("1 apply.");
  });

  it("drops a field of the wrong type to null, never refusing the narration", async () => {
    const a = await readDemo(source({ ...fixture("demo-failed.json"), ask: { prompt: "p", reply: 3, light: "x", paths: "yes", ghost: 1 }, opening: 5, closing: ["x"] }));
    expect(a.demo!.ask).toEqual({ prompt: "p", action: null, reply: null, status: null, light: null, paths: null, ghost: null });
    expect(a.demo!.opening).toBeNull();
    expect(a.demo!.closing).toBeNull();
  });

  it("drops an ask that is not an object or has no prompt, action or reply, and keeps a prompt over an action", async () => {
    for (const bad of ["x", [], { light: ["a/b"] }, { prompt: 4, action: 4, reply: 4 }]) {
      const a = await readDemo(source({ ...fixture("demo-failed.json"), ask: bad, asks: bad }));
      expect(a.demo).toMatchObject({ ask: null, asks: null });
    }
    const both = await readDemo(source({ ...fixture("demo-failed.json"), ask: { prompt: "p", action: "a" } }));
    expect(both.demo!.ask).toMatchObject({ prompt: "p", action: null });
  });

  it("keeps a tip's link only for https intentius.io or github.com/INTENTIUS", async () => {
    const l = (url: string, label?: string) => ({ title: "T", body: "b", link: { url, label } });
    const tips = [
      l("https://intentius.io/x/", "Go"),
      l("https://github.com/INTENTIUS/choudoufu"),
      l("http://intentius.io/x/", "no"),
      l("https://evil.example/x", "no"),
      l("https://intentius.io.evil.example/", "no"),
      l("https://github.com/other/repo", "no"),
      l("https://github.com/INTENTIUSX/repo", "no"),
      l("javascript:alert(1)", "no"),
    ];
    const a = await readDemo(source({ ...fixture("demo-failed.json"), ask: { status: "Applying", tips } }));
    const got = a.demo!.ask!.tips!.map((t) => t.link);
    expect(got[0]).toEqual({ label: "Go", url: "https://intentius.io/x/" });
    expect(got[1]).toEqual({ label: "Read how", url: "https://github.com/INTENTIUS/choudoufu" });
    expect(got.slice(2).every((x) => x === undefined)).toBe(true);
    expect(a.demo!.ask!.tips).toHaveLength(8);
  });
  it("passes tips through, keeping the valid cards in order; a plain string is a body with no title, and a tip with no body is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tips = [{ title: " A ", body: " one " }, { title: "", body: "x" }, { title: "B" }, "no", 7, { title: "C", body: "three" }];
    const a = await readDemo(source({ ...fixture("demo-failed.json"), ask: { status: "Applying", tips }, asks: [{ prompt: "p", tips: [] }, { status: "s", tips: "nope" }] }));
    expect(a.demo!.ask!.tips).toEqual([{ title: "A", body: "one" }, { body: "x" }, { body: "no" }, { title: "C", body: "three" }]);
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([expect.stringContaining("needs a body"), expect.stringContaining("needs a body")]);
    warn.mockRestore();
    expect("tips" in a.demo!.asks![0]!).toBe(false);
    expect("tips" in a.demo!.asks![1]!).toBe(false);
  });

  it("passes diff through: strings only, at most 120 characters each, at most 8 lines", async () => {
    const diff = ["+ network  aws_subnet.subnet_b  10.0.2.0/24", 3, "", "x".repeat(121), "~ edge     terraform_data.allowlist  + 10.0.2.0/24", ...Array.from({ length: 9 }, (_, i) => `+ l${i}`)];
    const a = await readDemo(source({ ...fixture("demo-failed.json"), ask: { reply: "Opened.", diff }, asks: [{ prompt: "p", diff: "nope" }, { prompt: "q", diff: [] }] }));
    expect(a.demo!.ask!.diff).toEqual([diff[0], diff[4], "+ l0", "+ l1", "+ l2", "+ l3", "+ l4", "+ l5"]);
    expect("diff" in a.demo!.asks![0]!).toBe(false);
    expect("diff" in a.demo!.asks![1]!).toBe(false);
  });

  it("passes status through, and an ask with only a status is valid", async () => {
    const a = await readDemo(source({ ...fixture("demo-failed.json"), ask: { status: " Applying across estates. " }, asks: [{ prompt: "p", status: "Waiting" }, { status: "Applying" }, { status: "" }] }));
    expect(a.demo!.ask).toEqual({ prompt: null, action: null, reply: null, status: "Applying across estates.", light: null, paths: null, ghost: null });
    expect(a.demo!.asks!.map((x) => x.status)).toEqual(["Waiting", "Applying"]);
  });

  it("keeps the valid beats of asks", async () => {
    const a = await readDemo(source({ ...fixture("demo-failed.json"), asks: [ask, 7, { light: ["a/b"] }, ask] }));
    expect(a.demo!.asks).toHaveLength(2);
  });

  it("keeps a reply with no prompt or action, as an applied step has", async () => {
    const a = await readDemo(source({ ...fixture("demo-failed.json"), ask: { prompt: null, action: null, reply: "Applied. {roots} states, 1 plan, 1 apply." } }));
    expect(a.demo!.ask).toMatchObject({ prompt: null, action: null, reply: "Applied. {roots} states, 1 plan, 1 apply." });
  });
});

describe("demo.json's act and acts", () => {
  it("keeps the scenario's act within its own demo, and drops a missing or bad one", async () => {
    const a = await readDemo(source({ ...fixture("demo-waiting.json"), scenarios: 6, index: 4, act: 2, acts: 2 }));
    expect([a.demo!.act, a.demo!.acts]).toEqual([2, 2]);
    const b = await readDemo(source({ ...fixture("demo-waiting.json"), act: "two" }));
    expect([b.demo!.act, b.demo!.acts]).toEqual([null, null]);
  });
});
