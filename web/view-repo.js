// behold#571: the repo this page reads, on a server that serves several
// (`behold serve --repos`). The kiosk opens behold's own page in its frame
// with `?repo=<name>`; every read the page makes then carries it, so the
// graph, the reports and the popover are that repo's. Imported first by
// app.js, so the wrap is in place before the page's first read. Without
// `repo` in the address nothing changes.

/** The page's `repo`, or null. */
export function pageRepo(search) {
  const v = new URLSearchParams(search || "").get("repo");
  return v ? v : null;
}

/** `url` with `repo` set, when it is one of this server's /api/ reads; otherwise `url` unchanged. */
export function withRepo(url, repo, origin) {
  if (!repo || typeof url !== "string") return url;
  let u;
  try {
    u = new URL(url, origin);
  } catch {
    return url;
  }
  if (u.origin !== origin || !u.pathname.startsWith("/api/") || u.searchParams.has("repo")) return url;
  u.searchParams.set("repo", repo);
  return url.startsWith(origin) ? u.toString() : `${u.pathname}${u.search}${u.hash}`;
}

/** Wrap fetch and EventSource so each /api/ read carries `repo`. */
export function followRepo(win, repo) {
  if (!repo || !win) return;
  const origin = win.location.origin;
  const fetch0 = win.fetch && win.fetch.bind(win);
  if (fetch0) win.fetch = (input, init) => fetch0(typeof input === "string" ? withRepo(input, repo, origin) : input, init);
  const ES = win.EventSource;
  if (ES) {
    win.EventSource = class extends ES {
      constructor(url, opts) {
        super(withRepo(String(url), repo, origin), opts);
      }
    };
  }
}

if (typeof window !== "undefined") followRepo(window, pageRepo(window.location.search));
