# The demo host

One machine runs the public demo (#570, tracked in #571): Forgejo, its runner
and floci from terragucci's stack, the loop driver (terragucci
`stack/demo.sh`), a read-only `behold serve --public`, and Caddy in front of
behold. Caddy is the only thing listening on a public address. The instance has
no IAM role and no AWS credentials, since the demo is `terraform_data` against
floci's S3 and nothing on it needs to reach a real account.

```
internet ──443/80──> caddy ──edge network──> behold :4600 (--public, GET only)
                                               │ terragucci network
                                               ├─> floci :4566  (reports, demo.json; read-only key)
                                               └─> forgejo :3000 (chant/lifecycle; read-only token)
driver (host network) ── docker.sock ──> terragucci stack: forgejo, forgejo-runner, floci, job containers
watchdog (systemd) ── docker + localhost:4580 ──> driver, demo.json, behold's checkout
```

## Files

| File | What it is |
|---|---|
| `demo-host.sh` | Everything done on the host: `bootstrap`, `start`, `pause`, `update`, `open`, `close`, `status` |
| `compose.yaml` | Caddy, behold and the driver (project `demo-host`) |
| `Caddyfile` | `demo.intentius.io`, the certificate, the password until launch morning |
| `behold.Dockerfile` | behold built from its checkout at `BEHOLD_REF` |
| `driver.Dockerfile` | node, git and the Docker CLI for terragucci's scripts |
| `driver-entry.sh` | The driver container's entry: bootstrap when floci has no base, behold's keys, then the loop |
| `watchdog.sh` | Restarts the driver when it exits or stalls, logs stalls, pulls behold's checkout every cycle |
| `systemd/` | `demo-host.service` (the stack at boot) and `demo-host-watchdog.service` |
| `demo.env.example` | The settings, copied to `/etc/demo-host/demo.env` |

Forgejo, the runner and floci aren't in `compose.yaml`. They come from
terragucci's `stack/docker-compose.yml`, which the driver's bootstrap starts
the way it does on a laptop. Defining them here as well would make each
bootstrap recreate them with the other file's settings.

## The machine

- EC2, about 4 vCPU and 8 GB, for example `c7i.xlarge` (x86_64) or `c7g.xlarge`
  (arm64; every image here has both). A 60 GB gp3 root volume holds the
  terragucci CI images, Forgejo's data and the job cache.
- Ubuntu 24.04 LTS or Amazon Linux 2023. `demo-host.sh` installs Docker and
  everything else it needs from these.
- No instance profile. Nothing on the instance holds AWS credentials.
- A security group allowing:
  - TCP 443 from anywhere (the site)
  - TCP 80 from anywhere (Let's Encrypt's HTTP-01 challenge, and the redirect to https)
  - TCP 22 from the operator's address only (`<your IP>/32`)

  and nothing else. Forgejo (3300) and floci (4580) are published on
  127.0.0.1 only. The security group doesn't need to block them, but it
  does anyway.
- An Elastic IP associated with the instance.
- DNS: an `A` record for `demo.intentius.io` pointing at the Elastic IP. Create
  it before the bootstrap, because Caddy asks Let's Encrypt for the certificate
  as soon as it starts and the challenge has to reach this machine.

These four are made by hand, in the console or with the CLI. Decided on #570:
no infrastructure as code for them.

## Secrets

The only secret given to the host is the password the site carries until
launch morning. Write it to a file on your laptop, never in this repo
(`.gitignore` here lists `secrets.env` in case one lands next to these files):

```sh
DEMO_AUTH_PASSWORD=<at least 12 characters>
```

The file may also set any key of `demo.env.example`, for example
`BEHOLD_REF=<branch>` to bring the host up from a branch. Without a secrets
file, `bootstrap` asks for the password on the terminal.

What the host keeps:

| Where | What |
|---|---|
| `/etc/demo-host/demo.env` | the settings (mode 600); no secrets |
| `/etc/demo-host/caddy/password.caddy` | the `basic_auth` block: the user and a bcrypt hash, never the password |
| `/var/lib/demo-host/behold/behold-s3.env` | behold's floci key (`s3:GetObject` and `s3:ListBucket` on the reports prefix), new after each bootstrap |
| `/var/lib/demo-host/viewer.env` | the Forgejo user `demo-viewer`'s generated password and its `read:repository` token |
| `/opt/demo/terragucci/stack/.state/` | terragucci's own: Forgejo's admin token, the driver's signing key, the base snapshot |

## Bring it up

On a fresh instance:

```sh
scp secrets.env deploy/demo-host/demo-host.sh ubuntu@<elastic ip>:
ssh ubuntu@<elastic ip>
sudo bash demo-host.sh bootstrap --secrets ./secrets.env
```

The host keeps only the password's hash, so `secrets.env` doesn't need to stay
on it after the bootstrap.

`bootstrap` does, in order:

1. Installs Docker with the compose and buildx plugins, git, jq and curl.
2. Writes `/etc/docker/daemon.json` with `"ip": "127.0.0.1"`, so every port a
   container publishes without naming an address binds to localhost. Caddy's
   80 and 443 name `0.0.0.0` in `compose.yaml`; nothing else does.
3. Clones behold at `BEHOLD_REF` into `/opt/demo/behold` and continues from
   that checkout's copy of this script.
4. Writes `/etc/demo-host/demo.env` and Caddy's password file.
5. Clones terragucci at `TERRAGUCCI_REF` into `/opt/demo/terragucci`.
6. Installs and enables the two systemd units.
7. Builds the behold and driver images and starts the driver.
8. Waits for the driver's bootstrap (`stack/demo.sh up`). The first one builds
   terragucci's CI images and applies the base, so it takes a while; follow it
   with `docker logs -f demo-host-driver`.
9. Starts behold and Caddy. Caddy gets the certificate.

Running `bootstrap` again is safe. It keeps an existing `demo.env` and
password.

## What happens at boot

Docker restarts every `demo-host` container (`restart: unless-stopped`), and
`demo-host.service` runs `demo-host.sh start` as well. floci keeps everything
in memory, so after a reboot its states, reports and keys are gone. The
driver's entry (`driver-entry.sh`) notices: floci has no
`demo-host/bootstrapped` object for the checkout's commit. It runs
`stack/demo.sh up` again, which starts Forgejo and floci from terragucci's
compose file and applies the base. Then it gives behold a new floci key,
restarts behold, and starts the loop. Forgejo's data is on a volume and
survives the reboot.

## The watchdog

`demo-host-watchdog.service` runs `watchdog.sh`, which checks every 15 seconds:

- If the driver container isn't running, it starts it. A restart that Docker
  did by itself is logged too.
- If `demo.json` says `stalled`, the stall is logged right away. The driver
  resets and moves on by itself first. If it still says `stalled` after
  `DEMO_WATCHDOG_STALLED_GRACE` (300 s), the driver is restarted.
- If `demo.json` hasn't changed for `DEMO_WATCHDOG_STALE` (1800 s, longer than
  any one step's limit in the driver), the driver is restarted. While there is
  no `demo.json` at all, during a bootstrap, the limit is `DEMO_WATCHDOG_BOOT`
  (3600 s).
- When the cycle number in `demo.json` changes, behold's checkout is moved to
  origin's `main`.

The watchdog never pushes, resets `main` or writes a state. A restart stops the
driver, and the driver's own start does the reset, under the loop's rule that
nothing is pushed to `main` while a wave waits or applies
(INTENTIUS/terragucci#1014).

Stalls go to `/var/log/demo-host/stalls.log` and to the journal
(`journalctl -u demo-host-watchdog`).

## Running it

```sh
sudo /opt/demo/behold/deploy/demo-host/demo-host.sh status   # containers, demo.json, last stalls
docker logs -f demo-host-driver                              # the loop
sudo /opt/demo/behold/deploy/demo-host/demo-host.sh pause    # stop the loop, and keep it stopped
sudo /opt/demo/behold/deploy/demo-host/demo-host.sh start    # start it again
```

To reach Forgejo from your laptop, tunnel to it:
`ssh -L 3300:127.0.0.1:3300 ubuntu@<elastic ip>`, then open
http://localhost:3300.

## Launch morning (2026-11-04)

Take the password off:

```sh
sudo /opt/demo/behold/deploy/demo-host/demo-host.sh open
```

This renames `/etc/demo-host/caddy/password.caddy` to `password.caddy.off` and
reloads Caddy. The `Caddyfile` imports `/etc/caddy/auth/*.caddy`, and once no
file matches, there's no `basic_auth`. `demo-host.sh close` puts it back.

## Switching to the releases (2026-11-03)

Until 2026-11-03 the host runs both checkouts at `main`: the driver builds
terragucci's CI images from its checkout, and behold's image is built from its
checkout. Once the releases are cut, point the host at the tags:

```sh
sudo /opt/demo/behold/deploy/demo-host/demo-host.sh update --terragucci-ref v<x.y.z> --behold-ref behold-v<x.y.z>
```

`update` writes both refs to `demo.env`, moves the checkouts, rebuilds the
behold image, and recreates the driver. Because the terragucci commit changed,
the driver runs its bootstrap again, which builds the CI images for that tag
and applies the base. `update` with no flags moves the checkouts to whatever
refs `demo.env` already names, for example after a fix lands on `main`.

`update` restarts the driver wherever it is in a cycle, so run it while
`demo.json` says `reset` or `applied`, when no wave is waiting or applying.

## What this relies on from the other lanes

- `behold serve --public`, `--host`, `--allow-host` and `--terragucci`
  (#569, pull request #572). behold binds `0.0.0.0` inside its container,
  which publishes nothing, and only Caddy reaches it.
- terragucci `stack/demo.sh up` and `stack/demo.sh loop`
  (INTENTIUS/terragucci#1014). The repo is `terragucci-admin/demo` (the
  stack's admin, `$USER/demo`), the reports are `s3://demo-reports/demo`, and
  `demo.json` is at `demo-reports/demo/demo.json`. The admin token is in
  `stack/.state/forgejo.env`. If any of these change, set `DEMO_REPO` or
  `DEMO_REPORTS` in `demo.env`.
- terragucci `stack/docker-compose.yml`: the network `terragucci`, and Forgejo
  and floci published on 3300 and 4580 with no address.
- behold's floci key is limited only while floci's IAM enforcement is on.
  The driver's environment sets `TERRAGUCCI_FLOCI_IAM_ENFORCEMENT=true`
  (`compose.yaml`), and terragucci's compose file has to read it:
  `FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED: ${TERRAGUCCI_FLOCI_IAM_ENFORCEMENT:-false}`.
  That line lands with INTENTIUS/terragucci#1014 step 2. Until then floci
  starts with enforcement off, and behold's key, like any key, can do anything
  in floci. Under enforcement, `test` (the jobs' and the driver's key) passes
  as floci's account root, and unsigned S3 requests are not refused.
