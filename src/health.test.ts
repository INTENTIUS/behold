import { describe, it, expect } from "vitest";
import { classifyHealth, classifyObservedHealth } from "./health.ts";

describe("classifyHealth", () => {
  it("maps healthy terminal states", () => {
    for (const s of ["CREATE_COMPLETE", "UPDATE_COMPLETE", "Running", "Active", "Ready", "available", "Succeeded", "Bound"]) {
      expect(classifyHealth(s)).toBe("healthy");
    }
  });

  it("maps in-flight states to progressing", () => {
    for (const s of ["CREATE_IN_PROGRESS", "UPDATE_IN_PROGRESS", "Pending", "ContainerCreating", "Provisioning"]) {
      expect(classifyHealth(s)).toBe("progressing");
    }
  });

  it("maps failing states to degraded — even when they contain 'complete'", () => {
    for (const s of ["ROLLBACK_COMPLETE", "CREATE_FAILED", "UPDATE_ROLLBACK_FAILED", "CrashLoopBackOff", "Error", "ImagePullBackOff", "Evicted"]) {
      expect(classifyHealth(s)).toBe("degraded");
    }
  });

  it("returns unknown for unmapped or missing status (never fabricated)", () => {
    expect(classifyHealth("")).toBe("unknown");
    expect(classifyHealth(undefined)).toBe("unknown");
    expect(classifyHealth("SomeVendorSpecificState")).toBe("unknown");
  });
});

// #104 — the substrate-agnostic claim held for CloudFormation and failed on
// both non-AWS readers. Every string below is one chant's own plugins actually
// emit: gcp `statusFromCC` (Config Connector conditions) and azure's ARM
// `provisioningState`, checked against the lexicon source rather than guessed.
describe("classifyHealth — non-AWS substrates (#104)", () => {
  describe("Config Connector (gcp)", () => {
    it("does not read a NEGATED condition as healthy — the positive token is a substring of its own negation", () => {
      // The serious one. `NOT_READY` contains "ready", so a broken GCP resource
      // painted green. Config Connector states everything as Type=Status, so
      // this hit every resource that was not well.
      expect(classifyHealth("NOT_READY")).toBe("degraded");
      expect(classifyHealth("Ready=False")).toBe("degraded");
      expect(classifyHealth("Synced=False")).toBe("degraded");
    });

    it("lets a negation outweigh a positive condition alongside it", () => {
      // The condition-list fallback joins every type: a resource can be synced
      // and still not ready, and it is the not-ready that matters.
      expect(classifyHealth("Ready=False,Synced=True")).toBe("degraded");
    });

    it("still reads a genuinely positive condition as healthy", () => {
      expect(classifyHealth("READY")).toBe("healthy");
      expect(classifyHealth("Ready=True")).toBe("healthy");
      expect(classifyHealth("Synced=True")).toBe("healthy");
    });

    it("classifies a Ready-condition reason on its own merits", () => {
      expect(classifyHealth("UpdateFailed")).toBe("degraded");
      expect(classifyHealth("Updating")).toBe("progressing");
    });
  });

  describe("ARM (azure)", () => {
    it("maps the terminal states the CloudFormation vocabulary missed", () => {
      expect(classifyHealth("Succeeded")).toBe("healthy");
      expect(classifyHealth("Failed")).toBe("degraded");
      expect(classifyHealth("Canceled")).toBe("degraded");
    });

    it("maps Accepted to progressing — ARM has taken the request and is working", () => {
      expect(classifyHealth("Accepted")).toBe("progressing");
    });
  });

  it("reads PRESENT as healthy — the sentinel BOTH non-AWS readers emit", () => {
    // gcp emits it for a resource with no conditions at all; azure for any
    // resource type carrying no provisioningState, which is most of them.
    // Reading it as `unknown` meant a healthy Azure resource showed no verdict.
    expect(classifyHealth("PRESENT")).toBe("healthy");
  });

  it("reads a Pod the scheduler cannot place as degraded (chant#1397)", () => {
    // chant used to report this Pod's bare phase, `Pending`, which classifies
    // as progressing — indistinguishable from one that is about to start.
    // `Unschedulable` is terminal until a human changes something.
    expect(classifyHealth("Unschedulable")).toBe("degraded");
  });

  it("reads a crashlooping Pod as degraded, now that chant reports the reason", () => {
    // chant#1397: a crashlooping Pod used to observe as `Running`, which this
    // classified as healthy — a broken workload painting green.
    expect(classifyHealth("CrashLoopBackOff")).toBe("degraded");
    expect(classifyHealth("ImagePullBackOff")).toBe("degraded");
    // And a genuinely running Pod is still healthy.
    expect(classifyHealth("Running")).toBe("healthy");
  });

  it("leaves the CloudFormation vocabulary exactly as it was", () => {
    expect(classifyHealth("CREATE_COMPLETE")).toBe("healthy");
    expect(classifyHealth("UPDATE_ROLLBACK_COMPLETE")).toBe("degraded");
    expect(classifyHealth("CREATE_IN_PROGRESS")).toBe("progressing");
    expect(classifyHealth("DELETE_FAILED")).toBe("degraded");
  });
});

// #226 — the two GitOps controllers, whose verdicts the status-string
// heuristic could only reach by luck. Every fixture below is the shape the
// controller actually writes: Argo's `status.health`/`status.sync` pair, and
// the Flux toolkit's `Ready` condition — plus chant's string rendering of that
// condition (`Type=Reason: message`), which is what reaches behold today.
describe("classifyObservedHealth — Argo (#226)", () => {
  const app = (status: unknown, word = "PRESENT") => ({
    type: "K8s::Argo::Application",
    status: word,
    attributes: { namespace: "argocd", resourceVersion: "40122", status },
  });

  it("reads a Degraded Application as degraded — an Application writes no Ready condition", () => {
    // The case #226 opens with: the summarized status carries no failing
    // string, and `status.health.status` is the only place the truth lives.
    const v = classifyObservedHealth(
      app({
        health: { status: "Degraded", message: "Deployment has minimum availability" },
        sync: { status: "Synced", revision: "9f2b1c0d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b" },
      }),
    );
    expect(v.health).toBe("degraded");
    expect(v.detail).toBe("health=Degraded, sync=Synced");
  });

  it("reads a healthy-but-OutOfSync Application as not-converged, not broken", () => {
    // Drift, not damage — behold's pending paint, the colour a node that has
    // not converged wears on the drift axis. `degraded` (red) would call a
    // perfectly running app that is one commit behind broken.
    const v = classifyObservedHealth(
      app({
        health: { status: "Healthy" },
        sync: { status: "OutOfSync", revision: "9f2b1c0d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b" },
      }),
    );
    expect(v.health).toBe("progressing");
    expect(v.detail).toBe("health=Healthy, sync=OutOfSync");
  });

  it("maps the rest of the Argo vocabulary", () => {
    expect(classifyObservedHealth(app({ health: { status: "Healthy" }, sync: { status: "Synced" } })).health).toBe("healthy");
    expect(classifyObservedHealth(app({ health: { status: "Progressing" } })).health).toBe("progressing");
    expect(classifyObservedHealth(app({ health: { status: "Suspended" } })).health).toBe("progressing");
    expect(classifyObservedHealth(app({ health: { status: "Missing" } })).health).toBe("progressing");
    expect(classifyObservedHealth(app({ health: { status: "Unknown" } })).health).toBe("unknown");
  });

  it("reads the pair back out of chant's collapsed status word", () => {
    // chant's `argoStatusWord` sends the unhappy half as the status string and
    // `READY` for Healthy+Synced — all behold gets over the wire today. A word
    // only the HEALTH vocabulary recognises names health, sync stays unread —
    // chant dropped it and this reader does not guess it.
    const degraded = classifyObservedHealth({ type: "K8s::Argo::Application", status: "Degraded" });
    expect(degraded.health).toBe("degraded");
    expect(degraded.detail).toBe("health=Degraded");
    // The one the regex missed outright: `OutOfSync` matches no pattern in it
    // ("synced" is not a substring of "outofsync"), so it used to be unknown.
    expect(classifyHealth("OutOfSync")).toBe("unknown");
    // `OutOfSync` only exists in the SYNC vocabulary — chant's own collapse
    // (health checked first) only reaches this branch once health already
    // read Healthy, so this reader names both halves rather than just sync's.
    const outOfSync = classifyObservedHealth({ type: "K8s::Argo::Application", status: "OutOfSync" });
    expect(outOfSync.health).toBe("progressing");
    expect(outOfSync.detail).toBe("health=Healthy, sync=OutOfSync");
    const ready = classifyObservedHealth({ type: "K8s::Argo::Application", status: "READY" });
    expect(ready.health).toBe("healthy");
    expect(ready.detail).toBe("health=Healthy, sync=Synced");
  });

  // #275 — found live by the #269 e2e: a ComparisonError leaves health.status
  // Healthy and sync.status Unknown, and chant's collapse sends the bare word
  // `Unknown`, which sits in BOTH vocabularies. Reading it as health (the old
  // behaviour) reported `health=Unknown` for an app whose workload was fine —
  // the wrong half. `Unknown` is read as sync's now, matching the more common
  // real cause (a broken comparison, not an unassessable workload).
  it("reads a bare `Unknown` as the sync half, not health's (#275)", () => {
    const v = classifyObservedHealth({ type: "K8s::Argo::Application", status: "Unknown" });
    expect(v.health).toBe("unknown");
    expect(v.detail).toBe("health=Healthy, sync=Unknown");
  });

  // #275 — Argo's own `ApplicationCondition` carries no `status` field
  // (`{ type, message, lastTransitionTime }` is the whole shape), so a
  // ComparisonError's message is the one diagnostic line the controller
  // writes, and it has nowhere else to surface.
  it("joins an error-type condition's message onto the pair (#275)", () => {
    const v = classifyObservedHealth({
      type: "K8s::Argo::Application",
      status: "Unknown",
      attributes: {
        namespace: "argocd",
        status: {
          health: { status: "Healthy" },
          sync: { status: "Unknown" },
          conditions: [
            {
              type: "ComparisonError",
              message:
                "Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = example-argo-estate/app-b/behold-e2e-does-not-exist: app path does not exist",
              lastTransitionTime: "2026-08-09T10:14:02Z",
            },
          ],
        },
      },
    });
    expect(v.health).toBe("unknown");
    expect(v.detail).toBe(
      "health=Healthy, sync=Unknown: Failed to load target state: failed to generate manifest for source 1 of 1: rpc error: code = Unknown desc = example-argo-estate/app-b/behold-e2e-does-not-exist: app path does not exist",
    );
  });

  // What the wire ACTUALLY carries: chant's describe-resources flattens the
  // condition into `unhappyConditions()`'s `Type: message` string under
  // `attributes.conditions` — there is no raw `status` tree. The fixture above
  // (raw shape) predates chant#1644 and never occurred live; this one is the
  // argo e2e's step 5, verbatim.
  it("joins the message off chant's flattened condition string (chant#1644)", () => {
    const v = classifyObservedHealth({
      type: "K8s::Argo::Application",
      status: "Unknown",
      attributes: {
        namespace: "argocd",
        conditions: [
          "ComparisonError: Failed to load target state: rpc error: code = Unknown desc = example-argo-estate/app-b/behold-e2e-does-not-exist: app path does not exist",
        ],
      },
    });
    expect(v.health).toBe("unknown");
    expect(v.detail).toBe(
      "health=Healthy, sync=Unknown: Failed to load target state: rpc error: code = Unknown desc = example-argo-estate/app-b/behold-e2e-does-not-exist: app path does not exist",
    );
  });

  it("a *Warning condition string joins nothing — odd, not damage", () => {
    const v = classifyObservedHealth({
      type: "K8s::Argo::Application",
      status: "Unknown",
      attributes: { namespace: "argocd", conditions: ["SharedResourceWarning: Service web is also managed by app other"] },
    });
    expect(v.detail).toBe("health=Healthy, sync=Unknown");
  });

  it("does not join a *Warning condition's message — only an *Error one is damage", () => {
    const v = classifyObservedHealth({
      type: "K8s::Argo::Application",
      attributes: {
        namespace: "argocd",
        status: {
          health: { status: "Healthy" },
          sync: { status: "Synced" },
          conditions: [{ type: "SharedResourceWarning", message: "resource is part of applications app-a and app-b" }],
        },
      },
    });
    expect(v.health).toBe("healthy");
    expect(v.detail).toBe("health=Healthy, sync=Synced");
  });

  it("falls back for an Application the controller has not written a status onto", () => {
    // `PRESENT` is chant's "read it back, nothing richer" sentinel — no
    // health, no sync, nothing to be kind-aware about.
    const v = classifyObservedHealth({ type: "K8s::Argo::Application", status: "PRESENT" });
    expect(v.health).toBe(classifyHealth("PRESENT"));
    expect(v.detail).toBeUndefined();
  });
});

describe("classifyObservedHealth — Flux (#226)", () => {
  const kustomization = (status: unknown, word: string) => ({
    type: "K8s::Flux::Kustomization",
    status: word,
    attributes: { namespace: "flux-system", status },
  });

  it("reads Ready=False with its reason as degraded, and carries the reason", () => {
    const v = classifyObservedHealth(
      kustomization(
        {
          observedGeneration: 3,
          lastAttemptedRevision: "main@sha1:5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d",
          conditions: [
            {
              type: "Ready",
              status: "False",
              reason: "BuildFailed",
              message: "kustomize build failed: accumulating resources: accumulation err='accumulating resources from apps: no such file or directory'",
              lastTransitionTime: "2026-08-09T10:14:02Z",
            },
            { type: "Reconciling", status: "True", reason: "ProgressingWithRetry", message: "Reconciliation in progress" },
          ],
        },
        "BuildFailed",
      ),
    );
    expect(v.health).toBe("degraded");
    expect(v.detail).toBe("Ready=False (BuildFailed)");
  });

  it("reads a mid-reconcile Kustomization as pending — the case that painted green", () => {
    // Ready=Unknown gives chant's `statusFromObject` nothing to say, so the
    // word on the wire is `PRESENT`, which the fallback reads as healthy.
    expect(classifyHealth("PRESENT")).toBe("healthy");
    const v = classifyObservedHealth(
      kustomization(
        {
          observedGeneration: 2,
          lastAppliedRevision: "main@sha1:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
          conditions: [
            {
              type: "Ready",
              status: "Unknown",
              reason: "Progressing",
              message: "Reconciliation in progress",
              lastTransitionTime: "2026-08-09T10:15:31Z",
            },
            { type: "Reconciling", status: "True", reason: "Progressing", message: "Reconciliation in progress" },
          ],
        },
        "PRESENT",
      ),
    );
    expect(v.health).toBe("progressing");
    expect(v.detail).toBe("Ready=Unknown (Progressing)");
  });

  it("recovers the same two verdicts from chant's string conditions alone", () => {
    // What actually reaches behold over the wire (chant#1401): the UNHAPPY
    // conditions, rendered `Type=Reason: message`. The True/False/Unknown is
    // gone, and the reason is what separates a failure from a reconcile.
    const failing = classifyObservedHealth({
      type: "K8s::Flux::HelmRelease",
      status: "UpgradeFailed",
      attributes: {
        namespace: "flux-system",
        conditions: ["Ready=UpgradeFailed: Helm upgrade failed for release podinfo/podinfo"],
      },
    });
    expect(failing.health).toBe("degraded");
    expect(failing.detail).toBe("Ready=False (UpgradeFailed)");

    const reconciling = classifyObservedHealth({
      type: "K8s::Flux::Kustomization",
      status: "PRESENT",
      attributes: { namespace: "flux-system", conditions: ["Ready=Progressing: Reconciliation in progress"] },
    });
    expect(reconciling.health).toBe("progressing");
    expect(reconciling.detail).toBe("Ready=Unknown (Progressing)");
  });

  it("reads Ready=True as healthy across the toolkit's kinds", () => {
    for (const type of [
      "K8s::Flux::GitRepository",
      "K8s::Flux::OCIRepository",
      "K8s::Flux::HelmChart",
      "K8s::Flux::Bucket",
      "K8s::Flux::HelmRepository",
      "K8s::Flux::ImagePolicy",
      "K8s::Flux::Alert",
    ]) {
      const v = classifyObservedHealth({
        type,
        status: "READY",
        attributes: {
          namespace: "flux-system",
          status: {
            artifact: {
              revision: "main@sha1:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
              path: "gitrepository/flux-system/infra.tar.gz",
            },
            conditions: [
              { type: "Ready", status: "True", reason: "Succeeded", message: "stored artifact for revision 'main@sha1:1a2b3c'" },
            ],
          },
        },
      });
      expect(v.health).toBe("healthy");
    }
  });

  it("reads a Flux object with no conditions at all as pending, not healthy", () => {
    // Just applied; the controller has not picked it up yet. `PRESENT` again,
    // and green again under the fallback.
    const v = classifyObservedHealth({
      type: "K8s::Flux::Kustomization",
      status: "PRESENT",
      attributes: { namespace: "flux-system" },
    });
    expect(v.health).toBe("progressing");
    expect(v.detail).toBe("no Ready condition yet");
  });

  it("reads the revision half of Flux's own convergence test off one object", () => {
    // Ready still reports the last SUCCESS; the revision Flux is attempting is
    // a newer one, so the object is not converged on the source it points at.
    // (The full join — lastAppliedRevision against the SOURCE's
    // status.artifact.revision — needs both objects and stays out of here.)
    const v = classifyObservedHealth(
      kustomization(
        {
          lastAppliedRevision: "main@sha1:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
          lastAttemptedRevision: "main@sha1:5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d",
          conditions: [
            { type: "Ready", status: "True", reason: "ReconciliationSucceeded", message: "Applied revision: main@sha1:1a2b3c" },
          ],
        },
        "READY",
      ),
    );
    expect(v.health).toBe("progressing");
    expect(v.detail).toBe(
      "applied main@sha1:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b, attempted main@sha1:5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d",
    );
  });

  it("stays healthy when applied and attempted agree", () => {
    const rev = "main@sha1:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
    const v = classifyObservedHealth(
      kustomization(
        {
          lastAppliedRevision: rev,
          lastAttemptedRevision: rev,
          conditions: [{ type: "Ready", status: "True", reason: "ReconciliationSucceeded", message: `Applied revision: ${rev}` }],
        },
        "READY",
      ),
    );
    expect(v.health).toBe("healthy");
  });
});

describe("classifyObservedHealth — everything else is the fallback, unchanged (#226)", () => {
  it("classifies an unknown kind exactly as classifyHealth does", () => {
    for (const [type, status] of [
      ["AWS::S3::Bucket", "CREATE_COMPLETE"],
      ["AWS::CloudFormation::Stack", "UPDATE_ROLLBACK_COMPLETE"],
      ["K8s::Core::Pod", "CrashLoopBackOff"],
      ["K8s::Apps::Deployment", "PROGRESSING(1/3)"],
      ["GCP::Storage::Bucket", "NOT_READY"],
      ["Azure::Web::Site", "Accepted"],
      ["Vendor::Thing::Widget", "SomeVendorSpecificState"],
    ]) {
      const v = classifyObservedHealth({ type, status });
      expect(v.health).toBe(classifyHealth(status));
      expect(v.detail).toBeUndefined();
    }
  });

  it("is unknown for a node with no observed record at all", () => {
    expect(classifyObservedHealth(null)).toEqual({ health: "unknown" });
    expect(classifyObservedHealth(undefined)).toEqual({ health: "unknown" });
  });

  it("does not let another k8s object's conditions reach the Flux reader", () => {
    // The Ready-condition rule is scoped to the kinds whose contract behold has
    // read; a Pod carrying an unhappy `Ready` still classifies off its word.
    const v = classifyObservedHealth({
      type: "K8s::Core::Pod",
      status: "ImagePullBackOff",
      attributes: { namespace: "web", conditions: ["Ready=ContainersNotReady: containers with unready status: [api]"] },
    });
    expect(v.health).toBe("degraded");
    expect(v.detail).toBeUndefined();
  });
});

describe("classifyObservedHealth — Deployment rollouts", () => {
  const deploy = (conditions?: unknown, extra?: Record<string, unknown>) => ({
    type: "K8s::Apps::Deployment",
    status: "PRESENT",
    attributes: { namespace: "default", resourceVersion: "956", ...(conditions ? { conditions } : {}), ...extra },
  });

  it("reads a stuck rollout as degraded — the crashlooping-workload case", () => {
    // The gap this reader closes: a single-replica Deployment whose only pod
    // crashloops collapses to the status word `PRESENT` (healthy through the
    // fallback), while the controller's own verdict sits in the unhappy
    // conditions chant forwards.
    const v = classifyObservedHealth(
      deploy([
        "Available=MinimumReplicasUnavailable: Deployment does not have minimum availability.",
        'Progressing=ProgressDeadlineExceeded: ReplicaSet "db-6498455ff4" has timed out progressing.',
      ]),
    );
    expect(v.health).toBe("degraded");
    expect(v.detail).toBe('Progressing=ProgressDeadlineExceeded: ReplicaSet "db-6498455ff4" has timed out progressing.');
  });

  it("reads ReplicaFailure as degraded even while the deadline still covers the rollout", () => {
    const v = classifyObservedHealth(
      deploy(["ReplicaFailure=FailedCreate: pods \"db-0\" is forbidden: exceeded quota."]),
    );
    expect(v.health).toBe("degraded");
    expect(v.detail).toMatch(/^ReplicaFailure=FailedCreate/);
  });

  it("reads Available-only unhappiness as progressing — a rollout inside its deadline", () => {
    // `Progressing` is never False for a rollout merely in flight, so its
    // absence from the unhappy list is the controller saying the deadline
    // still covers this; red would overstate a healthy rolling update.
    const v = classifyObservedHealth(
      deploy(["Available=MinimumReplicasUnavailable: Deployment does not have minimum availability."]),
    );
    expect(v.health).toBe("progressing");
    expect(v.detail).toMatch(/^Available=MinimumReplicasUnavailable/);
  });

  it("reads raw condition objects, unhappy states only", () => {
    // A richer wire (or fixture) carrying the full status subtree: happy
    // conditions must not count as unhappy just for being present.
    const raw = deploy(undefined, {
      status: {
        conditions: [
          { type: "Available", status: "False", reason: "MinimumReplicasUnavailable", message: "Deployment does not have minimum availability." },
          { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: "ReplicaSet has timed out progressing." },
        ],
      },
    });
    expect(classifyObservedHealth(raw).health).toBe("degraded");
    const happy = deploy(undefined, {
      status: {
        conditions: [
          { type: "Available", status: "True", reason: "MinimumReplicasAvailable" },
          { type: "Progressing", status: "True", reason: "NewReplicaSetAvailable" },
        ],
      },
    });
    expect(classifyObservedHealth(happy).health).toBe("healthy");
  });

  it("falls through for a Deployment with no unhappy conditions", () => {
    // chant sends only unhappy conditions, so their absence is the happy path —
    // the collapsed word (`PRESENT` here) classifies through the fallback.
    const v = classifyObservedHealth(deploy());
    expect(v.health).toBe("healthy");
    expect(v.detail).toBeUndefined();
  });
});
