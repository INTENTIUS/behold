/**
 * What differs between the forges the action runs on, in one place: where the
 * pull request or merge request comes from, how to talk to the API, how a
 * comment is found and edited, and the words the summary uses. run.mjs is
 * written against this and holds no forge name of its own.
 *
 * github.mjs, gitlab.mjs and forgejo.mjs hold the REST calls of each forge.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { githubClient, updateIfPresent as githubUpdateIfPresent, upsertComment as githubUpsert } from "./github.mjs";
import { forgejoClient, updateIfPresent as forgejoUpdateIfPresent, upsertComment as forgejoUpsert } from "./forgejo.mjs";
import { gitlabClient, mergeRequestOf, updateNoteIfPresent, upsertNote } from "./gitlab.mjs";

export const FORGE_NAMES = ["github", "gitlab", "forgejo"];

/** `forge: auto` looks at the variables each CI sets. Forgejo Actions also sets GITHUB_ACTIONS, so it is tested first. */
export function detectForge(env, requested = "auto") {
  if (requested && requested !== "auto") {
    if (!FORGE_NAMES.includes(requested)) throw new Error(`unknown forge ${requested}; expected ${FORGE_NAMES.join(", ")} or auto`);
    return requested;
  }
  if (env.FORGEJO_ACTIONS === "true") return "forgejo";
  if (env.GITLAB_CI === "true") return "gitlab";
  return "github";
}

/** The pull request in a `pull_request` event payload (GitHub and Forgejo share the shape). */
export function pullRequestOf(env, readFile = (p) => readFileSync(p, "utf8")) {
  if (!env.GITHUB_EVENT_PATH) return undefined;
  let event;
  try {
    event = JSON.parse(readFile(env.GITHUB_EVENT_PATH));
  } catch {
    return undefined;
  }
  const pr = event.pull_request;
  if (!pr) return undefined;
  return {
    number: pr.number ?? event.number,
    base: pr.base?.sha,
    head: pr.head?.sha,
    fork: !!pr.head?.repo && pr.head.repo.full_name !== (env.GITHUB_REPOSITORY ?? env.FORGEJO_REPOSITORY),
  };
}

const runLink = (url, label = "workflow run") => (url ? `\n<sub>behold, from the [${label}](${url}); the SVG and JSON are artifacts of that run.</sub>\n` : "");

const GITHUB = {
  name: "github",
  noun: "pull request",
  summaryTitle: "behold: what this pull request changes",
  forkNote: "This run is from a fork, so the token is read-only and the comment is posted by the workflow_run job instead.",
  deniedNote: (status) => `The token could not write a comment (HTTP ${status}). Give the job pull-requests: write, or use the workflow_run recipe in the action's README.`,
  workspace: (env) => env.GITHUB_WORKSPACE,
  requestOf: pullRequestOf,
  client: ({ token, env, fetch }) => githubClient({ token, apiUrl: env.GITHUB_API_URL, fetch }),
  target: (env) => env.GITHUB_REPOSITORY,
  footer: (env) => (env.GITHUB_RUN_ID ? runLink(`${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`) : ""),
  upsert: (c, { target, number, body, marker }) => githubUpsert(c, { repo: target, number, body, marker }),
  updateIfPresent: (c, { target, number, body, marker }) => githubUpdateIfPresent(c, { repo: target, number, body, marker }),
};

const FORGEJO = {
  ...GITHUB,
  name: "forgejo",
  forkNote: "This run is from a fork, so Forgejo gives it a read-only token and no secrets. The job summary and the artifacts are all it leaves; there is no comment.",
  deniedNote: (status) => `The token could not write a comment (HTTP ${status}). Give the repository's Actions token write access to pull requests, or run the job on a branch of the same repository.`,
  workspace: (env) => env.FORGEJO_WORKSPACE ?? env.GITHUB_WORKSPACE,
  client: ({ token, env, fetch }) => {
    const server = env.FORGEJO_SERVER_URL ?? env.GITHUB_SERVER_URL;
    return forgejoClient({ token, apiUrl: env.BEHOLD_API_URL || env.FORGEJO_API_URL || env.GITHUB_API_URL || (server ? `${server}/api/v1` : undefined), fetch });
  },
  target: (env) => env.FORGEJO_REPOSITORY ?? env.GITHUB_REPOSITORY,
  // The run page is addressed by the run number in the repository, not by the instance-wide id.
  footer: (env) => {
    const server = env.FORGEJO_SERVER_URL ?? env.GITHUB_SERVER_URL;
    const repo = env.FORGEJO_REPOSITORY ?? env.GITHUB_REPOSITORY;
    const n = env.FORGEJO_RUN_NUMBER ?? env.GITHUB_RUN_NUMBER;
    return server && repo && n ? runLink(`${server}/${repo}/actions/runs/${n}`) : "";
  },
  upsert: (c, { target, number, body, marker }) => forgejoUpsert(c, { repo: target, number, body, marker }),
  updateIfPresent: (c, { target, number, body, marker }) => forgejoUpdateIfPresent(c, { repo: target, number, body, marker }),
};

const GITLAB = {
  name: "gitlab",
  noun: "merge request",
  summaryTitle: "behold: what this merge request changes",
  forkNote: "This merge request is from a fork. The job makes no API call and posts no note, so its token never meets the fork's code. The job log and the artifacts are all it leaves.",
  deniedNote: (status) => `The token could not write a note (HTTP ${status}). Set BEHOLD_GITLAB_TOKEN to a project access token with the api scope and the Reporter role or higher.`,
  workspace: (env) => env.CI_PROJECT_DIR,
  requestOf: (env) => mergeRequestOf(env),
  client: ({ token, env, fetch }) => gitlabClient({ token, apiUrl: env.CI_API_V4_URL, fetch }),
  target: (env) => env.CI_MERGE_REQUEST_PROJECT_ID ?? env.CI_PROJECT_ID,
  /** The SVG link is what a note falls back to when the diagram does not fit GitLab's 2,000 characters. */
  footer: (env, { out, svg }) => {
    if (!env.CI_JOB_URL) return "";
    const rel = out && env.CI_PROJECT_DIR ? relative(env.CI_PROJECT_DIR, out).split("\\").join("/") : "behold-changed";
    const svgLink = svg ? ` SVG: [changed.svg](${env.CI_JOB_URL}/artifacts/file/${rel}/changed.svg).` : "";
    return `\n<sub>behold, from the [CI job](${env.CI_JOB_URL}).${svgLink} All artifacts: [browse](${env.CI_JOB_URL}/artifacts/browse/${rel}/).</sub>\n`;
  },
  upsert: (c, { target, number, body, marker, webUrl }) => upsertNote(c, { project: target, iid: number, body, marker, webUrl }),
  updateIfPresent: (c, { target, number, body, marker, webUrl }) => updateNoteIfPresent(c, { project: target, iid: number, body, marker, webUrl }),
};

const ADAPTERS = { github: GITHUB, gitlab: GITLAB, forgejo: FORGEJO };

/** @param {"github" | "gitlab" | "forgejo"} name */
export const forgeAdapter = (name) => ADAPTERS[name];
