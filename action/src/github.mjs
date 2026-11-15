/**
 * The few GitHub REST calls the action makes, over an injectable `fetch` so
 * the logic is tested against recorded responses with no network.
 */

export class GithubError extends Error {
  constructor(status, message, path) {
    super(`${message} (${status} on ${path})`);
    this.status = status;
    this.path = path;
  }
}

/** @param {{token?: string, apiUrl?: string, fetch?: typeof fetch}} opts */
export function githubClient({ token, apiUrl = "https://api.github.com", fetch: f = globalThis.fetch } = {}) {
  async function request(method, path, body) {
    const res = await f(path.startsWith("http") ? path : `${apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "behold-action",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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
    if (!res.ok) throw new GithubError(res.status, data?.message ?? res.statusText ?? "request failed", path);
    return { data, link: res.headers.get("link") ?? "" };
  }

  /** Every item of a paginated list, following `Link: rel="next"`. */
  async function paginate(path) {
    const out = [];
    let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let guard = 0; next && guard < 50; guard++) {
      const { data, link } = await request("GET", next);
      out.push(...(Array.isArray(data) ? data : []));
      next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
    }
    return out;
  }

  return { request, paginate };
}

/** The first comment on the pull request carrying `<!-- marker -->`, oldest first. */
export async function findComment(gh, repo, number, marker) {
  const comments = await gh.paginate(`/repos/${repo}/issues/${number}/comments`);
  const needle = `<!-- ${marker} -->`;
  return comments.find((c) => typeof c.body === "string" && c.body.includes(needle));
}

/**
 * Keep one comment per marker: edit the one that carries it, or create it.
 * A token that may not write answers `denied` rather than throwing, since a
 * fork's pull_request run has a read-only token and that is not a failure.
 * @returns {Promise<{action: "created" | "updated" | "unchanged" | "denied", url?: string, status?: number}>}
 */
export async function upsertComment(gh, { repo, number, body, marker }) {
  try {
    const existing = await findComment(gh, repo, number, marker);
    if (existing) {
      if (existing.body === body) return { action: "unchanged", url: existing.html_url };
      const { data } = await gh.request("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
      return { action: "updated", url: data?.html_url ?? existing.html_url };
    }
    const { data } = await gh.request("POST", `/repos/${repo}/issues/${number}/comments`, { body });
    return { action: "created", url: data?.html_url };
  } catch (err) {
    if (err instanceof GithubError && (err.status === 403 || err.status === 401)) return { action: "denied", status: err.status };
    throw err;
  }
}

/** When nothing changed and no comment exists, there is nothing to post; when one exists, it is edited. */
export async function updateIfPresent(gh, { repo, number, body, marker }) {
  const existing = await findComment(gh, repo, number, marker).catch(() => undefined);
  if (!existing) return { action: "none" };
  return upsertComment(gh, { repo, number, body, marker });
}
