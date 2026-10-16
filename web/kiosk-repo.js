// behold#571: which repo the kiosk's graph reads, on a behold that serves
// several (`behold serve --repos`, one checkout per demo repo). The kiosk
// knows the repo it is about (demo.json's `repo`, or a tool's latest cycle's)
// and asks for that checkout by name with `?repo=`; the server answers from
// it, or refuses a name it doesn't serve.

/** The reads that depend on the served checkout: the project, the reports' marks, the run view, (behold#571's approval panel) the gate ledger read from its chant/lifecycle, and (behold#631) a chant repo's pull-request loop. */
const REPO_READS = new Set(["/api/project", "/api/terragucci", "/api/terragucci/progress", "/api/terragucci/lifecycle", "/api/lifecycle/history", "/api/chant/pr"]);

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

const sameCommit = (a, b) => typeof a === "string" && typeof b === "string" && !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * The checkout that holds the step's commit (behold#571). A step names the
 * commit it is about (demo.json's `commit`: a pull request's head, then its
 * merge); the repo's own checkout may sit on another one. Of `name` and the
 * served checkouts named `<name>.<anything>`, the one whose commit
 * (`/api/project`'s viewCommits) is the step's; `name` when none is, at the
 * reset and on the base, which draw the base.
 */
export function stepCheckout(name, demo, served, commits) {
  if (!name || !demo || !demo.commit || !commits || !Array.isArray(served)) return name;
  if (demo.scenario === "base" || demo.step === "reset") return name;
  const at = (n) => sameCommit(commits[n], demo.commit);
  if (at(name)) return name;
  return served.find((n) => n.startsWith(`${name}.`) && at(n)) || name;
}
