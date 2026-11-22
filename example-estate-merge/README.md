# estate-merge: two estates, one shared claim

Two chant projects served together as the two sides of a merge:

- `shop` declares an assets bucket and an exports bucket.
- `analytics` declares a warehouse bucket and the same exports bucket
  (`acme-shared-exports-91c2`), so both estates claim one cloud id.

Each side carries a recorded engine document under `.behold/graph/`, which is
where the cloud ids come from: a source-only read has none. The analytics
document also holds a policy whose `policy_resource` is the ARN of the shop's
assets bucket, which behold draws as a derived reference from one side into the
other.

```sh
npx @intentius/behold demo estate-merge
```

Open `/graph` and read "Two estates side by side", or ask
`GET /api/graphdb/estate-merge`. No cloud, no Docker, no engine binary.
