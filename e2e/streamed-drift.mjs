// behold#998: the browser half of e2e/streamed-drift-e2e.sh.
//
// Opens the served choudoufu-estate demo, starts "Stream drift card by card:
// monolith" from the palette, and watches the monolith's cards with a
// MutationObserver in the page. The fake chant (e2e/fixtures/fake-chant-drift)
// answers each `--resource` with a start, a pause, one record and a settle,
// and stays silent for one resource. Asserted from what the page drew, never
// from an exit code:
//
//   1. every card was reading before it was coloured, and none is reading at the end;
//   2. the cards were coloured one by one: no two within MIN_GAP_MS of each
//      other, and when the first was coloured at least ten were still uncoloured;
//   3. the silent resource ends not-observed / not-reached, neutral;
//   4. the drifted one is warn, the unclaimed one warn, the rest in sync, good.
//
// Usage: node e2e/streamed-drift.mjs <url> <silent> <drifted> <unclaimed> <step secs>
import { chromium } from "playwright";

const [url, SILENT, DRIFTED, UNCLAIMED, STEP] = process.argv.slice(2);
const MEMBER = "monolith";
const CARDS = 21;
const MIN_GAP_MS = Math.round(Number(STEP || "0.6") * 1000 * 0.5);
const DONE_MS = 180_000;

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}

async function launch() {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(url);
  const sel = `#graph svg [data-node-id^="${MEMBER}/"]`;
  await page.waitForFunction((s) => document.querySelectorAll(s).length > 0, sel, { timeout: 120_000 });
  // The progressive overlay settles first, so the stream is the only thing moving the cards.
  await page.waitForFunction(() => !document.querySelector("#graph [data-pending-read]"), null, { timeout: 120_000 });
  const ids = await page.$$eval(sel, (gs) => gs.map((g) => g.getAttribute("data-node-id")));
  check(`the monolith draws its ${CARDS} cards`, ids.length === CARDS, `got ${ids.length}`);

  // Every change to a card's reading mark or drift status, timestamped in the page.
  await page.evaluate((s) => {
    window.__drift = [];
    const t0 = performance.now();
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        const g = m.target;
        const id = g.getAttribute && g.getAttribute("data-node-id");
        if (!id || !g.matches(s)) continue;
        if (m.attributeName === "data-drift-reading") window.__drift.push({ t: performance.now() - t0, id, kind: "reading", on: g.hasAttribute("data-drift-reading") });
        if (m.attributeName === "data-drift-status") window.__drift.push({ t: performance.now() - t0, id, kind: "status", value: g.getAttribute("data-drift-status") });
      }
    });
    obs.observe(document.querySelector("#graph"), { subtree: true, attributes: true, attributeFilter: ["data-drift-reading", "data-drift-status"] });
  }, sel);

  await page.click("#hintk");
  await page.fill("#pal-input", `Stream drift card by card: ${MEMBER}`);
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");

  await page.waitForFunction(
    ({ s, n }) => [...document.querySelectorAll(s)].filter((g) => g.hasAttribute("data-drift-status") && !g.hasAttribute("data-drift-reading")).length >= n,
    { s: sel, n: CARDS },
    { timeout: DONE_MS, polling: 100 },
  ).catch(() => {});

  const events = await page.evaluate(() => window.__drift);
  const final = await page.$$eval(sel, (gs) => gs.map((g) => ({
    id: g.getAttribute("data-node-id"),
    status: g.getAttribute("data-drift-status"),
    tone: g.getAttribute("data-drift-tone"),
    notReached: g.hasAttribute("data-drift-not-reached"),
    reading: g.hasAttribute("data-drift-reading"),
    tip: (g.querySelector("title[data-drift]") || {}).textContent || "",
  })));
  const byId = new Map(final.map((c) => [c.id, c]));

  // 1. reading, then a colour.
  const firstReading = new Map();
  const firstStatus = new Map();
  for (const e of events) {
    if (e.kind === "reading" && e.on && !firstReading.has(e.id)) firstReading.set(e.id, e.t);
    if (e.kind === "status" && !firstStatus.has(e.id)) firstStatus.set(e.id, e.t);
  }
  check("every card was coloured by the stream", final.every((c) => c.status), final.filter((c) => !c.status).map((c) => c.id).join(", "));
  const readFirst = ids.filter((id) => firstReading.has(id) && firstStatus.has(id) && firstReading.get(id) < firstStatus.get(id));
  check("every card read as reading before its colour arrived", readFirst.length === ids.length, `${readFirst.length} of ${ids.length}`);
  check("no card is still reading after the stream", final.every((c) => !c.reading), final.filter((c) => c.reading).map((c) => c.id).join(", "));

  // 2. one by one.
  const order = [...firstStatus.entries()].sort((a, b) => a[1] - b[1]);
  const gaps = order.slice(1).map(([, t], i) => t - order[i][1]);
  const close = gaps.filter((g) => g < MIN_GAP_MS).length;
  check(`cards changed colour one by one (each at least ${MIN_GAP_MS} ms after the one before)`, order.length === CARDS && close === 0, `${close} pairs closer, gaps ${gaps.map((g) => Math.round(g)).join(",")}`);
  const uncolouredAtFirst = order.length ? order.filter(([, t]) => t > order[0][1]).length : 0;
  check("when the first card was coloured, the others were not yet", uncolouredAtFirst >= 10, `${uncolouredAtFirst} still uncoloured`);

  // 3. the silent resource.
  const silent = byId.get(`${MEMBER}/${SILENT}`);
  check(
    `${SILENT}, which never reported, ends not-observed / not-reached`,
    !!silent && silent.status === "not-observed" && silent.notReached && silent.tone === "neutral" && /not-reached/.test(silent.tip),
    JSON.stringify(silent),
  );

  // 4. the others.
  const drifted = byId.get(`${MEMBER}/${DRIFTED}`);
  check(`${DRIFTED} is drifted, warn`, !!drifted && drifted.status === "drifted" && drifted.tone === "warn", JSON.stringify(drifted));
  const unclaimed = byId.get(`${MEMBER}/${UNCLAIMED}`);
  check(`${UNCLAIMED} is unclaimed, warn`, !!unclaimed && unclaimed.status === "unclaimed" && unclaimed.tone === "warn", JSON.stringify(unclaimed));
  const rest = final.filter((c) => ![SILENT, DRIFTED, UNCLAIMED].map((a) => `${MEMBER}/${a}`).includes(c.id));
  check("every other card is in sync, good", rest.every((c) => c.status === "in-sync" && c.tone === "good" && !c.notReached), rest.filter((c) => c.status !== "in-sync").map((c) => `${c.id}=${c.status}`).join(", "));
} finally {
  await browser.close();
}
if (failed) {
  console.error(`streamed drift e2e: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("streamed drift e2e: all green");
