---
name: open-in-behold
description: Open the current repo in behold, which draws infrastructure from the files as a graph. Use when asked to see, draw or open the repo's infrastructure.
allowed-tools: Bash
---

# Open this repo in behold

behold draws the repo as a graph from its files. Today that means Terraform
roots. It needs no state file and no cloud account, and it writes nothing into
the folder.

1. Start the serve in the background from the repo root, so the session stays
   free: run `npx -y @intentius/behold@0.33.3 serve .` as a background process
   that you do not wait on to exit. If port 4600 is taken, add `--port 4601` (or any
   free port).
2. Read the background output until the line that starts with `behold` and
   gives an `http://localhost:` URL appears. That URL is the address, normally
   `http://localhost:4600`.
3. Print that URL to the user and say it opens in a browser tab. Cursor
   does not render the graph itself.
4. The `behold` MCP server in this plugin finds the running serve by itself.
   Call `ask` to put a question to the graph. `show` moves a browser tab that
   is already open on the serve, so the user opens the URL first; with no tab
   open it refuses and returns the link to hand over.

If the folder holds no Terraform, behold says so on startup. Report that
message as it is; do not invent a graph.
