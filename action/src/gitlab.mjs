/**
 * The GitLab REST calls the action makes for a merge request note, over an
 * injectable `fetch` so the logic is tested against recorded responses.
 *
 * Posting a note needs a token with the `api` scope that the user supplies
 * (a project access token). `CI_JOB_TOKEN` is not used: whether it may create
 * notes is not documented, so the action does not depend on it.
 */

export class GitlabError extends Error {
  constructor(status, message, path) {
    super(`${message} (${status} on ${path})`);
    this.status = status;
    this.path = path;
  }
}

/** @param {{token?: string, apiUrl?: string, fetch?: typeof fetch}} opts */
export function gitlabClient({ token, apiUrl = "https://gitlab.com/api/v4", fetch: f = globalThis.fetch } = {}) {
  async function request(method, path, body) {
    const res = await f(path.startsWith("http") ? path : `${apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "user-agent": "behold-action",
        ...(token ? { "private-token": token } : {}),
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
    // GitLab answers errors as {"message": "401 Unauthorized"} or {"error": "..."}.
    if (!res.ok) throw new GitlabError(res.status, (typeof data?.message === "string" ? data.message : data?.error) ?? res.statusText ?? "request failed", path);
    return { data, link: res.headers.get("link") ?? "", nextPage: res.headers.get("x-next-page") ?? "" };
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

/** The first user note on the merge request carrying `<!-- marker -->`, oldest first. System notes ("added 1 commit") are skipped. */
export async function findNote(gl, project, iid, marker) {
  const notes = await gl.paginate(`/projects/${encodeURIComponent(project)}/merge_requests/${iid}/notes?sort=asc&order_by=created_at`);
  const needle = `<!-- ${marker} -->`;
  return notes.find((n) => !n.system && typeof n.body === "string" && n.body.includes(needle));
}

/** A note has no URL of its own in the API response; GitLab's page anchor is `#note_<id>`. */
const noteUrl = (webUrl, id) => (webUrl && id !== undefined ? `${webUrl}#note_${id}` : undefined);

/**
 * Keep one note per marker: edit the one that carries it, or create it.
 * A token that may not write answers `denied`, not a throw.
 * @param {{project: string | number, iid: number, body: string, marker: string, webUrl?: string}} args `webUrl` is the merge request's page, for the link in the result.
 * @returns {Promise<{action: "created" | "updated" | "unchanged" | "denied", url?: string, status?: number}>}
 */
export async function upsertNote(gl, { project, iid, body, marker, webUrl }) {
  const base = `/projects/${encodeURIComponent(project)}/merge_requests/${iid}/notes`;
  try {
    const existing = await findNote(gl, project, iid, marker);
    if (existing) {
      if (existing.body === body) return { action: "unchanged", url: noteUrl(webUrl, existing.id) };
      const { data } = await gl.request("PUT", `${base}/${existing.id}`, { body });
      return { action: "updated", url: noteUrl(webUrl, data?.id ?? existing.id) };
    }
    const { data } = await gl.request("POST", base, { body });
    return { action: "created", url: noteUrl(webUrl, data?.id) };
  } catch (err) {
    if (err instanceof GitlabError && (err.status === 403 || err.status === 401)) return { action: "denied", status: err.status };
    throw err;
  }
}

/** When nothing changed and no note exists, there is nothing to post; when one exists, it is edited. */
export async function updateNoteIfPresent(gl, args) {
  const existing = await findNote(gl, args.project, args.iid, args.marker).catch(() => undefined);
  if (!existing) return { action: "none" };
  return upsertNote(gl, args);
}

/**
 * The merge request a GitLab CI job belongs to, from predefined variables.
 * `fork` is true when the source project is not the target project: that is a
 * merge request from a fork whose pipeline the parent project runs, and it is
 * code the project does not control.
 */
export function mergeRequestOf(env) {
  const iid = Number(env.CI_MERGE_REQUEST_IID);
  if (!Number.isInteger(iid) || iid <= 0) return undefined;
  const target = env.CI_MERGE_REQUEST_PROJECT_ID ?? env.CI_PROJECT_ID;
  const source = env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID ?? target;
  return {
    number: iid,
    // CI_MERGE_REQUEST_SOURCE_BRANCH_SHA and CI_MERGE_REQUEST_TARGET_BRANCH_SHA are set in merged results pipelines only.
    base: env.CI_MERGE_REQUEST_DIFF_BASE_SHA || env.CI_MERGE_REQUEST_TARGET_BRANCH_SHA || undefined,
    head: env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA || env.CI_COMMIT_SHA || undefined,
    fork: String(source) !== String(target),
    project: target,
    webUrl: env.CI_MERGE_REQUEST_PROJECT_URL && `${env.CI_MERGE_REQUEST_PROJECT_URL}/-/merge_requests/${iid}`,
  };
}
