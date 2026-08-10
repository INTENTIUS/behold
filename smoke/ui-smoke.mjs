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
import { startStub, JSON_FIXTURE, BOX, EDGE_VIA } from "./stub.mjs";
import { THEMES, DEFAULT_THEME } from "../web/themes.js";
import { tokensFor, pinTokensFor, colorForCategory, setTheme, hexToOklch, contrast } from "../web/theme.js";
import { helmIconFor, PLATE_FILL } from "../src/icon-packs.ts";

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
// contrast() is theme.js's own WCAG ratio (#240) — imported rather than
// reimplemented here, so the acceptance harness checks the exact metric
// tokensFor()'s --muted floor is derived against, not a second approximation
// of it.
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
    // #240: secondary text (--muted on --panel) clears a real 3:1 WCAG floor
    // — surfaced by this exact sweep as Darkermatrix landing at 1.25:1.
    "--muted clears the 3:1 floor on --panel": (t) => contrast(t.muted, t.panel) >= 3,
  };
  const n = Object.keys(THEMES).length;
  for (const [name, rule] of Object.entries(RULES)) {
    const bad = Object.values(THEMES).filter((th) => !rule(tokensFor(th), th)).map((th) => th.name);
    check(`${n} themes: ${name}`, bad.length === 0);
    if (bad.length) console.error("  offenders:", bad.slice(0, 8).join(", "), bad.length > 8 ? `… (${bad.length})` : "");
  }
}

// ---- #246: the Helm mark's ground, swept the same way ---------------------
// The mark is navy line art on transparent, so whatever is under it in the card
// is what it reads against — and there are two such grounds, neither of which
// the pack can know. In an exported SVG or a static snapshot it is pinhole's
// own `--pin-<status>Fill`; in the SPA `recolorNodesByCategory` has already
// replaced that with a per-kind hue out of the active palette. Sweep both, in
// both polarities, and the answer is the same shape as #229's: the fix cannot
// be conditional on anything, because the failure is not conditional either.
const HELM_INK = "#0f1689";
{
  const glyph = helmIconFor("Helm::Release");
  const inks = [...new Set([...glyph.body.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase()))].filter((c) => c !== PLATE_FILL);
  check("the Helm mark's only ink is the navy this sweep measures", inks.length === 1 && inks[0] === HELM_INK);

  const STATUS_FILLS = ["managedFill", "foreignFill", "pendingFill", "neutralFill", "goodFill", "warnFill", "badFill", "accentFill"];
  const grounds = [];
  for (const th of Object.values(THEMES)) {
    setTheme(th, { persist: false });
    const pin = pinTokensFor(th);
    for (const kind of ["Helm::Release", "Helm::Chart"]) grounds.push({ dark: th.dark, fill: colorForCategory(kind), where: "spa" });
    for (const k of STATUS_FILLS) if (pin[k]) grounds.push({ dark: th.dark, fill: pin[k], where: "export" });
  }
  const failing = (xs) => xs.filter((g) => contrast(HELM_INK, g.fill) < 3);
  const n = Object.keys(THEMES).length;

  // Bare, the mark fails on real grounds in BOTH polarities. This is the check
  // that rules out "swap in cncf/artwork's icon/white on dark themes": a
  // treatment keyed on the theme's polarity cannot fix a failure that happens
  // in both, and the white variant would newly fail every ground the navy
  // currently clears.
  const darkFails = failing(grounds.filter((g) => g.dark));
  const lightFails = failing(grounds.filter((g) => !g.dark));
  check(`${n} themes: the bare Helm navy falls under 3:1 on dark grounds`, darkFails.length > 0);
  check(`${n} themes: …and on light ones too, so polarity is the wrong axis`, lightFails.length > 0);
  check(`${n} themes: the bare Helm navy also fails on SPA category fills, not just exports`, failing(grounds.filter((g) => g.where === "spa")).length > 0);
  console.log(
    `    bare mark under 3:1 on ${failing(grounds).length}/${grounds.length} grounds ` +
      `(dark ${darkFails.length}, light ${lightFails.length}); plated: ${contrast(HELM_INK, PLATE_FILL).toFixed(2)}:1 on all of them`,
  );

  // Plated, the ground is the plate — one number, every theme, every status,
  // every category hue, and every consumer that never runs the recolour pass.
  check("the plate is painted before the ink, so it is the ground", new RegExp(`^<rect [^>]*fill="${PLATE_FILL}"/>`).test(glyph.body));
  check("the Helm ink clears 7:1 on the plate", contrast(HELM_INK, PLATE_FILL) >= 7);
  check("the plate declares no transparency, so no ground reaches the ink", !/opacity/.test(glyph.body.slice(0, glyph.body.indexOf("/>") + 2)));
  setTheme(THEMES[DEFAULT_THEME], { persist: false });
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
// #259: the JSON view's copy control writes to the system clipboard. Grant it,
// so the write resolves instead of logging a permissions-policy error into the
// "no page errors" check — and so the smoke can read the result back.
try {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${PORT}` });
} catch {
  /* older channel without the permission names — the copy check falls back below */
}
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (process.env.SMOKE_DEBUG) console.log("CONSOLE", m.type(), m.text());
  if (m.type() === "error") pageErrors.push(m.text());
});
if (process.env.SMOKE_DEBUG) page.on("request", (r) => r.url().includes("/api/layout") && console.log("REQ", r.method(), r.url(), r.postData()));

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

  // ---- #259: JSON in the pane is a tree, not a blob ------------------------
  // `api` is the stub's rich node: a declared object attribute, an observed
  // payload deep enough to fold, a string long enough to truncate, and a drift
  // pair whose two sides are objects. Everything below is read off the rendered
  // DOM — the same surface a static export ships, since it inlines this JS.
  await page.click('#graph [data-node-id="api"]');
  await page.waitForSelector('#inspect .jsonv-node[data-key="metadata"]', { timeout: 10000 });
  const jsonNode = (key) => page.locator(`#inspect .jsonv-node[data-key="${key}"]`).first();
  const openState = (key) => jsonNode(key).getAttribute("data-open");

  const paneText = await page.locator("#inspect").innerText();
  check("no flat JSON.stringify blob survives in the pane", !paneText.includes('{"') && !paneText.includes('["'));
  check("the declared object became a tree", (await page.locator("#inspect .jsonv").count()) >= 2);
  check("the drift pair stacked into labelled halves instead of an arrow between two blobs", (await page.locator("#inspect .pair-label").count()) >= 2);

  // Depth-1 open, deeper folded — and a folded subtree costs no DOM at all.
  check("the depth-1 tier is open", (await openState("template")) === "1");
  check("a deep subtree renders collapsed", (await openState("metadata")) === "0");
  check("a collapsed subtree builds no children", (await jsonNode("metadata").locator(".jsonv-children > *").count()) === 0);
  check("the collapsed line says what it is hiding", (await jsonNode("metadata").locator(".jsonv-summary").first().innerText()).includes("2 keys"));

  // Keyboard: Enter and Space both toggle the focused node (#259's a11y clause).
  await jsonNode("metadata").locator(".jsonv-head").first().focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(60);
  check("Enter on a focused node expands it", (await openState("metadata")) === "1");
  check("expanding builds the children", (await jsonNode("metadata").locator('.jsonv-node[data-key="labels"]').count()) === 1);
  await page.keyboard.press(" ");
  await page.waitForTimeout(60);
  check("Space toggles it back", (await openState("metadata")) === "0");
  await jsonNode("metadata").locator(".jsonv-head").first().click();
  await page.waitForTimeout(60);
  check("a click toggles it too", (await openState("metadata")) === "1");

  // A long string truncates, and gives the rest back on demand.
  const longNode = jsonNode("lastApplied");
  check("a long string is truncated", (await longNode.innerText()).includes("…") && !(await longNode.innerText()).includes(JSON_FIXTURE.longString));
  await longNode.locator(".jsonv-more").click();
  await page.waitForTimeout(60);
  check("expanding a long string reveals all of it", (await longNode.innerText()).includes(JSON_FIXTURE.longString));
  check("…and the expander retires", (await longNode.locator(".jsonv-more").count()) === 0);

  // Copy: what the control writes is this subtree's raw JSON, and it parses.
  const copyCtl = jsonNode("metadata").locator("> .jsonv-line > .jsonv-copy");
  const payload = await copyCtl.evaluate((el) => el.__jsonPayload());
  let copied = null;
  try {
    copied = JSON.parse(payload);
  } catch {
    /* left null → the check below fails with the raw text in hand */
  }
  check("per-subtree copy yields valid JSON", copied !== null);
  check("…and it is the SUBTREE, not the whole payload", JSON.stringify(copied) === JSON.stringify({ labels: JSON_FIXTURE.deepLabels, annotations: { "chant.dev/owner": "estate" } }));
  check("…2-space pretty printed", payload.split("\n").length > 3 && payload.includes('\n  "labels": {'));
  await copyCtl.click();
  await page.waitForTimeout(80);
  check("clicking copy reports back on the control", (await copyCtl.getAttribute("data-copied")) !== null);
  let clipboardText = null;
  try {
    clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  } catch {
    /* no readable clipboard in this browser — the payload above is the assertion */
  }
  if (clipboardText === null) console.log("    (clipboard not readable here — the copy payload was asserted off the control)");
  else check("the clipboard holds exactly that payload", clipboardText === payload);

  // Tokens only (#229/#253): the tree borrows the pane's own two inks and paints
  // nothing of its own, so all 552 palettes keep it legible for free.
  const colorOf = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).color);
  check("tree keys take the pane's value ink (--fg)", (await colorOf("#inspect .jsonv-key")) === (await colorOf("#inspect dd")));
  check("tree punctuation takes the pane's label ink (--muted)", (await colorOf("#inspect .jsonv-punct")) === (await colorOf("#inspect dt")));
  check("tree text is mono", /mono/i.test(await fontOf("#inspect .jsonv")));
  check(
    "nothing in the tree hardcodes a colour",
    await page.locator("#inspect .jsonv").first().evaluate((root) => ![...root.querySelectorAll("[style]"), root].some((el) => /#[0-9a-f]{3}|rgb\(/i.test(el.getAttribute("style") || ""))),
  );
  await page.screenshot({ path: join(SHOTS, "1c-json.png") });

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

  // #246: the Helm mark, measured in the live page rather than argued about.
  // The stub paints the REAL glyph off the pack, at the 22px card slot, on the
  // boot theme — which is dark. "Visible by construction" means two things and
  // both are read off the rendered DOM: the plate geometrically covers the ink
  // (so the ink's background IS the plate, whatever the card became), and the
  // two colours clear 7:1 against each other.
  const helmPaint = () =>
    page.evaluate(() => {
      const g = document.querySelector('#graph [data-node-id="worker"] [data-mark="helm"]');
      if (!g) return { found: false };
      const plate = g.querySelector("rect");
      const ink = [...g.querySelectorAll("path")];
      const card = document.querySelector('#graph [data-node-id="worker"] rect');
      const box = (el) => { const b = el.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      const paint = (el) => getComputedStyle(el).fill;
      const inkBox = ink.map(box).reduce((a, b) => ({
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
        h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y),
      }));
      return {
        found: true,
        plate: paint(plate),
        plateOpacity: getComputedStyle(plate).fillOpacity,
        ink: paint(ink[0]),
        card: paint(card),
        plateRole: plate.getAttribute("data-cat"),
        plateBox: box(plate),
        inkBox,
      };
    });
  const rgbHex = (s) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
    return m ? "#" + m.slice(1).map((v) => Number(v).toString(16).padStart(2, "0")).join("") : s;
  };
  const helm = await helmPaint();
  check("the real Helm mark reaches the card slot", helm.found);
  check("the boot theme is dark, so this is the dark-mode reading", THEMES[DEFAULT_THEME].dark === true);
  check("the plate is opaque", helm.plateOpacity === "1");
  check(
    "the plate covers the ink — the card is not the mark's background any more",
    helm.plateBox.x <= helm.inkBox.x && helm.plateBox.y <= helm.inkBox.y &&
      helm.plateBox.x + helm.plateBox.w >= helm.inkBox.x + helm.inkBox.w &&
      helm.plateBox.y + helm.plateBox.h >= helm.inkBox.y + helm.inkBox.h,
  );
  const helmOnPlate = contrast(rgbHex(helm.ink), rgbHex(helm.plate));
  check(`the Helm ink clears 7:1 on its own ground in dark mode (${helmOnPlate.toFixed(2)}:1)`, helmOnPlate >= 7);
  check("the recolour pass leaves the plate alone, like every other authored paint", helm.plateRole === null);
  console.log(`    ink ${rgbHex(helm.ink)} on plate ${rgbHex(helm.plate)} = ${helmOnPlate.toFixed(2)}:1; the card it sits on is ${rgbHex(helm.card)}`);

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
  const hitPath = () => page.locator('#graph g[data-edge-from="api"] path:not(.pin-edge-line)').getAttribute("d");
  const boxWidth = async () => Number(await page.locator("#graph [data-layout-box] > rect").getAttribute("width"));
  const viewBox = () => page.locator("#graph svg").getAttribute("viewBox");
  // #267: geometry in the SVG's OWN units, measured the way the clamp measures
  // it — so a check reads as "the card rect is inside the box rect", which is
  // the actual invariant, and not as "the transform string says what I expected".
  // `via` (when given) picks the edge-label chip by its text instead: the chip
  // carries no id of any kind, which is the whole fragility under test here.
  const userRect = (sel, via) =>
    page.evaluate(
      ([s, v]) => {
        const svg = document.querySelector("#graph svg");
        const el = v
          ? ([...svg.querySelectorAll("text")].find((t) => (t.textContent || "").trim() === v) || { parentNode: null }).parentNode
          : svg.querySelector(s);
        const target = el && v ? el.querySelector("rect") : el;
        if (!target) return null;
        const r = target.getBoundingClientRect();
        const inv = svg.getScreenCTM().inverse();
        const at = (x, y) => {
          const p = svg.createSVGPoint();
          p.x = x;
          p.y = y;
          return p.matrixTransform(inv);
        };
        const a = at(r.left, r.top);
        const b = at(r.right, r.bottom);
        return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      },
      [sel, via],
    );
  const cardRect = (id) => userRect(`[data-node-id="${id}"]`);
  const boxRect = () => userRect("[data-layout-box] > rect");
  // The chip's <rect> is centred on the edge's midpoint to the digit (pinhole's
  // own edgeLabel geometry), so its centre is directly comparable with the
  // midpoint of the re-anchored path.
  const labelAt = () => userRect(null, EDGE_VIA);
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
  const labelBefore = await labelAt();
  check("the labelled edge's chip starts on pinhole's own midpoint", labelBefore && Math.abs(labelBefore.cx - 210) < 1 && Math.abs(labelBefore.cy - 112) < 1);
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
  check("the transparent hit-path re-anchors with the line it stands in for", (await hitPath()) === anchored);

  // #267: and the words go with the line. The chip pinhole paints for the
  // edge's `viaAttr` used to sit where the bezier used to be, which is nowhere
  // in particular once an end moves.
  const labelAfter = await labelAt();
  const midX = (anchorNums[0] + anchorNums[2]) / 2;
  const midY = (anchorNums[1] + anchorNums[3]) / 2;
  check("the edge label moves when its line is re-anchored", labelAfter && (Math.abs(labelAfter.cx - labelBefore.cx) > 1 || Math.abs(labelAfter.cy - labelBefore.cy) > 1));
  check("…and lands on the re-anchored line's midpoint", labelAfter && Math.abs(labelAfter.cx - midX) < 1.5 && Math.abs(labelAfter.cy - midY) < 1.5);

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

  // …and both went to the sidecar too (the stub holds it in memory; the real
  // server writes `.behold/layout.json`). Debounced, so a drag is one write.
  const sidecar = () => server.layout.get("components") || {};
  await page.waitForTimeout(800);
  check("the finished drag reached the sidecar", Math.abs((sidecar().api || {}).dx - wantDx) < 2);
  check("the box's resize reached it too", Math.abs((sidecar()["box:wave-1"] || {}).dw + 80 / scale) < 2);

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
  // The label ride is not a drag-time effect bolted onto the pointer handler —
  // it is part of painting a delta, so a stored one puts the chip back too.
  const labelReloaded = await labelAt();
  check("the label is re-placed from the stored delta, not just during the drag", labelReloaded && Math.abs(labelReloaded.cx - midX) < 1.5 && Math.abs(labelReloaded.cy - midY) < 1.5);

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

  // ---- #228, the server tier: the sidecar the SPA shares a layout through ---
  // THE acceptance for this half: wipe this browser's tier entirely, reload,
  // and the placement is still there — it came off the server.
  await page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p)).forEach((k) => localStorage.removeItem(k)), LAYOUT_PREFIX);
  await page.reload();
  await page.waitForSelector("#graph svg [data-node-id]", { timeout: 20000 });
  await page.waitForFunction((want) => document.querySelector('#graph [data-node-id="api"]').getAttribute("transform") === want, cardTf, { timeout: 10000 });
  check("with localStorage cleared, the position comes from the server", (await transformOf('#graph [data-node-id="api"]')) === cardTf);
  check("so does the box's size", Math.abs((await boxWidth()) - boxW1) < 0.5);
  check("nothing was written back to localStorage just by reading the server", (await layoutKeys()).length === 0);

  // Merge: local wins where both have an id, the server fills in the rest.
  // (Someone else committed a layout that moves `worker`; you have your own
  // idea about `api`.)
  server.layout.set("components", { ...sidecar(), api: { dx: -300, dy: -300 }, worker: { dx: 15, dy: 25 } });
  await page.evaluate(([k]) => localStorage.setItem(k, JSON.stringify({ api: { dx: 60, dy: 30 } })), [key]);
  await page.reload();
  await page.waitForSelector("#graph svg [data-node-id]", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#graph [data-node-id="worker"]').getAttribute("transform") !== "translate(230, 80)", null, { timeout: 10000 });
  check("a conflicting id takes the LOCAL delta, not the server's", /translate\(\s*60,\s*30\)/.test(await transformOf('#graph [data-node-id="api"]')));
  check("an id only the server has is applied", /translate\(\s*15,\s*25\)/.test(await transformOf('#graph [data-node-id="worker"]')));

  // Reset: back to dagre's placement, and the key goes with it.
  await page.click("#layout-reset");
  await page.waitForTimeout(150);
  check("reset restores the card", (await transformOf('#graph [data-node-id="api"]')) === "translate(40, 80)");
  check("reset restores the box", (await boxWidth()) === boxW0);
  check("reset restores the edge's original curve", (await edgePath()) === "M 115 112 C 115 112, 305 112, 305 112");
  const labelReset = await labelAt();
  check("reset puts the label back where pinhole painted it", labelReset && Math.abs(labelReset.cx - 210) < 1 && Math.abs(labelReset.cy - 112) < 1);
  check("reset clears this lens's key", (await layoutKeys()).length === 0);
  check("reset hides itself again", !(await page.locator("#layout-reset").isVisible()));
  await page.waitForTimeout(800);
  check("reset clears the sidecar too — or the next merge would pull it back", !server.layout.has("components"));

  // ---- #267: a card cannot leave the box that draws around it -------------
  // The box does not grow to fit — that's a gesture of its own — so a drag that
  // keeps going after the wall simply stops at the padding. Everything below is
  // measured in viewBox units against the box's real rect, because "inside the
  // box" is the claim, not "the transform holds a particular number".
  const PAD = 8; // CLAMP_PAD in web/layout-store.js
  const wall0 = await boxRect();
  check("the fixture's box is where the stub painted it", Math.abs(wall0.x - BOX.x) < 1 && Math.abs(wall0.h - BOX.h) < 1);
  const apiBefore = await cardRect("api");
  await dragBy(await page.locator('#graph [data-node-id="api"]').boundingBox(), 0, 300); // far past the floor
  const apiWalled = await cardRect("api");
  check("a drag into the box's wall stops at the padding", Math.abs(apiWalled.y + apiWalled.h - (wall0.y + wall0.h - PAD)) < 1.5);
  check("…and it did move — the clamp stops the drag, it doesn't cancel it", apiWalled.y - apiBefore.y > 1);
  const walled = await storedDeltas();
  check("what's stored is the clamped delta, not the pointer's", Math.abs(walled.api.dy - (apiWalled.y - apiBefore.y)) < 1.5);

  // Grow the box and the same drag goes further — the affordance the clamp
  // points at ("need more room? the box is resizable") actually works.
  await dragBy(await page.locator("#graph [data-layout-resize]").boundingBox(), 0, 120);
  const wall1 = await boxRect();
  check("the corner handle grew the box downward", wall1.h - wall0.h > 20);
  await dragBy(await page.locator('#graph [data-node-id="api"]').boundingBox(), 0, 220);
  const apiLower = await cardRect("api");
  check("a bigger box lets the card go further", apiLower.y - apiWalled.y > 20);
  check("…and it stops at the NEW wall", Math.abs(apiLower.y + apiLower.h - (wall1.y + wall1.h - PAD)) < 1.5);

  // A delta stored before any of this existed (or against a box since shrunk)
  // is brought back inside on apply — clamped, never discarded (#267).
  await page.evaluate(([k]) => localStorage.setItem(k, JSON.stringify({ api: { dx: 4000, dy: 4000 } })), [key]);
  await page.reload();
  await page.waitForSelector("#graph svg [data-node-id]", { timeout: 20000 });
  await page.waitForTimeout(400);
  const wall2 = await boxRect();
  const rescued = await cardRect("api");
  check(
    "an out-of-bounds stored delta is clamped on apply, not dropped",
    Math.abs(rescued.x + rescued.w - (wall2.x + wall2.w - PAD)) < 1.5 &&
      Math.abs(rescued.y + rescued.h - (wall2.y + wall2.h - PAD)) < 1.5,
  );
  check("…and it really was applied, not ignored", rescued.x > apiBefore.x + 20);
  await page.screenshot({ path: join(SHOTS, "8-clamp.png") });
  await page.click("#layout-reset");
  await page.waitForTimeout(150);

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
