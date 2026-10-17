import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { readCarve, carveShow } from "./dots-recording.js";
import { parentsOf, unitsOf, unitOf, packBlock, ringsOf } from "./dots-layout.js";
import { choreograph, buildScene, takeoffsBy, countsAt, flightPoint, CHOREO } from "./dots-scene.js";

const text = gunzipSync(readFileSync(fileURLToPath(new URL("../scripts/dot-bench/carve-terralith-14.jsonl.gz", import.meta.url)))).toString("utf8");
const rec = readCarve(text);
const show = carveShow(rec, parentsOf(rec.roster));

describe("the dots layout (#712)", () => {
  it("groups a unit by module, block stem and count index", () => {
    expect(unitOf("aws_iam_role.team_0003_role", "aws_iam_role")).toBe(unitOf("aws_iam_instance_profile.team_0003_profile", "aws_iam_instance_profile"));
    expect(unitOf("aws_cloudwatch_log_group.team_a_0")).toBe(unitOf("aws_cloudwatch_log_group.team_a_2"));
    expect(unitOf("aws_ecs_service.svc_0001")).not.toBe(unitOf("aws_ecs_service.svc_0002"));
    expect(unitOf('aws_route53_record.records["www"]', "aws_route53_record")).toBe("|dns");
  });
  it("packs a large ring into concentric rings", () => {
    const rs = ringsOf(141);
    expect(rs.reduce((s, r) => s + r.n, 0)).toBe(141);
    expect(rs.length).toBeGreaterThan(3);
  });
  it("keeps every slot when units leave from the front of a box packed from the end", () => {
    const us = unitsOf(rec.roster);
    const width = 60;
    const all = packBlock(us, { width, fromEnd: true });
    const rest = packBlock(us.slice(5), { width, fromEnd: true });
    for (const [a, s] of rest.slots) expect(all.slots.get(a)).toEqual(s);
  });
});

describe("the carve choreography (#712)", () => {
  const flights = choreograph(show);
  it("flies every resource that changes estate exactly once, and lands it where the recording ends", () => {
    const seen = new Set(flights.map((f) => f.address));
    expect(seen.size).toBe(flights.length);
    const owners = new Map(show.owners0);
    for (const f of flights) if (f.ok) owners.set(f.address, f.to);
    for (const r of rec.roster) expect(owners.get(r.address)).toBe(show.ownersEnd.get(r.address));
    expect(flights.filter((f) => !f.ok && !f.parent)).toHaveLength(14);
  });
  it("flies each move when the recording says it was written, on the recording's own clock", () => {
    const clock = show.timeline;
    const byAddr = new Map(show.events.map((e) => [e.address, e]));
    for (const f of flights.filter((x) => !x.parent)) {
      const w = byAddr.get(f.address);
      expect(f.start).toBeCloseTo(Math.max(0, clock.toReplay(w.t) - CHOREO.flight), 6);
    }
    expect(Math.min(...flights.map((f) => f.start))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...flights.map((f) => f.start))).toBeLessThanOrEqual(clock.length);
  });
  it("carries a child with its parent", () => {
    const child = flights.find((f) => f.parent);
    const parent = flights.find((f) => f.address === child.parent);
    expect(child.to).toBe(parent.to);
    expect(child.start - parent.start).toBeLessThan(60);
  });
});

describe("the scene (#712)", () => {
  const scene = buildScene(show, { sourceAspect: 2.5 });
  it("is the same every time it is built", () => {
    const again = buildScene(show, { sourceAspect: 2.5 });
    const a = scene.layoutAt(200);
    const b = again.layoutAt(200);
    expect([...a.slots]).toEqual([...b.slots]);
  });
  it("puts every dot inside its estate's box, at the start and at the end", () => {
    for (const k of [0, scene.landing.length]) {
      const L = scene.layoutAt(k);
      for (const [addr, s] of L.slots) {
        const b = L.boxes.get(L.owners.get(addr));
        expect(s.x).toBeGreaterThanOrEqual(b.x - 1e-9);
        expect(s.x).toBeLessThanOrEqual(b.x + b.w + 1e-9);
        expect(s.y).toBeGreaterThanOrEqual(b.y - 1e-9);
        expect(s.y).toBeLessThanOrEqual(b.y + b.h + 1e-9);
      }
    }
    expect(scene.layoutAt(0).boxes.size).toBe(1);
    expect(scene.layoutAt(scene.landing.length).boxes.size).toBe(9);
  });
  it("never overlaps two estates' final boxes", () => {
    const bs = [...scene.layoutAt(scene.landing.length).boxes.values()];
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i];
        const b = bs[j];
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
      }
  });
  it("counts a dot where it is until it lands", () => {
    const f = scene.landing[10];
    const before = countsAt(scene, f.end - 1);
    const after = countsAt(scene, f.end);
    expect(after.get(f.to) - (before.get(f.to) ?? 0)).toBeGreaterThanOrEqual(1);
    expect(takeoffsBy(scene, f.start)).toBeGreaterThanOrEqual(f.k);
  });
});

describe("a flight's path (#712)", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  it("leaves its old slot, arcs, and lands in its new one", () => {
    expect(flightPoint(a, b, 0)).toEqual({ x: 0, y: 0 });
    const end = flightPoint(a, b, 1);
    expect(end.x).toBeCloseTo(100, 9);
    expect(end.y).toBeCloseTo(0, 9);
    expect(Math.abs(flightPoint(a, b, 0.5).y)).toBeGreaterThan(5);
  });
  it("comes back to its slot when the move was refused", () => {
    const back = flightPoint(a, b, 1, { ok: false });
    expect(back.x).toBeCloseTo(0, 9);
    expect(back.y).toBeCloseTo(0, 9);
    expect(flightPoint(a, b, 0.5, { ok: false }).x).toBeGreaterThan(10);
  });
});
