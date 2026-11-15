// Drives Headlamp's web UI (the app the desktop build wraps) and asserts the
// two "Done when" views. Playwright comes from behold's own dependencies.
import { chromium } from "playwright";

const base = process.env.HEADLAMP_URL;
const cluster = process.env.HEADLAMP_CONTEXT;
const ARN = "arn:aws:iam::123456789012:role/checkout";
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

// The Resource Map: the Security kind (where ServiceAccounts live) is off by default.
await page.goto(`${base}/c/${cluster}/map`);
await page.getByRole("button", { name: /Workloads, Storage/ }).waitFor({ timeout: 30000 });
await page.getByRole("button", { name: /Workloads, Storage/ }).click();
await page.getByText("Outside the cluster (behold)").waitFor();
// The checkboxes follow the menu: Workloads, Storage, Cluster, Network, Security.
await page.getByRole("checkbox").nth(4).click();
await page.keyboard.press("Escape");
// Connected nodes are stacked into one group; opening it shows the link.
await page.getByText("checkout", { exact: true }).first().click();
await page.getByText(ARN.slice(0, 12), { exact: false }).waitFor({ timeout: 15000 }).catch(() => fail("no node for the IAM role in the map"));
const text = await page.locator("body").innerText();
if (!text.includes("Cloud identity")) fail("the role node is not drawn as a cloud identity");
if (!text.includes("ServiceAccount")) fail("the ServiceAccount is not beside the role node");
console.log("ok: the map holds the role node linked to the ServiceAccount");

await page.goto(`${base}/c/${cluster}/serviceaccounts/shop/checkout`);
await page.getByText("Outside the cluster", { exact: true }).waitFor({ timeout: 30000 }).catch(() => fail("no Outside the cluster section"));
if (!(await page.locator("body").innerText()).includes(ARN)) fail("the section does not name the role");
console.log("ok: the ServiceAccount page lists the role");

await browser.close();
