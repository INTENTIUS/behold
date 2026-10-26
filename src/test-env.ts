/**
 * behold#1013: vitest's setup file (vitest.config.ts `setupFiles`), run in
 * every worker before each test file. No test reads the environment of the
 * shell that started vitest.
 *
 * At round 1's epic-ready, src/choudoufu-member.test.ts and src/doctor.test.ts
 * failed with CHOUDOUFU_BIN pointing at a local choudoufu build and passed
 * without it, and the first run spawned a real `pulumi refresh` against the
 * machine's default Pulumi backend. So:
 *
 *  - every variable behold reads to pick a binary, an endpoint or a service
 *    is removed. A test that wants one sets it and puts back what was there
 *    (src/demos.test.ts and src/choudoufu-member.test.ts do for
 *    CHOUDOUFU_BIN);
 *  - Pulumi's login and backend are replaced: PULUMI_BACKEND_URL names an
 *    empty directory made for this run (vitest.config.ts), which wins over
 *    whatever `pulumi login` stored in ~/.pulumi, PULUMI_ACCESS_TOKEN and the
 *    other Pulumi Cloud variables are removed, and PULUMI_SKIP_UPDATE_CHECK
 *    is true, so a pulumi or plunge that chant or behold spawns reaches
 *    neither Pulumi Cloud nor the network for a version check.
 *
 * BEHOLD_CACHE_DIR (vitest.config.ts) and BEHOLD_REQUIRE_PEERS (the tests'
 * own switch, CI's peers job) are kept.
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Read by behold to choose a binary, an endpoint or a service; never inherited by a test. */
export const AMBIENT = [
  "CHOUDOUFU_BIN",
  "PLUNGE_BIN",
  "AWS_BIN",
  "GIT_BIN",
  "BEHOLD_DRIFT_CHANT",
  "BEHOLD_HOST",
  "BEHOLD_ALLOWED_HOSTS",
  "BEHOLD_WORKBENCH",
  "BEHOLD_SERVES_DIR",
  "BEHOLD_RECENTS_FILE",
  "BEHOLD_PROMETHEUS_URL",
  "BEHOLD_TEMPO_URL",
  "BEHOLD_HUD_URL",
  "BEHOLD_CI_RUN_DIR",
  "BEHOLD_CI_REPORT_URL",
  "BEHOLD_RUN_EVENTS_IDLE_MS",
  "BEHOLD_RUN_EVENTS_MAX_IDLE_MS",
  "FLY_FLAPS_BASE_URL",
  "LOOM_ENV",
  "TERRALITH_PORT",
  "AWS_ENDPOINT_URL",
  "AWS_REGION",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "PULUMI_ACCESS_TOKEN",
  "PULUMI_API",
  "PULUMI_CONSOLE_DOMAIN",
] as const;

for (const name of AMBIENT) delete process.env[name];

// vitest.config.ts makes the directory and passes it in. Without one the run
// stops here, before any test could spawn pulumi against ~/.pulumi's login.
const backend = process.env.PULUMI_BACKEND_URL?.startsWith("file://") ? fileURLToPath(process.env.PULUMI_BACKEND_URL) : undefined;
if (backend) mkdirSync(backend, { recursive: true });
else throw new Error("src/test-env.ts: vitest.config.ts sets no file:// PULUMI_BACKEND_URL; a test could reach the machine's Pulumi backend");
process.env.PULUMI_SKIP_UPDATE_CHECK = "true";
