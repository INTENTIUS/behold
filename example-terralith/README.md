# terralith: adopt and split, on a scratch floci

One Terraform root that holds everything, taken to four choudoufu estates in
two reviewed steps. [choudoufu](https://github.com/INTENTIUS/choudoufu) is the
OpenTofu fork for AWS, GCP, Azure and Kubernetes whose ownership lives on each resource as
two tags, `tofu-estate` and `tofu-address`.

```sh
npx @intentius/behold demo terralith   # Docker, curl and choudoufu 0.28.0 or newer
```

The page is `http://localhost:4600/terralith`. It reads the files each phase
leaves in `snapshots/`, and shows the next phase's line for you to run here.

| Phase | You run | What happens |
|---|---|---|
| 1. Stock | `bash scripts/terralith-up.sh` (the demo runs it) | a floci on 127.0.0.1:4652, a state bucket, and `terralith/` applied the stock way: 23 resources in one state file |
| 2. Adopt | `bash scripts/terralith-step.sh adopt` | terragucci's `backends:` migration: the backend block becomes a live block (`phases/adopt/`), `choudoufu live-import` reads the state once and stamps the two tags on each resource it verifies |
| 3. Split | `bash scripts/terralith-step.sh split` | terragucci's `moves:` migration: three team roots (`phases/split/`), and `choudoufu live-mv -from-estate` moves each team's resources into the team's estate, one tag write each, recorded in `split.json` |
| 4. Plan | `bash scripts/terralith-step.sh plan` | one change across the estates (`phases/plan/`): the terralith outputs `log_retention_days`, each team's first log group reads it, `live-cone` gives each team's cone, the team roots plan against the terralith's planned output with `-estate-outputs-from` in one `live-plan-set`, and `live-summary` folds the three changes into one group. Nothing is applied |

From adopt on, each card carries a tag. A filled tag means the resource wears the
marker; an outlined one means it has no tags argument and rides the role it
belongs to. The word beside it says how choudoufu's plan found the resource:
`marker`, by the tag sweep, or `derived`, by the name the code gives it. A
named resource reads `derived` and wears the marker too.

The state file stays in the bucket as it was after adopt. Each stamp and
each retag is its own tag write.

`bash scripts/terralith-down.sh` removes the container. Set
`TERRALITH_CONTAINER` and `TERRALITH_PORT` for another name and port, or
`CHOUDOUFU_BIN` for a choudoufu that is not on PATH.
