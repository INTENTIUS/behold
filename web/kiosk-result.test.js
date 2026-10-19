// behold#782: Watch's result card at the applied step, drawn with a DOM just big enough for it.
import { describe, expect, it } from "vitest";

describe("kiosk: the result card says Applied once (behold#782)", () => {
  const fakeDocument = () => {
    const make = (tag) => {
      const n = { tagName: tag, className: "", textContent: "", children: [], dataset: {}, style: {}, hidden: false };
      n.appendChild = (c) => (n.children.push(c), c);
      n.append = (...cs) => cs.forEach((c) => n.children.push(typeof c === "string" ? { tagName: "#text", textContent: c, children: [] } : c));
      n.replaceChildren = () => (n.children = []);
      n.addEventListener = () => {};
      return n;
    };
    return { createElement: make };
  };

  it("leads with its first count and leaves the step's line to the caption", async () => {
    const { drawResult } = await import("./kiosk.js");
    const was = globalThis.document;
    globalThis.document = fakeDocument();
    try {
      const host = document.createElement("aside");
      const model = { head: "Applied", line: "All fifteen roots are in.", counts: ["3 waves applied", "1 created, 6 updated"], waves: [] };
      drawResult(host, model, { waveTraces: {} });
      expect(host.children.map((c) => [c.className, c.textContent || c.children.map((x) => x.textContent).join(" | ")])).toEqual([
        ["k-result-head", "3 waves applied"],
        ["k-result-counts", "1 created, 6 updated"],
      ]);
      // No count: the head says the step.
      drawResult(host, { ...model, counts: [] }, { waveTraces: {} });
      expect(host.children.map((c) => c.textContent)).toEqual(["Applied"]);
    } finally {
      globalThis.document = was;
    }
  });
});
