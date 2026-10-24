import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { joinTerragucci, type CheckoutRoot } from "./terragucci-overlay.ts";
import { readTerragucci, REPORT_SCHEMA, INDEX_SCHEMA } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";
// @ts-expect-error the kiosk's browser module has no declaration file
import { slotState } from "../web/kiosk-light.js";

// A composed tf-apply report as terragucci writes it (applied-values.ts, #1263): the
// attributes the plan left unknown carry `{ path, after }`. After it, the demo's base reset
// pushes a no-op apply, which has no approval and so no `applied` mark in the index.
const PROJECT = "github.com/acme/demo";
const ROOTS: CheckoutRoot[] = ["network", "app", "edge"].map((n) => ({ member: "m", name: n, path: n }));
const NODES = [
  { id: "m/network/terraform_data.subnet", attrs: { root: "network" } },
  { id: "m/app/terraform_data.security_group", attrs: { root: "app" } },
  { id: "m/edge/terraform_data.dns_upstream", attrs: { root: "edge" } },
];
const SUBNET = "subnet-0a1b2c";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function write(dir: string, path: string, doc: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), JSON.stringify(doc));
}
const run = (stage: string, finished: string) => ({ project: PROJECT, commit: "c1", stage, finished, wave: 1 });
const root = (path: string, changes: unknown[]) => ({ path, status: "planned", changes });
const create = (address: string, attributes: unknown[]) => ({ address, action: "create", attributes });

function bucket(resetApproval: "none" | "not-required"): string {
  const d = mkdtempSync(join(tmpdir(), "behold-composed-applied-"));
  made.push(d);
  const applyPath = "p/apply";
  const resetPath = "p/reset";
  write(d, `${applyPath}/report.json`, {
    schema: REPORT_SCHEMA,
    run: run("tf-apply", "2026-10-24T10:00:00.000Z"),
    waves: [{ number: 1 }],
    roots: [
      root("network", [create("terraform_data.subnet", [{ path: "id", after: SUBNET }, { path: "output", after: "10.0.1.0/24" }])]),
      root("app", [create("terraform_data.security_group", [{ path: "input", after: `sg in ${SUBNET}` }])]),
      root("edge", [create("terraform_data.dns_upstream", [{ path: "input", after: `app.${SUBNET}.internal` }])]),
    ],
  });
  write(d, `${resetPath}/report.json`, {
    schema: REPORT_SCHEMA,
    run: run("tf-apply", "2026-10-24T10:05:00.000Z"),
    waves: [{ number: 1 }],
    roots: ROOTS.map((r) => root(r.path, [])),
  });
  write(d, "index.json", {
    schema: INDEX_SCHEMA,
    reports: [
      { project: PROJECT, commit: "c1", stage: "tf-apply", wave: 1, finished: "2026-10-24T10:00:00.000Z", path: applyPath, approval: "approved", applied: "2026-10-24T10:00:00.000Z" },
      { project: PROJECT, commit: "c2", stage: "tf-apply", wave: 1, finished: "2026-10-24T10:05:00.000Z", path: resetPath, ...(resetApproval === "none" ? {} : { approval: "not-required", applied: "2026-10-24T10:05:00.000Z" }) },
    ],
  });
  return d;
}

describe("a composed apply's values survive the base reset's no-op apply (behold#935)", () => {
  for (const reset of ["none", "not-required"] as const) {
    it(`reads app's values from the apply that wrote them (reset approval: ${reset})`, async () => {
      const read = await readTerragucci(terragucciSource(bucket(reset)), { roots: ROOTS.map((r) => r.path) });
      const m = joinTerragucci(read, NODES, ROOTS);
      expect(m.applied["m/app/terraform_data.security_group"]?.values).toEqual([{ address: "terraform_data.security_group", path: "input", after: `sg in ${SUBNET}` }]);
      expect(m.applied["m/network/terraform_data.subnet"]?.values.map((v) => v.path)).toEqual(["id", "output"]);
    });
  }

  it("fills the kiosk's marked slot with the value", async () => {
    const read = await readTerragucci(terragucciSource(bucket("none")), { roots: ROOTS.map((r) => r.path) });
    const m = joinTerragucci(read, NODES, ROOTS);
    const slot = { cardId: "m/app/terraform_data.security_group", path: "input", producerRoot: "network" };
    const progress = { states: [{ number: 1, state: "applied", composed: { members: [{ root: "network", apply: "applied", state: "written" }] } }] };
    expect(slotState(slot, m, progress)).toEqual({ filled: true, value: `sg in ${SUBNET}` });
  });
});
