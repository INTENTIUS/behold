/**
 * behold#1083: the exec credential plugin a kubeconfig user can name
 * (`users[].user.exec`, client.authentication.k8s.io), run once to get a token
 * or a client certificate for a read.
 *
 * Kubeconfigs the GKE, EKS and AKS command line tools write usually name one
 * (`gke-gcloud-auth-plugin`, `aws eks get-token`, `kubelogin`). chant's lister
 * takes static credentials only and refuses such a user, so behold would have
 * to run the plugin and hand chant what it prints. Running a command a file
 * names is a choice the person makes, so src/read-cluster.ts refuses an exec
 * user unless the caller passes `allowExecPlugin` (`--allow-exec-plugin` on
 * `behold graph`). This module is only the runner, and it is never reached
 * without that.
 *
 * The protocol is the one kubectl speaks: the command runs with the user's
 * `args` and `env` added to the process environment, with no terminal for
 * input, and prints an `ExecCredential` on stdout whose `status` holds a
 * `token`, or a `clientCertificateData` and `clientKeyData`. `provideClusterInfo`
 * is honoured through `KUBERNETES_EXEC_INFO`. A relative command with a slash
 * in it resolves against the kubeconfig's directory, as client-go does.
 */
import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export interface ExecUser {
  apiVersion?: string;
  command?: string;
  args?: string[];
  env?: { name: string; value: string }[];
  provideClusterInfo?: boolean;
}

export interface ExecCluster {
  server: string;
  caData?: string;
  insecureSkipVerify?: boolean;
}

export interface ExecCredentialStatus {
  token?: string;
  clientCertificateData?: string;
  clientKeyData?: string;
}

/** The plugin ran and did not give a credential. */
export class ExecPluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecPluginError";
  }
}

export type ExecRunner = (command: string, args: string[], env: Record<string, string>, timeoutMs: number) => Promise<{ stdout: string }>;

const defaultRunner: ExecRunner = (command, args, env, timeoutMs) =>
  new Promise((resolveRun, reject) => {
    const child = execFile(command, args, { env, timeout: timeoutMs, maxBuffer: 1 << 20, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new ExecPluginError(`${command} failed: ${String(stderr || err.message).trim().slice(0, 400)}`));
      else resolveRun({ stdout });
    });
    // No terminal and no input: a plugin that wants a prompt fails instead of hanging.
    child.stdin?.end();
  });

/** Run the plugin a kubeconfig user names and answer the credential it printed. */
export async function runExecPlugin(
  user: ExecUser,
  cluster: ExecCluster,
  opts: { baseDir?: string; env?: Readonly<Record<string, string | undefined>>; run?: ExecRunner; timeoutMs?: number } = {},
): Promise<ExecCredentialStatus> {
  if (!user.command) throw new ExecPluginError("the exec entry names no command");
  const apiVersion = user.apiVersion ?? "client.authentication.k8s.io/v1";
  const command = !isAbsolute(user.command) && user.command.includes("/") && opts.baseDir ? resolve(opts.baseDir, user.command) : user.command;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? process.env)) if (v !== undefined) env[k] = v;
  for (const e of user.env ?? []) env[e.name] = e.value;
  env.KUBERNETES_EXEC_INFO = JSON.stringify({
    apiVersion,
    kind: "ExecCredential",
    spec: {
      interactive: false,
      ...(user.provideClusterInfo
        ? { cluster: { server: cluster.server, ...(cluster.caData ? { "certificate-authority-data": cluster.caData } : {}), ...(cluster.insecureSkipVerify ? { "insecure-skip-tls-verify": true } : {}) } }
        : {}),
    },
  });
  const { stdout } = await (opts.run ?? defaultRunner)(command, user.args ?? [], env, opts.timeoutMs ?? 30_000);
  let doc: { kind?: string; status?: ExecCredentialStatus };
  try {
    doc = JSON.parse(stdout);
  } catch {
    throw new ExecPluginError(`${user.command} printed no ExecCredential JSON`);
  }
  const status = doc.status ?? {};
  const out: ExecCredentialStatus = {};
  if (typeof status.token === "string" && status.token) out.token = status.token;
  if (typeof status.clientCertificateData === "string" && status.clientCertificateData) out.clientCertificateData = status.clientCertificateData;
  if (typeof status.clientKeyData === "string" && status.clientKeyData) out.clientKeyData = status.clientKeyData;
  if (!out.token && !(out.clientCertificateData && out.clientKeyData)) throw new ExecPluginError(`${user.command} printed an ExecCredential with no token and no client certificate`);
  return out;
}
