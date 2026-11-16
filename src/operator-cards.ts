/**
 * behold#1132: the card faces of an operator's view of a cluster read
 * (src/cluster-apps.ts), registered as pinhole field packs in src/render.ts.
 *
 * - A workload card: ready over desired replicas, its image and its Pods'
 *   restarts. The Pods' names are in the card's attributes, not on its face.
 * - An application card (chant's component of a cluster read): the same
 *   health, and its namespace.
 * - A card for something outside the cluster: the whole ARN or address, over
 *   as many rows as it takes, where the card's title is its short name.
 *
 * Imports nothing, so it bundles for the browser with src/render.ts.
 */

export interface Field {
  label: string;
  value: string;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** The most characters of a value one row holds at pinhole's widest fitted card. */
export const ROW_CHARS = 56;

/** A long value over several rows, the first labelled and the rest marked as its continuation. */
export function wrapped(label: string, value: string, width = ROW_CHARS): Field[] {
  const rows: Field[] = [];
  for (let i = 0; i < value.length; i += width) rows.push({ label: i === 0 ? label : "", value: value.slice(i, i + width) });
  return rows.length ? rows : [{ label, value }];
}

/** A workload card's face, from `_workload`, or undefined for any other k8s card. */
export function workloadFields(attrs: Rec): Field[] | undefined {
  const face = rec(attrs._workload);
  if (!Object.keys(face).length) return undefined;
  const ready = num(face.ready);
  const desired = num(face.desired);
  const restarts = num(face.restarts);
  return [
    ...(desired !== undefined ? [{ label: "ready", value: `${ready ?? 0}/${desired}` }] : []),
    ...(typeof face.image === "string" ? [{ label: "image", value: face.image }] : []),
    ...(restarts !== undefined ? [{ label: "restarts", value: String(restarts) }] : []),
  ];
}

/** An application card of a cluster read (`attrs.inferredFrom: kubernetes`), or undefined for a declared component. */
export function applicationFields(attrs: Rec): Field[] | undefined {
  if (attrs.inferredFrom !== "kubernetes") return undefined;
  const status = rec(attrs.status);
  const ready = num(status.readyReplicas);
  const desired = num(status.desiredReplicas);
  const restarts = num(status.restarts);
  const ns = typeof attrs.namespace === "string" ? attrs.namespace : Array.isArray(attrs.namespaces) ? attrs.namespaces.join(", ") : undefined;
  return [
    { label: "ready", value: desired !== undefined ? `${ready ?? 0}/${desired}` : "no replica count" },
    ...(restarts !== undefined ? [{ label: "restarts", value: String(restarts) }] : []),
    ...(ns ? [{ label: "namespace", value: ns }] : []),
  ];
}

/**
 * A card for what a cluster object names outside it (src/read-cluster.ts's
 * `addOutsideCards`): the whole ARN, service account or address. Undefined
 * for the card that stands for the public internet, which keeps its own row.
 */
export function outsideFields(kind: string, attrs: Rec): Field[] | undefined {
  if (attrs.reaches !== undefined) return undefined;
  if (kind === "CloudIdentity") {
    if (typeof attrs.arn === "string") return [...wrapped("role", attrs.arn), ...(typeof attrs.account === "string" ? [{ label: "account", value: attrs.account }] : [])];
    if (typeof attrs.email === "string") return wrapped("service account", attrs.email);
    if (typeof attrs.clientId === "string") return wrapped("client id", attrs.clientId);
  }
  if (typeof attrs.repoURL === "string") return [...wrapped("repo", attrs.repoURL), ...(typeof attrs.path === "string" ? [{ label: "path", value: attrs.path }] : [])];
  if (typeof attrs.label === "string") return wrapped("names", attrs.label);
  return [];
}
