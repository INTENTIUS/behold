// Drives Argo CD's UI and asserts the "Done when" views. Playwright comes from
// behold's own dependencies. Screenshots go to $SHOTS.
import { chromium } from "playwright";
import { join } from "node:path";

const base = process.env.ARGOCD_URL;
const shots = process.env.SHOTS || ".";
const ARN = "arn:aws:iam::123456789012:role/checkout";
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const browser = await chromium.launch({ channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => (m.type() === "error" || /^Extension .* failed to load/.test(m.text())) && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${base}/login`);
await page.getByRole("textbox", { name: /username/i }).fill("admin");
await page.locator("input[type=password]").fill(process.env.ARGOCD_PASSWORD);
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(/applications/, { timeout: 30000 });

const tab = () => page.getByText("Outside the cluster", { exact: false }).first();

// A ServiceAccount's tab shows the role its annotation names.
await page.goto(`${base}/applications/argocd/shop?view=tree`);
await page.getByText("checkout", { exact: true }).first().waitFor({ timeout: 60000 });
await page.getByText("checkout", { exact: true }).first().click();
await tab().click();
await page.locator(`[data-behold-card="${ARN}"]`).waitFor({ timeout: 30000 }).catch(() => fail("the ServiceAccount tab has no card for the role"));
const sa = await page.locator('[data-behold-tab="resource"]').innerText();
if (!sa.includes("Cloud identity") || !sa.includes("123456789012")) fail("the card does not read as a cloud identity: " + sa);
await page.screenshot({ path: join(shots, "serviceaccount-tab.png") });
console.log("ok: the ServiceAccount tab shows its cloud identity as a card");

// The Application's own tab lists every resource's outside dependencies.
await page.goto(`${base}/applications/argocd/shop?view=tree`);
await page.getByRole("button", { name: /details/i }).first().click();
await tab().click();
await page.locator('[data-behold-tab="application"]').waitFor({ timeout: 30000 }).catch(() => fail("no Application tab"));
await page.locator(`[data-behold-card="${ARN}"]`).waitFor({ timeout: 30000 }).catch(() => fail("the Application tab does not list the role"));
const app = await page.locator('[data-behold-tab="application"]').innerText();
if (!app.includes("named by ServiceAccount checkout")) fail("the role is not tied to the ServiceAccount: " + app);
if (!app.includes("Git source") || !app.includes("gitsrv.gitsrv.svc.cluster.local/shop")) fail("the Application's own git source is not listed: " + app);
await page.screenshot({ path: join(shots, "application-tab.png") });
console.log("ok: the Application tab lists the role and the git source");

// The default export URL from EXTENSION_JS_VARS reached window.BEHOLD_VARS.
const vars = await page.evaluate(() => window.BEHOLD_VARS);
if (!vars || !vars.EXPORT_URL) fail("window.BEHOLD_VARS has no EXPORT_URL: " + JSON.stringify(vars));
console.log("ok: BEHOLD_VARS", JSON.stringify(vars));

const bad = errors.filter((e) => /TypeError|^Extension .* failed to load/i.test(e));
if (bad.length) fail("console errors: " + bad.join(" | "));
console.log("ok: no TypeError and no extension load failure in the console");
await browser.close();
