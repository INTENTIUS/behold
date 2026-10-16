// The demo host's own services (#570): Caddy, a public read-only behold, and
// the loop driver. `npm run build:docker` writes them to ../compose.yaml,
// which demo-host.sh runs as compose project demo-host, with
// /etc/demo-host/demo.env as the env file; see ../README.md.
//
// Forgejo, its runner and floci are not here. They are terragucci's stack
// (stack/docker-compose.yml, project terragucci, profile forgejo), and the
// driver's bootstrap (terragucci stack/demo.sh up, which runs
// stack/bootstrap.sh forgejo) starts them with that file. Defining them here
// too would make each bootstrap recreate them with the other file's settings.
//
// Only Caddy publishes a port. The host's Docker daemon binds every published
// port that names no address to 127.0.0.1 ("ip" in /etc/docker/daemon.json,
// written by demo-host.sh bootstrap), so Forgejo's 3300 and floci's 4580 from
// terragucci's file listen on localhost only. Caddy names 0.0.0.0 itself.
//
// Every service has restart: unless-stopped, so Docker starts it again when
// the machine boots; demo-host.service runs `up -d` at boot as well.
import { Network, Service, Volume } from "@intentius/chant-lexicon-docker";

/** Caddy and behold. Nothing else is on it. */
export const edge = new Network({ name: "demo-host-edge" });

/**
 * terragucci's network, made by its compose file: behold reads floci
 * (http://floci:4566) and fetches chant/lifecycle from Forgejo
 * (http://forgejo:3000) over it. The driver's first bootstrap creates it, so
 * behold waits in its entry loop until then.
 */
export const terragucci = new Network({ name: "${TG_NETWORK:-terragucci}", external: true });

// Compose keys with a hyphen, as the services mount them: string export names.
const caddyData = new Volume({ name: "demo-host-caddy-data" });
const caddyConfig = new Volume({ name: "demo-host-caddy-config" });
export { caddyData as "caddy-data", caddyConfig as "caddy-config" };

export const caddy = new Service({
  image: "caddy:2.11.4-alpine",
  container_name: "demo-host-caddy",
  restart: "unless-stopped",
  depends_on: ["behold"],
  ports: ["0.0.0.0:80:80", "0.0.0.0:443:443"],
  environment: {
    DEMO_HOSTNAME: "${DEMO_HOSTNAME:-demo.intentius.io}",
  },
  volumes: [
    "./Caddyfile:/etc/caddy/Caddyfile:ro",
    // password.caddy: the basic_auth block, written by demo-host.sh
    // bootstrap from the password it is given. Never in the repo.
    "/etc/demo-host/caddy:/etc/caddy/auth:ro",
    "caddy-data:/data",
    "caddy-config:/config",
  ],
  networks: ["edge"],
});

// behold binds 0.0.0.0 inside its container, which publishes nothing: only
// Caddy, on the edge network, reaches it. --allow-host lets the public name
// through behold's Host check. `$$` is compose's escape for a literal `$`.
// behold#571: /view holds a checkout per demo repo. behold serves the first
// of DEMO_REPOS by default, and any of them for a request that asks for it by
// name (--repos /view): the kiosk asks for the repo its scenario runs on, a
// tool's page for its tool's repo.
const beholdEntry = `first="$$(set -- $$DEMO_REPOS; echo "$$1")"
first="/view/$\${first##*/}"
until [ -s /run/demo-host/behold-s3.env ] && [ -d "$$first/.git" ]; do
  echo "waiting for the driver's bootstrap (behold-s3.env and the view checkout $$first)"; sleep 10
done
. /run/demo-host/behold-s3.env
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
exec node /app/bin/behold.js serve "$$first" --repos /view --public \\
  --host 0.0.0.0 --port 4600 \\
  --allow-host "$$DEMO_HOSTNAME" \\
  --terragucci "$$DEMO_REPORTS"
`;

export const behold = new Service({
  build: {
    context: "${BEHOLD_SRC:-/opt/demo/behold}",
    dockerfile: "deploy/demo-host/behold.Dockerfile",
  },
  image: "demo-host-behold:local",
  container_name: "demo-host-behold",
  restart: "unless-stopped",
  // The node user of the image. The view checkout is chowned to it.
  user: "1000:1000",
  environment: {
    HOME: "/tmp",
    DEMO_HOSTNAME: "${DEMO_HOSTNAME:-demo.intentius.io}",
    DEMO_REPORTS: "${DEMO_REPORTS:-s3://demo-reports/demo}",
    DEMO_REPOS: "${DEMO_REPOS:-terragucci-admin/demo terragucci-admin/demo-terragrunt terragucci-admin/demo-chant}",
    AWS_ENDPOINT_URL: "http://floci:4566",
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-east-1",
    // behold#571: the kiosk's "Pipeline metrics" read the stack's Prometheus
    // (terragucci's observability-lite profile, which stack/demo.sh up starts)
    // on the terragucci network. With it down, the pane does not show.
    BEHOLD_PROMETHEUS_URL: "http://prometheus:9090",
  },
  volumes: [
    // A checkout per demo repo, /view/<repo name> (behold#571): behold's
    // cards are their roots. The watchdog moves each to origin's main at the
    // start of every cycle. `views`, not the single checkout `view` was
    // before: that directory is left as it is.
    "${DEMO_ROOT:-/opt/demo}/views:/view",
    // behold-s3.env: floci keys that may only GetObject on the reports
    // prefix, written by driver-entry.sh after each bootstrap.
    "/var/lib/demo-host/behold:/run/demo-host:ro",
  ],
  command: ["sh", "-c", beholdEntry],
  networks: ["edge", "terragucci"],
});

/**
 * The loop driver: terragucci's stack/demo.sh, from the terragucci checkout,
 * in a container with node, git and the Docker CLI. It drives the host's
 * Docker through the socket (bootstrap.sh starts Forgejo, the runner and
 * floci with it, and builds the CI images), and uses the host's network,
 * because terragucci's scripts reach Forgejo and floci on localhost:3300
 * and localhost:4580. The checkout is mounted at the same path as on the
 * host, so the compose file and build contexts it hands the daemon resolve.
 */
export const driver = new Service({
  build: {
    context: ".",
    dockerfile: "driver.Dockerfile",
  },
  image: "demo-host-driver:local",
  container_name: "demo-host-driver",
  restart: "unless-stopped",
  network_mode: "host",
  working_dir: "${DEMO_ROOT:-/opt/demo}/terragucci",
  environment: {
    TERRAGUCCI_SRC: "${DEMO_ROOT:-/opt/demo}/terragucci",
    DEMO_REPOS: "${DEMO_REPOS:-terragucci-admin/demo terragucci-admin/demo-terragrunt terragucci-admin/demo-chant}",
    DEMO_REPORTS: "${DEMO_REPORTS:-s3://demo-reports/demo}",
    // The scenarios the loop runs, space-separated, as terragucci's
    // stack/demo.sh reads them; empty or unset is its default list.
    DEMO_SCENARIOS: "${DEMO_SCENARIOS:-}",
    DEMO_VIEWER_USER: "${DEMO_VIEWER_USER:-demo-viewer}",
    TERRAGUCCI_FORGEJO_PORT: "${TERRAGUCCI_FORGEJO_PORT:-3300}",
    TERRAGUCCI_FLOCI_PORT: "${TERRAGUCCI_FLOCI_PORT:-4580}",
    // floci checks every signed key but `test` against its IAM policies, so
    // behold-reader's key can only read the reports prefix; the jobs and the
    // driver keep `test`. terragucci's stack/docker-compose.yml reads this
    // as FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED from
    // INTENTIUS/terragucci#1014 step 2 on (decided on #570). Before that
    // line lands, floci runs with enforcement off whatever this says.
    TERRAGUCCI_FLOCI_IAM_ENFORCEMENT: "true",
  },
  volumes: [
    "/var/run/docker.sock:/var/run/docker.sock",
    "${DEMO_ROOT:-/opt/demo}/terragucci:${DEMO_ROOT:-/opt/demo}/terragucci",
    "${DEMO_ROOT:-/opt/demo}/views:/view",
    "/var/lib/demo-host:/var/lib/demo-host",
    "./driver-entry.sh:/usr/local/bin/driver-entry.sh:ro",
  ],
  command: ["/usr/local/bin/driver-entry.sh"],
});
