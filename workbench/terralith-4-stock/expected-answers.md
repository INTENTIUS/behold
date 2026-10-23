# terralith-4-stock: expected answers for demo steps 2 to 6

Hand-written answers for INTENTIUS/behold#908's "ask your agent about a
Terraform estate" demo, on the estate `behold demo terralith-4-stock` builds
(#912). #908's final run checks each step's answer against this file. It lives in
the entry directory and is never copied into the served estate, so the agent
under test cannot read it.

The estate is `go run ./tools/terralith-gen -scale 4 -findings` from choudoufu
(INTENTIUS/choudoufu#2199), applied by stock `terraform`. It has one root and
one module call. Every answer below is about that output and no other; if the
generator changes, re-derive them (see the last section).

## Reading the queries

Each step gives the `chant search` query an agent would run, then the rows or
counts it should get back. The features the queries use have landed on chant's
`epic/908-ask-your-agent` and ship in chant 0.124.46:

- `kind:aws_instance` matching a Terraform resource type, and `kind:aws_`
  as a prefix: INTENTIUS/chant#4366.
- `--count-by kind|module|attr:<name>`: INTENTIUS/chant#4360.
- `search` reading `terraform.roots` from behold's scratch config:
  INTENTIUS/chant#4365.
- `internetFacing` and `effectiveIngress` on Terraform kinds:
  INTENTIUS/chant#4362.
- Transitive and attribute-qualified edges (`->*`, `<-*`, `[via=]`, `[to=]`)
  with a path per match under `--explain`: INTENTIUS/chant#4359.
- The plan read (`planAction`, `planActions`, `planReplacePaths`,
  `planActionReason` on the IR): INTENTIUS/chant#4358. It is chosen with
  `CHANT_TERRAFORM_OBSERVE=plan` and needs `--live --env <name>`.
- The capability terms (`cap:`, `[cap=]`, as in `cap:internet-reachable(22)`
  and `cap:stores-data`): INTENTIUS/chant#4375. Steps 4 and 6 keep the
  attribute and plain-path queries as cross-checks.

Row ids in a workspace answer are `<member>/<root>/<address>`, for example
`terralith-4-stock/terralith-4-stock/aws_instance.bastion`. The member is
named by behold#925's member naming (it leads even with one member), and
`<root>` is the name of the directory the estate was rendered into:
`terralith-4-stock` for `behold demo terralith-4-stock` and for `just
e2e-workbench`. Both are `terralith-4-stock` here.

Two counts appear throughout, and they differ:

- declared: resource blocks in the configuration. This is what the declared
  graph holds and what behold draws (one card per block; `count` and
  `for_each` blocks are one card each).
- applied: resource instances after `count` and `for_each` expand, which is
  what `terraform state list` prints.

The estate has 195 declared blocks (189 in the root, 6 in
`modules/team_pod`) and 318 applied instances.

Before any step, behold must be able to draw the estate at all. chant's
terraform lexicon reports 3 lint errors in it (TF022, TF030, TF033), and with
chant 0.124.46 or newer behold draws it anyway (#919): its scratch config sets
`graph.lint: "report"`. behold draws 196 nodes at `?logical=1` (195 blocks plus
the `module.team_pod` call) and 24 at the default zoom, where 180 look-alike
cards stack into 8. The note ends "3 lint errors, drawn anyway" and names the
three findings: TF022 and TF033 on `aws_db_instance.orders`, and TF030 on
`aws_vpc_security_group_ingress_rule.bastion_ssh`. Check the set of findings,
not the string: behold writes an em dash where this file would write a
hyphen, and the findings may come in any order (TF030 first, for one). Those
two cards carry the findings on `attrs._lint`. A chant below 0.124.46 still refuses the
estate, and the refusal names the chant that draws it.

## Step 2: "What's in here?"

```
chant search "kind:aws_" --count-by kind
```

One root and one module call, `module "team_pod"` (source
`./modules/team_pod`, `for_each = toset(["pod-a", "pod-b"])`). No backend
block, so state is local (`terraform.tfstate`). Provider `hashicorp/aws`
`= 6.59.0`.

By type, whole estate:

| type | declared | applied |
|---|---:|---:|
| aws_iam_role_policy_attachment | 57 | 85 |
| aws_iam_role | 31 | 45 |
| aws_iam_instance_profile | 27 | 41 |
| aws_iam_policy | 27 | 41 |
| aws_iam_role_policy | 26 | 40 |
| aws_ecs_service | 4 | 4 |
| aws_ecs_task_definition | 4 | 4 |
| aws_subnet | 4 | 4 |
| aws_security_group | 2 | 2 |
| aws_db_instance | 1 | 1 |
| aws_db_subnet_group | 1 | 1 |
| aws_dynamodb_table | 1 | 1 |
| aws_ecs_cluster | 1 | 1 |
| aws_instance | 1 | 1 |
| aws_internet_gateway | 1 | 1 |
| aws_launch_template | 1 | 1 |
| aws_route53_record | 1 | 40 |
| aws_route53_zone | 1 | 1 |
| aws_route_table | 1 | 1 |
| aws_route_table_association | 1 | 1 |
| aws_vpc | 1 | 1 |
| aws_vpc_security_group_ingress_rule | 1 | 1 |
| total | 195 | 318 |

The declared column counts each block in `modules/team_pod` once, as the
configuration does (6 blocks). The applied column counts it once per module
key and per `count` index (2 keys x 4 = 8 instances per block, 48 in all).
`--count-by kind` over the declared graph prints the declared column,
sorted by count then name, with a total line of 195. With `--json` the same
answer is `.groups[]` (`group`, `count`) and `.total`.

## Step 3: "How many resources does each module own, by type?"

```
chant search "kind:aws_" --count-by module
chant search "kind:aws_ !module.team_pod" --count-by kind
chant search "kind:aws_ module.team_pod" --count-by kind
```

Groups are `terralith-4-stock/(root)` and `terralith-4-stock/module.team_pod`.
The member name leads every group (behold#925's member naming), even though
this estate has one member. If `!module.team_pod` comes
up short of 189 because a root block's body names `module.team_pod`, the
`--count-by module` row is the answer.

By module:

| module | declared | applied |
|---|---:|---:|
| terralith-4-stock/(root) | 189 | 270 |
| terralith-4-stock/module.team_pod | 6 | 48 (24 per key: `["pod-a"]`, `["pod-b"]`) |
| total | 195 | 318 |

`terralith-4-stock/(root)` by type, declared (applied where it differs):

| type | declared | applied |
|---|---:|---:|
| aws_iam_role_policy_attachment | 55 | 69 |
| aws_iam_role | 30 | 37 |
| aws_iam_instance_profile | 26 | 33 |
| aws_iam_policy | 26 | 33 |
| aws_iam_role_policy | 25 | 32 |
| aws_ecs_service | 4 | |
| aws_ecs_task_definition | 4 | |
| aws_subnet | 4 | |
| aws_security_group | 2 | |
| aws_route53_record | 1 | 40 |
| each of aws_db_instance, aws_db_subnet_group, aws_dynamodb_table, aws_ecs_cluster, aws_instance, aws_internet_gateway, aws_launch_template, aws_route53_zone, aws_route_table, aws_route_table_association, aws_vpc, aws_vpc_security_group_ingress_rule | 1 | |
| total | 189 | 270 |

`terralith-4-stock/module.team_pod` by type, declared (applied per key, then both keys):

| type | declared | per key | both keys |
|---|---:|---:|---:|
| aws_iam_role_policy_attachment | 2 | 8 | 16 |
| aws_iam_instance_profile | 1 | 4 | 8 |
| aws_iam_policy | 1 | 4 | 8 |
| aws_iam_role | 1 | 4 | 8 |
| aws_iam_role_policy | 1 | 4 | 8 |
| total | 6 | 24 | 48 |

## Step 4: "What's reachable on SSH from the internet?"

```
chant search "cap:internet-reachable(22)"
chant search "kind:aws_instance attr:internetFacing=true attr:effectiveIngress=tcp:22:0.0.0.0/0" --explain
```

Through behold the first is `ask {query: "cap:internet-reachable(22)"}`; the
`capabilities` tool lists it (16 capabilities, `port` optional). Its
provenance line is `declared only · each member mapped by its own chant,
capabilities evaluated once over the composed workspace graph`. Exactly one
row, `terralith-4-stock/terralith-4-stock/aws_instance.bastion`, internet-facing via:

```
aws_instance.bastion.subnet_id -> aws_subnet.public; aws_route_table_association.public.subnet_id -> aws_subnet.public; .route_table_id -> aws_route_table.public; aws_route_table.public.route -> #route[0]; #route[0].gateway_id -> aws_internet_gateway.main
```

and open-ingress via:

```
aws_instance.bastion.launch_template -> aws_launch_template.bastion; .vpc_security_group_ids -> aws_security_group.bastion; aws_vpc_security_group_ingress_rule.bastion_ssh.security_group_id -> aws_security_group.bastion
```

It notes what it does not evaluate: load balancers, API gateways, network
ACLs. The attribute query is the cross-check, and also returns exactly one row:

```
terralith-4-stock/terralith-4-stock/aws_instance.bastion  Terraform::Resource
— declared only · no observation · physical ids unavailable · effectiveIngress, internetFacing derived from declared references
— 1 of 1 aws_instance matched  (query: kind:aws_instance attr:internetFacing=true attr:effectiveIngress=tcp:22:0.0.0.0/0)
  ✓ terralith-4-stock/terralith-4-stock/aws_instance.bastion internetFacing via subnet route aws_subnet.public -> aws_route_table.public -> aws_internet_gateway.main (inline route)
  ✓ terralith-4-stock/terralith-4-stock/aws_instance.bastion effectiveIngress via security groups aws_launch_template.bastion -> aws_security_group.bastion
```

The path, edge by edge, as the configuration states it:

| from | attribute | to |
|---|---|---|
| aws_instance.bastion | subnet_id | aws_subnet.public.id |
| aws_route_table_association.public | subnet_id | aws_subnet.public.id |
| aws_route_table_association.public | route_table_id | aws_route_table.public.id |
| aws_route_table.public | route.gateway_id (cidr_block "0.0.0.0/0") | aws_internet_gateway.main.id |
| aws_instance.bastion | launch_template.id | aws_launch_template.bastion.id |
| aws_launch_template.bastion | vpc_security_group_ids | aws_security_group.bastion.id |
| aws_vpc_security_group_ingress_rule.bastion_ssh | security_group_id (tcp 22-22, cidr_ipv4 "0.0.0.0/0") | aws_security_group.bastion.id |

There is no other instance. The ECS services run in `aws_subnet.main`, which
has no route table association (it sits on the VPC's main route table, which
the fold does not follow), and `aws_security_group.ecs` has no ingress at all.
So "none besides the bastion" is part of the answer: a second row is wrong.

## Step 5: "What would this change do, and why does it replace the database?"

The change is `replace-db.patch`, copied into the target beside the estate:

```
cd <target>
patch -p1 < replace-db.patch     # data.tf: storage_encrypted = false -> true
```

```
CHANT_TERRAFORM_OBSERVE=plan chant search --live --env <name> --json -- "attr:planAction=replace"
```

Add `--show planActions,planReplacePaths,planActionReason --explain` to see
the fields and the provenance line in one answer. Through behold the same
read is `ask {query: "attr:planAction=replace", plan: true, show:
"planActions,planReplacePaths,planActionReason"}`. `<name>` is an environment
name; the plan read runs `terraform plan -lock=false` in the root, so the
shell needs the floci variables the setup prints (`AWS_ENDPOINT_URL` and the
test credentials) and the root must already be initialised (the setup does
that). The provenance line is `observed at the plan depth (terraform plan
-lock=false) · bound 1/1` (INTENTIUS/chant#4384), and the document's source
is `{kind: live, env: behold-plan, depth: "plan"}`. #910 is what lets behold
draw these facts on the card.

Exactly one row, `aws_db_instance.orders`:

| field | value |
|---|---|
| `planAction` | `replace` |
| `planActions` | `{"aws_db_instance.orders":["delete","create"]}` (the raw list, keyed by instance address) |
| `planReplacePaths` | `["storage_encrypted"]` (dotted strings, not nested lists) |
| `planActionReason` | `replace_because_cannot_update` |

`terraform plan` says the same in its own words: `# aws_db_instance.orders
must be replaced`, `~ storage_encrypted = false -> true # forces
replacement`, `Plan: 1 to add, 0 to change, 1 to destroy.` Every other
resource is a no-op: on the cards (`/api/graph?plan=1`, `attrs._plan`) the
database is the one replace and 14 are no-op, and the database card carries
`source: "plan"`. The answer counts 1 of 1 `aws_db_instance`.

Where the forcing value comes from: the literal `storage_encrypted = true` on
`aws_db_instance.orders` in `data.tf`, the line the patch changes. It reads
no variable, local or other resource, so its source trace ends at that line.
Nothing in the estate references `aws_db_instance.orders`, so the replace
reaches no other resource. The database itself reads one thing,
`db_subnet_group_name = aws_db_subnet_group.orders.name`, which is not
changed.

Why this attribute: on provider 6.59.0, changing `identifier` or
`engine_version` plans an in-place update, measured against floci (see
INTENTIUS/choudoufu#2199). `storage_encrypted` cannot be changed in place.

## Step 6: "If this role is compromised, what data can it reach?"

"This role" is `aws_iam_role.app_data`, the role the internet-facing bastion
carries (`aws_launch_template.bastion.iam_instance_profile.arn ->
aws_iam_instance_profile.app_data`, whose `role` is `aws_iam_role.app_data`).
Step 6 as #908 frames it asks for a capability: what the role reaches that
stores data (INTENTIUS/chant#4375). The agent first finds the role with
`kind:aws_iam_role <-[cap=runs-as]aws_instance.bastion`, then asks:

```
chant search "cap:stores-data <-[cap=reaches]aws_iam_role.app_data" --explain
```

It returns only `aws_dynamodb_table.sessions` (as a workspace row,
`terralith-4-stock/terralith-4-stock/aws_dynamodb_table.sessions`), with the
provenance line `declared only · each member mapped by its own chant,
capabilities evaluated once over the composed workspace graph` and the path:

```
aws_iam_role_policy_attachment.app_data.role -> role; .policy_arn -> aws_iam_policy.app_data; .policy -> Statement[0]; Statement[0].Resource[0] -> aws_dynamodb_table.sessions
```

`reaches` does not evaluate `Resource "*"` (26 statements here), IAM
Condition keys, NotAction/NotResource, boundaries and SCPs, AWS-managed
policies, or unresolved resources, so the 8 wildcard roles below are outside
this answer and a careful agent says so. The same answer also comes from plain
path terms (#4359, #4366):

```
chant search "kind:aws_dynamodb_table <-*aws_iam_role_policy_attachment.app_data" --explain
chant search "kind:aws_iam_role_policy_attachment ->[via=role]aws_iam_role.app_data" --show policy_arn
```

The first plain-path query returns exactly one row, `terralith-4-stock/terralith-4-stock/aws_dynamodb_table.sessions`,
with the path:

```
aws_iam_role_policy_attachment.app_data.policy_arn -> aws_iam_policy.app_data.arn; aws_iam_policy.app_data.policy -> aws_dynamodb_table.sessions.arn
```

The second returns exactly one row, `terralith-4-stock/terralith-4-stock/aws_iam_role_policy_attachment.app_data`:
the role has one attached policy and no inline policy.

The expected answer: `aws_iam_role.app_data` reaches one data store,
`aws_dynamodb_table.sessions`, through its one attached customer-managed
policy `aws_iam_policy.app_data`, with `dynamodb:GetItem`, `dynamodb:PutItem`,
`dynamodb:Query` and `dynamodb:DeleteItem` on the table's ARN. It reaches
neither the database (`aws_db_instance.orders`: no `rds` or `rds-db` action)
nor any S3 bucket (the estate declares none).

What a careful answer adds, because the configuration says so:

- 8 other roles reach the same table by wildcard: `team_0002`, `team_0005`,
  `team_0008`, `team_0011`, `team_0014`, `team_0017`, `team_0020` and
  `team_0023` (`aws_iam_role.team_NNNN_role`) each have an inline policy
  allowing `dynamodb:GetItem`, `PutItem`, `UpdateItem` and `DeleteItem` on
  `Resource = "*"`. No reference edge leads from them to the table, so an
  edge query does not find them; a capability rule (chant#4361) would.
- The S3 ARNs other policies name (`arn:aws:s3:::terralith-shared-bucket/*`,
  `arn:aws:s3:::tl-team-NNNN-data/*`) are buckets this estate does not
  declare, so they are not data stores in this estate.
- AWS-managed policies attached elsewhere (`ReadOnlyAccess` 9 times,
  `AmazonS3ReadOnlyAccess` 9, `AmazonEC2ReadOnlyAccess` 8,
  `AmazonECSTaskExecutionRolePolicy` 4, counted as attachment blocks) are
  named by ARN only. Their documents are not in the configuration, so what
  they reach cannot be answered from it. None is attached to
  `aws_iam_role.app_data`.

## How these answers were derived

From the generated HCL, by script and by reading it, then checked against a
real apply:

1. Rendered the estate with `go run ./tools/terralith-gen -scale 4 -findings
   -out <dir>` from INTENTIUS/choudoufu#2199's change.
2. A script read every `resource "<type>" "<name>"` header and its `count` /
   `for_each` line in the root and in `modules/team_pod`, and expanded them:
   `count = 8` as written, `count = var.pod_size` as 4 (`local.pod_size` in
   `main.tf`), `for_each = local.dns_records` as its 40 keys, and the module
   call's `for_each` as its 2 keys. That gave the declared and applied
   columns of steps 2 and 3. The generator's own summary line agrees (318
   resources).
3. The applied column was checked against `terraform state list` after a
   stock `terraform apply` against a scratch floci (pinned image): 318
   instances, identical per module and type to the script's expansion.
4. Steps 4 and 6 come from the references in `bastion.tf` and `data.tf`,
   which choudoufu's `tools/terralith-gen/findings_test.go` pins edge by edge
   (instance -> launch template -> security group -> ingress rule; instance
   subnet -> association -> route table -> internet gateway; role ->
   attachment -> policy -> table). Step 6's wildcard and managed-policy notes
   come from a second script that listed every `aws_iam_role_policy` and
   every `aws_iam_role_policy_attachment` with the actions and `Resource` of
   the policy behind it.
5. Step 5 comes from `terraform plan` and `terraform show -json` on a copy of
   the applied estate with `replace-db.patch` applied: one resource change,
   `aws_db_instance.orders`, with the actions, `planReplacePaths`
   and `planActionReason` above (the names chant#4358 landed; the raw
   `terraform show -json` calls them `replace_paths` and `action_reason`). The same plan without the patch reads "No changes".
6. behold's node counts (196 at `?logical=1`, 24 at the default zoom) were
   read from `/api/graph` on that applied estate, with chant built from its
   `epic/908-ask-your-agent` branch (#919's `graph.lint: "report"`) and no
   change to behold's scratch config by hand.
