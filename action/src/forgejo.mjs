/**
 * The Forgejo REST calls the action makes for a pull request comment. Forgejo
 * serves the Gitea API under `/api/v1`: a pull request is an issue, so its
 * comments are issue comments, as on GitHub, but with different paging
 * (`page` and `limit`, at most 50 an item page by default) and a `token`
 * authorization scheme.
 *
 * The event payload of a Forgejo Actions run has the same shape as GitHub's
 * for the fields the action reads, so `pullRequestOf` in run.mjs serves both.
 */

export class ForgejoError extends Error {
  constructor(status, message, path) {
    super(`${message} (${status} on ${path})`);
    this.status = status;
    this.path = path;
  }
}

/** Forgejo caps `limit` at its MAX_RESPONSE_ITEMS, 50 unless the instance raised it. */
const PAGE = 50;

/** @param {{token?: string, apiUrl?: string, fetch?: typeof fetch}} opts */
export function forgejoClient({ token, apiUrl = "https://codeberg.org/api/v1", fetch: f = globalThis.fetch } = {}) {
  async function request(method, path, body) {
    const res = await f(path.startsWith("http") ? path : `${apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "user-agent": "behold-action",
        ...(token ? { authorization: `token ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) throw new ForgejoError(res.status, data?.message ?? res.statusText ?? "request failed", path);
    return { data, link: res.headers.get("link") ?? "", total: Number(res.headers.get("x-total-count") ?? NaN) };
  }

  /** Every item of a paginated list: the `Link: rel="next"` header when sent, else page numbers until `X-Total-Count` is reached or a page runs short. */
  async function paginate(path) {
    const out = [];
    const sep = path.includes("?") ? "&" : "?";
    let next = `${path}${sep}limit=${PAGE}&page=1`;
    for (let page = 1, guard = 0; next && guard < 100; guard++) {
      const { data, link, total } = await request("GET", next);
      const items = Array.isArray(data) ? data : [];
      out.push(...items);
      const rel = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
      if (rel) next = rel;
      else if (items.length > 0 && (Number.isFinite(total) ? out.length < total : items.length >= PAGE)) next = `${path}${sep}limit=${PAGE}&page=${++page}`;
      else next = undefined;
    }
    return out;
  }

  return { request, paginate };
}

/** The first comment on the pull request carrying `<!-- marker -->`, oldest first. */
export async function findComment(fj, repo, number, marker) {
  const comments = await fj.paginate(`/repos/${repo}/issues/${number}/comments`);
  const needle = `<!-- ${marker} -->`;
  return comments.find((c) => typeof c.body === "string" && c.body.includes(needle));
}

/**
 * Keep one comment per marker: edit the one that carries it, or create it.
 * A token that may not write answers `denied`, which is what a fork's run has.
 * @returns {Promise<{action: "created" | "updated" | "unchanged" | "denied", url?: string, status?: number}>}
 */
export async function upsertComment(fj, { repo, number, body, marker }) {
  try {
    const existing = await findComment(fj, repo, number, marker);
    if (existing) {
      if (existing.body === body) return { action: "unchanged", url: existing.html_url };
      const { data } = await fj.request("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
      return { action: "updated", url: data?.html_url ?? existing.html_url };
    }
    const { data } = await fj.request("POST", `/repos/${repo}/issues/${number}/comments`, { body });
    return { action: "created", url: data?.html_url };
  } catch (err) {
    if (err instanceof ForgejoError && (err.status === 403 || err.status === 401)) return { action: "denied", status: err.status };
    throw err;
  }
}

/** When nothing changed and no comment exists, there is nothing to post; when one exists, it is edited. */
export async function updateIfPresent(fj, args) {
  const existing = await findComment(fj, args.repo, args.number, args.marker).catch(() => undefined);
  if (!existing) return { action: "none" };
  return upsertComment(fj, args);
}
