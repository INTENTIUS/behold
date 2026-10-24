// The demo banner: the example's name and act, the live demo's products, and a link to its code. Everything shown is live.
// Pure: the model from a tool id and the list; web/kiosk.html draws it.
//
// Logo policy (web/kiosk-vendor.js): a logo appears only where its owner's published rules allow one. choudoufu's,
// chant's (the chant repo's docs/public/brand/mark.svg) and terragucci's are ours. Terragrunt's and Atmos's icons, from gruntwork-io/terragrunt (docs/src/assets/icons/terragrunt-icon.svg)
// and cloudposse/atmos (docs/img/atmos-logo-128.svg), appear on the demos that use those tools (maintainer, 2026-10-24). OpenTofu, Terragrunt and Atmos are shown by name, as text, and link to their official sites.

import { vendorOf } from "./kiosk-vendor.js";

/** The products a banner may show: the name, the site, and the logo (null where no rule allows one). */
export const PRODUCTS = {
  choudoufu: { name: "choudoufu", url: "https://intentius.io/choudoufu/", logo: { src: "/vendors/choudoufu.svg" } },
  chant: { name: "chant", url: "https://intentius.io/chant/", logo: { src: "/vendors/chant.svg" } },
  terragucci: { name: "terragucci", url: "https://intentius.io/terragucci/", logo: { src: "/vendors/terragucci.svg" } },
  opentofu: { name: "OpenTofu", url: "https://opentofu.org/", logo: null },
  terragrunt: { name: "Terragrunt", url: "https://terragrunt.com/", logo: { src: "/vendors/terragrunt.svg" } },
  atmos: { name: "Atmos", url: "https://atmos.tools/", logo: { src: "/vendors/atmos.svg" } },
};

/** "I", "II", "III"...: an act's number as the banner writes it. */
export function actNumeral(n) {
  const r = [["X", 10], ["IX", 9], ["V", 5], ["IV", 4], ["I", 1]];
  let out = "";
  for (let [s, v] of r) while (n >= v) { out += s; n -= v; }
  return out;
}

/**
 * The act the loop is on, "Act I": the scenario's place among its own tool's scenarios (demo.json's `act` and `acts`).
 * Without `act` (an older driver) it falls back to `index` and `scenarios`, which count every tool's scenarios. Null for
 * one act, another tool's run or none.
 */
export function actOf(tool, demo) {
  const d = demo && demo.demo ? demo.demo : demo;
  if (!d || d.tool !== tool) return null;
  if (d.act !== undefined && d.act !== null) {
    if (!Number.isInteger(d.act) || !Number.isInteger(d.acts) || d.acts < 2 || d.act < 1) return null;
    return `Act ${actNumeral(d.act)}`;
  }
  if (!Number.isInteger(d.index) || !Number.isInteger(d.scenarios) || d.scenarios < 2 || d.index < 1) return null;
  return `Act ${actNumeral(d.index)}`;
}

/** The title every demo shares; the logos beside it say which demo is on. */
export const BANNER_TITLE = "One plan, one apply, across estates";

/** The demo whose tool demo.json names now, when it is a listed demo; else null. */
export function liveTool(demo) {
  const d = demo && demo.demo ? demo.demo : demo;
  // The base (a reset between scenarios) names the tool that just ran, not the one that is next: it is no demo going live.
  const t = d && typeof d.tool === "string" && d.scenario !== "base" ? d.tool : null;
  const v = t ? vendorOf(t) : null;
  return v && v.code && v.title ? t : null;
}

/** The banner for the live demo `tool`, or null for a tool that is no listed demo. */
export function bannerModel(tool, act = null) {
  const v = vendorOf(tool);
  if (!v || !v.code || !v.title) return null;
  return {
    tool,
    name: v.heading || BANNER_TITLE,
    act,
    products: (v.products || []).map((id) => PRODUCTS[id]).filter(Boolean),
    code: { label: "See the code", short: "Code", url: v.code },
  };
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
  host.appendChild(code);
  return true;
}
