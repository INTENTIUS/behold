/**
 * #914: the route an agent calls to move the person's open tab.
 *
 * `POST /api/view {view, by}` settles `view` with the same checks a link's
 * query gets (web/view-url.js `viewFromObject`, `settleView`, `checkQuery`),
 * then pushes it to every open tab of this serve as a `view` event on the
 * existing `/api/events` stream. The tab applies it the way it applies a
 * host's `behold:view` message, says an agent moved it, and keeps the view it
 * left one Back away (web/app.js `agentMove`).
 *
 * It writes nothing: not to infrastructure, not to the project, not to
 * `.behold/layout.json`, and nothing is kept server-side. That is why it is on
 * the terragucci write allowlist (src/terragucci-repo.ts).
 *
 * Refused under `--public` (anyone could steer a stranger's tab) and under
 * every `behold preview` (a demo someone else is looking at), and ignored by
 * an embedded frame with a host, whose view is the host's (#476).
 *
 * `by` is a label, at most 80 printable characters, defaulting to the
 * request's User-Agent product token. Anyone who can reach the serve can
 * claim any name, so it says who the caller claims to be and authenticates
 * nothing.
 *
 * `moveView` is the whole decision with no Hono in it, so the UI smoke's stub
 * (smoke/stub.mjs) answers the route with this same code.
 */
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { settleView, viewFromObject, writeViewQuery, ZOOMS, type Refusal, type Want } from "../web/view-url.js";

/** What the serve can honour, for settleView. Zooms are behold's whole set:
 * the tab settles them again against what its estate offers. */
export interface ViewOffer {
  envs: string[];
  tiers?: string[];
}

export interface MoveContext {
  /** `serve --public`. */
  public: boolean;
  /** Any `behold preview`, with or without `--emulator`. */
  preview: boolean;
  offer: ViewOffer;
  /** Open `/api/events` streams: the tabs the move reaches. */
  tabs: number;
  /** The serve's origin as the caller reached it, for `link`. */
  origin: string;
  /** The env this serve was started with: a link that sets `env: null` has to say `env=`. */
  defaultEnv?: string | null;
  userAgent?: string | null;
  now?: () => Date;
  newId?: () => string;
}

/** The `view` event's payload, as the tab reads it. */
export interface ViewEvent {
  id: string;
  movedAt: string;
  by: string;
  view: Want;
}

export interface MoveAnswer {
  status: 200 | 400 | 403 | 409;
  body: Record<string, unknown>;
  /** Present only on a 200: what to emit as the `view` event. */
  event?: ViewEvent;
}

export const BY_MAX = 80;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The `by` label. A given one must be a string of 1 to BY_MAX printable
 * characters. Absent, it is the User-Agent's first product token
 * (`curl/8.7.1`, `claude-code/2.1.0`), cut to BY_MAX, or `unknown`.
 */
export function byLabel(by: unknown, userAgent?: string | null): { ok: true; value: string } | { ok: false; reason: string } {
  if (by === undefined || by === null || by === "") {
    const token = (userAgent ?? "").trim().split(/\s+/)[0] ?? "";
    const clean = [...token].filter((ch) => !CONTROL.test(ch)).join("").slice(0, BY_MAX);
    return { ok: true, value: clean || "unknown" };
  }
  if (typeof by !== "string") return { ok: false, reason: "by is a string" };
  const t = by.trim();
  if (!t) return byLabel(undefined, userAgent);
  if (t.length > BY_MAX) return { ok: false, reason: `by is at most ${BY_MAX} characters` };
  if (CONTROL.test(t)) return { ok: false, reason: "by holds printable characters only" };
  return { ok: true, value: t };
}

/** The link to a settled view on this serve, for a person to open. */
export function viewLink(origin: string, view: Want, defaultEnv?: string | null): string {
  // Only a view that names env may write `env=`: one that leaves env alone says nothing about it.
  const defaults = "env" in view && defaultEnv ? { env: defaultEnv } : {};
  return `${origin.replace(/\/+$/, "")}/${writeViewQuery("", view, defaults)}`;
}

/** The whole route, minus HTTP. */
export function modeRefusal(ctx: { public: boolean; preview: boolean }): MoveAnswer | null {
  if (ctx.public) {
    return { status: 403, body: { error: "behold is serving a public, read-only view: no one may move its tabs", code: "public" } };
  }
  if (ctx.preview) {
    return { status: 403, body: { error: "moving the open tab is disabled in behold preview: the tab is someone else's demo", code: "preview" } };
  }
  return null;
}

export function moveView(body: unknown, ctx: MoveContext): MoveAnswer {
  const mode = modeRefusal(ctx);
  if (mode) return mode;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "the body is a JSON object: {view: {...}, by?}", code: "body" } };
  }
  const b = body as { view?: unknown; by?: unknown };
  const by = byLabel(b.by, ctx.userAgent);
  if (!by.ok) return { status: 400, body: { error: by.reason, code: "by" } };
  const shape = viewFromObject(b.view);
  const settled = settleView(shape.want, { zooms: ZOOMS, envs: ctx.offer.envs, ...(ctx.offer.tiers ? { tiers: ctx.offer.tiers } : {}) });
  const refused: Refusal[] = [...shape.refused, ...settled.refused];
  const view = settled.apply;
  if (!Object.keys(view).length) {
    return {
      status: 400,
      body: { error: refused.length ? "nothing in the view can be applied" : "the view is empty: name at least one view key, such as q", code: "view", refused },
    };
  }
  const link = viewLink(ctx.origin, view, ctx.defaultEnv);
  if (ctx.tabs < 1) {
    return { status: 409, body: { error: "no tab of this serve is open, so there is nothing to move. Hand the person the link.", code: "no-tab", link, refused } };
  }
  const event: ViewEvent = {
    id: (ctx.newId ?? (() => randomBytes(4).toString("hex")))(),
    movedAt: (ctx.now ?? (() => new Date()))().toISOString(),
    by: by.value,
    view,
  };
  return { status: 200, body: { id: event.id, movedAt: event.movedAt, sent: ctx.tabs, link, view, refused }, event };
}

const BODY_MAX = 16 * 1024;

/** Register `POST /api/view` on the app. */
export function viewMoveRoute(
  app: Hono,
  deps: {
    emit: (event: ViewEvent) => void;
    tabs: () => number;
    public: () => boolean;
    preview: () => boolean;
    offer: () => Promise<ViewOffer>;
    defaultEnv: () => string | null;
  },
): void {
  app.post("/api/view", async (c) => {
    // Refused before the body is read, so a refusal never depends on what was sent.
    const early = modeRefusal({ public: deps.public(), preview: deps.preview() });
    if (early) return c.json(early.body, early.status);
    const text = await c.req.text();
    if (text.length > BODY_MAX) return c.json({ error: `the body is at most ${BODY_MAX} bytes`, code: "body" }, 400);
    let body: unknown;
    try {
      body = JSON.parse(text || "null");
    } catch {
      return c.json({ error: "the body is not JSON", code: "body" }, 400);
    }
    const answer = moveView(body, {
      public: deps.public(),
      preview: deps.preview(),
      offer: await deps.offer(),
      tabs: deps.tabs(),
      origin: new URL(c.req.url).origin,
      defaultEnv: deps.defaultEnv(),
      userAgent: c.req.header("user-agent") ?? null,
    });
    if (answer.event) deps.emit(answer.event);
    return c.json(answer.body, answer.status);
  });
}
