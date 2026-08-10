// #199: the web/ regression net. Boots the SPA against smoke/stub.mjs (no
// chant, no Docker) and drives the panel's whole surface headless: every tab,
// drag-snap, collapse, ⌘K, a theme flip, a Scope render. Fails (exit 1) on
// any page error or broken invariant. `npm run smoke:ui`; screenshots land in
// smoke/shots/ (gitignored) for eyeballing a failure.
//
// Browser: tries the OS Chrome first (channel "chrome" — preinstalled on the
// GitHub ubuntu runners and on most dev machines), then playwright's own
// chromium if one is installed (`npx playwright install chromium`).
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startStub } from "./stub.mjs";
import { THEMES, DEFAULT_THEME } from "../web/themes.js";
import { tokensFor, hexToRgb, hexToOklch } from "../web/theme.js";

const PORT = 4689;
const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });

const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? "ok" : "FAIL"}  ${name}`);
  if (!ok) failures.push(name);
};

// ---- #229, part 1: the token derivation, checked without a browser ---------
// Nothing in the chrome is a fixed colour any more, so the two things worth
// asserting are (a) the pre-paint fallback IS the default theme's derivation,
// and (b) every one of the 552 palettes still derives chrome you can see.
const CHROME_TOKENS = ["rule", "focus", "active", "well", "shadow"];
const relLum = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const A = relLum(a), B = relLum(b);
  return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05);
};
const dL = (a, b) => Math.abs(hexToOklch(a).L - hexToOklch(b).L);

{
  const html = readFileSync(join(HERE, "..", "web", "index.html"), "utf8");
  const block = html.match(/:root\s*\{([^}]*)\}/);
  const fallback = Object.fromEntries([...(block ? block[1] : "").matchAll(/--([\w-]+)\s*:\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  const want = tokensFor(THEMES[DEFAULT_THEME]);
  const wantKeys = Object.keys(want).filter((k) => k !== "dark" && k !== "cat");
  const mismatched = wantKeys.filter((k) => fallback[k] !== String(want[k]).toLowerCase());
  check(`pre-paint fallback is ${DEFAULT_THEME}, token for token`, mismatched.length === 0 && Object.keys(fallback).length === wantKeys.length);
  if (mismatched.length) console.error("  fallback drift:", mismatched.map((k) => `--${k}: ${fallback[k] ?? "(missing)"} ≠ ${want[k]}`).join(", "));

  // Legible chrome across the whole corpus: a visible edge, a visible active
  // fill, a well you can tell from the background — and a fill that never
  // costs the label more than a third of the contrast it had on the panel.
  const RULES = {
    "every chrome token is a colour": (t, th) => CHROME_TOKENS.every((k) => /^#[0-9a-f]{6}$/i.test(t[k])),
    "--rule draws a visible edge on the panel": (t) => dL(t.rule, t.panel) >= 0.05,
    "--active fill is visible on the panel": (t) => dL(t.active, t.panel) >= 0.05,
    "--focus reads against the panel": (t) => dL(t.focus, t.panel) >= 0.05,
    "--well is distinguishable from the background": (t, th) => dL(t.well, th.bg) >= 0.02,
    "--fg stays legible on the --active fill": (t) => contrast(t.fg, t.active) >= contrast(t.fg, t.panel) * 0.6,
  };
  const n = Object.keys(THEMES).length;
  for (const [name, rule] of Object.entries(RULES)) {
    const bad = Object.values(THEMES).filter((th) => !rule(tokensFor(th), th)).map((th) => th.name);
    check(`${n} themes: ${name}`, bad.length === 0);
    if (bad.length) console.error("  offenders:", bad.slice(0, 8).join(", "), bad.length > 8 ? `… (${bad.length})` : "");
  }
}

async function launch() {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

const server = await startStub(PORT);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector("#graph svg [data-node-id]", { timeout: 20000 });
  await page.waitForTimeout(300);

  // Boot invariants: full-bleed graph, tabs-only panel, project in the title.
  check("graph renders nodes", (await page.locator("#graph [data-node-id]").count()) === 3);
  check("no app header", (await page.locator("header").count()) === 0);
  check("no panel title bar", (await page.locator("#panel-titlebar").count()) === 0);
  check("tab title names the project", (await page.title()).includes("stub-estate"));
  check("footer statusbar shows zoom + env", (await page.locator("#panel-foot #statusbar").innerText()).includes("env:"));
  await page.screenshot({ path: join(SHOTS, "1-boot.png") });

  // ---- #229, part 2: the identity actually reaches the DOM ----------------
  const cssVar = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  for (const k of CHROME_TOKENS) check(`--${k} is applied at :root`, /^#[0-9a-f]{6}$/i.test(await cssVar("--" + k)));
  // Data is mono; labels are not. The footer carries counts/env/tier, so it is
  // the honest probe for "the mono voice is wired".
  const fontOf = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily);
  check("statusbar (state) is mono", /mono/i.test(await fontOf("#statusbar")));
  check("panel headings (labels) are not mono", !/mono/i.test(await fontOf("#panel h3")));
  // Sharp controls inside a soft shell.
  const radiusOf = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  check("controls take the sharp radius", (await radiusOf("#panel .opt")) === "3px");
  check("the shell stays soft", (await radiusOf("#panel")) === "10px");
  // Tabs are FILLED, not underlined.
  const tabFill = await page.locator('#panel-tabs button[data-tab].active').evaluate((el) => getComputedStyle(el).backgroundColor);
  const tabIdle = await page.locator('#panel-tabs button[data-tab]:not(.active)').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  check("active tab is a fill", tabFill !== tabIdle && !/rgba\(0, 0, 0, 0\)/.test(tabFill));
  check("active tab has no underline", (await page.locator('#panel-tabs button[data-tab].active').evaluate((el) => getComputedStyle(el).borderBottomWidth)) === "0px");
  // Motion signature 1: the graph fades through on every render.
  check("graph fades through on render", (await page.locator("#graph svg").evaluate((el) => getComputedStyle(el).animationName)) === "graph-fade-through");
  // Inspect: keys are labels (sans), values are data (mono).
  await page.click('#graph [data-node-id="frontend"]');
  await page.waitForTimeout(100);
  check("inspect renders the node's identity", (await page.locator("#inspect dt").count()) > 0);
  check("inspect values are mono", /mono/i.test(await fontOf("#inspect dd")));
  check("inspect keys are not mono", !/mono/i.test(await fontOf("#inspect dt")));
  await page.screenshot({ path: join(SHOTS, "1b-inspect.png") });

  // Every tab renders its section.
  for (const [tab, probe] of [
    ["scope", "#tab-scope .opt"],
    ["substrates", "#substrates .sub"],
    ["model", "#tab-model .count-row"],
    ["deploy", "#actions"],
    ["view", "#panel-zoom .opt"],
  ]) {
    await page.click(`#panel-tabs button[data-tab="${tab}"]`);
    await page.waitForTimeout(100);
    check(`tab ${tab} renders`, (await page.locator(probe).count()) > 0);
  }
  check("substrates list all four", (await page.locator("#substrates .sub").count()) === 4);
  await page.click('#panel-tabs button[data-tab="scope"]');
  check("scope shows the loaded project", (await page.locator("#tab-scope").innerText()).includes("stub-estate"));
  check("scope shows the k8s cluster binding", (await page.locator("#tab-scope").innerText()).includes("stub-cluster"));
  await page.screenshot({ path: join(SHOTS, "2-scope.png") });

  // Drag from a tab button: moves the panel, docks to the corner, does NOT
  // switch tabs.
  await page.click('#panel-tabs button[data-tab="model"]');
  const tabBox = await page.locator('#panel-tabs button[data-tab="view"]').boundingBox();
  await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(1300, 850, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const docked = await page.locator("#panel").boundingBox();
  check("drag docks to the corner", Math.abs(docked.x + docked.width - (1400 - 12)) < 2 && Math.abs(docked.y + docked.height - (900 - 12)) < 2);
  check("drag does not switch tabs", await page.locator('#panel-body section[data-tab="model"]').isVisible());
  await page.screenshot({ path: join(SHOTS, "3-docked.png") });

  // Collapse to the strip; a tab click expands.
  await page.click("#panel-collapse");
  await page.waitForTimeout(150);
  check("collapses to the strip", (await page.locator("#panel").boundingBox()).height < 40);
  await page.click('#panel-tabs button[data-tab="view"]');
  await page.waitForTimeout(150);
  check("tab click expands", await page.locator("#panel-body").isVisible());

  // ⌘K from the strip pill: opens, filters, closes.
  await page.click("#hintk");
  check("palette opens", (await page.locator("#palette.on").count()) === 1);
  await page.fill("#pal-input", "panel");
  await page.waitForTimeout(100);
  check("palette filters to panel commands", (await page.locator("#pal-list .row").count()) >= 5);
  await page.screenshot({ path: join(SHOTS, "4-palette.png") });
  await page.keyboard.press("Escape");
  check("palette closes", (await page.locator("#palette.on").count()) === 0);

  // Motion signature 2 (#229): behold boots on the `local` overlay, where the
  // stub reports `worker` deployed; dropping to the source graph flips it back
  // to pending. The one node whose status changed pulses — in the colour it
  // just became — and the two that didn't stay still.
  await page.click('#panel-tabs button[data-tab="scope"]');
  await page.click('#tab-scope .opt:has-text("(source)")');
  await page.waitForSelector('#graph [data-node-id="worker"].status-changed', { timeout: 10000 });
  check("only the changed node pulses", (await page.locator("#graph [data-node-id].status-changed").count()) === 1);
  check(
    "the pulse wears the new status colour",
    (await page.locator('#graph [data-node-id="worker"]').evaluate((el) => el.style.getPropertyValue("--pulse"))) === "var(--pending)",
  );
  await page.screenshot({ path: join(SHOTS, "5-pulse.png") });

  // #227: the lexicon-native marks. pinhole paints a pack's `colored` glyph as
  // authored — its paint rides no `--pin-*` token — so recolorNodesByCategory,
  // which classifies elements by the token they came in on, must never claim
  // one. Read the mark's paint either side of the theme flip below: the boot
  // pass and the theme pass both walk every child of every [data-node-id].
  const markPaint = () =>
    page.evaluate(() => {
      const badge = document.querySelector('#graph [data-node-id="api"] [data-mark="badge"]');
      const detail = document.querySelector('#graph [data-node-id="api"] [data-mark="detail"]');
      const label = document.querySelector('#graph [data-node-id="api"] text');
      return {
        found: !!badge && !!detail,
        badge: badge && badge.getAttribute("style"),
        detail: detail && detail.getAttribute("fill"),
        // The role marker app.js stamps on the elements it DID claim — proof
        // the recolour pass ran at all, so "untouched" means something.
        badgeRole: badge && badge.getAttribute("data-cat"),
        labelRole: label && label.getAttribute("data-cat"),
      };
    });
  const markBefore = await markPaint();
  check("colored mark is in the DOM", markBefore.found);
  check("recolour pass ran (a --pin-text label got claimed)", markBefore.labelRole === "inkf");
  check("recolour leaves the colored mark unclassified", markBefore.badgeRole === null);

  // Theme flip: a light Ghostty theme re-derives the tokens without errors —
  // including #229's chrome tokens, which must all move with it.
  await page.click('#panel-tabs button[data-tab="view"]'); // the picker lives here
  const before = Object.fromEntries(await Promise.all(["--bg", ...CHROME_TOKENS.map((k) => "--" + k)].map(async (k) => [k, await cssVar(k)])));
  await page.selectOption("#panel-theme select", "Atom One Light");
  await page.waitForTimeout(300);
  const after = Object.fromEntries(await Promise.all(["--bg", ...CHROME_TOKENS.map((k) => "--" + k)].map(async (k) => [k, await cssVar(k)])));
  check("light theme applies", after["--bg"] !== "" && after["--bg"] !== before["--bg"]);
  for (const k of CHROME_TOKENS) check(`--${k} re-derives on theme switch`, /^#[0-9a-f]{6}$/i.test(after["--" + k]) && after["--" + k] !== before["--" + k]);
  await page.screenshot({ path: join(SHOTS, "6-light.png") });

  // …and the colored mark rode the flip out unchanged (#227), both authoring
  // styles the vendored corpus uses.
  const markAfter = await markPaint();
  check("colored mark keeps its authored style fill across a theme switch", markAfter.badge === markBefore.badge && /fill:#326ce5/.test(markAfter.badge || ""));
  check("colored mark keeps its authored fill attribute across a theme switch", markAfter.detail === "#ffffff");

  // ---- #228: hand layout — drag, resize, persist, reset -------------------
  // dagre places, you re-place. Everything below is driven through real pointer
  // input so the pan/click latch (`panMoved`) is exercised the way a hand does
  // it, not by poking the module's state.
  const LAYOUT_PREFIX = "behold.layout.";
  const layoutKeys = () => page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p)), LAYOUT_PREFIX);
  const storedDeltas = async () => {
    const [k] = await layoutKeys();
    return k ? JSON.parse(await page.evaluate((key) => localStorage.getItem(key), k)) : {};
  };
  const transformOf = (sel) => page.locator(sel).evaluate((el) => el.getAttribute("transform") || "");
  const edgePath = () => page.locator('#graph g[data-edge-from="api"] path.pin-edge-line').getAttribute("d");
  const boxWidth = async () => Number(await page.locator("#graph [data-layout-box] > rect").getAttribute("width"));
  const viewBox = () => page.locator("#graph svg").getAttribute("viewBox");
  const dragBy = async (box, dx, dy) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  };

  check("nothing is hand-placed on a fresh boot", (await layoutKeys()).length === 0);
  check("the reset control hides until it has something to reset", !(await page.locator("#layout-reset").isVisible()));

  // Screen pixels → viewBox units: the drag must land where the pointer went,
  // whatever the current zoom is.
  const scale = await page.evaluate(() => document.querySelector("#graph svg").getScreenCTM().a);
  const wantDx = 120 / scale;
  const wantDy = 70 / scale;
  const vbBeforeDrag = await viewBox();
  await dragBy(await page.locator('#graph [data-node-id="api"]').boundingBox(), 120, 70);

  const cardTf = await transformOf('#graph [data-node-id="api"]');
  const [gotDx, gotDy] = (cardTf.match(/translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/) || ["", "0", "0"]).slice(1).map(Number);
  check("dragging a card translates its group by the pointer delta, in viewBox units", Math.abs(gotDx - wantDx) < 2 && Math.abs(gotDy - wantDy) < 2);
  check("the delta rides ON TOP of the layout's own transform", /translate\([^)]*\)\s*translate\(\s*40/.test(cardTf));
  check("a drag on a card never pans the graph", (await viewBox()) === vbBeforeDrag);
  check("a drag is never also a click — the card is not selected", (await page.locator('#graph [data-node-id="api"].sel').count()) === 0);

  // Edge re-anchoring: the touched end moves with its node, the other stays on
  // pinhole's own anchor, and the bezier degrades to a straight line (#228
  // accepts the fallback explicitly).
  const anchored = await edgePath();
  const anchorNums = anchored.match(/-?[\d.]+/g).map(Number);
  check("the edge re-anchors as a straight line", /^M\s[-\d.]+\s[-\d.]+\sL\s[-\d.]+\s[-\d.]+$/.test(anchored));
  check("the displaced end carries its node's delta", Math.abs(anchorNums[0] - (115 + wantDx)) < 2 && Math.abs(anchorNums[1] - (112 + wantDy)) < 2);
  check("the untouched end stays exactly where pinhole put it", anchorNums[2] === 305 && anchorNums[3] === 112);

  const [key] = await layoutKeys();
  check("the layout is stored as behold.layout.<project>.<lens>", key === "behold.layout.estates-stub-estate.components");
  const afterCard = await storedDeltas();
  check("the delta is keyed by node id", Math.abs(afterCard.api.dx - wantDx) < 2 && Math.abs(afterCard.api.dy - wantDy) < 2);
  check("the reset control appears once something is hand-placed", await page.locator("#layout-reset").isVisible());

  // The containment box: a corner handle resizes it (children do NOT reflow).
  const boxW0 = await boxWidth();
  await dragBy(await page.locator("#graph [data-layout-resize]").boundingBox(), -80, 40);
  const boxW1 = await boxWidth();
  check("the corner handle resizes the containment box", Math.abs(boxW1 - (boxW0 - 80 / scale)) < 2);
  const afterBox = await storedDeltas();
  check("a box stores {dw,dh} under its own id", afterBox["box:wave-1"] && Math.abs(afterBox["box:wave-1"].dw + 80 / scale) < 2);
  await page.screenshot({ path: join(SHOTS, "7-layout.png") });

  // exportSvg() blobs `#graph svg`'s own outerHTML (no server round-trip), so
  // the displaced positions come along by construction — and the resize handles
  // do not, because their `opacity="0"` is an attribute, not a CSS rule.
  const serialized = await page.locator("#graph svg").evaluate((el) => el.outerHTML);
  check("an export carries the displaced card", serialized.includes(cardTf));
  check("an export carries the re-anchored edge", serialized.includes(anchored));
  check("an export does not carry a visible resize handle", /data-layout-resize="[^"]*"[^>]*opacity="0"/.test(serialized));

  // Reload: the layout is still there, applied onto a freshly fetched SVG.
  await page.reload();
  await page.waitForSelector("#graph svg [data-node-id]", { timeout: 20000 });
  await page.waitForTimeout(300);
  check("the card's placement survives a reload", (await transformOf('#graph [data-node-id="api"]')) === cardTf);
  check("the box's size survives a reload", Math.abs((await boxWidth()) - boxW1) < 0.5);
  check("the re-anchored edge is re-applied to the new SVG", (await edgePath()) === anchored);

  // A delta for a node that left the estate is dropped without a word (#228).
  await page.evaluate(
    ([k]) => {
      const d = JSON.parse(localStorage.getItem(k));
      d["a-node-that-no-longer-exists"] = { dx: 40, dy: 40 };
      localStorage.setItem(k, JSON.stringify(d));
    },
    [key],
  );
  await page.reload();
  await page.waitForSelector("#graph svg [data-node-id]", { timeout: 20000 });
  await page.waitForTimeout(300);
  check(
    "a delta for a node that left the estate is ignored, without error",
    (await page.locator("#graph [data-node-id]").count()) === 3 && (await transformOf('#graph [data-node-id="api"]')) === cardTf,
  );

  // Reset: back to dagre's placement, and the key goes with it.
  await page.click("#layout-reset");
  await page.waitForTimeout(150);
  check("reset restores the card", (await transformOf('#graph [data-node-id="api"]')) === "translate(40, 80)");
  check("reset restores the box", (await boxWidth()) === boxW0);
  check("reset restores the edge's original curve", (await edgePath()) === "M 115 112 C 115 112, 305 112, 305 112");
  check("reset clears this lens's key", (await layoutKeys()).length === 0);
  check("reset hides itself again", !(await page.locator("#layout-reset").isVisible()));

  // …and the two gestures that were there before still are.
  await page.click('#graph [data-node-id="api"]');
  await page.waitForTimeout(100);
  check("click-inspect still selects after a layout gesture", (await page.locator('#graph [data-node-id="api"].sel').count()) === 1);
  const vbBeforePan = await viewBox();
  await page.mouse.move(600, 780);
  await page.mouse.down();
  await page.mouse.move(680, 810, { steps: 5 });
  await page.mouse.up();
  check("pan still owns the empty ground", (await viewBox()) !== vbBeforePan);
  await page.click("#zoom-toggle");
  await page.waitForTimeout(100);
  check("⤢ fit still resets the view", (await viewBox()) === vbBeforePan);

  check("no page errors", pageErrors.length === 0);
  if (pageErrors.length) console.error("page errors:", pageErrors);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log("\nUI smoke: all checks passed");
