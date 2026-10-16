// behold#571: the forge's mark on each wave box of the Components view, so the
// CI projection says which forge runs each wave. One mark is an icon and the
// forge's name beside it, in the box's title row, linked to the wave's job
// when behold has that job's URL. app.js draws it; nothing here touches the DOM.
//
// Which forge, in this order, from what behold already reads:
//
// 1. a forge the pipeline names: terragucci.components.json's
//    `pipeline.forge`, or the forge chant's own CI projection was generated
//    for (`/api/ci`'s `forge`);
// 2. the shape of a run's URLs in the reports (`job_url`, `commit_url`,
//    `pull_request_url`): a known host, or GitLab's `/-/jobs/`, GitHub's
//    `/actions/runs/<n>/job/<n>`, Forgejo's `/actions/runs/<n>/jobs/<n>`;
// 3. the pipeline file's path (`pipeline.path`), or the one workflow
//    directory the repo has (`.forgejo/workflows`, `.github/workflows`,
//    `.gitlab-ci.yml`), as the server found it (src/terragucci-components.ts).
//
// None of them, or URLs that disagree, is no forge, and no mark is drawn.
// The link is always a URL a report carried; behold never builds one.

/**
 * The marks. Each is drawn in a `size` x `size` square from its own viewBox.
 *
 * Forgejo: the official logo by Caesar Schinas, CC BY-SA 4.0, from
 * https://codeberg.org/forgejo/meta/src/branch/readme/branding (logo/forgejo.svg),
 * its geometry and colours as published.
 *
 * GitHub: Octicons `mark-github` (16px), MIT, Copyright (c) GitHub Inc., from
 * https://github.com/primer/octicons/blob/ea8e6bb79894cc7e85564ee9b53d86b418738d04/icons/mark-github-16.svg,
 * filled in currentColor so it reads on either theme.
 *
 * GitLab: the tanuki behold has drawn since #58, one filled silhouette in GitLab's orange.
 */
export const FORGES = {
  forgejo: {
    label: "Forgejo",
    viewBox: "0 0 212 212",
    transform: "translate(6,6)",
    shapes: [
      { tag: "path", d: "M58 168 v-98 a50 50 0 0 1 50-50 h20", fill: "none", stroke: "#ff6600", "stroke-width": 25 },
      { tag: "path", d: "M58 168 v-30 a50 50 0 0 1 50-50 h20", fill: "none", stroke: "#d40000", "stroke-width": 25 },
      { tag: "circle", cx: 142, cy: 20, r: 18, fill: "none", stroke: "#ff6600", "stroke-width": 15 },
      { tag: "circle", cx: 142, cy: 88, r: 18, fill: "none", stroke: "#d40000", "stroke-width": 15 },
      { tag: "circle", cx: 58, cy: 180, r: 18, fill: "none", stroke: "#d40000", "stroke-width": 15 },
    ],
  },
  github: {
    label: "GitHub",
    viewBox: "0 0 16 16",
    shapes: [
      {
        tag: "path",
        fill: "currentColor",
        d: "M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656",
      },
    ],
  },
  gitlab: {
    label: "GitLab",
    viewBox: "0 0 24 24",
    shapes: [
      {
        tag: "path",
        fill: "#FC6D26",
        d: "M23.6004 9.5927l-.0337-.0862L20.3.9814a.851.851 0 00-.3362-.405.8748.8748 0 00-.9997.0539.8748.8748 0 00-.29.4399l-2.2055 6.748H7.5375l-2.2055-6.748a.8573.8573 0 00-.29-.4412.8748.8748 0 00-.9997-.0537.8585.8585 0 00-.3362.405L.4332 9.5065l-.0325.0862a6.0657 6.0657 0 002.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 001.2197 0l1.4995-1.1321 2.462-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 002.0094-7.003z",
      },
    ],
  },
};

/** The icon's size and the label's, in the svg's units: about the tanuki's 17px. */
export const MARK = { size: 17, font: 11, gap: 5, pad: 12 };

/** A forge named outright ("forgejo", "GitHub Actions", "gitlab-ci"), or null. */
export function forgeOfName(name) {
  const s = String(name || "").trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("forgejo") || s === "codeberg") return "forgejo";
  if (s.startsWith("github")) return "github";
  if (s.startsWith("gitlab")) return "gitlab";
  return null;
}

/** The forge a pipeline file's path belongs to, or null. */
export function forgeOfPath(path) {
  const p = String(path || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (/(^|\/)\.forgejo\/workflows(\/|$)/.test(p)) return "forgejo";
  if (/(^|\/)\.github\/workflows(\/|$)/.test(p)) return "github";
  if (/(^|\/)\.gitlab-ci\.ya?ml$/.test(p)) return "gitlab";
  return null;
}

/** The forge a run's URL is on, from its host or its path, or null. */
export function forgeOfUrl(url) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com")) return "github";
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return "gitlab";
  if (host === "codeberg.org" || host.endsWith(".codeberg.org")) return "forgejo";
  const p = u.pathname;
  if (/\/-\/(jobs|pipelines|merge_requests|commit)\//.test(p)) return "gitlab";
  if (/\/actions\/runs\/\d+\/job\/\d+/.test(p)) return "github";
  if (/\/actions\/runs\/\d+\/jobs\/\d+/.test(p)) return "forgejo";
  return null;
}

/**
 * The forge that runs the pipeline, or null when none of what behold reads
 * says. `declared` is a forge the pipeline names, `urls` are run URLs from the
 * reports, `path` is the pipeline file's path, and `found` a forge the server
 * found from the repo's one workflow directory.
 */
export function detectForge({ declared = null, urls = [], path = null, found = null } = {}) {
  const named = forgeOfName(declared);
  if (named) return named;
  const fromUrls = new Set(urls.map(forgeOfUrl).filter(Boolean));
  if (fromUrls.size === 1) return [...fromUrls][0];
  if (fromUrls.size > 1) return null;
  return forgeOfPath(path) || forgeOfName(found);
}

/**
 * The forge of a terragucci repo's components graph: `facets` is its
 * `meta.terragucciComponents` (`forge` and what said so, `forgeFrom`:
 * `declared` and `config` name it, `pipeline-path` and `workflow-dir` found it),
 * `answer` the terragucci read whose run URLs come second.
 */
export function componentsForge(facets, answer) {
  if (!facets) return null;
  const from = facets.forgeFrom;
  return detectForge({
    declared: from === "declared" || from === "config" ? facets.forge : null,
    urls: answerUrls(answer),
    path: facets.pipeline || null,
    found: from === "pipeline-path" || from === "workflow-dir" ? facets.forge : null,
  });
}

/** Every run URL a terragucci read carries, for {@link detectForge}. */
export function answerUrls(answer) {
  if (!answer || answer.error) return [];
  const out = [];
  const add = (r) => {
    if (!r) return;
    for (const k of ["job_url", "commit_url", "pull_request_url"]) if (typeof r[k] === "string" && r[k]) out.push(r[k]);
  };
  for (const r of Array.isArray(answer.roots) ? answer.roots : []) for (const s of ["plan", "drift", "apply"]) add(r[s]);
  for (const w of Array.isArray(answer.waiting) ? answer.waiting : []) add(w);
  if (answer.pull_request) add(answer.pull_request.run);
  return out;
}

const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * The URL of the job that applied wave `n`, as a report carried it: the
 * wave's waiting gate, or a root's newest apply in that wave. With a
 * `commit`, only a run on that commit counts. Null when no report has one.
 */
export function waveJobUrl(answer, n, commit = null) {
  if (!answer || answer.error) return null;
  const found = [];
  for (const w of Array.isArray(answer.waiting) ? answer.waiting : []) {
    if (w.wave === n && w.job_url) found.push({ url: w.job_url, at: w.since || "", commit: w.commit });
  }
  for (const r of Array.isArray(answer.roots) ? answer.roots : []) {
    const a = r && r.apply;
    if (a && a.wave === n && a.job_url) found.push({ url: a.job_url, at: a.finished || "", commit: a.commit });
  }
  const runs = commit ? found.filter((f) => sameSha(f.commit, commit)) : found;
  runs.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return runs.length ? runs[0].url : null;
}

/** The URL the forge's mark links to: a report's job URL, unless its own shape names another forge. */
export function markLink(url, forge) {
  if (!url) return null;
  const on = forgeOfUrl(url);
  return on && on !== forge ? null : url;
}

/** The mark's tooltip: "apply-wave-2 on Forgejo". */
export function markTitle(job, forge) {
  const f = FORGES[forge];
  if (!f) return "";
  return job ? `${job} on ${f.label}` : `Runs on ${f.label}`;
}

const SVGNS = "http://www.w3.org/2000/svg";

/**
 * A mark's icon as an `<svg>` element of `size` x `size`, from a spec of
 * `{ viewBox, transform?, fill?: { dark, light }, attrs?, shapes }` or
 * `{ image }` (a PNG behold ships), for a dark or a `light` ground. It
 * nests in the graph's svg and stands alone in HTML alike. `doc` is the
 * document to make it in.
 */
export function iconSvg(doc, spec, size, { x = 0, y = 0, light = false } = {}) {
  const svg = doc.createElementNS(SVGNS, "svg");
  const set = (n, k, v) => n.setAttribute(k, String(v));
  set(svg, "width", size);
  set(svg, "height", size);
  set(svg, "x", x);
  set(svg, "y", y);
  set(svg, "aria-hidden", "true");
  set(svg, "focusable", "false");
  if (spec.image) {
    set(svg, "viewBox", "0 0 1 1");
    const img = doc.createElementNS(SVGNS, "image");
    for (const [k, v] of Object.entries({ href: spec.image, x: 0, y: 0, width: 1, height: 1 })) set(img, k, v);
    svg.appendChild(img);
    return svg;
  }
  set(svg, "viewBox", spec.viewBox);
  for (const [k, v] of Object.entries(spec.attrs || {})) set(svg, k, v);
  // A mark drawn in one colour per theme (`fill: { dark, light }`) takes it on a group.
  const host = spec.transform || spec.fill ? doc.createElementNS(SVGNS, "g") : svg;
  if (host !== svg) {
    if (spec.transform) set(host, "transform", spec.transform);
    if (spec.fill) set(host, "fill", light ? spec.fill.light : spec.fill.dark);
    svg.appendChild(host);
  }
  for (const { tag, ...attrs } of spec.shapes) {
    const n = doc.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) set(n, k, v);
    host.appendChild(n);
  }
  return svg;
}
