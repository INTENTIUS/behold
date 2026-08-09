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
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startStub } from "./stub.mjs";

const PORT = 4689;
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });

const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? "ok" : "FAIL"}  ${name}`);
  if (!ok) failures.push(name);
};

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

  // Theme flip: a light Ghostty theme re-derives the tokens without errors.
  await page.selectOption("#panel-theme select", "Atom One Light");
  await page.waitForTimeout(300);
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  check("light theme applies", bg !== "" && bg !== "#0d1117");
  await page.screenshot({ path: join(SHOTS, "5-light.png") });

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
