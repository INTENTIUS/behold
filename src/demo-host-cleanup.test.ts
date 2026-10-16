// behold#571, #603: the demo host's disk cleanup (deploy/demo-host/cleanup.sh).
// Run against a stub `docker`, `df` and `journalctl` that answer from
// fixtures and record every call, so each test sees exactly what the script
// asked Docker to do.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, "../deploy/demo-host");
const SCRIPT = join(DIR, "cleanup.sh");

// Fixtures: images "<id> <repo> <tag>", containers "<id> <image id>".
const DOCKER = `#!/usr/bin/env bash
echo "docker $*" >> "$CALLS"
case "$1" in
  ps) cut -d' ' -f1 "$CONTAINERS" ;;
  inspect)
    shift 3
    for c in "$@"; do awk -v c="$c" '$1 == c { print $2 }' "$CONTAINERS"; done ;;
  images)
    if [ "$3" = --filter ]; then awk '$2 == "<none>"' "$IMAGES"; else cat "$IMAGES"; fi ;;
  rmi)
    # Docker refuses an image a container uses.
    id="$(awk -v r="$2" '$1 == r || ($2 ":" $3) == r { print $1 }' "$IMAGES")"
    if [ -n "$id" ] && awk '{ print $2 }' "$CONTAINERS" | grep -qxF "$id"; then echo "conflict: in use" >&2; exit 1; fi
    echo "Untagged: $2" ;;
  builder)
    if [ "$3" = --help ]; then echo "      \${BUILDER_FLAG:---max-used-space} bytes   Maximum amount of disk space"; fi ;;
  container) echo "Total reclaimed space: 0B" ;;
  volume) cat "$VOLUMES" ;;
  system) echo "TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE" ;;
esac
exit 0
`;

const DF = `#!/usr/bin/env bash
echo "df $*" >> "$CALLS"
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/root 60000000 20000000 40000000 \${DISK_PCT:-34}% /"
`;

const JOURNALCTL = `#!/usr/bin/env bash
echo "journalctl $*" >> "$CALLS"
echo "Vacuuming done, freed 0B of archived journals from /var/log/journal."
`;

interface Run {
  calls: string[];
  out: string;
  err: string;
  status: number | null;
  state: string;
  logs: string;
}

const IN_USE = "sha256:aaa1"; // floci, by digest
const OLD_IN_USE = "sha256:c031"; // a 0.4.31 image a stopped job container still holds

const IMAGES = [
  "sha256:c032a ghcr.io/intentius/terragucci-tofu 0.4.32-tofu1.13.1",
  "sha256:c032b ghcr.io/intentius/terragucci-terragrunt 0.4.32-tg1.1.6-tofu1.13.1",
  "sha256:c030a ghcr.io/intentius/terragucci-tofu 0.4.30-tofu1.13.1",
  "sha256:c030b ghcr.io/intentius/terragucci-choudoufu 0.4.30-choudoufu0.28.0",
  "sha256:c029a ghcr.io/intentius/terragucci-terraform 0.4.29-tf1.14.9",
  `${OLD_IN_USE} ghcr.io/intentius/terragucci-terraform 0.4.31-tf1.14.9`,
  "sha256:loc1 terragucci-demo-tofu local",
  "sha256:loc2 demo-host-behold local",
  "sha256:loc3 ghcr.io/intentius/terragucci-tofu local",
  `${IN_USE} ghcr.io/lex00/floci <none>`,
  "sha256:pgd1 postgres <none>",
  "sha256:dng1 <none> <none>",
  "sha256:dng2 <none> <none>",
  "sha256:oth1 node 22.23.3-bookworm-slim",
];
const CONTAINERS = ["c-floci " + IN_USE, "c-job " + OLD_IN_USE, "c-dangling sha256:dng2", "c-behold sha256:loc2"];

function cleanup(opts: { ref?: string; pkg?: string | null; disk?: number; env?: string[]; builderFlag?: string } = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "demo-host-cleanup-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of [
    ["docker", DOCKER],
    ["df", DF],
    ["journalctl", JOURNALCTL],
  ]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const root = join(dir, "opt");
  if (opts.pkg !== null) {
    mkdirSync(join(root, "terragucci/packages/terragucci"), { recursive: true });
    writeFileSync(join(root, "terragucci/packages/terragucci/package.json"), JSON.stringify({ name: "@intentius/terragucci", version: opts.pkg ?? "0.4.32" }));
  }
  const envFile = join(dir, "demo.env");
  writeFileSync(envFile, [`TERRAGUCCI_REF=${opts.ref ?? "v0.4.32"}`, ...(opts.env ?? [])].join("\n") + "\n");
  const files = { IMAGES: IMAGES, CONTAINERS: CONTAINERS, VOLUMES: [] as string[] };
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: join(dir, "calls"),
    DEMO_ENV_FILE: envFile,
    DEMO_ROOT: root,
    DEMO_STATE_DIR: join(dir, "state"),
    DEMO_LOG_DIR: join(dir, "log"),
    DISK_PCT: String(opts.disk ?? 34),
    ...(opts.builderFlag ? { BUILDER_FLAG: opts.builderFlag } : {}),
  };
  for (const [k, lines] of Object.entries(files)) {
    env[k] = join(dir, k.toLowerCase());
    writeFileSync(env[k], lines.map((l) => `${l}\n`).join(""));
  }
  writeFileSync(env.CALLS, "");
  const r = spawnSync("bash", [SCRIPT], { env, encoding: "utf8" });
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return {
    calls: read(env.CALLS).split("\n").filter(Boolean),
    out: r.stdout,
    err: r.stderr,
    status: r.status,
    state: read(join(dir, "state/disk.status")),
    logs: read(join(dir, "log/stalls.log")),
  };
}

const rmis = (r: Run) => r.calls.filter((c) => c.startsWith("docker rmi ")).map((c) => c.slice("docker rmi ".length));

/** What the script must never ask Docker to do. */
function forbidden(calls: string[]): string[] {
  return calls.filter(
    (c) =>
      /^docker (volume (prune|rm)|system prune)/.test(c) ||
      /^docker rmi .*(-f\b|--force)/.test(c) ||
      /^docker image prune .*(-a\b|--all)/.test(c) ||
      /^docker (container )?rm .*-v\b/.test(c),
  );
}

describe("cleanup.sh never removes what the host still needs", () => {
  it("never names volume prune, system prune, rmi -f or image prune -a in the script", () => {
    const code = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code).not.toMatch(/volume\s+(prune|rm)\b/);
    expect(code).not.toMatch(/system\s+prune/);
    expect(code).not.toMatch(/--volumes\b/);
    expect(code).not.toMatch(/rmi\s+(-[a-z]*f|--force)/);
    expect(code).not.toMatch(/image\s+prune/);
  });

  it("removes the CI images of other releases and unnamed dangling ones, and keeps every image a container uses, :local and the current release", () => {
    const r = cleanup();
    expect(r.status).toBe(0);
    expect(forbidden(r.calls)).toEqual([]);
    expect(rmis(r).sort()).toEqual(
      [
        "ghcr.io/intentius/terragucci-choudoufu:0.4.30-choudoufu0.28.0",
        "ghcr.io/intentius/terragucci-terraform:0.4.29-tf1.14.9",
        "ghcr.io/intentius/terragucci-tofu:0.4.30-tofu1.13.1",
        "sha256:dng1",
      ].sort(),
    );
    // The old image a stopped job container holds is kept, and said so.
    expect(r.out).toContain("ghcr.io/intentius/terragucci-terraform:0.4.31-tf1.14.9 is used by a container; kept");
    // Never the current release, a :local image, an image pulled by digest
    // or a dangling image a container uses.
    expect(rmis(r).filter((x) => /0\.4\.3[12]|local$|postgres|floci|node|^sha256:(dng2|aaa1|pgd1|loc)/.test(x))).toEqual([]);
  });

  it("reads the version from the checkout's package.json when TERRAGUCCI_REF is a commit or a branch", () => {
    for (const ref of ["6d5224f2", "main"]) {
      const r = cleanup({ ref, pkg: "0.4.30" });
      expect(forbidden(r.calls)).toEqual([]);
      expect(rmis(r)).toContain("ghcr.io/intentius/terragucci-tofu:0.4.32-tofu1.13.1");
      expect(rmis(r)).not.toContain("ghcr.io/intentius/terragucci-tofu:0.4.30-tofu1.13.1");
      expect(r.out).toContain("keeping terragucci 0.4.30");
    }
  });

  it("keeps both releases when the tag and the checkout disagree", () => {
    const r = cleanup({ ref: "v0.4.32", pkg: "0.4.30" });
    expect(rmis(r).filter((x) => x.startsWith("ghcr.io/"))).toEqual(["ghcr.io/intentius/terragucci-terraform:0.4.29-tf1.14.9"]);
  });

  it("removes no CI image when no version can be read", () => {
    const r = cleanup({ ref: "main", pkg: null });
    expect(rmis(r).filter((x) => x.startsWith("ghcr.io/"))).toEqual([]);
    expect(r.out).toContain("removing none");
  });

  it("prunes only old stopped containers no compose project made, and caps the build cache and the journal", () => {
    const r = cleanup({ env: ["DEMO_BUILD_CACHE_MAX=3GB", "DEMO_JOURNAL_MAX=200M"] });
    expect(r.calls).toContain("docker container prune --force --filter until=24h --filter label!=com.docker.compose.project");
    expect(r.calls).toContain("docker builder prune --force --max-used-space 3GB");
    expect(r.calls).toContain("journalctl --vacuum-size=200M");
    // An older buildx names the cap --keep-storage.
    expect(cleanup({ builderFlag: "--keep-storage" }).calls).toContain("docker builder prune --force --keep-storage 5GB");
  });

  it("logs the disk and docker system df before and after", () => {
    const r = cleanup();
    expect(r.out).toMatch(/\[cleanup\] before: .*used \(34%\)/);
    expect(r.out).toMatch(/\[cleanup\] after: .*used \(34%\)/);
    expect(r.calls.filter((c) => c === "docker system df")).toHaveLength(2);
    expect(r.state).toMatch(/^ok /);
  });

  it("says so loudly and exits 3 when the disk is still over DEMO_DISK_WARN", () => {
    const r = cleanup({ disk: 91 });
    expect(r.status).toBe(3);
    expect(r.err).toContain("WARNING: DISK 91% used after cleanup, over DEMO_DISK_WARN=85%");
    expect(r.logs).toContain("DISK 91% used after cleanup");
    expect(r.state).toMatch(/^over /);
    expect(forbidden(r.calls)).toEqual([]);
    expect(cleanup({ disk: 91, env: ["DEMO_DISK_WARN=95"] }).status).toBe(0);
  });
});

describe("demo-host.sh runs the cleanup", () => {
  const sh = readFileSync(join(DIR, "demo-host.sh"), "utf8");
  it("installs the cleanup unit and its daily timer, and starts it after an update", () => {
    expect(sh).toMatch(/for u in [^;]*demo-host-cleanup\.service demo-host-cleanup\.timer/);
    expect(sh).toContain("systemctl enable --now demo-host-cleanup.timer");
    const rest = sh.slice(sh.indexOf("cmd_update_rest() {"), sh.indexOf("\n}\n", sh.indexOf("cmd_update_rest() {")));
    expect(rest.indexOf("running_as_named")).toBeLessThan(rest.indexOf("systemctl start --no-block demo-host-cleanup.service"));
    expect(readFileSync(join(DIR, "systemd/demo-host-cleanup.timer"), "utf8")).toMatch(/^OnCalendar=\*-\*-\* 04:00:00 UTC$/m);
    expect(readFileSync(join(DIR, "systemd/demo-host-cleanup.service"), "utf8")).toContain("ExecStart=@DEMO_ROOT@/behold/deploy/demo-host/cleanup.sh");
  });
});
