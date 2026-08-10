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
