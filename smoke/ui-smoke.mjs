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
import { startStub, JSON_FIXTURE } from "./stub.mjs";
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
  check("reset clears this lens's key", (await layoutKeys()).length === 0);
  check("reset hides itself again", !(await page.locator("#layout-reset").isVisible()));
  await page.waitForTimeout(800);
  check("reset clears the sidecar too — or the next merge would pull it back", !server.layout.has("components"));

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

  // ---- #254: the carve walkthrough, driven end to end -----------------------
  // A second stub in carve mode (smoke/stub.mjs `{carve: true}`) serving the
  // REAL committed report through the REAL lens, and the two POST steps canned
  // — so the six steps are deterministic in CI with no chant, no HCL parser and
  // no npm install. What's asserted is the walkthrough's own contract: the tab
  // exists only here, the gates hold in order, a run posts the picked address,
  // Emit shows lint and never build, Handoff is copy buttons rather than a run
  // button, and Done leaves a marker on the card.
  const carveServer = await startStub(PORT + 1, { carve: true });
  const carvePage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  carvePage.on("pageerror", (e) => pageErrors.push("carve: " + String(e)));
  carvePage.on("console", (m) => {
    if (m.type() === "error" && !/favicon/i.test(m.text())) pageErrors.push("carve: " + m.text());
  });
  try {
    check("the Carve tab is absent on an ordinary project", (await page.locator('#panel-tabs button[data-tab="carve"]').count()) === 0);

    await carvePage.goto(`http://localhost:${PORT + 1}/`);
    await carvePage.waitForSelector("#graph svg [data-node-id]", { timeout: 20000 });
    await carvePage.waitForSelector('#panel-tabs button[data-tab="carve"]', { timeout: 10000 });
    check("carve mode mounts the Carve tab", (await carvePage.locator('#panel-tabs button[data-tab="carve"]').count()) === 1);
    await carvePage.click('#panel-tabs button[data-tab="carve"]');
    // The raw report is a second fetch (`/api/carve`, for the boundary lists);
    // wait for it rather than racing it, so what follows tests the panel and
    // not the network. The panel renders without it either way.
    await carvePage.waitForSelector('#tab-carve[data-report="1"]', { timeout: 10000 });

    const step = (id) => carvePage.locator(`#tab-carve .carve-step[data-step="${id}"]`);
    const stepState = (id) => step(id).getAttribute("data-status");
    const bodyStep = () => carvePage.locator("#tab-carve .carve-body").getAttribute("data-step");
    const carveText = () => carvePage.locator("#tab-carve").innerText();

    // 1. Advise — the band legend, with the real report's counts.
    check("six steps on the track", (await carvePage.locator("#tab-carve .carve-step").count()) === 6);
    check("boots on Advise", (await bodyStep()) === "advise");
    const advise = await carveText();
    check("Advise shows the band legend with real counts", advise.includes("carve now") && advise.includes("boundary work") && /\b6\b/.test(advise));
    check("Advise names where the runs will write", advise.includes("app/carveout"));
    check("emit is blocked before anything is picked", (await stepState("emit")) === "blocked");
    check("…and the blocked step says why", (await step("emit").getAttribute("title")).includes("Pick a resource first"));

    // 2. Pick — a click on the green star, and the honest cut summary.
    await carvePage.click('#graph [data-node-id="aws_s3_bucket.assets"]');
    await carvePage.waitForTimeout(200);
    check("a graph click IS the Pick step", (await bodyStep()) === "pick");
    const pick = await carveText();
    check("Pick shows the score arithmetic", pick.includes("100 - 12x1 inbound = 88"));
    check("Pick names the cut from the breakdown's counts", pick.includes("1 inbound"));
    check("…and says plainly that the survivors aren't in this report (chant#1636)", pick.includes("chant#1636"));
    check("the inspect pane opened on the same node", (await carvePage.locator("#inspect").innerText()).includes("aws_s3_bucket.assets"));
    check("emit unblocks once something is picked", (await stepState("emit")) !== "blocked");
    check("bridge stays blocked until emit has run", (await stepState("bridge")) === "blocked");

    // 3. Emit — a real POST, then the emitted source and the lint verdict.
    await step("emit").click();
    await carvePage.click("#tab-carve button.carve-run");
    await carvePage.waitForSelector('#tab-carve .carve-body[data-step="emit"] .carve-artifact', { timeout: 15000 });
    const emitPost = carveServer.carvePosts.find((p) => p.path === "/api/carve/emit");
    check("Emit posted the picked address as JSON", !!emitPost && emitPost.body.select === "aws_s3_bucket.assets");
    check("…as an application/json body (so a cross-origin page preflights)", !!emitPost && emitPost.contentType.includes("application/json"));
    const emit = await carveText();
    check("Emit shows the emitted source file", emit.includes("app/carveout/src/assets.ts") && emit.includes("new Bucket"));
    check("Emit shows the chant lint verdict", emit.includes("chant lint: passes"));
    check("Emit counts warnings off chant's summary line, not a column number", emit.includes("3 warning(s)"));
    check("Emit never claims a chant build", !/chant build/.test(emit) || emit.includes("not `chant build`"));
    check("Emit links the build caveat (chant#1637)", (await carvePage.locator("#tab-carve .carve-caveat").innerText()).includes("why lint and not build"));
    check("the boundary report renders as a JSON tree, not a blob", (await carvePage.locator("#tab-carve .jsonv").count()) >= 1);
    check("a finished run does NOT skip past its own result", (await bodyStep()) === "emit");
    check("bridge unblocks once emit has run", (await stepState("bridge")) !== "blocked");
    await carvePage.screenshot({ path: join(SHOTS, "8-carve-emit.png"), fullPage: true });

    // 4. Bridge — proposals only, never --apply-rewrites.
    await step("bridge").click();
    await carvePage.click("#tab-carve button.carve-run");
    await carvePage.waitForSelector('#tab-carve .carve-body[data-step="bridge"] .carve-artifact', { timeout: 15000 });
    const bridge = await carveText();
    check("Bridge posted the same address", carveServer.carvePosts.some((p) => p.path === "/api/carve/bridge" && p.body.select === "aws_s3_bucket.assets"));
    check("Bridge renders the proposed data source", bridge.includes("aws_s3_bucket-assets-datasources.tf") && bridge.includes('data "aws_s3_bucket"'));
    check("Bridge says your Terraform wasn't touched", bridge.includes("Nothing in your Terraform changed"));

    // 5. Handoff — copy buttons, and the refusal to be a button.
    await step("handoff").click();
    await carvePage.waitForTimeout(150);
    const handoff = await carveText();
    check("Handoff renders the runbook's commands", handoff.includes("terraform state rm aws_s3_bucket.assets"));
    check("…deduped (the runbook prints `terraform plan` twice)", (handoff.match(/terraform plan/g) || []).length === 1);
    check("Handoff has a copy button per command", (await carvePage.locator("#tab-carve .carve-cmd-row .carve-copy").count()) === 3);
    check("Handoff has NO run button — the destructive middle stays human", (await carvePage.locator("#tab-carve button.carve-run").count()) === 0);
    check("…and the UI says why", handoff.includes("not buttons, on purpose") && handoff.includes("terraform state rm"));
    const copyCtl = carvePage.locator("#tab-carve .carve-cmd-row .carve-copy").first();
    await copyCtl.click();
    await carvePage.waitForTimeout(120);
    check("clicking copy reports back on the control", (await copyCtl.getAttribute("data-copied")) === "1");
    let carveClip = null;
    try {
      await carvePage.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${PORT + 1}` });
      carveClip = await carvePage.evaluate(() => navigator.clipboard.readText());
    } catch {
      /* no readable clipboard here — the control's own report is the assertion */
    }
    if (carveClip !== null) check("the clipboard holds the command verbatim", carveClip.startsWith("terraform state rm"));
    await carvePage.screenshot({ path: join(SHOTS, "9-carve-handoff.png"), fullPage: true });

    // 6. Done — the marker on the card, and the end card.
    await carvePage.click("#tab-carve button.carve-ran");
    await carvePage.waitForTimeout(200);
    check("acknowledging the handoff lands on Done", (await bodyStep()) === "done");
    const done = await carveText();
    check("the end card is #254's line", done.includes("chant-owned, observe position") && done.includes("terraform import"));
    check("the follow-up is named, not implied", done.includes("SLIDE") && done.includes("--live"));
    const marker = carvePage.locator('#graph [data-node-id="aws_s3_bucket.assets"] [data-carved="1"]');
    check("the carved card carries a marker", (await marker.count()) === 1);
    check("…inside the card's own box, not at the group's origin", await marker.evaluate((t) => Number(t.getAttribute("x")) > 0 && Number(t.getAttribute("y")) > 0));
    check("every step now reads done", (await carvePage.locator('#tab-carve .carve-step[data-status="done"]').count()) === 5);
    await carvePage.screenshot({ path: join(SHOTS, "10-carve-done.png"), fullPage: true });

    // Picking a different resource invalidates the runs that were about the old
    // one — showing one resource's emitted source under another's name is the
    // one way this panel could actively lie.
    await carvePage.click('#graph [data-node-id="aws_cloudwatch_log_group.worker"]');
    await carvePage.waitForTimeout(200);
    check("a new pick drops the previous runs", (await bodyStep()) === "pick" && (await stepState("bridge")) === "blocked");

    // A resource with no native mapping is refused here, not after a round trip
    // to chant — the advisor already scored it 0 and said why.
    await carvePage.click('#graph [data-node-id="random_pet.suffix"]');
    await carvePage.waitForTimeout(200);
    check("an unmappable resource says so at Pick time", (await carveText()).includes("no known native mapping"));
    await step("emit").click();
    await carvePage.waitForTimeout(100);
    check("…and its Emit button is disabled rather than dead-ending in chant's error", await carvePage.locator("#tab-carve button.carve-run").isDisabled());

    // The track is a state machine, not six tabs: a blocked step refuses the
    // click rather than showing an empty panel.
    await step("done").click();
    await carvePage.waitForTimeout(100);
    check("a blocked step refuses navigation", (await bodyStep()) === "emit");
  } finally {
    await carvePage.close();
    carveServer.close();
  }

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
