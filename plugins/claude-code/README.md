# behold for Claude Code

behold draws your infrastructure repo as a graph, from the files. Run it in a folder of Terraform and it finds each root and draws it as a box of resources, with an edge for each reference the configuration states. It needs no state file or cloud account, and it runs no terraform binary. It writes nothing into the folder it reads. The same command draws a Pulumi program and the Kubernetes manifests in a plain directory, since their lexicons come with the install. behold works beside the tools a repo already uses.

## Install

```
claude plugin marketplace add INTENTIUS/behold
claude plugin install behold@behold
```

The plugin registers the `behold` MCP server (`npx @intentius/behold@0.34.5 mcp`) and adds one skill, `open-in-behold`, which starts `npx @intentius/behold serve .` in the background and prints the URL. Claude Code does not render MCP App views, so the graph opens in a browser tab.

## Try it

In a folder of Terraform, ask Claude to open the repo in behold.
