import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPLY_IS_HUMAN,
  applyCommandFor,
  carveProgress,
  carveStageNote,
  carveStageOf,
  carveStateNote,
  carveStateOf,
  carveStatePayload,
  carveToneFor,
  carveWordFor,
  bandGraduated,
  listCarveManifests,
  parseCarveManifest,
  readCarveManifest,
  readCarveStates,
  splitCarveState,
  type CarveManifest,
  type CarveManifestIo,
  type CarveState,
} from "./carve-manifest.ts";
import { carveReportToIr, type CarveReport } from "./carve-lens.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__", "carve-manifests");

/**
 * The fixtures are REAL manifests. This repo's own `example-carve` was copied
 * to a scratch dir (so nothing in the checkout was touched), `npm install` in
 * its `app/` pinned to `@intentius/chant@0.52.2` +
 * `@intentius/chant-lexicon-aws@0.52.2` (chant#998's manifest, chant PR #1575,
 * ships at 0.52.2), `npm install --no-save @cdktf/hcl2json` beside it for the
 * HCL parse, then the three carve verbs run against `legacy-tf/` with
 * `--output app/carveout`:
 *
 *   aws_iam_role.api            `carve emit`                          -> emitted
 *   aws_cloudwatch_log_group.worker  `carve emit` + `carve bridge`     -> bridged
 *   aws_s3_bucket.assets        emit + bridge + `carve apply --env prod
 *                               --stack assets --write --write-source` -> applied
 *
 * Committed as chant wrote them, with ONE substitution: the scratch directory's
 * absolute prefix was rewritten to `/tmp/carve-fixture`, because the real one
 * carried a session id and the operator's home path and neither is part of the
 * shape under test. Nothing else is edited — the boundary reports, the emit
 * params, the ownership tags and the timestamps are chant's own.
 *
 * `carve apply` was run BY HAND here, in a terminal, which is the only way it
 * is ever run: behold has no apply endpoint and no apply button. Generating
 * this fixture is the one place the applied stage exists in this repo at all.
 */
const manifestPath = (name: string) => join(FIXTURES, name);
const read = (name: string) => JSON.parse(readFileSync(manifestPath(name), "utf8")) as CarveManifest;

const EMITTED = "aws_iam_role-api.carve.json";
const BRIDGED = "aws_cloudwatch_log_group-worker.carve.json";
const APPLIED = "aws_s3_bucket-assets.carve.json";

describe("the real chant carve manifests", () => {
  it("are all v1, each naming one Terraform address", () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".carve.json"));
    expect(files.sort()).toEqual([BRIDGED, EMITTED, APPLIED].sort());
    for (const f of files) {
      const m = parseCarveManifest(read(f));
      expect(m, f).not.toBeNull();
      expect(m!.version).toBe(1);
      expect(typeof m!.target).toBe("string");
      expect(m!.boundary, f).toBeTruthy();
    }
  });

  it("stage off the sections chant recorded, cumulatively", () => {
    expect(carveStageOf(read(EMITTED))).toBe("emitted");
    expect(carveStageOf(read(BRIDGED))).toBe("bridged");
    expect(carveStageOf(read(APPLIED))).toBe("applied");
  });

  it("only the applied one counts as graduated", () => {
    const state = (f: string) => carveStateOf(read(f), manifestPath(f));
    expect(state(EMITTED).graduated).toBe(false);
    expect(state(BRIDGED).graduated).toBe(false);
    expect(state(APPLIED).graduated).toBe(true);
    // Ownership is chant's, recorded by the apply — behold reports it, never mints it.
    expect(state(APPLIED).ownership).toEqual({
      stack: "assets",
      env: "prod",
      tags: { "chant:managed-by": "chant", "chant:stack": "assets", "chant:env": "prod" },
    });
    expect(state(EMITTED).ownership).toBeUndefined();
  });

  it("flattens the emit params chant recorded as deferred inputs", () => {
    // aws_iam_role.api reads random_pet.suffix.id for its name; chant's emit
    // turned that outbound edge into a build parameter with a state-resolved
    // default.
    expect(carveStateOf(read(EMITTED), manifestPath(EMITTED)).deferredInputs).toEqual(["name ← random_pet.suffix"]);
  });

  it("carries the bridge's excision list on the bridged carve", () => {
    const state = carveStateOf(read(BRIDGED), manifestPath(BRIDGED));
    expect(state.excised).toEqual(["aws_cloudwatch_log_group.worker"]);
    // The bridge wrote proposals, not edits — the manifest says so, and behold
    // repeats it rather than reading the .tf itself.
    expect(read(BRIDGED).bridge?.appliedInPlace).toBe(false);
  });

  it("takes the age of the state from the last step chant stamped", () => {
    const applied = read(APPLIED);
    expect(carveStateOf(applied, manifestPath(APPLIED)).at).toBe(applied.apply!.at);
    const emitted = read(EMITTED);
    expect(carveStateOf(emitted, manifestPath(EMITTED)).at).toBe(emitted.emit!.at);
  });
});

describe("parseCarveManifest", () => {
  it("refuses anything that isn't a v1 manifest", () => {
    expect(parseCarveManifest(null)).toBeNull();
    expect(parseCarveManifest([])).toBeNull();
    expect(parseCarveManifest({})).toBeNull();
    expect(parseCarveManifest({ version: 1 })).toBeNull();
    expect(parseCarveManifest({ version: 1, target: "" })).toBeNull();
    // A future major means something else by these sections; half-reading it
    // would put a wrong stage on a card.
    expect(parseCarveManifest({ version: 2, target: "aws_s3_bucket.assets" })).toBeNull();
  });

  it("accepts a minimal one — the fields the renderer reads, not every field chant emits", () => {
    const m = parseCarveManifest({ version: 1, target: "aws_s3_bucket.assets", somethingNew: true });
    expect(m?.target).toBe("aws_s3_bucket.assets");
  });
});

describe("readCarveManifest", () => {
  it("reads a real one off disk", () => {
    expect(readCarveManifest(manifestPath(APPLIED))?.target).toBe("aws_s3_bucket.assets");
  });

  it("is null, never a throw, on an unreadable or unparseable file", () => {
    expect(
      readCarveManifest("/nope.carve.json", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
    expect(readCarveManifest("x", () => "{not json")).toBeNull();
  });
});

/** An in-memory tree, so discovery is tested without a temp dir. */
function fakeIo(files: Record<string, string>): CarveManifestIo {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    for (let d = dirname(p); d && d !== "/" && d !== "."; d = dirname(d)) dirs.add(d);
  }
  const children = (dir: string): string[] => {
    const out = new Set<string>();
    for (const p of [...Object.keys(files), ...dirs]) {
      if (dirname(p) === dir) out.add(p.slice(dir.length + 1));
    }
    return [...out];
  };
  return {
    readdir: (dir) => children(dir),
    isDirectory: (p) => dirs.has(p),
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
  };
}

const manifestJson = (target: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, target, ...extra });

describe("listCarveManifests", () => {
  it("finds manifests two levels down — the carveout inside a project", () => {
    const io = fakeIo({
      "/e/app/carveout/aws_s3_bucket-assets.carve.json": manifestJson("aws_s3_bucket.assets"),
      "/e/app/src/main.ts": "//",
    });
    expect(listCarveManifests("/e", io)).toEqual(["/e/app/carveout/aws_s3_bucket-assets.carve.json"]);
  });

  it("never walks vendored or dot directories", () => {
    const io = fakeIo({
      "/e/node_modules/pkg/x.carve.json": manifestJson("aws_s3_bucket.vendored"),
      "/e/.terraform/y.carve.json": manifestJson("aws_s3_bucket.hidden"),
      "/e/out/z.carve.json": manifestJson("aws_s3_bucket.real"),
    });
    expect(listCarveManifests("/e", io)).toEqual(["/e/out/z.carve.json"]);
  });

  it("stops at the documented depth rather than walking someone's repo", () => {
    const io = fakeIo({ "/e/a/b/c/deep.carve.json": manifestJson("aws_s3_bucket.deep") });
    expect(listCarveManifests("/e", io)).toEqual([]);
  });

  it("is empty, not a throw, on a directory that isn't there", () => {
    expect(listCarveManifests("/gone", fakeIo({}))).toEqual([]);
  });
});

describe("readCarveStates", () => {
  it("keys every discovered manifest by its Terraform address", () => {
    const io = fakeIo({
      "/e/out/a.carve.json": manifestJson("aws_s3_bucket.assets", { emit: { files: [], at: "t" } }),
      "/e/out/b.carve.json": manifestJson("aws_iam_role.api"),
    });
    const states = readCarveStates(["/e"], io);
    expect([...states.keys()].sort()).toEqual(["aws_iam_role.api", "aws_s3_bucket.assets"]);
  });

  it("resolves a duplicated target to the further-along stage", () => {
    const io = fakeIo({
      "/e/stale/a.carve.json": manifestJson("aws_s3_bucket.assets"),
      "/e/out/a.carve.json": manifestJson("aws_s3_bucket.assets", { bridge: { at: "t" }, apply: { at: "t" } }),
    });
    expect(readCarveStates(["/e"], io).get("aws_s3_bucket.assets")?.stage).toBe("applied");
  });

  it("skips a file that isn't a manifest without failing the read", () => {
    const io = fakeIo({
      "/e/out/broken.carve.json": "{ not json",
      "/e/out/good.carve.json": manifestJson("aws_s3_bucket.assets"),
    });
    expect([...readCarveStates(["/e"], io).keys()]).toEqual(["aws_s3_bucket.assets"]);
  });

  it("reads the real fixture directory", () => {
    const states = readCarveStates([FIXTURES]);
    expect(states.size).toBe(3);
    expect(states.get("aws_s3_bucket.assets")?.stage).toBe("applied");
    expect(states.get("aws_cloudwatch_log_group.worker")?.stage).toBe("bridged");
    expect(states.get("aws_iam_role.api")?.stage).toBe("emitted");
  });
});

describe("how a stage reads", () => {
  it("gives each stage its own word", () => {
    expect(carveWordFor("emitted")).toBe("emitted — not bridged");
    expect(carveWordFor("bridged")).toBe("bridged — apply is yours");
    expect(carveWordFor("applied")).toBe("carved → chant");
  });

  it("paints only the graduated stage green — the partials share the in-flight tone", () => {
    expect(carveToneFor("applied")).toBe("good");
    expect(carveToneFor("bridged")).toBe("accent");
    expect(carveToneFor("emitted")).toBe("accent");
  });

  it("says who owns it, in words, at each stage", () => {
    const state = (f: string) => carveStateOf(read(f), manifestPath(f));
    expect(carveStageNote(state(APPLIED))).toContain("chant owns it");
    expect(carveStageNote(state(APPLIED))).toContain("stack assets");
    expect(carveStageNote(state(BRIDGED))).toContain("Terraform still owns the resource");
    expect(carveStageNote(state(EMITTED))).toContain("still reads the resource directly");
  });
});

describe("carveProgress", () => {
  const states = () => [...readCarveStates([FIXTURES]).values()];

  it("counts the graduated against the ranking, and names the rest as in flight", () => {
    const p = carveProgress(states(), 12);
    expect(p).toMatchObject({ applied: 1, bridged: 1, emitted: 1, inFlight: 2, total: 12 });
    expect(p.label).toBe("1 of 12 carved");
    expect(p.detail).toBe("1 emitted, 1 bridged — apply is yours");
  });

  it("has no denominator to invent when there is no report", () => {
    expect(carveProgress(states()).label).toBe("1 carved");
  });

  it("is quiet about nothing", () => {
    const p = carveProgress([], 12);
    expect(p.label).toBe("0 of 12 carved");
    expect(p.detail).toBe("");
  });
});

describe("carveStateNote", () => {
  it("says nothing at all when no carve has been recorded", () => {
    expect(carveStateNote(carveProgress([], 12), new Map())).toBe("");
  });

  it("names the manifest count, so the reader knows where the claim comes from", () => {
    const states = readCarveStates([FIXTURES]);
    const note = carveStateNote(carveProgress(states.values(), 12), states);
    expect(note).toContain("3 manifests");
    expect(note).toContain("1 of 12 carved");
  });
});

describe("applyCommandFor", () => {
  const state = () => carveStateOf(read(BRIDGED), manifestPath(BRIDGED));

  it("composes off the manifest — no --select, which is what chant#998 shipped", () => {
    const cmd = applyCommandFor(state());
    expect(cmd).toContain("chant carve apply");
    expect(cmd).not.toContain("--select");
    expect(cmd).toContain("--from /tmp/carve-fixture/legacy-tf");
    expect(cmd).toContain(`--output ${FIXTURES}`);
  });

  it("shows placeholders for what chant needs and the manifest doesn't have yet", () => {
    expect(applyCommandFor(state())).toContain("--env <env> --stack <stack>");
  });

  it("uses the marker the apply recorded once there is one", () => {
    const cmd = applyCommandFor(carveStateOf(read(APPLIED), manifestPath(APPLIED)));
    expect(cmd).toContain("--env prod --stack assets");
  });

  it("takes display labels without changing which carve it names", () => {
    const cmd = applyCommandFor(state(), { from: "legacy-tf", out: "app/carveout" });
    expect(cmd).toContain("--from legacy-tf --output app/carveout");
  });
});

describe("carveStatePayload", () => {
  it("publishes one shape, sorted, with the apply boundary on the wire", () => {
    const payload = carveStatePayload(readCarveStates([FIXTURES]), 12);
    expect(payload.manifests).toBe(3);
    expect(payload.states.map((s) => s.target)).toEqual([
      "aws_cloudwatch_log_group.worker",
      "aws_iam_role.api",
      "aws_s3_bucket.assets",
    ]);
    expect(payload.states[0].note).toContain("Terraform still owns");
    expect(payload.states[0].applyCommand).toContain("chant carve apply");
    expect(payload.apply).toEqual({ human: true, note: APPLY_IS_HUMAN });
    expect(payload.apply.note).toContain("no apply endpoint and no");
  });
});

// ---------------------------------------------------------------------------
// The strangler-fig split — the picture #230 M3 is actually about.
// ---------------------------------------------------------------------------

const REPORT = JSON.parse(readFileSync(join(HERE, "__fixtures__", "carve-sample-estate.json"), "utf8")) as CarveReport;

const stateFor = (target: string, stage: "emitted" | "bridged" | "applied"): CarveState =>
  carveStateOf(
    {
      version: 1,
      target,
      ...(stage !== "emitted" ? { bridge: { at: "t" } } : {}),
      ...(stage === "applied" ? { apply: { marker: { stack: "s", env: "e" }, at: "t" } } : {}),
      emit: { files: [`/out/src/${target}.ts`], at: "t" },
    } as CarveManifest,
    "/out/x.carve.json",
  );

describe("splitCarveState", () => {
  const ir = carveReportToIr(REPORT);
  const target = REPORT.resources[0].address;

  it("is a no-op with no manifests — the #254 frame, unchanged", () => {
    const { tf, graduated } = splitCarveState(ir, new Map());
    expect(tf).toBe(ir);
    expect(graduated).toEqual([]);
  });

  it("moves a graduated address out of the bands and hands it back as a chant node", () => {
    const { tf, graduated } = splitCarveState(ir, new Map([[target, stateFor(target, "applied")]]));
    expect(tf.nodes.some((n) => n.id === target)).toBe(false);
    expect(Object.values(tf.groups.byStack as Record<string, string[]>).flat()).not.toContain(target);
    // It keeps its Terraform ADDRESS as its id — the morph's identity
    // continuity, and what makes a restart show the same card in the chant box.
    expect(graduated.map((n) => n.id)).toEqual([target]);
    expect(graduated[0].attrs._status).toBe("good");
    expect(graduated[0].attrs.carve).toBe("carved → chant");
    expect(graduated[0].attrs.ownedStack).toBe("s");
  });

  it("drops the boundary edges of a graduated address — that cut has been made", () => {
    const withEdges = { ...ir, edges: [{ from: "aws_vpc.main", to: target, kind: "ref" as const }] };
    const { tf } = splitCarveState(withEdges, new Map([[target, stateFor(target, "applied")]]));
    expect(tf.edges).toEqual([]);
  });

  it("keeps a partial carve in its band, repainted with the stage's word", () => {
    for (const stage of ["emitted", "bridged"] as const) {
      const { tf, graduated } = splitCarveState(ir, new Map([[target, stateFor(target, stage)]]));
      expect(graduated).toEqual([]);
      const node = tf.nodes.find((n) => n.id === target)!;
      // Tone AND word, never tone alone — and never the band's own three tones.
      expect(node.attrs._status).toBe("accent");
      expect(node.attrs.carve).toBe(carveWordFor(stage));
      expect(node.attrs.carveState).toBe(stage);
      expect(node.attrs.chantSource).toContain("/out/src/");
      // Still banded: nothing has changed hands.
      expect(Object.values(tf.groups.byStack as Record<string, string[]>).flat()).toContain(target);
    }
  });

  it("empties a band rather than leaving a titled hole when its last member graduates", () => {
    const band = Object.entries(ir.groups.byStack as Record<string, string[]>).find(([, m]) => m.length === 1);
    if (!band) return; // the sample estate has no singleton band; nothing to assert
    const [title, [only]] = band;
    const { tf } = splitCarveState(ir, new Map([[only, stateFor(only, "applied")]]));
    expect(Object.keys(tf.groups.byStack as Record<string, string[]>)).not.toContain(title);
  });

  it("bands the graduated pile above the ranking when there is no chant box", () => {
    const { tf, graduated } = splitCarveState(ir, new Map([[target, stateFor(target, "applied")]]));
    const single = bandGraduated(tf, graduated);
    const bands = Object.keys(single.groups.byStack as Record<string, string[]>);
    expect(bands[0]).toBe("carved → chant");
    expect((single.groups.byStack as Record<string, string[]>)["carved → chant"]).toEqual([target]);
    expect(single.nodes).toHaveLength(ir.nodes.length);
    // No graduation, no extra band — the #252 single view, unchanged.
    expect(bandGraduated(ir, [])).toBe(ir);
  });

  it("trims the emitted source path for the card when a caller says how", () => {
    const { graduated } = splitCarveState(ir, new Map([[target, stateFor(target, "applied")]]), {
      shorten: (p) => p.replace("/out/", ""),
    });
    expect(graduated[0].attrs.chantSource).toBe(`src/${target}.ts`);
  });

  it("ignores a manifest for an address this report never ranked", () => {
    const { tf, graduated } = splitCarveState(ir, new Map([["aws_s3_bucket.not_here", stateFor("aws_s3_bucket.not_here", "applied")]]));
    expect(graduated).toEqual([]);
    expect(tf.nodes).toHaveLength(ir.nodes.length);
  });
});
