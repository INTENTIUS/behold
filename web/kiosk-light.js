// behold#937: what a demo step's `ask` does to the graph. Pure logic here (what to
// light, how many depend on it, each state's file and look, the unknown slot and
// when it fills); web/kiosk-light-frame.js draws it in the graph frame, and
// startKioskLight wires the pane's events (behold#936) to both.
//
// The contract with the pane (behold#936):
//   behold:ask-start  detail { ask, step, scenario }  before the reply types; we set
//                     window.beholdAskTokens = { dependents } so the reply can fill it.
//   behold:ask-done   same detail, after the reply; we light the graph.
//   behold:ask-clear  a new step with no ask; the lighting goes.
//
// Everything is read from what the kiosk already holds: /api/terragucci (the
// reports joined onto the cards: `cards`, `roots`, `unmatched`, `pull_request`)
// and the run view (`progress`: `states`, `reads`). Nothing here fetches.

/** An address with its instance keys dropped: `aws_x.y["a"]` is `aws_x.y`. */
export const bare = (address) => String(address || "").replace(/\[(?:"(?:[^"\\]|\\.)*"|[^\]])*\]/g, "");

/** The key a step names a resource by: `<root>/<address>`. */
export const lightKey = (root, address) => `${root}/${address}`;

/** A resource's name and type, for a card that leads with its name: `terraform_data.subnet` is `subnet` over `terraform_data`. */
export function cardTitle(address) {
  const tokens = bare(address).split(".");
  let i = 0;
  while (tokens[i] === "module" && i + 1 < tokens.length) i += 2;
  if (tokens[i] === "data") i += 1;
  const type = tokens[i] || "";
  const name = tokens.slice(i + 1).join(".");
  const inst = (String(address).match(/(\[[^\]]*\])$/) || [])[1] || "";
  return name ? { name: name + inst, type } : { name: bare(address) + inst, type: "" };
}

/** The block a card id names after its `<member>/<root>/` prefix, as an address. */
function addressOfBlock(block) {
  return String(block).split("/").join(".");
}

/**
 * The plan as the kiosk's terragucci read holds it: the changed resources by
 * `<root>/<address>` (with the card each is, when the checkout has one), the
 * reads edges between roots, and the blast radius' resource reaches.
 */
export function planOf(answer, progress = null) {
  const out = { roots: [], resources: new Map(), edges: [], reaches: new Map(), reads: [] };
  if (!answer || answer.error || !Array.isArray(answer.roots)) return out;
  out.roots = answer.roots.map((r) => ({ path: r.path, member: r.member, name: r.name }));
  const rootAt = (id) => {
    let best = null;
    for (const r of answer.roots) {
      const prefix = `${r.member}/${r.name}/`;
      if (String(id).startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, root: r };
    }
    return best;
  };
  const add = (root, address, extra) => {
    const key = lightKey(root, address);
    const had = out.resources.get(key);
    if (had) {
      if (extra.cardId && !had.cardId) had.cardId = extra.cardId;
      if (extra.values && extra.values.length && !had.values.length) had.values = extra.values;
      return;
    }
    out.resources.set(key, { key, root, address, ...cardTitle(address), cardId: null, action: null, values: [], ...extra });
  };
  // behold#940: a composed choudoufu run's resources, as its reports state them (an estate keeps no state file, and the graph's cards are as of the base).
  const scene = answer.estateScene && Array.isArray(answer.estateScene.roots) ? answer.estateScene.roots : [];
  for (const r of scene) {
    for (const res of r.resources || []) add(r.path, res.address, { cardId: `${r.member}/${r.name}/${res.address}`, action: res.action || null, values: Array.isArray(res.values) ? res.values : [] });
  }
  for (const [id, marks] of Object.entries(answer.cards || {})) {
    const at = rootAt(id);
    if (!at) continue;
    const mark = (marks || []).find((m) => m.verdict === "wave") || (marks || []).find((m) => m.verdict === "plan");
    if (!mark) continue;
    const addresses = mark.addresses && mark.addresses.length ? mark.addresses : [addressOfBlock(id.slice(at.prefix.length))];
    for (const address of addresses) {
      const values = (mark.values || []).filter((v) => !v.address || v.address === address);
      add(at.root.path, address, { cardId: id, action: mark.action || null, values });
    }
  }
  for (const c of (answer.unmatched && answer.unmatched.changes) || []) {
    if (c.verdict === "drift") continue;
    add(c.root, c.address, { action: c.action || null });
  }
  const pr = answer.pull_request;
  const seen = new Set();
  const edge = (from, to) => {
    const k = `${from}\u0000${to}`;
    if (from && to && from !== to && !seen.has(k)) {
      seen.add(k);
      out.edges.push({ from, to }); // from the upstream to the root that reads it
    }
  };
  if (pr) {
    for (const r of pr.reads || []) {
      edge(r.upstream, r.root);
      out.reads.push(r);
    }
    for (const [root, ups] of Object.entries(pr.upstreams || {})) for (const u of ups || []) edge(u, root);
    for (const res of (pr.blast && pr.blast.resources) || []) out.reaches.set(lightKey(res.root, res.address), res.reaches || []);
  }
  if (progress && Array.isArray(progress.reads)) for (const r of progress.reads) for (const u of r.reads || []) edge(u, r.root);
  // A composed run's members come in the order it applies them. When no read names an order, each reads the one before.
  if (!out.edges.length) {
    const members = pr && Array.isArray(pr.waves) ? (pr.waves.map((w) => w.composed && w.composed.members).find((m) => Array.isArray(m) && m.length > 1) || []) : [];
    for (let i = 1; i < members.length; i++) edge(members[i - 1].root, members[i].root);
  }
  return out;
}

/**
 * Which resources a step lights. `ask.light` names seeds as `<root>/<address>`
 * (an unmatched one is skipped, never an error); `ask.paths` adds what is
 * downstream: every changed resource of a root that reads a lit root, through
 * the reads and dependency edges, and what the blast radius says refers to a
 * seed inside its root. Null when the step lights nothing.
 */
export function selectLight(plan, ask) {
  if (!ask || typeof ask !== "object") return null;
  const wanted = Array.isArray(ask.light) ? ask.light.filter((x) => typeof x === "string") : [];
  if (!wanted.length) return null;
  const seeds = [];
  const skipped = [];
  for (const w of wanted) {
    const hit = plan.resources.has(w) ? w : [...plan.resources.keys()].find((k) => bare(k) === bare(w));
    if (hit) {
      if (!seeds.includes(hit)) seeds.push(hit);
    } else skipped.push(w);
  }
  if (!seeds.length) return null;
  const downstream = new Set();
  if (ask.paths === true && seeds.length) {
    for (const s of seeds) for (const r of plan.reaches.get(s) || []) {
      const k = lightKey(r.root, r.address);
      if (plan.resources.has(k)) downstream.add(k);
    }
    // The roots that read a seed's root, and the roots that read those.
    const queue = [...new Set(seeds.map((s) => plan.resources.get(s).root))];
    const roots = new Set(queue);
    while (queue.length) {
      const up = queue.shift();
      for (const e of plan.edges) if (e.from === up && !roots.has(e.to)) {
        roots.add(e.to);
        queue.push(e.to);
      }
    }
    for (const r of plan.resources.values()) if (roots.has(r.root) && !seeds.includes(r.key) && !seeds.some((s) => plan.resources.get(s).root === r.root)) downstream.add(r.key);
  }
  const lit = [...seeds, ...[...downstream].filter((k) => !seeds.includes(k))];
  const cards = lit.map((k) => plan.resources.get(k).cardId).filter(Boolean);
  const rootsLit = [...new Set(lit.map((k) => plan.resources.get(k).root))];
  return { seeds, lit, dependents: lit.length - seeds.length, cardIds: cards, roots: rootsLit, skipped };
}

/** `{dependents}` for the pane's reply: the number of nodes the step's `paths` lights, beyond the ones it names. */
export function dependentsOf(answer, progress, ask) {
  if (!ask || ask.paths !== true) return null;
  const sel = selectLight(planOf(answer, progress), ask);
  return sel ? sel.dependents : 0;
}

// ---------------------------------------------------------------------------
// The states: a file name each, a written mark, and one of three looks.
// ---------------------------------------------------------------------------

const lastSegment = (path) => String(path || "").split("/").filter(Boolean).pop() || String(path || "");

/** A root's state file name: its backend's key from the run view, else the root's path with `.tfstate`. */
export function stateFile(root, progress) {
  const r = progress && Array.isArray(progress.reads) ? progress.reads.find((x) => x.root === root) : null;
  if (r && typeof r.stateKey === "string" && r.stateKey) return { file: r.stateKey, from: "run" };
  return { file: `${lastSegment(root)}.tfstate`, from: "path" };
}

/** A composed member's, or a plain wave root's, apply outcome from the run view. */
export function applyOf(root, progress) {
  const states = progress && Array.isArray(progress.states) ? progress.states : [];
  for (const w of states) {
    const m = w.composed && Array.isArray(w.composed.members) ? w.composed.members.find((x) => x.root === root) : null;
    if (m) return { apply: m.apply || null, state: m.state || null, wave: w.number, waveState: w.state };
  }
  for (const w of states) {
    if (!Array.isArray(w.roots) || !w.roots.includes(root)) continue;
    const changed = !Array.isArray(w.changed) || w.changed.includes(root);
    if (w.state === "applied") return { apply: changed ? "applied" : "no-changes", state: changed ? "written" : "unchanged", wave: w.number, waveState: w.state };
    if (w.state === "failed") return { apply: "partial", state: "written", wave: w.number, waveState: w.state };
    if (w.state === "refused" || w.state === "blocked" || w.state === "not-started") return { apply: "not-started", state: "unchanged", wave: w.number, waveState: w.state };
    return { apply: null, state: null, wave: w.number, waveState: w.state };
  }
  return null;
}

export const LOOK_WORDS = { applied: "applied", partial: "partly applied", "not-applied": "not applied" };
const LOOK_OF = { applied: "applied", "no-changes": "applied", partial: "partial", failed: "partial", "not-started": "not-applied" };

/** Each root's state: `{ file, from, written, look }`. `look` is applied, partial, not-applied, or null while nothing is decided. */
export function stateMarks(answer, progress) {
  const roots = answer && Array.isArray(answer.roots) ? answer.roots.map((r) => r.path) : progress && Array.isArray(progress.reads) ? progress.reads.map((r) => r.root) : [];
  // behold#940: an estate of choudoufu's has no state file: it holds records, one per resource, written as each applies.
  const estate = !!(answer && answer.estateScene && Array.isArray(answer.estateScene.roots) && answer.estateScene.roots.length);
  const out = {};
  for (const root of roots) {
    const a = applyOf(root, progress);
    const file = estate ? { file: lastSegment(root), from: "estate", estate: true } : stateFile(root, progress);
    out[root] = { ...file, written: !!a && a.state === "written", look: a && a.apply ? LOOK_OF[a.apply] || null : null };
  }
  return out;
}

/** The words of a state's label: its file (or an estate's name), its look, and that it was written. */
export function stateWords(m) {
  return [m.estate ? m.file : `state ${m.file}`, m.look ? LOOK_WORDS[m.look] : null, m.written ? (m.estate ? "records written" : "written") : null].filter(Boolean).join(" \u00b7 ");
}

// ---------------------------------------------------------------------------
// The unknown value: a marked empty slot, and when it fills.
// ---------------------------------------------------------------------------

/**
 * The resource whose creation makes a card's unknown input known: the blast
 * radius' reach into it through an output, else a created resource of the root
 * it reads, else itself (an output that is its own).
 */
export function producerOf(plan, res) {
  for (const [seed, reaches] of plan.reaches) {
    if ((reaches || []).some((r) => r.root === res.root && r.address === res.address && r.through)) {
      const p = plan.resources.get(seed);
      if (p && p.key !== res.key) return p;
    }
  }
  for (const r of plan.reads) {
    if (r.root !== res.root || !(r.unknown && r.unknown.length)) continue;
    const created = [...plan.resources.values()].filter((x) => x.root === r.upstream && x.action === "create");
    const owner = created.find((x) => x.values.some((v) => v.unknown)) || created[0];
    if (owner) return owner;
  }
  return res;
}

/** Every unknown attribute of the planned resources: `{ key, cardId, path, producer, text }`. */
export function unknownSlots(plan) {
  const slots = [];
  for (const res of plan.resources.values()) {
    for (const v of res.values) {
      if (!v.unknown) continue;
      const producer = producerOf(plan, res);
      slots.push({ key: res.key, cardId: res.cardId, root: res.root, address: res.address, path: v.path, producer: producer.key, producerRoot: producer.root, text: `not known until ${producer.name} exists` });
    }
  }
  return slots;
}

/**
 * Whether a slot has been filled, and with what. Filled once the producer's root
 * has applied (the run view's member or wave). Its value is shown only when an
 * apply-time report states one (`answer.applied`, what the root's newest applied
 * wave wrote); run.json states none, so otherwise the slot is filled with no value.
 */
export function slotState(slot, answer, progress) {
  const a = applyOf(slot.producerRoot, progress);
  const filled = !!a && (a.apply === "applied" || a.apply === "no-changes");
  const wrote = slot.cardId && answer && answer.applied ? answer.applied[slot.cardId] : null;
  const v = filled && wrote ? (wrote.values || []).find((x) => x.path === slot.path && !x.unknown && "after" in x) : null;
  return v ? { filled, value: v.after } : { filled };
}

// ---------------------------------------------------------------------------
// Wiring.
// ---------------------------------------------------------------------------

/** The message the frame takes: what to light, whether to ghost the second approval, and a token that changes with each beat (so the pulse plays once). */
export function lightMessage(sel, ask, token) {
  return {
    type: "behold:light",
    labels: true, // the frame labels each state with its file once any step has had an ask
    ids: sel ? sel.cardIds : [],
    roots: sel ? sel.roots : [],
    lit: !!sel,
    ghost: !!(ask && ask.ghost === true),
    token,
  };
}

/** How long after a beat's reply to look again for the reads a step lights, while they are not in. */
export const RETRY_MS = [400, 800, 1600, 3200];

/**
 * Listen for the pane's events and tell the frame. `post` sends a message to the
 * frame; `getAnswer` and `getProgress` give the kiosk's current reads.
 * Returns a stop function.
 */
export function startKioskLight({ post, getAnswer, getProgress, win = typeof window !== "undefined" ? window : null }) {
  if (!win) return () => {};
  let last = null;
  let n = 0;
  const send = (m) => {
    last = m;
    post(m);
  };
  const askOf = (e) => (e && e.detail && e.detail.ask && typeof e.detail.ask === "object" ? e.detail.ask : null);
  const onStart = (e) => {
    const ask = askOf(e);
    const d = ask ? dependentsOf(getAnswer(), getProgress(), ask) : null;
    win.beholdAskTokens = d === null ? {} : { dependents: d };
  };
  // behold#940: the lit state is drawn the moment the reply is done. When the reads the step lights are not in yet
  // (the kiosk's own poll is behind the frame's), it asks again soon, never waiting for a poll's turn.
  const onDone = (e) => {
    const ask = askOf(e);
    const wants = !!(ask && Array.isArray(ask.light) && ask.light.length);
    const attempt = (k) => {
      const sel = ask ? selectLight(planOf(getAnswer(), getProgress()), ask) : null;
      n += 1;
      const mine = n;
      send(lightMessage(sel, ask, mine));
      if (!sel && wants && k < RETRY_MS.length && typeof win.setTimeout === "function") {
        win.setTimeout(() => {
          if (n === mine) attempt(k + 1);
        }, RETRY_MS[k]);
      }
    };
    attempt(0);
  };
  const onClear = () => {
    n += 1;
    win.beholdAskTokens = {};
    send(lightMessage(null, null, n));
  };
  // A frame that reloaded asks nothing; it is told again when it says it has drawn.
  const onMessage = (e) => {
    if (last && e && e.data && e.data.type === "behold:drawn") post(last);
  };
  win.addEventListener("behold:ask-start", onStart);
  win.addEventListener("behold:ask-done", onDone);
  win.addEventListener("behold:ask-clear", onClear);
  win.addEventListener("message", onMessage);
  return () => {
    win.removeEventListener("behold:ask-start", onStart);
    win.removeEventListener("behold:ask-done", onDone);
    win.removeEventListener("behold:ask-clear", onClear);
    win.removeEventListener("message", onMessage);
  };
}
