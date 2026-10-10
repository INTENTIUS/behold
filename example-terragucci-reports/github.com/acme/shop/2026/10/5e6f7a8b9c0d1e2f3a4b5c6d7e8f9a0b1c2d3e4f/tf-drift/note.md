### terragucci tf-drift: `5e6f7a8b9c0d`

15 roots: 2 groups, 1 destroy or replacement, 1 refused. [Full report](report.html)

**Destroys, replacements, refusals, imports and forgets (2):**

- [`envs/prod/payments`](report.html#root-envs/prod/payments) (refused to plan): plan failed: Error: reading SQS Queue (shop-prod-payments-dead-letter): AccessDenied: not authorized to perform sqs:GetQueueAttributes
- [`envs/staging/orders: module.service.aws_sqs_queue.jobs`](report.html#root-envs/staging/orders) (deleted outside Terraform)

#### [Group 49648f9475c7](report.html#group-49648f9475c7): 13 roots, no changes

Roots: `envs/dev/email`, `envs/dev/orders`, `envs/dev/payments`, `envs/dev/platform`, `envs/dev/search`, `envs/prod/email`, `envs/prod/orders`, `envs/prod/platform`, `envs/prod/search`, `envs/staging/email`, `envs/staging/payments`, `envs/staging/platform`, `envs/staging/search`

#### [Group 4dfa08e28c56](report.html#group-4dfa08e28c56): 1 root (outlier), change

```
- module.service.aws_sqs_queue.jobs
```

Roots: `envs/staging/orders`

**Each root's plan:**

<details><summary><code>envs/staging/orders</code></summary>

```diff
(plan text for envs/staging/orders)
```

[plan.txt](roots/envs/staging/orders/plan.txt)

</details>


<sub><img src="https://intentius.io/terragucci/brand/taco-small.png" width="26" height="16" alt=""> Posted by [terragucci](https://intentius.io/terragucci/)</sub>
