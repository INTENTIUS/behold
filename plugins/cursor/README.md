# behold for Cursor

behold draws your infrastructure repo as a graph, from the files. Run it in a folder of Terraform and it finds each root and draws it as a box of resources, with an edge for each reference the configuration states. It needs no state file or cloud account, and it runs no terraform binary. It writes nothing into the folder it reads. Terraform roots are what it draws from files today. Kubernetes manifests in a plain directory and the edges between tools are coming. behold works beside the tools a repo already uses.

## Install

Install behold from the Cursor Marketplace. To try it from a clone of this repository, copy `plugins/cursor` to `~/.cursor/plugins/local/behold` and run Developer: Reload Window.

The plugin registers the `behold` MCP server (`npx @intentius/behold@0.31.0 mcp`) and adds one skill, `open-in-behold`, which starts `npx @intentius/behold serve .` in the background and prints the URL. The server's tools are `ask`, `show`, `shot` and `capabilities`; they return text and a link, so the graph opens in a browser tab.

## Try it

In a folder of Terraform, ask the agent to open the repo in behold.
