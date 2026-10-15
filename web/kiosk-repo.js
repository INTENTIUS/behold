// behold#571: which repo the kiosk's graph reads, on a behold that serves
// several (`behold serve --repos`, one checkout per demo repo). The kiosk
// knows the repo it is about (demo.json's `repo`, or a tool's latest cycle's)
// and asks for that checkout by name with `?repo=`; the server answers from
// it, or refuses a name it doesn't serve.

/** The reads that depend on the served checkout: the project, the reports' marks, the run view, and (behold#571's approval panel) the gate ledger read from its chant/lifecycle. */
const REPO_READS = new Set(["/api/project", "/api/terragucci", "/api/terragucci/progress", "/api/terragucci/lifecycle", "/api/lifecycle/history"]);

/** The checkout name for `repo` ("<owner>/<name>") when the server serves it; null otherwise. */
export function repoParam(repo, served) {
  if (typeof repo !== "string" || !repo || !Array.isArray(served)) return null;
  const name = repo.replace(/\.git$/, "").slice(repo.lastIndexOf("/") + 1);
  return served.includes(name) ? name : null;
}

/** `url` asking for `repo`, when it is one of the reads that depend on the checkout. */
export function repoUrl(url, repo) {
  if (!repo || typeof url !== "string") return url;
  const [path, query = ""] = url.split("?");
  if (!REPO_READS.has(path)) return url;
  const q = new URLSearchParams(query);
  q.set("repo", repo);
  return `${path}?${q.toString()}`;
}
