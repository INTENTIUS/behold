// behold#571: `demo-host.sh update` clears what a failed recreate left before
// it starts the services. Run against a stub `docker` (and `id`, for the
// root check), which answers `ps` from a fixture and records every call.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../deploy/demo-host/demo-host.sh");

const DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$DOCKER_LOG"
if [ "$1" = ps ]; then
  svc=""
  for a in "$@"; do
    case "$a" in label=com.docker.compose.service=*) svc="\${a#label=com.docker.compose.service=}" ;; esac
  done
  while read -r s id name state; do
    [ "$s" = "$svc" ] && echo "$id $name $state"
  done < "$FIXTURE"
fi
exit 0
`;

/** Run `demo-host.sh clear-strays` over `containers` ("<service> <id> <name> <state>" lines); the docker calls it made and its log. */
function clear(containers: string[]): { calls: string[]; err: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "demo-host-strays-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), DOCKER);
  writeFileSync(join(bin, "id"), "#!/bin/sh\necho 0\n");
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "id"), 0o755);
  const fixture = join(dir, "containers");
  writeFileSync(fixture, containers.map((l) => `${l}\n`).join(""));
  const log = join(dir, "docker.log");
  writeFileSync(log, "");
  const r = spawnSync("bash", [SCRIPT, "clear-strays"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_LOG: log, FIXTURE: fixture }, encoding: "utf8" });
  return { calls: readFileSync(log, "utf8").split("\n").filter(Boolean), err: r.stderr, status: r.status };
}

const rms = (calls: string[]) => calls.filter((c) => c.startsWith("compose ")).map((c) => c.replace(/^compose --project-name demo-host -f \S+ --env-file \S+ /, ""));

describe("demo-host.sh clear-strays", () => {
  it("removes behold's containers when a failed recreate left one created and a renamed one runs as the service", () => {
    const r = clear(["behold b1 demo-host-behold-stale-20261016 running", "behold b2 9f3c1a2b_demo-host-behold created", "driver d1 demo-host-driver running"]);
    expect(r.status).toBe(0);
    expect(rms(r.calls)).toEqual(["rm --stop --force behold"]);
    expect(r.err).toContain("demo-host-behold-stale-20261016");
    expect(r.err).toContain("9f3c1a2b_demo-host-behold");
    // Only this project's containers of the service, by compose's labels.
    const ps = r.calls.filter((c) => c.startsWith("ps "));
    expect(ps.every((c) => c.includes("label=com.docker.compose.project=demo-host"))).toBe(true);
  });
  it("removes a service's container that holds its name but isn't running", () => {
    const r = clear(["behold b1 demo-host-behold running", "driver d1 demo-host-driver exited"]);
    expect(rms(r.calls)).toEqual(["rm --stop --force driver"]);
  });
  it("leaves the services alone when each runs under its name", () => {
    const r = clear(["behold b1 demo-host-behold running", "driver d1 demo-host-driver running"]);
    expect(r.status).toBe(0);
    expect(rms(r.calls)).toEqual([]);
    expect(r.calls.some((c) => c.startsWith("rm ") || c.includes(" rm "))).toBe(false);
  });
  it("does nothing when compose has made no containers yet", () => {
    const r = clear([]);
    expect(rms(r.calls)).toEqual([]);
  });
});
