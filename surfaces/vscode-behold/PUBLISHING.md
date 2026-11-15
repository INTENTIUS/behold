# Publishing the extension

Building and testing need nothing from this list. Publishing does, and every
step here is for a maintainer: it needs an account or an organisation setting
that an agent or a contributor cannot create.

The workflow is `.github/workflows/vscode-extension.yml`. It runs on a tag
`vscode-behold-v<version>` that equals `version` in this folder's package.json.

## Visual Studio Marketplace

1. Create the publisher. The publisher ID in package.json is `intentius`; the
   ID cannot be changed once created, so confirm the name before the first
   publish. If chant already holds a Marketplace publisher (INTENTIUS/chant#4676
   and #4698 mention one, unconfirmed), use it and set `publisher` to match.
2. Give the GitHub Actions run an identity the Marketplace accepts. Create a
   Microsoft Entra application with a federated credential for this repository
   (subject `repo:INTENTIUS/behold:environment:vscode-marketplace`), then add
   that application as a member of the publisher with the Manager role.
3. In the repository settings create an environment `vscode-marketplace` and
   set the repository variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`. No
   Marketplace token is stored anywhere. Until `AZURE_CLIENT_ID` exists the
   `marketplace` job is skipped.

## Open VSX (Cursor, VSCodium and other forks)

1. Create an eclipse.org account and link it to a GitHub account at
   open-vsx.org.
2. Sign the Eclipse Foundation Open VSX Publisher Agreement.
3. Create the namespace: `npx ovsx create-namespace intentius -p <token>`.
4. Create an access token for the account and store it as the secret
   `OVSX_PAT` in an environment `vscode-open-vsx`. Open VSX issues personal
   access tokens, and no OIDC route to it is known here (not checked against
   Open VSX's current docs), so this is the one long-lived credential in the path. Rotate it on a
   schedule, and scope it to the environment so only a tag run can read it.

## First release

1. Tag `vscode-behold-v0.1.0` after the pinhole 0.6.0 release is in
   behold's package.json (the viewer build needs it).
2. The `package` job prints the VSIX size and fails above `budget.json`.
3. Check the listing on both registries, then install the VSIX from Open VSX
   into VSCodium or Cursor and run "behold: Show infrastructure graph" on a
   folder of .tf files.
