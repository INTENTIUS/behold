// behold#571: the tool each job runs, as a mark beside the forge's on each
// wave box of the Components view and on the kiosk's job rows. Every mark is
// the tool's name as text, with the tool's own logo before it where its
// owner's published rules allow that use. A tool's logo is never drawn for
// another tool's job. Pure data and functions; app.js and kiosk-runs.js draw.
//
// Which tools a job runs, in this order:
//
// 1. the job's own image, from its log (`image=ghcr.io/intentius/terragucci-tofu:…`),
//    and the commands its log shows (`atmos terraform plan`, `terragrunt run`, `yodel apply`);
// 2. for a job whose log isn't read yet, or a wave box: the repo's, as the
//    server read them (src/pipeline-marks.ts): an orchestrator from the
//    repo's files (Terragrunt units, cdktf.json, atmos.yaml, a chant
//    workspace with members, SQL Yodeler's yodel.config.ts or migrations/),
//    then the engine terragucci.yml's `binary:` names.
//
// Nothing known is no mark.

/**
 * The tools, orchestrators before engines. `icon` is a spec for
 * forge-mark.js's iconSvg, or null for the name alone. Each logo decision
 * rests on its owner's published words, quoted beside it.
 */
export const TOOLS = {
  // Terragrunt: Gruntwork's "G" logomark,
  // https://gruntwork.io/_assets/media/gruntwork-logomark-white.svg, its one
  // path filled in currentColor so it reads on either theme (the file is white).
  // Gruntwork's Website Terms (https://gruntwork.io/legal/website-terms, s.5):
  // "Gruntwork's trademarks and trade dress may not be used in connection with
  // any product or service that is not Gruntwork's in any manner that is likely
  // to cause confusion among customers, or in any manner that disparages or
  // discredits Gruntwork." A label saying this job runs Terragrunt does neither.
  // The mark is never a link: "You may not use any Gruntwork logo ... as part of the link".
  terragrunt: { name: "Terragrunt", kind: "orchestrator", icon: { viewBox: "0 0 512 512", shapes: [{"tag": "path", "d": "M240.511 14.8887C238.537 11.7136 241.561 7.10591 245.151 8.15108C385.826 49.1115 455.362 105.305 478.864 211.331H345.692C341.107 193.408 333.188 180.07 321.934 171.317C311.097 162.147 289.631 157.562 257.537 157.562C227.943 157.562 207.103 162.564 195.015 172.567C182.927 182.154 173.758 196.117 167.505 214.457C161.253 232.38 158.127 254.054 158.127 279.48C158.127 304.905 161.462 326.579 168.131 344.502C174.8 362.425 184.595 376.18 197.516 385.766C210.854 395.353 229.194 400.146 252.535 400.146C275.043 400.146 292.34 398.271 304.428 394.52C316.516 390.768 325.685 385.141 331.938 377.639C338.19 369.719 342.775 360.341 345.692 349.504H307.88C283.184 349.504 263.164 329.484 263.164 304.787V253.846H425.095C444.268 253.846 458.44 259.056 467.61 269.476C476.779 279.48 483.032 294.902 486.366 315.742L512 491.428H408.839L400.086 432.684C364.078 488.696 315.224 503.307 249.409 503.307C196.474 503.307 154.793 494.346 124.365 476.423C62.4517 439.105 13.5468 357.519 41.3238 251.502C45.5964 235.195 22.3875 227.402 6.71548 230.651C4.79551 231.049 1.71572 227.624 2.83557 226.015C10.1503 215.501 23.9462 198.101 42.5653 185.388C54.5086 177.233 49.0229 159.223 3.39737 154.866C0.537409 154.593 -1.03324 151.484 0.7659 149.244C17.1073 128.9 86.7099 54.8033 233.646 54.8033C249.977 54.8033 253.092 35.1262 240.511 14.8887Z", "fill": "currentColor"}] } },
  // CDK Terrain: the Open Construct Foundation's mark as cdktn.io publishes it,
  // https://cdktn.io/favicon.svg. cdktn.io publishes no rules for it.
  "cdk-terrain": { name: "CDK Terrain", kind: "orchestrator", icon: { viewBox: "0 0 24 24", shapes: [{"tag": "rect", "x": 0, "y": 0, "width": 24, "height": 24, "rx": 6, "fill": "rgb(22, 163, 74)"}, {"tag": "polygon", "points": "12,5 18,8.5 18,15.5 12,19 6,15.5 6,8.5", "fill": "none", "stroke": "white", "stroke-width": 2, "stroke-linejoin": "round"}] } },
  // Atmos: Cloud Posse's mark, the lock with a rocket, from Cloud Posse's own
  // files: https://github.com/cloudposse/atmos/blob/ee2aa74cfef0a677422d556ef5b54f59416f29cf/website/static/img/slides/atmos-intro/cloudposse-logo.svg,
  // in Cloud Posse's own two colours: white on dark, as that file is, and
  // rgb(10,25,34) on light, as cloudposse-logo-dark.svg beside it draws the
  // mark (same commit path, website/static/img/). Cloud Posse publishes no rules
  // for the open-source Atmos; its Atmos Pro media kit
  // (https://atmos-pro.com/media-kit) asks: "Don't ... Use the logo to imply
  // endorsement without permission", and not to "Alter or distort the logo
  // colors or proportions". A job label implies no endorsement, and the
  // colours and geometry are Cloud Posse's.
  atmos: { name: "Atmos", kind: "orchestrator", icon: { viewBox: "0 0 192 191.999996", fill: { dark: "#ffffff", light: "rgb(10,25,34)" }, shapes: [{"tag": "path", "d": "M 117.269531 58.875 L 119.5 50.671875 L 127.792969 48.460938 L 119.5 46.253906 L 117.269531 38.050781 L 115.035156 46.253906 L 106.742188 48.460938 L 115.035156 50.671875 Z M 117.269531 58.875 ", "fill-rule": "nonzero"}, {"tag": "path", "d": "M 163.125 79.195312 L 161.351562 85.703125 L 154.777344 87.453125 L 161.351562 89.207031 L 163.125 95.714844 L 164.894531 89.207031 L 171.472656 87.453125 L 164.894531 85.703125 Z M 163.125 79.195312 ", "fill-rule": "nonzero"}, {"tag": "path", "d": "M 181.980469 51.519531 L 180.484375 46.019531 L 178.988281 51.519531 L 173.429688 53 L 178.988281 54.480469 L 180.484375 59.980469 L 181.980469 54.480469 L 187.539062 53 Z M 181.980469 51.519531 ", "fill-rule": "nonzero"}, {"tag": "path", "d": "M 151.78125 101.105469 L 151.8125 101.078125 C 148.183594 95.535156 143.296875 91.1875 137.667969 88.285156 C 138.976562 85.765625 140.238281 83.152344 141.453125 80.441406 C 142.304688 80.308594 143.433594 79.996094 144.757812 79.296875 L 149.492188 85.363281 C 149.585938 85.480469 149.730469 85.546875 149.878906 85.535156 C 150.03125 85.523438 150.164062 85.4375 150.238281 85.304688 L 154.171875 78.21875 C 154.21875 78.136719 154.238281 78.042969 154.226562 77.949219 L 153.242188 70.554688 C 154.359375 68.753906 155.421875 66.730469 156.410156 64.542969 C 162.089844 51.9375 160.945312 43.84375 159.753906 40.140625 C 159.363281 38.921875 158.996094 38.296875 158.984375 38.269531 C 158.890625 38.113281 158.714844 38.03125 158.535156 38.054688 C 158.070312 38.117188 147.082031 39.8125 137.78125 57.585938 C 137.769531 57.609375 136.578125 59.976562 135.484375 63.113281 L 129.105469 67.238281 C 129.027344 67.289062 128.96875 67.359375 128.933594 67.441406 L 125.855469 74.933594 C 125.816406 75.03125 125.8125 75.136719 125.84375 75.234375 C 125.859375 75.273438 125.878906 75.3125 125.902344 75.351562 C 125.988281 75.472656 126.132812 75.546875 126.28125 75.542969 L 134.003906 75.355469 C 134.359375 76.632812 134.980469 77.679688 135.828125 78.484375 C 134.65625 81.074219 133.441406 83.578125 132.179688 85.984375 C 128.554688 84.8125 124.710938 84.191406 120.765625 84.191406 C 119.742188 84.191406 118.667969 84.242188 117.574219 84.335938 L 116.347656 84.441406 L 115.863281 83.316406 C 109.441406 68.316406 93.898438 58.242188 77.1875 58.242188 C 54.109375 58.242188 35.335938 76.433594 35.335938 98.792969 L 35.335938 100.597656 L 33.765625 100.714844 C 32.863281 100.785156 31.941406 100.894531 31.027344 101.046875 C 27.207031 101.625 23.507812 102.984375 20.21875 105.007812 L 20.222656 105.011719 L 18.957031 105.933594 C 11.15625 111.320312 6.5 120.046875 6.5 129.285156 C 6.5 145.082031 19.753906 157.933594 36.046875 157.933594 L 119.867188 157.933594 C 140.816406 157.933594 157.863281 141.414062 157.863281 121.105469 C 157.863281 114.453125 156 107.929688 152.480469 102.234375 Z M 146.242188 55.753906 C 148.613281 55.007812 151.148438 56.304688 151.902344 58.652344 C 152.65625 61 151.34375 63.503906 148.972656 64.25 C 146.597656 64.996094 144.066406 63.699219 143.3125 61.351562 C 142.558594 59.003906 143.871094 56.5 146.242188 55.753906 Z M 36.046875 151.210938 C 23.5 151.210938 13.296875 141.375 13.296875 129.285156 C 13.296875 118.742188 21.09375 109.683594 31.835938 107.738281 C 33.078125 107.542969 34.195312 107.449219 35.285156 107.449219 C 41.074219 107.449219 46.480469 109.699219 50.546875 113.648438 C 51.171875 114.433594 52.132812 114.941406 53.21875 114.941406 C 55.097656 114.941406 56.625 113.417969 56.625 111.535156 C 56.625 110.34375 56.015625 109.300781 55.089844 108.691406 C 51.796875 105.558594 47.816406 103.214844 43.402344 101.90625 L 42.253906 101.566406 L 42.179688 100.128906 C 42.15625 99.679688 42.132812 99.230469 42.132812 98.792969 C 42.132812 80.140625 57.855469 64.964844 77.1875 64.964844 C 90.570312 64.964844 102.980469 72.515625 108.800781 84.207031 L 109.628906 85.867188 L 107.878906 86.523438 C 100.277344 89.367188 93.84375 94.667969 89.496094 101.464844 C 88.996094 102.054688 88.691406 102.820312 88.691406 103.65625 C 88.691406 105.535156 90.210938 107.054688 92.085938 107.054688 C 93.375 107.054688 94.496094 106.335938 95.070312 105.28125 C 95.074219 105.285156 95.078125 105.289062 95.082031 105.292969 C 100.070312 97.289062 108.429688 91.972656 117.898438 91.066406 C 118.59375 91.023438 119.230469 91 119.867188 91 C 122.933594 91 125.894531 91.4375 128.695312 92.234375 C 112.875 118.917969 91.886719 133.214844 75.910156 140.714844 C 56.324219 149.90625 39.992188 151.113281 38.371094 151.210938 Z M 119.867188 151.210938 L 65.675781 151.210938 C 69.613281 149.855469 73.824219 148.195312 78.210938 146.144531 C 95.222656 138.207031 117.613281 122.976562 134.285156 94.421875 C 144.25 99.453125 151.066406 109.523438 151.066406 121.105469 C 151.066406 137.707031 137.070312 151.210938 119.867188 151.210938 Z M 119.867188 151.210938 ", "fill-rule": "nonzero"}] } },
  // chant: ours. Its small mark from chant's docs, docs/scripts/brand/mark.py
  // (https://github.com/INTENTIUS/chant/blob/main/docs/public/brand/mark.svg),
  // in the gold chant's site draws it in (styles/chant.css `--ch-gold`).
  chant: { name: "chant", kind: "orchestrator", icon: { viewBox: "0 0 15 15", fill: { dark: "#c9a96e", light: "#9a7b3f" }, attrs: { "shape-rendering": "crispEdges" }, shapes: [{"tag": "rect", "x": 10, "y": 1, "width": 1, "height": 1}, {"tag": "rect", "x": 11, "y": 2, "width": 1, "height": 1}, {"tag": "rect", "x": 6, "y": 3, "width": 1, "height": 1}, {"tag": "rect", "x": 11, "y": 3, "width": 1, "height": 1}, {"tag": "rect", "x": 7, "y": 4, "width": 1, "height": 1}, {"tag": "rect", "x": 11, "y": 4, "width": 1, "height": 1}, {"tag": "rect", "x": 2, "y": 5, "width": 1, "height": 1}, {"tag": "rect", "x": 7, "y": 5, "width": 1, "height": 1}, {"tag": "rect", "x": 11, "y": 5, "width": 1, "height": 1}, {"tag": "rect", "x": 3, "y": 6, "width": 1, "height": 1}, {"tag": "rect", "x": 7, "y": 6, "width": 1, "height": 1}, {"tag": "rect", "x": 11, "y": 6, "width": 1, "height": 1}, {"tag": "rect", "x": 3, "y": 7, "width": 1, "height": 1}, {"tag": "rect", "x": 7, "y": 7, "width": 1, "height": 1}, {"tag": "rect", "x": 11, "y": 7, "width": 1, "height": 1}, {"tag": "rect", "x": 3, "y": 8, "width": 1, "height": 1}, {"tag": "rect", "x": 7, "y": 8, "width": 1, "height": 1}, {"tag": "rect", "x": 11, "y": 8, "width": 1, "height": 1}, {"tag": "rect", "x": 2, "y": 9, "width": 1, "height": 1}, {"tag": "rect", "x": 7, "y": 9, "width": 1, "height": 1}, {"tag": "rect", "x": 11, "y": 9, "width": 1, "height": 1}, {"tag": "rect", "x": 7, "y": 10, "width": 1, "height": 1}, {"tag": "rect", "x": 11, "y": 10, "width": 1, "height": 1}, {"tag": "rect", "x": 6, "y": 11, "width": 1, "height": 1}, {"tag": "rect", "x": 11, "y": 11, "width": 1, "height": 1}, {"tag": "rect", "x": 11, "y": 12, "width": 1, "height": 1}, {"tag": "rect", "x": 10, "y": 13, "width": 1, "height": 1}] } },
  // SQL Yodeler: ours, its cowboy hat from SQL Yodeler's docs
  // (sql-yodeler docs-site/public/brand/hat-small.png and hat-160.png), served
  // as /vendors/sql-yodeler-44.png and -160.png; the larger one draws the mark.
  "sql-yodeler": { name: "SQL Yodeler", kind: "database", icon: { image: "vendors/sql-yodeler-160.png" } },
  // OpenTofu: the color icon from cncf/artwork,
  // https://github.com/cncf/artwork/blob/bd7f51052b704482f03f7dcb40b09a02b2cc9e7f/projects/opentofu/icon/color/opentofu-icon-color.svg,
  // geometry and colours as published (the classes inlined as fills). "All
  // artwork in this repo is made available under the Linux Foundation
  // trademark usage guidelines" (cncf/artwork LICENSE), and those guidelines
  // (https://www.linuxfoundation.org/legal/trademark-usage): "You may make fair
  // use of word marks to make true factual statements", with the logo used
  // as Flux's, Argo's and Helm's already are in behold (THIRD_PARTY.md).
  opentofu: { name: "OpenTofu", kind: "engine", icon: { viewBox: "0 0 37.96 41.01", shapes: [{"tag": "path", "fill": "#0d1a2a", "fill-rule": "evenodd", "d": "M20.37,.36c-.86-.47-1.91-.47-2.77,0L3.4,8.16s-.02,.01-.03,.02l-1.87,1.03C.57,9.71,0,10.68,0,11.73V29.28C0,30.33,.57,31.3,1.49,31.81l14.34,7.88s.04,.02,.06,.03l1.71,.94c.86,.47,1.91,.47,2.77,0l1.72-.94s.03-.02,.05-.03l14.34-7.88c.92-.51,1.49-1.47,1.49-2.52V11.73c0-1.05-.57-2.02-1.49-2.52l-1.86-1.02s-.03-.02-.04-.02L20.37,.36Zm.91,20.15l13.29-7.3s.03-.02,.04-.02l.16-.09c.44-.24,.98,.08,.98,.58v13.66c0,.5-.54,.82-.98,.58l-.12-.07s-.05-.03-.08-.04l-13.29-7.3ZM3.36,13.18s.02,.01,.03,.02l13.29,7.3L3.4,27.81s-.05,.03-.07,.04l-.13,.07c-.44,.24-.98-.08-.98-.58V13.67c0-.5,.54-.82,.98-.58l.17,.09Zm30.16-3.07L21.07,3.27c-.44-.24-.97,.07-.98,.56v14.81l13.43-7.38c.43-.26,.43-.88,0-1.14Zm-29.08,1.14l13.43,7.38V3.83c-.01-.49-.55-.8-.98-.56L4.44,10.11c-.44,.26-.44,.89,0,1.14Zm.02,19.66c-.45-.25-.46-.88-.03-1.14l13.45-7.39v14.81c-.01,.48-.53,.79-.96,.58l-12.46-6.85Zm15.63,6.25v-14.79l13.45,7.39c.42,.27,.41,.9-.04,1.14l-12.45,6.85c-.43,.22-.94-.09-.96-.57h0v-.02Z"}, {"tag": "path", "fill": "#e6c220", "d": "M18.66,2.29c.2-.11,.44-.11,.64,0l14.2,7.81c.46,.25,.46,.91,0,1.16l-14.2,7.81c-.2,.11-.44,.11-.64,0L4.46,11.26c-.46-.25-.46-.91,0-1.16L18.66,2.29Z"}, {"tag": "path", "fill": "#feda15", "d": "M2.21,13.67c0-.5,.54-.82,.98-.58l14.34,7.88c.21,.12,.34,.34,.34,.58v15.61c0,.5-.54,.82-.98,.58L2.56,29.87c-.21-.12-.34-.34-.34-.58V13.67Z"}, {"tag": "path", "fill": "#fff", "d": "M34.77,13.09c.44-.24,.98,.08,.98,.58v15.61c0,.24-.13,.47-.34,.58l-14.34,7.88c-.44,.24-.98-.08-.98-.58v-15.61c0-.24,.13-.47,.34-.58l14.34-7.88Z"}, {"tag": "path", "fill": "#0d1a2a", "d": "M8.23,25.92s0,.01,0,.02l-3.36-1.77s0-.01,0-.02c.08-1.05,.89-1.5,1.82-1.01,.93,.49,1.62,1.73,1.54,2.78Z"}, {"tag": "path", "fill": "#0d1a2a", "d": "M13.52,28.97s0,.01,0,.02l-3.36-1.77s0-.01,0-.02c.08-1.05,.89-1.5,1.82-1.01,.93,.49,1.62,1.73,1.54,2.78Z"}] } },
  // Terraform: the name alone. HashiCorp's trademark policy
  // (https://www.hashicorp.com/trademark-policy) allows its product logos
  // without permission only to identify a project and link to its page, and:
  // "All other uses of our logos must be approved in writing by HashiCorp's
  // marketing division." A job label is another use, so no logo.
  terraform: { name: "Terraform", kind: "engine", icon: null },
  // choudoufu: ours, the PNG the kiosk's choudoufu page already shows. Relative, so a static export finds it.
  choudoufu: { name: "choudoufu", kind: "engine", icon: { image: "vendors/choudoufu-128.png" } },
};

const ORDER = Object.keys(TOOLS);

/** `ids` as known tools, once each, orchestrators first. */
export function orderTools(ids) {
  const set = new Set((ids || []).filter((t) => Object.prototype.hasOwnProperty.call(TOOLS, t)));
  return ORDER.filter((t) => set.has(t));
}

/** The tools an image runs, from its name and tag: `terragucci-terragrunt:0.4-tofu1.13` is Terragrunt on OpenTofu. */
export function toolsOfImage(image) {
  const s = String(image || "").toLowerCase();
  if (!s) return [];
  const word = (w) => new RegExp(`(^|[/_.:@-])${w}([/_.:@-]|\\d|$)`).test(s);
  const out = [];
  if (word("terragrunt")) out.push("terragrunt");
  if (word("cdktn") || word("cdk-terrain") || word("cdktf")) out.push("cdk-terrain");
  if (word("atmos")) out.push("atmos");
  if (word("chant")) out.push("chant");
  if (word("sql-yodeler") || word("yodel")) out.push("sql-yodeler");
  if (word("choudoufu")) out.push("choudoufu");
  if (word("tofu") || word("opentofu")) out.push("opentofu");
  else if (word("terraform")) out.push("terraform");
  return orderTools(out);
}

/** The image a job ran in, as its log says (`image=…`), or null. */
export function jobImage(job) {
  for (const step of (job && job.steps) || []) {
    for (const line of step.log || []) {
      const m = /\bimage=("?)([^\s"]+)\1/.exec(line);
      if (m) return m[2];
    }
  }
  return null;
}

/** Commands a log line runs, for the tools a job's image doesn't name. */
const COMMANDS = [
  ["atmos", /(^|[\s/])atmos\s+(terraform|helmfile|workflow|describe|validate)\b/],
  ["terragrunt", /(^|[\s/])terragrunt\s+(run|run-all|plan|apply|init|stack)\b/],
  ["cdk-terrain", /(^|[\s/])(cdktn|cdktf)\s+(synth|deploy|diff|plan)\b/],
  ["choudoufu", /(^|[\s/])choudoufu\s+(plan|apply|live-check)\b/],
  ["sql-yodeler", /(^|[\s/])yodel\s+(apply|plan|lint|status|approve|drift|new|ci)\b/],
  // `atmos terraform plan` is Atmos's subcommand, not a terraform run.
  ["opentofu", /(^|[\s/])(?<!atmos\s)tofu\s+(plan|apply|init|validate)\b/],
  ["terraform", /(^|[\s/])(?<!atmos\s)terraform\s+(plan|apply|init|validate)\b/],
];

/** The tools a job's log shows it ran, by command. */
export function toolsOfLog(job) {
  const out = new Set();
  for (const step of (job && job.steps) || []) {
    for (const line of step.log || []) for (const [tool, re] of COMMANDS) if (re.test(line)) out.add(tool);
  }
  // An engine named by a command only counts when no other engine is.
  if (out.has("opentofu")) out.delete("terraform");
  return orderTools([...out]);
}

/**
 * The tools a job runs: its image's and its log's commands, or, for a job
 * whose log holds no line yet, the repo's (`repo`). A job whose log was read
 * and names none gets none.
 */
export function jobTools(job, repo = []) {
  const seen = (job && job.steps ? job.steps : []).some((s) => (s.log || []).length);
  if (!seen) return orderTools(repo);
  const engines = (ids) => ids.filter((t) => TOOLS[t].kind === "engine");
  const fromImage = toolsOfImage(jobImage(job));
  const fromLog = toolsOfLog(job);
  // The image's engine wins; the log adds an orchestrator the image doesn't name.
  const all = engines(fromImage).length ? [...fromImage, ...fromLog.filter((t) => TOOLS[t].kind !== "engine")] : [...fromImage, ...fromLog];
  return orderTools(all);
}

/** A tool's name, or null for an unknown id. */
export function toolName(id) {
  return Object.prototype.hasOwnProperty.call(TOOLS, id) ? TOOLS[id].name : null;
}
