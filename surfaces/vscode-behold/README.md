# behold for VS Code

Draws the open folder's infrastructure from its files, in a panel beside the editor. Click a card to open its file at the line that declares it. Saving a file draws the graph again.

Run "behold: Show infrastructure graph" from the Command Palette, or right-click a folder in the Explorer. When the workspace holds `.tf` files a "behold" item also appears in the status bar.

## What it reads

A folder of Terraform or OpenTofu files. A Terraform root is a folder with a `terraform`, `provider` or backend block; a folder of loose `.tf` files with none of those draws nothing, and the extension says so.

`behold graph` reads more kinds (a chant project, a chant workspace, Kubernetes members). The VSIX leaves out the TypeScript toolchain and the Kubernetes tooling those need, so this version draws Terraform and OpenTofu only.

Nothing is applied, planned or sent anywhere. The reader runs inside the extension: it needs no `node`, no `terraform` and no network. The VSIX carries the part of chant that reads Terraform and runs it with VS Code's own runtime.

## Trust

The reader runs chant over the folder, so the extension works only in a workspace you have trusted. Virtual workspaces are not supported, since the reader works on files on disk. In a remote workspace (SSH, a container, Codespaces) the extension runs on the remote side, next to the files.

## Theme

The page background, text and selection follow the colour theme. The cards use behold's light or dark palette, whichever the theme is closer to.

## Developing

This folder is its own package inside the behold repository and is built from the repository's sources, so install the repository first.

    npm ci                 # at the repository root
    cd surfaces/vscode-behold
    npm ci
    npm run build          # dist/: extension, viewer, staged chant
    npm test               # unit tests
    npm run package        # the .vsix, and its size against budget.json
    npm run test:vscode    # a real VS Code installed from that .vsix, no node on PATH

`npm run test:vscode` unpacks the .vsix, so it tests the file set that ships, not this checkout (where the reader would find the repository's own dependencies by walking up). It downloads VS Code the first time and opens a window; on a machine with no display run it under `xvfb-run -a`. To try the extension by hand, open this folder in VS Code and press F5.

Publishing is described in PUBLISHING.md.

## When this moves to its own repository

Everything outside this folder that the extension touches is named in `src/behold.ts` and `scripts/build.mjs`: the reader (`@intentius/behold-graph`, which becomes a dependency), the viewer sources (`src/viewer/`, built by `scripts/build-viewer.mts`), the painter's `documentIcons`, and the `BEHOLD_CHANT_BIN` seam in `src/chant.ts`. The workflow `.github/workflows/vscode-extension.yml` moves with it.
