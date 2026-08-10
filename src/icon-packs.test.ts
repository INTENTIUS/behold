import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { helmIconFor, k8sIconFor, mappedKinds, platedMarks, PLATE_FILL, type PackGlyph } from "./icon-packs.ts";

const ICONS = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "icons");

const { k8s, helm } = mappedKinds();

/** Every kind that must resolve, including the two mark families by prefix. */
const EVERY_MAPPED_KIND = [
  ...k8s,
  "K8s::Flux::Kustomization",
  "K8s::Flux::GitRepository",
  "K8s::Flux::HelmRelease",
  "K8s::Argo::Application",
  "K8s::Argo::ApplicationSet",
  "K8s::Argo::AppProject",
];

const resolve = (kind: string): PackGlyph | undefined =>
  kind.startsWith("Helm::") ? helmIconFor(kind) : k8sIconFor(kind);

describe("the vendored icon corpus", () => {
  it("resolves every mapped kind to a usable body", () => {
    for (const kind of [...EVERY_MAPPED_KIND, ...helm]) {
      const glyph = resolve(kind);
      expect(glyph, kind).toBeDefined();
      expect(glyph!.body.length, kind).toBeGreaterThan(0);
      expect(glyph!.colored, kind).toBe(true);
      expect(glyph!.viewBox, kind).toMatch(/^[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+$/);
    }
  });

  // The body is inlined into a host document, so a nested <svg> would open a new
  // coordinate system and a <script>/<foreignObject> would be live content.
  it("hands back inner markup only — no wrapper, nothing executable", () => {
    for (const kind of [...EVERY_MAPPED_KIND, ...helm]) {
      const body = resolve(kind)!.body;
      expect(body, kind).not.toMatch(/<svg\b/i);
      expect(body, kind).not.toMatch(/<\/svg\s*>/i);
      expect(body, kind).not.toMatch(/<script\b/i);
      expect(body, kind).not.toMatch(/<foreignObject\b/i);
      expect(body, kind).not.toMatch(/\son\w+\s*=/i);
    }
  });

  // Inlining several bodies into one document makes ids and CSS class names
  // global; upstream Flux and Helm both ship a `.cls-1`, and half the Inkscape
  // files call a layer `layer1`.
  it("namespaces ids and classes so two bodies can share a document", () => {
    const flux = k8sIconFor("K8s::Flux::Kustomization")!.body;
    const helmMark = helmIconFor("Helm::Release")!.body;
    const pod = k8sIconFor("K8s::Core::Pod")!.body;
    for (const [body, prefix] of [
      [flux, "cncf-flux-"],
      [helmMark, "cncf-helm-"],
      [pod, "k8s-pod-"],
    ] as const) {
      for (const name of [
        ...body.matchAll(/\sid\s*=\s*"([^"]*)"/g),
        ...body.matchAll(/\sclass\s*=\s*"([^"]*)"/g),
      ]) {
        for (const token of name[1].split(/\s+/)) {
          if (token) expect(token, `${prefix}${token}`).toContain(prefix);
        }
      }
    }
  });

  it("paints the kinds behold's own demos put on the graph", () => {
    expect(k8sIconFor("K8s::Apps::Deployment")!.body).toContain("k8s-deploy-");
    expect(k8sIconFor("K8s::Core::Service")!.body).toContain("k8s-svc-");
    expect(k8sIconFor("K8s::Core::Namespace")!.body).toContain("k8s-ns-");
    expect(k8sIconFor("K8s::Rbac::ClusterRoleBinding")!.body).toContain("k8s-crb-");
    expect(k8sIconFor("K8s::Autoscaling::HorizontalPodAutoscaler")!.body).toContain("k8s-hpa-");
  });

  it("gives Flux, Argo and Helm resources their own project marks", () => {
    const flux = k8sIconFor("K8s::Flux::Kustomization")!;
    const argo = k8sIconFor("K8s::Argo::Application")!;
    const chart = helmIconFor("Helm::Chart")!;
    expect(flux.body).toContain("cncf-flux-");
    expect(argo.body).toContain("cncf-argo-");
    expect(chart.body).toContain("cncf-helm-");
    expect(helmIconFor("Helm::Release")!.body).toBe(chart.body);
    // Three different marks, not one mark three times.
    expect(new Set([flux.body, argo.body, chart.body]).size).toBe(3);
  });

  // Falling through is the correct answer, not a gap to paper over: pinhole's
  // chain then reaches the keyword heuristic.
  it("falls through for kinds with no official icon", () => {
    for (const kind of [
      "K8s::Core::Node",
      "K8s::Apps::DeploymentList",
      "K8s::KubeMicroVM::MicroVMReplicaSet",
      "K8s::Monitoring::ServiceMonitor",
      "K8s::Core::Nonsense",
      "",
    ]) {
      expect(k8sIconFor(kind), kind).toBeUndefined();
    }
    expect(helmIconFor("Helm::Values")).toBeUndefined();
    expect(helmIconFor("K8s::Core::Pod")).toBeUndefined();
  });

  it("caches — the same kind hands back the same object", () => {
    expect(k8sIconFor("K8s::Core::Pod")).toBe(k8sIconFor("K8s::Core::Pod"));
    expect(k8sIconFor("K8s::Core::PodTemplate")).toBe(k8sIconFor("K8s::Core::Pod"));
  });
});

/** sRGB relative luminance — the same maths #229's sweep uses. */
function luminance(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio. */
function contrast(a: string, b: string): number {
  const [A, B] = [luminance(a), luminance(b)];
  return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05);
}

/** Every authored colour in a glyph body, lowercased, plate excluded. */
const inksOf = (body: string): string[] =>
  [...new Set([...body.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase()))].filter((c) => c !== PLATE_FILL);

// #246. A colored mark's background is the card, and the card's fill is not
// knowable from here — pinhole's `--pin-<status>Fill` in an export, one of 552
// palettes' category hues in the SPA. A plate makes that question moot for the
// marks that cannot survive the answer.
describe("the contrast plate", () => {
  it("covers the Helm mark and nothing else", () => {
    expect(platedMarks()).toEqual(["cncf/helm"]);
    for (const kind of ["Helm::Chart", "Helm::Release"]) {
      expect(helmIconFor(kind)!.body, kind).toContain(PLATE_FILL);
    }
    // The other marks are not plated, and asserting that is what keeps the
    // treatment from spreading by habit rather than by the rule below.
    for (const kind of ["K8s::Flux::Kustomization", "K8s::Argo::Application", "K8s::Apps::Deployment", "K8s::Core::Service"]) {
      expect(k8sIconFor(kind)!.body, kind).not.toContain(`fill="${PLATE_FILL}"`);
    }
  });

  // The rule the plated set encodes, re-derived from the artwork itself rather
  // than restated: a mark survives an unknown background if it spans some
  // luminance — something in it reads whichever way the ground goes. Sweep the
  // whole vendored corpus and the set that fails that test must be exactly the
  // set that gets a plate. Vendor a new single-ink mark and this is what says so.
  it("plates exactly the marks with no light ink, swept over the whole corpus", () => {
    // Read off the vendored file, which never carries a plate — so `lightest`
    // is the artwork's own lightest ink, not one this module put there.
    const inkLimits = (rel: string) => {
      const raw = readFileSync(join(ICONS, `${rel}.svg`), "utf8");
      const inks = [...new Set([...raw.matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => m[0].toLowerCase()))].map(luminance);
      return { rel, lightest: Math.max(...inks), darkest: Math.min(...inks) };
    };
    const corpus = [
      ...readdirSync(join(ICONS, "cncf")).map((f) => `cncf/${f.replace(/\.svg$/, "")}`),
      ...readdirSync(join(ICONS, "k8s")).map((f) => `k8s/${f.replace(/\.svg$/, "")}`),
    ];
    expect(corpus.length).toBe(33);

    // "Light enough to read on a near-black card" — the ground an export gets.
    const READS_ON_DARK = 0.35;
    const measured = corpus.map(inkLimits);
    const noLightInk = measured.filter((m) => m.lightest < READS_ON_DARK).map((m) => m.rel);
    expect(noLightInk).toEqual(platedMarks());

    // …and it is not a close call: the gap either side of the threshold is wide,
    // so the rule is not an artefact of where the line was drawn.
    const worstPlated = Math.max(...measured.filter((m) => noLightInk.includes(m.rel)).map((m) => m.lightest));
    const bestBare = Math.min(...measured.filter((m) => !noLightInk.includes(m.rel)).map((m) => m.lightest));
    expect(worstPlated).toBeLessThan(0.05);
    expect(bestBare).toBeGreaterThan(0.6);
  });

  it("paints the ground before the ink, so the mark is legible by construction", () => {
    const body = helmIconFor("Helm::Release")!.body;
    expect(body).toMatch(new RegExp(`^<rect [^>]*fill="${PLATE_FILL}"/>`));
    const inks = inksOf(body);
    expect(inks).toEqual(["#0f1689"]);
    for (const ink of inks) expect(contrast(ink, PLATE_FILL), ink).toBeGreaterThan(7);
  });

  it("keeps the painted footprint — plate and mark both stay inside the viewBox", () => {
    const g = helmIconFor("Helm::Release")!;
    const [minX, minY, w, h] = g.viewBox.split(" ").map(Number);
    const side = Math.max(w, h);
    const rect = /^<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(g.body)!;
    const [x, y, rw, rh] = rect.slice(1).map(Number);
    // A square of side max(vbW,vbH) centred on the viewBox is exactly the slot
    // pinhole scales a glyph into, so the plate adds no painted area.
    expect(rw).toBe(side);
    expect(rh).toBe(side);
    expect(x + rw / 2).toBeCloseTo(minX + w / 2, 3);
    expect(y + rh / 2).toBeCloseTo(minY + h / 2, 3);
    // The mark is scaled uniformly about that centre — proportions untouched,
    // which is what the trademark guidelines ask for.
    const [, k] = /scale\(([\d.]+)\)/.exec(g.body)!;
    expect(Number(k)).toBeGreaterThan(0.5);
    expect(Number(k)).toBeLessThan(1);
  });

  it("is still a body pinhole can splice — no wrapper, no new ids", () => {
    const body = helmIconFor("Helm::Release")!.body;
    expect(body).not.toMatch(/<svg\b/i);
    expect(body).not.toMatch(/\sid\s*=/);
    // One plate, not one per call: the cache holds the plated glyph.
    expect(helmIconFor("Helm::Release")).toBe(helmIconFor("Helm::Chart"));
    expect([...body.matchAll(new RegExp(`fill="${PLATE_FILL}"`, "g"))]).toHaveLength(1);
  });
});
