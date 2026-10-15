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
| `compose.yaml` | Caddy, behold and the driver (project `demo-host`); written by chant |
| `Caddyfile` | `demo.intentius.io`, the certificate, the password until launch morning |
| `behold.Dockerfile` | behold built from its checkout at `BEHOLD_REF`; written by chant |
| `driver.Dockerfile` | node, git and the Docker CLI for terragucci's scripts; written by chant |
| `driver-entry.sh` | The driver container's entry: bootstrap when floci has no base, behold's keys, then the loop |
| `watchdog.sh` | Restarts the driver when it exits or stalls, logs stalls, pulls behold's checkout every cycle |
| `systemd/` | `demo-host.service` (the stack at boot) and `demo-host-watchdog.service` |
| `demo.env.example` | The settings, copied to `/etc/demo-host/demo.env` |
| `chant/` | The chant project: the AWS resources (`src/aws`), `compose.yaml` and the Dockerfiles (`src/docker`), and the ops (`ops/`) |

Forgejo, the runner and floci aren't in `compose.yaml`. They come from
terragucci's `stack/docker-compose.yml`, which the driver's bootstrap starts
the way it does on a laptop. Defining them here as well would make each
bootstrap recreate them with the other file's settings.

## The chant project

`chant/` is a chant project with its own `package.json`, so behold's root
doesn't carry the lexicons. It declares everything here that chant has a
lexicon for:

- `src/aws/`: the instance, security group, Elastic IP, association and key
  pair (chant's aws lexicon), built to `template.json`. See "The machine".
- `src/docker/`: `compose.yaml`, `behold.Dockerfile` and `driver.Dockerfile`
  (chant's docker lexicon). `npm run build:docker` builds them and writes
  them here, where `demo-host.sh` reads them, with a header naming the source
  and the compose project's `name: demo-host`, which the lexicon has no field
  for. Edit the TypeScript, not these files.
- `ops/`: the procedures the operator runs from a laptop, as chant Ops. See
  "The ops".

`npm run check` (and `just demo-host-check`, and CI's `demo-host` job)
typechecks and lints the project, and fails when `template.json`,
`compose.yaml` or either Dockerfile isn't what chant builds.

These stay as files, because chant has no lexicon for them: the `Caddyfile`,
the systemd units, `demo-host.sh`, `driver-entry.sh`, `watchdog.sh` and
`demo.env.example`.

## The machine

The host's AWS resources are declared in chant, in `chant/src/aws/host.ts`
(chant's aws lexicon, CloudFormation), and live in the stack
`demo-intentius-host` in us-east-2, account 354867293429:

| Logical id | Resource |
|---|---|
| `hostInstance` | `i-0262f1207d6eac51d`, c7i.xlarge, Ubuntu 24.04 (`ami-09519cc56eb20524a`), 60 GB gp3 root, IMDSv2 only, no instance profile |
| `hostSecurityGroup` | `sg-0a79a7fda2a635059` `demo-intentius-host` in the default VPC: TCP 443 and 80 from anywhere (the site; Let's Encrypt's HTTP-01 challenge and the redirect), TCP 22 from the operator's address only |
| `hostEip` | the Elastic IP `77.114.54.88` (`eipalloc-0c27d65c070ab3d92`) |
| `hostEipAssociation` | its association with the instance (`eipassoc-0b56691cca77e7314`) |
| `demoKeyPair` | the ed25519 key pair `demo-intentius` (the public half; the private key is the operator's `~/.ssh/demo-intentius.pem`) |

The stack's outputs are `ElasticIp` and `ElasticIpAllocationId`. The DNS
record for `demo.intentius.io` is an `A` record pointing at `ElasticIp`; it
isn't in the stack. The default VPC and its subnet are the account's and are
named by id.

Every resource has `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`.
Deleting the stack, or removing a resource from `host.ts`, leaves the resource
in the account. The `demo-host-infra` op also refuses a change set that would
replace a resource, since a new instance or a new Elastic IP would take the
demo down and change the address DNS names.

Nothing on the instance holds AWS credentials, since the demo is
`terraform_data` against floci's S3 and nothing on it needs to reach a real
account. Forgejo (3300) and floci (4580) are published on 127.0.0.1 only; the
security group doesn't need to block them, but it does anyway.

### Building and deploying it

```sh
cd deploy/demo-host/chant
npm ci
npm run build:aws            # writes template.json
npx chant run demo-host-infra
```

`demo-host-infra` builds `template.json`, makes a change set against the
stack, prints it, and stops at a gate. Read the change set, then approve it and
run the op again: it executes the change set and runs drift detection.

```sh
npx chant approve demo-host-infra apply-change-set --actor <you>
npx chant run demo-host-infra
```

The gate approves that plan's digest, so if the change set differs on the
second run, it stops again. `template.json` is committed; `npm run check`
(and CI) fails when it isn't what chant builds from `src/aws`.

### How the stack was made

The instance, security group, Elastic IP, association and key pair were made
by hand on 2026-10-15 (an earlier decision on #570 said no infrastructure as
code; that was replaced). On 2026-10-15 they were brought under the stack by
CloudFormation resource import, without changing any of them:

1. Every property in `host.ts` was read off the live resources
   (`aws ec2 describe-instances`, `describe-security-groups`,
   `describe-addresses`, `describe-key-pairs`, `describe-volumes`).
2. An import can't add outputs, so the import used `template.json` without
   them (`jq 'del(.Outputs)' template.json > build/import-template.json`).
3. `aws cloudformation create-change-set --change-set-type IMPORT` with
   `chant/import.json`, which names each resource by its identifier
   (`KeyName`, the security group's `Id`, `InstanceId`, the EIP's `PublicIp`
   and `AllocationId`, the association's `Id`). All five resource types
   support import.
4. `describe-change-set` showed five changes, every one `Import` with no
   replacement and nothing else; then `execute-change-set`, to
   `IMPORT_COMPLETE`.
5. An `UPDATE` change set with the full `template.json` added the two outputs.
   It had no resource changes.
6. Drift detection: `IN_SYNC`, no drifted resources. (CloudFormation doesn't
   detect drift on `AWS::EC2::EIPAssociation`.)

The import added CloudFormation's own `aws:cloudformation:*` tags to the
instance, security group and Elastic IP. The key pair's tags can't change
without replacing it, so CloudFormation left them alone.

To make a host like this from nothing, `chant build` the same source and
deploy it as a new stack; for this host that is never needed.

## The ops

Run from `deploy/demo-host/chant` on the operator's laptop, with
`npx chant run <name>`. They reach the host over ssh as `ubuntu`, at the
stack's `ElasticIp` output, with `~/.ssh/demo-intentius.pem` (`ops/host.sh`;
`DEMO_HOST_IP` and `DEMO_SSH_KEY` override both). Each calls `demo-host.sh` on
the host, so the systemd units and the watchdog don't change, and the
subcommands below still work by hand.

| Op | What it does |
|---|---|
| `demo-host-status` | `demo-host.sh status`: the containers, `demo.json`, the last stalls. Changes nothing. |
| `demo-host-bootstrap` | `demo-host.sh bootstrap` one piece per phase, for a fresh instance: copy the script and the secrets file (`DEMO_SECRETS`, default `./secrets.env`), install Docker, check out behold, write `demo.env` and Caddy's password (and remove the copied secrets file), check out terragucci and behold, install the units, build the images, start the driver and the watchdog, wait for the driver's base apply (up to 75 minutes), then bring up behold and Caddy. Not for the live host. |
| `demo-host-update` | Waits until `demo.json` says `reset` or `applied` (read from floci on the host), runs `demo-host.sh update` with `--terragucci-ref "$TERRAGUCCI_REF"` and `--behold-ref "$BEHOLD_REF"` for whichever of the two is set, then waits until floci holds the driver's base for the new terragucci commit (`bootstrapped at terragucci <commit>` in the driver's log). |
| `demo-host-go-public` | Launch morning. Checks that `demo.intentius.io` resolves to the Elastic IP and answers on https. While the host's `Caddyfile` still has the plain-http site by the address, it waits for a quiet step, runs `demo-host.sh update` so the host takes what behold's `main` holds (behold #590 removes that site), and fails if `main` still has it. It reloads Caddy and checks the address no longer serves the view. Then it stops at the gate `take-the-password-off`. After `npx chant approve demo-host-go-public take-the-password-off --actor <you>` and another run, it runs `demo-host.sh open` and checks the site answers 200 without a password. |
| `demo-host-infra` | The AWS stack: build, change set, gate `apply-change-set`, execute, drift detection. See "Building and deploying it". |

A gate stops the run with exit code 3 and records the pending approval;
`npx chant run status <name>` shows it. The run after an approval starts from
the first phase again. Every phase before a gate in these ops can run twice
without changing anything the first run didn't.

`demo-host.sh`'s pieces of `bootstrap`, which `demo-host-bootstrap` calls in
order: `install`, `checkout-self [--secrets <file>]`,
`configure [--secrets <file>]`, `checkouts`, `units`, `build`,
`start-driver`, `wait-bootstrap`, `up`. `reload-caddy` reloads Caddy's
config.

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

On a fresh instance, from your laptop: `npx chant run demo-host-bootstrap` in
`chant/` (see "The ops"). By hand:

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

From your laptop, `npx chant run demo-host-go-public` in `chant/` does the
checks, drops the by-address http site and stops for an approval before the
password comes off (see "The ops"). By hand, take the password off:

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
`TERRAGUCCI_REF=v<x.y.z> BEHOLD_REF=behold-v<x.y.z> npx chant run demo-host-update`
in `chant/` waits for that step itself, then waits for the new bootstrap.

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
