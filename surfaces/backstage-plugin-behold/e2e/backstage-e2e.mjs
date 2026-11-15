// Drives a Backstage app that has the plugin installed (e2e/install-into-app.sh)
// and asserts the "Done when" views. Playwright comes from behold's own
// dependencies and needs Chrome.
//   BACKSTAGE_URL=http://localhost:3000 SHOT=/path/shot.png node e2e/backstage-e2e.mjs
import { chromium } from "playwright";

const base = process.env.BACKSTAGE_URL ?? "http://localhost:3000";
const shot = process.env.SHOT;
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
// The tab is a link in the new system and a tab in the legacy one; the title is the same text.
const tab = (pg) => pg.getByText("Infrastructure", { exact: true }).first();
// The scaffolded app asks for a guest sign-in on each load.
const open = async (url) => {
  await page.goto(url);
  await page.getByRole("button", { name: "Enter" }).click({ timeout: 15000 }).catch(() => {});
};
const entity = (name, tab = "") => `${base}/catalog/default/component/${name}${tab}`;

// A component with the annotation gets the tab, drawing its root and nothing from the other.
await open(entity("prod-network"));
await tab(page).waitFor({ timeout: 60000 }).catch(() => fail("prod-network has no Infrastructure tab"));
await tab(page).click();
await page.getByTestId("behold-infrastructure").waitFor({ timeout: 30000 }).catch(() => fail("the tab drew nothing"));
const text = await page.getByTestId("behold-infrastructure").innerText();
if (!text.includes("behold.intentius.io/roots")) fail("the tab does not say which annotation picked the slice");
const svg = await page.locator("[data-testid=behold-fallback-svg], iframe[title='behold graph']").first();
const drawn = await page.locator("[data-testid=behold-fallback-svg] svg title").allTextContents();
if (drawn.length) {
  if (!drawn.every((t) => t.startsWith("prod/"))) fail(`a card outside the prod root is drawn: ${drawn.find((t) => !t.startsWith("prod/"))}`);
  console.log(`ok: the fallback drawing holds ${drawn.length} cards, all in the prod root`);
} else if (await svg.count()) {
  console.log("ok: the single-file viewer frame is drawn");
} else fail("neither the viewer nor the drawing is on the page");
if (shot) await page.screenshot({ path: shot, fullPage: false });

// The same through the Terraform workspace annotation.
await open(entity("platform-shared", "/infrastructure"));
await page.getByTestId("behold-infrastructure").waitFor({ timeout: 30000 }).catch(() => fail("platform-shared drew nothing"));
if (!(await page.getByTestId("behold-infrastructure").innerText()).includes("terraform/workspaces")) fail("platform-shared was not picked by terraform/workspaces");
console.log("ok: terraform/workspaces picks the platform root");

// No annotation, no tab.
await open(entity("unrelated"));
await page.getByText("Overview", { exact: true }).first().waitFor({ timeout: 60000 });
if ((await page.getByText("Infrastructure", { exact: true }).count()) !== 0) fail("unrelated has an Infrastructure tab");
console.log("ok: a component with no annotation has no tab");

await browser.close();
