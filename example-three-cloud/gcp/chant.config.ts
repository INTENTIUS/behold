// The live reads (drift and health) find a Cloud Run service's project in
// GOOGLE_CLOUD_PROJECT or the project-id annotation, not in the projectRef
// src/site.ts declares, so the project is named here too unless the
// environment already names one.
// TODO(INTENTIUS/chant#4201): drop this once the gcp reads take spec.projectRef.
process.env.GOOGLE_CLOUD_PROJECT ??= "three-cloud";

export default { lexicons: ["gcp"], sourceDir: "src", environments: ["local"] };
