// `demo-host.sh update` keeps the loop and the site going for as long as it
// can: the images build while the loop runs, the driver stops only at a quiet
// step, and only then does the terragucci checkout it reads move.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../deploy/demo-host");
const sh = readFileSync(join(DIR, "demo-host.sh"), "utf8");

/** One function of demo-host.sh, from its `name() {` line to the `}` that closes it. */
function fn(name: string): string {
  const start = sh.indexOf(`\n${name}() {`);
  expect(start, `${name} in demo-host.sh`).toBeGreaterThan(-1);
  return sh.slice(start + 1, sh.indexOf("\n}\n", start) + 2);
}

/** wait_quiet against a stub floci answering `steps` in turn (the last one from then on), and a driver running or not. */
function waitQuiet(steps: string[], opts: { running?: boolean; limit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "demo-host-update-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "steps"), steps.join("\n") + "\n");
  writeFileSync(join(dir, "demo.env"), `DEMO_QUIET_WAIT=${opts.limit ?? 900}\n`);
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash\nn=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"\nstep=$(sed -n "\${n}p" "${dir}/steps"); [ -n "$step" ] || step=$(tail -1 "${dir}/steps")\n[ "$step" = down ] && exit 7\necho "{\\"step\\":\\"$step\\"}"\n`,
  );
  writeFileSync(join(bin, "docker"), `#!/bin/sh\necho ${opts.running === false ? "false" : "true"}\n`);
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\n:\n");
  for (const f of ["curl", "docker", "sleep"]) chmodSync(join(bin, f), 0o755);
  const script = [
    "set -euo pipefail",
    `ENV_FILE=${JSON.stringify(join(dir, "demo.env"))}`,
    fn("log"),
    fn("die"),
    fn("conf"),
    fn("wait_quiet"),
    "wait_quiet",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  const looks = Number(readFileSync(join(dir, "n"), { encoding: "utf8", flag: "a+" }) || 0);
  return { status: r.status, err: r.stderr, looks };
}

describe("demo-host.sh update", () => {
  it("builds before the quiet step, and moves the terragucci checkout only after the driver stopped there", () => {
    const update = fn("cmd_update");
    expect(update).not.toMatch(/^\s*checkouts$/m);
    expect(update).not.toContain("checkout terragucci");
    expect(update).toContain('checkout behold "$(conf BEHOLD_REF main)"');
    const rest = fn("cmd_update_rest");
    const at = (s: string) => {
      const i = rest.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    expect(at("compose build")).toBeLessThan(at("wait_quiet"));
    expect(at("wait_quiet")).toBeLessThan(at("compose stop driver"));
    expect(at("compose stop driver")).toBeLessThan(at('checkout terragucci "$(conf TERRAGUCCI_REF main)"'));
    expect(at('checkout terragucci "$(conf TERRAGUCCI_REF main)"')).toBeLessThan(at("compose up -d --force-recreate driver"));
    expect(fn("cmd_update_prepare_rest")).toContain("compose build");
    expect(fn("cmd_update_prepare")).not.toContain("checkout terragucci");
  });

  it("restarts Caddy only when the Caddyfile changed", () => {
    expect(fn("cmd_update_rest")).toContain("if caddy_current; then");
  });

  it("waits for reset or applied before it lets the driver stop", () => {
    const r = waitQuiet(["planned", "waiting", "applying", "applied"]);
    expect(r.status).toBe(0);
    expect(r.looks).toBe(4);
    expect(r.err).toContain("demo.json says applied");
    expect(waitQuiet(["reset"]).looks).toBe(1);
  });

  it("gives up past DEMO_QUIET_WAIT and stops the update", () => {
    const r = waitQuiet(["applying"], { limit: 0 });
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("still says applying after 0s");
  });

  it("does not wait when the driver isn't running or demo.json isn't there", () => {
    expect(waitQuiet(["applying"], { running: false }).looks).toBe(0);
    expect(waitQuiet(["down"]).status).toBe(0);
  });
});
