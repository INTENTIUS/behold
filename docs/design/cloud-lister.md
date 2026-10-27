# The cloud lister (behold#1029)

`behold index <substrate>` (behold#1026) reads an account, subscription, project or cluster through that cloud's inventory API and hands the result to chant's typing (chant#4521). The lister is the reading part. Its code is in `src/cloud-lister/`, and it has no command of its own. This page covers what a person has to set up before running it: the credentials, what a listing costs, and the one API that has to be switched on by hand.

The lister only reads. Every request goes through one transport that refuses anything outside four read operations (`src/cloud-lister/guard.ts`): Cloud Control `ListResources`, Resource Graph's query, Cloud Asset `searchAllResources`, and Kubernetes discovery and LIST. No cloud SDK client is built.

## Credentials

The lister is given its credentials directly. It reads no environment variables. When a run names an endpoint (an emulator), it takes static credentials only and never falls back to a credential chain. Without an endpoint, a run against a real cloud may use the cloud SDK's own chain, from optional packages installed beside behold: `@aws-sdk/credential-providers`, `@azure/identity`, `google-auth-library`.

Below is the narrowest grant for each cloud.

### AWS

Cloud Control needs `cloudformation:ListResources`, plus each listed type's own list permissions, which are the `handlers.list.permissions` in the type's schema:

```sh
aws cloudformation describe-type --type RESOURCE --type-name AWS::S3::Bucket \
  --query Schema --output text | jq '.handlers.list.permissions'
```

A policy for the types you name:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["cloudformation:ListResources"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["s3:ListAllMyBuckets", "s3:GetBucketTagging", "iam:ListRoles", "iam:ListRoleTags"], "Resource": "*" }
  ]
}
```

The second statement changes with the types. If you would rather not maintain it, the `ReadOnlyAccess` managed policy covers every type, but it grants more than the lister uses.

### Azure

The built-in `Reader` role on the subscription. Resource Graph returns only the resources the caller can read, so a narrower scope gives a smaller listing, not an error.

```sh
az role assignment create --assignee <principal-id> --role Reader --scope /subscriptions/<subscription-id>
```

### GCP

`roles/cloudasset.viewer` on the project, which carries `cloudasset.assets.searchAllResources`:

```sh
gcloud projects add-iam-policy-binding <project> --member=<member> --role=roles/cloudasset.viewer
```

Before a project can be searched, its Cloud Asset API has to be enabled. Enabling it changes the project, so behold never does it. If the API is off, the lister lists nothing for that project, reports every coverage entry as `read-failed`, and leaves a note with the command for you to run:

```sh
gcloud services enable cloudasset.googleapis.com --project=<project>
```

### Kubernetes

A token or client certificate whose user can `list` the kinds you want to index. Discovery (`/api`, `/apis`) is open to every authenticated user through `system:discovery`. A ClusterRole for every kind except Secrets:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: behold-index-reader
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["list"]
```

That rule includes Secrets. To leave them out, list the resources by name instead of `"*"`. The lister masks a Secret's `data` and `stringData` either way, so no value is stored, but the grant should still match what you mean to read. A kubeconfig user with an `exec` plugin or an `auth-provider` is refused, because the lister takes static credentials only. Mint a token for it instead (`kubectl create token <serviceaccount>`).

## Listing cost

These are call counts taken from the code. Time per call has not been measured, and the maintainer's emulator and real-cloud runs will fill it in.

| Substrate | Calls for a full listing | What narrowing saves |
|---|---|---|
| AWS | one `ListResources` per page of 100, for every (type, region), with global types listed once | Types and regions cut calls in proportion. A tag filter saves nothing, because Cloud Control takes no filter: the lister lists in full and filters afterwards |
| Azure | one query per page of 1000 rows for the whole subscription | Types, locations and tags all go into the query, so they cut pages |
| GCP | one search per page of 500 results for the project | Types and labels go into the search. Locations are filtered afterwards, so they save nothing |
| Kubernetes | about two discovery calls plus one per API group, then one LIST per page of 500 for each listable kind | A label filter goes into each LIST. Namespaces are filtered afterwards |

Under a tag filter, every coverage entry reads `filtered`. A filtered listing cannot tell an untagged object from a missing one, so it cannot say anything is absent. A full listing costs the calls above.

## Which emulators serve these APIs

This was read from the source of the pinned images (choudoufu `live/floci-image`, `live/floci-gcp-image`, `live/floci-az-image`, `live/kind-node-image`). The emulators themselves were not run.

| Substrate | Emulator | Serves | Limits |
|---|---|---|---|
| AWS | floci, source c688f52ee | `ListResources` and `GetResource` (`services/cloudcontrol/CloudControlJsonHandler.java`) | `NextToken` and `ResourceModel` are ignored. A type floci does not model returns an empty list, not an error (`CloudControlStoreLister.java`) |
| Azure | floci-az, source 7f079c2 | `POST /providers/Microsoft.ResourceGraph/resources` (`docs/services/resource-graph.md`) | A KQL subset (no `join`), facets always empty |
| GCP | floci-gcp, source 641e6e8 | `GET /cloudasset/v1/projects/{p}:searchAllResources` (`services/cloudasset/CloudAssetController.java`) | Project scope only. Assets come from Compute, Cloud Storage, IAM and Pub/Sub. The query takes `labels.*` and tag terms. SERVICE_DISABLED is answered only when Service Usage enforcement is on |
| Kubernetes | kind (`kindest/node` v1.37.0) | A real API server | none |

For floci-gcp the endpoint is `http://localhost:4588/cloudasset`. Its routing filter maps a `cloudasset.*` host onto that prefix, but a lister given `localhost` has to name the prefix itself.
