### terragucci tf-plan: `b1c2d3e4f5a6`

1 instance: 1 group, 1 destroy or replacement. [Full report](report.html)

**Destroys, replacements, refusals, imports and forgets (1):**

- [`envs/prod/search: module.service.aws_dynamodb_table.records[0]`](report.html#root-envs/prod/search) (replace, forced by `hash_key`)

#### [Group 3c5cc5e65263](report.html#group-3c5cc5e65263): 1 instance of `module.service.aws_dynamodb_table.records`, change

```
-/+ module.service.aws_dynamodb_table.records: hash_key
```

Instances: `module.service.aws_dynamodb_table.records[0]`

**Each root's plan:**

<details><summary><code>envs/prod/search</code></summary>

```diff
(plan text for envs/prod/search)
```

[plan.txt](roots/envs/prod/search/plan.txt)

</details>


<sub><img src="https://intentius.io/terragucci/brand/taco-small.png" width="26" height="16" alt=""> Posted by [terragucci](https://intentius.io/terragucci/)</sub>
