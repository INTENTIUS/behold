# Publishing the extension

Building and testing need nothing from this list. Publishing does, and every
step here is for a maintainer: it needs an account or an organisation setting
that an agent or a contributor cannot create.

The extension is released on behold's release train: `chant.config.ts` in
this folder is its member, and `just release` at the repository root starts
`.github/workflows/release.yml`. A train that finds a change to the extension
since its last release cuts the next version, stamps it into package.json,
builds and packages the .vsix, runs the typecheck and the unit tests, and
attaches the .vsix and `checksums.txt` to the GitHub release
`vscode-behold-v<version>`. That is the only target today. The two registries
below become targets of the member once their setup is done and the release
workflow can run the Marketplace sign-in (INTENTIUS/chant#5318).

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
   Marketplace token is stored anywhere.

## Open VSX (Cursor, VSCodium and other forks)

1. Create an eclipse.org account and link it to a GitHub account at
   open-vsx.org.
2. Sign the Eclipse Foundation Open VSX Publisher Agreement.
3. Create the namespace: `npx ovsx create-namespace intentius -p <token>`.
4. Create an access token for the account and store it as the secret
   `OVSX_PAT` in an environment `vscode-open-vsx`. Open VSX issues personal
   access tokens, and no OIDC route to it is known here (not checked against
   Open VSX's current docs), so this is the one long-lived credential in the path. Rotate it on a
   schedule, and scope it to the environment so only a release run can read it.

## First release

1. `just release`. The first train releases the extension, which has no
   release yet. The cut packages the .vsix and fails above `budget.json`.
2. Install the .vsix from the GitHub release into VS Code, VSCodium or Cursor
   and run "behold: Show infrastructure graph" on a folder of .tf files.
