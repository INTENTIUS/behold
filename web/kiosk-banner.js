// The demo banner: the example's name, the products in it, a link to the code, and a switcher between the listed demos.
// Pure: the model from a tool id and the list; web/kiosk.html draws it.
//
// Logo policy (web/kiosk-vendor.js): a logo appears only where its owner's published rules allow one. choudoufu's and
// terragucci's are ours. OpenTofu, Terragrunt and Atmos are shown by name, as text, and link to their official sites.

import { vendorOf } from "./kiosk-vendor.js";

/** The public example trees live here. */
export const CODE_BASE = "https://github.com/INTENTIUS/terragucci/tree/main/";

/** The products a banner may show: the name, the site, and the logo (null where no rule allows one). */
export const PRODUCTS = {
  choudoufu: { name: "choudoufu", url: "https://intentius.io/choudoufu/", logo: { src: "/vendors/choudoufu.svg" } },
  terragucci: { name: "terragucci", url: "https://intentius.io/terragucci/", logo: { src: "/vendors/terragucci.svg" } },
  opentofu: { name: "OpenTofu", url: "https://opentofu.org/", logo: null },
  terragrunt: { name: "Terragrunt", url: "https://terragrunt.com/", logo: null },
  atmos: { name: "Atmos", url: "https://atmos.tools/", logo: null },
};

/** The demo's path: the first one is also served at `/`. */
export const demoPath = (tool) => `/${tool}`;

/**
 * The banner for `tool`, or null for a page that is no listed demo. `listed` is the tools the server lists
 * (/api/terragucci/demos); the switcher shows when it names more than one.
 */
/** "I", "II", "III"...: an act's number as the banner writes it. */
export function actNumeral(n) {
  const r = [["X", 10], ["IX", 9], ["V", 5], ["IV", 4], ["I", 1]];
  let out = "";
  for (let [s, v] of r) while (n >= v) { out += s; n -= v; }
  return out;
}

/** The act the loop is on, "Act I", from demo.json's index and scenario count; null for one act, another tool's run or none. */
export function actOf(tool, demo) {
  const d = demo && demo.demo ? demo.demo : demo;
  if (!d || d.tool !== tool || !Number.isInteger(d.index) || !Number.isInteger(d.scenarios) || d.scenarios < 2 || d.index < 1) return null;
  return `Act ${actNumeral(d.index)}`;
}

export function bannerModel(tool, listed = [], act = null) {
  const v = vendorOf(tool);
  if (!v || !v.tree || !v.title) return null;
  const tools = Array.isArray(listed) ? listed.filter((t) => { const x = vendorOf(t); return x && x.tree; }) : [];
  return {
    tool,
    name: v.title,
    act,
    products: (v.products || []).map((id) => PRODUCTS[id]).filter(Boolean),
    code: { label: "See the code", short: "Code", url: `${CODE_BASE}${v.tree}` },
    switcher: tools.length > 1 ? tools.map((t) => ({ tool: t, path: demoPath(t), label: switchLabel(t), current: t === tool })) : [],
  };
}

/** The switcher's label: "Compose", "Terragrunt" or "Atmos". */
export function switchLabel(tool) {
  if (tool === "terragrunt-choudoufu") return "Terragrunt";
  if (tool === "atmos-choudoufu") return "Atmos";
  return "Compose";
}

/** Draws the model into `host` (a header element); hides it with no model. Returns whether it shows. */
export function drawBanner(host, model, doc = document) {
  host.textContent = "";
  host.hidden = !model;
  doc.body.classList.toggle("k-bannered", !!model);
  if (!model) return false;
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const link = (cls, href, ...kids) => {
    const a = el("a", cls);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.append(...kids);
    return a;
  };
  const prods = el("span", "kb-products");
  for (const p of model.products) {
    const kids = [];
    if (p.logo) {
      const img = el("img", "kb-logo");
      img.src = p.logo.src;
      if (p.logo.src2x) img.srcset = `${p.logo.src2x} 2x`;
      img.alt = "";
      kids.push(img);
    }
    kids.push(el("span", "kb-pname", p.name));
    prods.appendChild(link("kb-product", p.url, ...kids));
  }
  const code = link("kb-code", model.code.url, el("span", "kb-code-long", model.code.label), el("span", "kb-code-short", model.code.short));
  const name = el("span", "kb-name", model.name);
  if (model.act) name.append(el("span", "kb-act", ` - ${model.act}`));
  host.append(name, prods);
  if (model.switcher.length) {
    const nav = el("nav", "kb-switch");
    nav.setAttribute("aria-label", "Demos");
    for (const s of model.switcher) {
      const a = el("a", s.current ? "kb-sw kb-sw-on" : "kb-sw", s.label);
      a.href = s.path;
      if (s.current) a.setAttribute("aria-current", "page");
      nav.appendChild(a);
    }
    host.appendChild(nav);
  }
  host.appendChild(code);
  return true;
}
