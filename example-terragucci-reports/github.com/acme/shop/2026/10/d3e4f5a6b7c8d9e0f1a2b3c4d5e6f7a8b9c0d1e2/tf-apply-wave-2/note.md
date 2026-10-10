### terragucci tf-apply, wave 2: `d3e4f5a6b7c8`

5 roots: 2 groups, 1 destroy or replacement. [Full report](report.html)

**Destroys, replacements, refusals, imports and forgets (1):**

- [`envs/staging/email: module.service.aws_dynamodb_table.records[0]`](report.html#root-envs/staging/email) (destroy)

| Wave | Roots | Set digest | Approval |
|---|---|---|---|
| 2 | 5 | `jcs1-sha256:2e0fba1` | waiting |

#### [Group 49648f9475c7](report.html#group-49648f9475c7): 4 roots, no changes

Roots: `envs/staging/orders`, `envs/staging/payments`, `envs/staging/platform`, `envs/staging/search`

#### [Group e2ffd4ada760](report.html#group-e2ffd4ada760): 1 root (outlier), change

```
- module.service.aws_dynamodb_table.records
```

Roots: `envs/staging/email`

**Each root's plan:**

<details><summary><code>envs/staging/email</code></summary>

```diff
(plan text for envs/staging/email)
```

[plan.txt](roots/envs/staging/email/plan.txt)

</details>


<sub><img src="https://intentius.io/terragucci/brand/taco-small.png" width="26" height="16" alt=""> Posted by [terragucci](https://intentius.io/terragucci/)</sub>
