// What live Kubernetes objects name outside the cluster, as placeholder cards
// (#1082, part of #1049 phase 4). A ServiceAccount's annotation names a cloud
// identity, an ExternalSecret names a store and through it a secret in a cloud
// secret manager, an Argo CD Application and a Flux Kustomization name a repo
// and a path. A cluster surface can draw those with no configuration and no
// Terraform read: this turns the objects into labelled cards and edges.
//
// Pure and browser-safe: it imports nothing, no `node:*` and nothing from
// src/. `esbuild web/outside-refs.js --bundle --platform=browser` takes it
// whole, and web/outside-refs.test.js checks the module graph.
//
//   outsideRefs(objects, { graph? }) -> { cards, edges, notes }
//
// `objects` are Kubernetes manifests as the API serves them (apiVersion, kind,
// metadata, spec), or `List` documents of them. `graph` is the graph the
// surface already holds, `{ nodes }`; a target it holds gets no card and no
// edge, because the derived edge (chant#5098, chant#5099) already draws it.
// What counts as holding a target:
//
//   cloud identity  a node of type aws_iam_role (name or arn), google_service_account
//                   (email, or account_id and project) or an Azure identity (client_id)
//   a secret key    aws_secretsmanager_secret (name), aws_ssm_parameter (name) or
//                   google_secret_manager_secret (secret_id and project): the key
//                   leaves the provider card's `keys`
//   a store         a Kubernetes node with the store's kind, namespace and name
//   a source        a node carrying the same URL in `repoURL`, `url` or `clone_url`
//
// A node's type is its `kind` when that reads like a Terraform type, else the
// type in its address, else the chant AWS name for the same resource. Its
// arguments are read from `attrs`, `attrs.body`, `attrs.values` and
// `attrs.properties`.
//
// The field paths are the ones chant#5098 (ExternalSecret and its store) and
// chant#5099 (ServiceAccount annotations) read, so a placeholder and a derived
// edge cannot disagree:
//
//   ServiceAccount  metadata.annotations["iam.gke.io/gcp-service-account"]
//                   metadata.annotations["eks.amazonaws.com/role-arn"]
//                   metadata.annotations["azure.workload.identity/client-id"]
//   ExternalSecret  spec.secretStoreRef.{name,kind}, spec.data[].remoteRef.key,
//                   spec.dataFrom[].extract.key
//   (Cluster)SecretStore  spec.provider.gcpsm.projectID, spec.provider.aws.{service,region},
//                   spec.provider.vault.{server,path}
//   Application     spec.source and spec.sources[]: repoURL, path, chart
//   Kustomization   spec.sourceRef, spec.path (the URL comes from the source object)
//
// Ids are made from what a card names, so two objects naming the same thing
// share one card:
//
//   outside:identity:aws:<arn>   outside:identity:gcp:<email>   outside:identity:azure:<client id>
//   outside:store:ClusterSecretStore/<name>   outside:store:SecretStore/<namespace>/<name>
//   outside:provider:gcpsm:<project>   outside:provider:aws:<service>:<region>
//   outside:provider:vault:<server>/<path>
//   outside:source:<repo url>#<path>   outside:source:<repo url>#chart=<chart>
//
// Edges name their origin twice: `from` is the object's id in the form
// "<group>/<Kind>/<namespace>/<name>" (group empty for core, namespace empty
// for a cluster-scoped kind) and `fromRef` is the same as an object, for a
// surface that keys on Kubernetes identity. A store's edge to its provider
// card starts at the store object the same way. An edge to a source card also
// carries the `targetRevision` as `revision`.
//
// A field the rules do not understand, or cannot read, goes in `notes`. The
// live read masks any key matching /secret/i, which takes the whole
// `spec.secretStoreRef` of an ExternalSecret (chant#5116). That ExternalSecret
// cannot be joined to its store, so it gives a note with `waitsOn` set, and
// its remoteRef keys stay off the provider card until the read allows it.

/** What chant's live read writes over a masked value. */
const MASKED = "<masked>";
const WAITS_ON_MASK = "INTENTIUS/chant#5116";

const ANNOTATION_GCP = "iam.gke.io/gcp-service-account";
const ANNOTATION_AWS = "eks.amazonaws.com/role-arn";
const ANNOTATION_AZURE = "azure.workload.identity/client-id";

const ESO_GROUP = "external-secrets.io";
const FLUX_SOURCE_GROUP = "source.toolkit.fluxcd.io";
const FLUX_KUSTOMIZE_GROUP = "kustomize.toolkit.fluxcd.io";
const ARGO_GROUP = "argoproj.io";

const CLUSTER_SCOPED = new Set(["ClusterSecretStore"]);

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.length > 0 ? v : undefined);
const arr = (v) => (Array.isArray(v) ? v : []);

/** `{ group, kind, namespace, name }` of a manifest. */
function refOf(obj) {
  const apiVersion = str(obj.apiVersion) || "";
  const group = apiVersion.includes("/") ? apiVersion.slice(0, apiVersion.indexOf("/")) : "";
  const meta = isObject(obj.metadata) ? obj.metadata : {};
  const kind = str(obj.kind);
  const name = str(meta.name);
  const namespace = CLUSTER_SCOPED.has(kind) ? "" : str(meta.namespace) || "default";
  return { group, kind, namespace, name };
}

const idOf = (r) => `${r.group}/${r.kind}/${r.namespace}/${r.name}`;

/** Every manifest in `objects`, with `List` documents opened up. */
function flatten(objects) {
  const out = [];
  for (const o of arr(objects)) {
    if (!isObject(o)) continue;
    if (Array.isArray(o.items) && typeof o.kind === "string" && o.kind.endsWith("List")) out.push(...flatten(o.items));
    else out.push(o);
  }
  return out;
}

// --- the graph the surface already holds ---------------------------------

const CHANT_AWS_TYPES = {
  "AWS::IAM::Role": "aws_iam_role",
  "AWS::SecretsManager::Secret": "aws_secretsmanager_secret",
  "AWS::SSM::Parameter": "aws_ssm_parameter",
};

/** The Terraform type a graph node stands for, or undefined. */
function typeOfNode(node) {
  const kind = str(node && node.kind);
  if (kind && CHANT_AWS_TYPES[kind]) return CHANT_AWS_TYPES[kind];
  if (kind && /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(kind)) return kind;
  const attrs = (node && node.attrs) || {};
  const address = str(attrs.address) || str(node && node.id);
  if (!address) return undefined;
  const parts = address.replace(/\[[^\]]*\]/g, "").split(".");
  if (parts[0] === "data" || parts.length < 2) return undefined;
  const type = parts[parts.length - 2];
  return /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(type) ? type : undefined;
}

/** A literal argument of a graph node, by any of `names`. */
function argOf(node, ...names) {
  const attrs = (node && node.attrs) || {};
  const layers = [attrs, attrs.body, attrs.values, attrs.properties, attrs.Properties].filter(isObject);
  for (const layer of layers) {
    for (const n of names) if (str(layer[n])) return layer[n];
  }
  return undefined;
}

function nodesOfType(graph, ...types) {
  return arr(graph && graph.nodes).filter((n) => types.includes(typeOfNode(n)));
}

function holdsIdentity(graph, identity) {
  if (identity.cloud === "aws") {
    return nodesOfType(graph, "aws_iam_role").some((n) => argOf(n, "arn") === identity.arn || argOf(n, "name", "RoleName", "role_name") === identity.role);
  }
  if (identity.cloud === "gcp") {
    return nodesOfType(graph, "google_service_account").some((n) => {
      if (argOf(n, "email") === identity.email) return true;
      const id = argOf(n, "account_id");
      const project = argOf(n, "project");
      return !!id && !!project && `${id}@${project}.iam.gserviceaccount.com` === identity.email;
    });
  }
  return nodesOfType(graph, "azuread_application", "azuread_application_registration", "azuread_service_principal", "azurerm_user_assigned_identity").some(
    (n) => String(argOf(n, "client_id", "application_id") || "").toLowerCase() === identity.clientId,
  );
}

function holdsSecret(graph, provider, key) {
  if (provider.provider === "gcpsm") {
    return nodesOfType(graph, "google_secret_manager_secret").some((n) => argOf(n, "secret_id") === key && argOf(n, "project") === provider.projectID);
  }
  if (provider.provider === "aws") {
    const types = provider.service === "ParameterStore" ? ["aws_ssm_parameter"] : ["aws_secretsmanager_secret"];
    return nodesOfType(graph, ...types).some((n) => argOf(n, "name", "Name") === key);
  }
  return false;
}

function holdsK8s(graph, ref) {
  return arr(graph && graph.nodes).some((n) => {
    const attrs = (n && n.attrs) || {};
    const meta = isObject(attrs.metadata) ? attrs.metadata : {};
    const parts = typeof n.kind === "string" ? n.kind.split("::") : [];
    const kind = str(attrs.kind) || (parts[0] === "K8s" ? parts[parts.length - 1] : undefined);
    if (kind !== ref.kind || str(meta.name) !== ref.name) return false;
    return CLUSTER_SCOPED.has(ref.kind) || (str(meta.namespace) || "default") === ref.namespace;
  });
}

function holdsSource(graph, url) {
  return arr(graph && graph.nodes).some((n) => {
    const v = argOf(n, "repoURL", "url", "clone_url");
    return !!v && normalizeUrl(v) === url;
  });
}

// --- naming ---------------------------------------------------------------

/** A repo URL as one key: host lower-cased, no trailing slash, no `.git`. */
export function normalizeUrl(raw) {
  let s = String(raw).trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]+)(.*)$/i.exec(s);
  if (m) s = m[1].toLowerCase() + m[2].toLowerCase() + m[3];
  return s;
}

const cleanPath = (p) => String(p).trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");

const PROVIDER_LABEL = {
  gcpsm: "GCP Secret Manager",
  aws: "AWS Secrets Manager",
  awsParameterStore: "AWS Parameter Store",
  vault: "Vault",
};

// --- the result under construction ---------------------------------------

function builder(graph) {
  const cards = new Map();
  const edges = new Map();
  const notes = [];
  return {
    graph,
    cards,
    notes,
    card(c) {
      const have = cards.get(c.id);
      if (!have) cards.set(c.id, { ...c, placeholder: true });
      return cards.get(c.id);
    },
    edge(from, fromRef, to, viaAttr, extra) {
      const e = { from, to, kind: "ref", viaAttr, inferred: true, placeholder: true, ...(extra || {}) };
      if (fromRef) e.fromRef = fromRef;
      edges.set(`${from}>${to}>${viaAttr}`, e);
    },
    note(from, path, code, message, extra) {
      notes.push({ code, from, path, message, ...(extra || {}) });
    },
    result() {
      const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return {
        cards: [...cards.values()].sort(byId),
        edges: [...edges.values()].sort((a, b) => `${a.from}>${a.to}>${a.viaAttr}`.localeCompare(`${b.from}>${b.to}>${b.viaAttr}`)),
        notes,
      };
    },
  };
}

const isMasked = (v) => v === MASKED;

// --- ServiceAccount: cloud identity --------------------------------------

function identityFor(annotation, value) {
  if (annotation === ANNOTATION_GCP) {
    const m = /^[^@\s]+@([^@\s]+)\.iam\.gserviceaccount\.com$/.exec(value);
    return {
      id: `outside:identity:gcp:${value}`,
      identity: { cloud: "gcp", email: value, ...(m ? { project: m[1] } : {}) },
      label: value,
      ok: true,
    };
  }
  if (annotation === ANNOTATION_AWS) {
    const m = /^arn:aws[a-z-]*:iam::(\d{12}):role\/(.+)$/.exec(value);
    if (!m) return { ok: false, why: "not an IAM role ARN" };
    const role = m[2].slice(m[2].lastIndexOf("/") + 1);
    return { id: `outside:identity:aws:${value}`, identity: { cloud: "aws", arn: value, account: m[1], role }, label: value, ok: true };
  }
  const clientId = value.toLowerCase();
  return { id: `outside:identity:azure:${clientId}`, identity: { cloud: "azure", clientId }, label: `Azure identity ${clientId}`, ok: true };
}

function serviceAccount(b, obj, ref) {
  const annotations = isObject(obj.metadata) && isObject(obj.metadata.annotations) ? obj.metadata.annotations : {};
  for (const annotation of [ANNOTATION_GCP, ANNOTATION_AWS, ANNOTATION_AZURE]) {
    if (!(annotation in annotations)) continue;
    const path = `metadata.annotations[${annotation}]`;
    const value = annotations[annotation];
    if (isMasked(value)) {
      b.note(idOf(ref), path, "masked", "the live read masked this annotation", { waitsOn: WAITS_ON_MASK });
      continue;
    }
    if (!str(value)) {
      b.note(idOf(ref), path, "unrecognised", "the annotation is empty or not a string");
      continue;
    }
    const found = identityFor(annotation, value.trim());
    if (!found.ok) {
      b.note(idOf(ref), path, "unrecognised", `${found.why}: ${value}`);
      continue;
    }
    if (holdsIdentity(b.graph, found.identity)) continue;
    const cardAttrs = { ...found.identity };
    b.card({ id: found.id, kind: "CloudIdentity", label: found.label, attrs: cardAttrs });
    b.edge(idOf(ref), ref, found.id, path);
  }
}

// --- ExternalSecret and its store ----------------------------------------

function providerOf(store, ref, b) {
  const provider = isObject(store.spec) && isObject(store.spec.provider) ? store.spec.provider : undefined;
  if (!provider) {
    b.note(idOf(ref), "spec.provider", "unrecognised", "the store has no provider");
    return undefined;
  }
  const kinds = Object.keys(provider);
  const known = kinds.filter((k) => k === "gcpsm" || k === "aws" || k === "vault");
  for (const k of kinds) {
    if (!known.includes(k)) b.note(idOf(ref), `spec.provider.${k}`, "unrecognised", `no placeholder rule for the ${k} provider`);
  }
  if (known.length === 0) return undefined;
  const k = known[0];
  const spec = isObject(provider[k]) ? provider[k] : {};
  if (k === "gcpsm") {
    const projectID = str(spec.projectID);
    if (!projectID || isMasked(projectID)) {
      b.note(idOf(ref), "spec.provider.gcpsm.projectID", "unrecognised", "no readable projectID");
      return undefined;
    }
    return { provider: "gcpsm", projectID, id: `outside:provider:gcpsm:${projectID}`, label: `${PROVIDER_LABEL.gcpsm} ${projectID}`, path: "spec.provider.gcpsm" };
  }
  if (k === "aws") {
    const region = str(spec.region);
    const service = str(spec.service) || "SecretsManager";
    if (!region || isMasked(region)) {
      b.note(idOf(ref), "spec.provider.aws.region", "unrecognised", "no readable region");
      return undefined;
    }
    const label = service === "ParameterStore" ? PROVIDER_LABEL.awsParameterStore : PROVIDER_LABEL.aws;
    return { provider: "aws", service, region, id: `outside:provider:aws:${service}:${region}`, label: `${label} ${region}`, path: "spec.provider.aws" };
  }
  const server = str(spec.server);
  if (!server || isMasked(server)) {
    b.note(idOf(ref), "spec.provider.vault.server", "unrecognised", "no readable server");
    return undefined;
  }
  const path = str(spec.path) || "";
  return {
    provider: "vault",
    server,
    ...(path ? { path } : {}),
    id: `outside:provider:vault:${server}/${path}`,
    label: `${PROVIDER_LABEL.vault} ${server}${path ? `/${path}` : ""}`,
    path: "spec.provider.vault",
  };
}

/** The remoteRef keys an ExternalSecret reads, and a note for each shape that gives none. */
function keysOf(obj, ref, b) {
  const spec = isObject(obj.spec) ? obj.spec : {};
  const keys = [];
  arr(spec.data).forEach((d, i) => {
    const key = isObject(d) && isObject(d.remoteRef) ? d.remoteRef.key : undefined;
    if (str(key) && !isMasked(key)) keys.push(key);
    else b.note(idOf(ref), `spec.data[${i}].remoteRef.key`, "unrecognised", "no readable key");
  });
  arr(spec.dataFrom).forEach((d, i) => {
    const key = isObject(d) && isObject(d.extract) ? d.extract.key : undefined;
    if (str(key) && !isMasked(key)) keys.push(key);
    else b.note(idOf(ref), `spec.dataFrom[${i}]`, "unrecognised", "only extract.key is read; find, sourceRef and the rest name no single secret");
  });
  return keys;
}

function externalSecrets(b, all) {
  const stores = new Map();
  for (const o of all) {
    const r = refOf(o);
    if (r.group === ESO_GROUP && (r.kind === "SecretStore" || r.kind === "ClusterSecretStore") && r.name) stores.set(idOf(r), { obj: o, ref: r });
  }
  // provider id -> { provider, keys:Set } so stores and secrets that name one scope share a card
  const providers = new Map();
  const touch = (storeKey) => {
    const s = stores.get(storeKey);
    if (!s || s.provider !== undefined) return s;
    s.provider = providerOf(s.obj, s.ref, b) || null;
    if (s.provider && !providers.has(s.provider.id)) providers.set(s.provider.id, { provider: s.provider, keys: new Set(), stores: [] });
    if (s.provider) providers.get(s.provider.id).stores.push(s);
    return s;
  };
  for (const key of stores.keys()) touch(key);

  for (const o of all) {
    const ref = refOf(o);
    if (ref.group !== ESO_GROUP || ref.kind !== "ExternalSecret" || !ref.name) continue;
    const from = idOf(ref);
    const spec = isObject(o.spec) ? o.spec : {};
    const sref = spec.secretStoreRef;
    if (isMasked(sref) || (isObject(sref) && (isMasked(sref.name) || isMasked(sref.kind)))) {
      b.note(from, "spec.secretStoreRef", "masked", "the live read masked secretStoreRef, so the store and the keys cannot be joined", { waitsOn: WAITS_ON_MASK });
      continue;
    }
    if (!isObject(sref) || !str(sref.name)) {
      b.note(from, "spec.secretStoreRef", "unrecognised", "no store named");
      continue;
    }
    const storeKind = str(sref.kind) || "SecretStore";
    if (storeKind !== "SecretStore" && storeKind !== "ClusterSecretStore") {
      b.note(from, "spec.secretStoreRef.kind", "unrecognised", `no placeholder rule for a ${storeKind} store`);
      continue;
    }
    const storeRef = { group: ESO_GROUP, kind: storeKind, namespace: storeKind === "ClusterSecretStore" ? "" : ref.namespace, name: sref.name };
    const keys = keysOf(o, ref, b);
    const held = holdsK8s(b.graph, storeRef);
    const found = touch(idOf(storeRef));
    if (!held) {
      const id = `outside:store:${storeKind}/${storeKind === "SecretStore" ? `${storeRef.namespace}/` : ""}${storeRef.name}`;
      b.card({
        id,
        kind: "SecretStore",
        label: storeKind === "SecretStore" ? `SecretStore ${storeRef.namespace}/${storeRef.name}` : `ClusterSecretStore ${storeRef.name}`,
        attrs: { storeKind, name: storeRef.name, ...(storeRef.namespace ? { namespace: storeRef.namespace } : {}), read: !!found },
      });
      b.edge(from, ref, id, "spec.secretStoreRef");
    }
    if (!found) {
      b.note(from, "spec.secretStoreRef", "unresolved", `${storeKind} ${storeRef.name} is not among the objects read, so its provider is not known`);
      continue;
    }
    if (found.provider) for (const k of keys) providers.get(found.provider.id).keys.add(k);
  }

  for (const { provider, keys, stores: viaStores } of providers.values()) {
    const kept = [...keys].filter((k) => !holdsSecret(b.graph, provider, k)).sort();
    const { id, label, path, ...attrs } = provider;
    b.card({ id, kind: "SecretProvider", label, attrs: { ...attrs, keys: kept } });
    for (const s of viaStores) b.edge(idOf(s.ref), s.ref, id, path);
  }
}

// --- Argo CD Application and Flux Kustomization --------------------------

function sourceCard(b, ref, from, via, { url, path, chart, revision, kindOfSource }) {
  const repo = normalizeUrl(url);
  if (holdsSource(b.graph, repo)) return;
  const where = chart ? `chart=${chart}` : path ? cleanPath(path) : "";
  const id = `outside:source:${repo}#${where}`;
  const label = chart ? `${repo} chart ${chart}` : where ? `${repo} ${where}` : repo;
  b.card({
    id,
    kind: "Source",
    label,
    attrs: { repoURL: repo, ...(path ? { path: cleanPath(path) } : {}), ...(chart ? { chart } : {}), ...(kindOfSource ? { sourceKind: kindOfSource } : {}) },
  });
  b.edge(from, ref, id, via, revision ? { revision } : undefined);
}

function application(b, obj, ref) {
  const from = idOf(ref);
  const spec = isObject(obj.spec) ? obj.spec : {};
  const entries = [];
  if (isObject(spec.source)) entries.push([spec.source, "spec.source"]);
  arr(spec.sources).forEach((s, i) => entries.push([s, `spec.sources[${i}]`]));
  for (const [s, via] of entries) {
    if (!isObject(s)) continue;
    const url = str(s.repoURL);
    if (!url || isMasked(url)) {
      b.note(from, `${via}.repoURL`, "unrecognised", "no readable repoURL");
      continue;
    }
    sourceCard(b, ref, from, via, { url, path: str(s.path), chart: str(s.chart), revision: str(s.targetRevision) });
  }
}

const FLUX_SOURCE_KINDS = new Set(["GitRepository", "OCIRepository", "Bucket"]);

function kustomization(b, obj, ref, all) {
  const from = idOf(ref);
  const spec = isObject(obj.spec) ? obj.spec : {};
  const sref = spec.sourceRef;
  if (!isObject(sref) || !str(sref.name)) {
    b.note(from, "spec.sourceRef", "unrecognised", "no source named");
    return;
  }
  const kind = str(sref.kind) || "GitRepository";
  if (!FLUX_SOURCE_KINDS.has(kind)) {
    b.note(from, "spec.sourceRef.kind", "unrecognised", `no placeholder rule for a ${kind} source`);
    return;
  }
  const namespace = str(sref.namespace) || ref.namespace;
  const source = all.find((o) => {
    const r = refOf(o);
    return r.group === FLUX_SOURCE_GROUP && r.kind === kind && r.name === sref.name && r.namespace === namespace;
  });
  if (!source) {
    b.note(from, "spec.sourceRef", "unresolved", `${kind} ${namespace}/${sref.name} is not among the objects read, so the repo is not known`);
    return;
  }
  const sspec = isObject(source.spec) ? source.spec : {};
  const url = kind === "Bucket" ? (str(sspec.endpoint) && str(sspec.bucketName) ? `${sspec.endpoint}/${sspec.bucketName}` : undefined) : str(sspec.url);
  if (!url || isMasked(url)) {
    b.note(from, "spec.sourceRef", "unrecognised", `${kind} ${namespace}/${sref.name} has no readable url`);
    return;
  }
  sourceCard(b, ref, from, "spec.sourceRef", { url, path: str(spec.path), kindOfSource: kind });
}

// --- the function ----------------------------------------------------------

/**
 * Placeholder cards, edges and notes for what `objects` name outside the cluster.
 * `opts.graph` is the graph already on the surface, `{ nodes }`.
 */
export function outsideRefs(objects, opts = {}) {
  const all = flatten(objects);
  const b = builder(opts.graph);
  for (const o of all) {
    const ref = refOf(o);
    if (!ref.kind || !ref.name) continue;
    if (ref.group === "" && ref.kind === "ServiceAccount") serviceAccount(b, o, ref);
    else if (ref.group === ARGO_GROUP && ref.kind === "Application") application(b, o, ref);
    else if (ref.group === FLUX_KUSTOMIZE_GROUP && ref.kind === "Kustomization") kustomization(b, o, ref, all);
  }
  externalSecrets(b, all);
  return b.result();
}
