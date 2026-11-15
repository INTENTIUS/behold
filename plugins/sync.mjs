#!/usr/bin/env node
// Generates the files that carry the listing text and the pinned version, so
// each is written once and the plugins cannot drift from it.
//
//   node plugins/sync.mjs           write the generated files
//   node plugins/sync.mjs --check   exit 1 if any generated file is stale (CI)
//
// Sources: plugins/listing.json (the listing text, quoted, never reworded),
// package.json (the version the MCP config pins), and
// plugins/shared/skills (the skill, with {{VERSION}} filled in) and
// plugins/shared/icon.png (square, from docs/public/brand/logo.svg).
// The Claude Code and Cursor plugins are two folders written from the same
// sources; the Cursor manifest and marketplace file are the Cursor-only parts.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const check = process.argv.includes("--check");

const listing = JSON.parse(readFileSync(join(here, "listing.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const json = (v) => JSON.stringify(v, null, 2) + "\n";

const mcpConfig = {
  mcpServers: {
    behold: { command: "npx", args: ["-y", "-p", `@intentius/behold@${version}`, "-p", "@modelcontextprotocol/sdk@1.30.1", "behold", "mcp"] },
  },
};

// The shared skills, as { relative path: text }.
function sharedSkills(host) {
  const base = join(here, "shared", "skills");
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(base, p)] = readFileSync(p, "utf8").replaceAll("{{VERSION}}", version).replaceAll("{{HOST}}", host);
    }
  };
  walk(base);
  return out;
}

const files = {};
const put = (path, text) => (files[join(root, path)] = text);
const icon = readFileSync(join(here, "shared", "icon.png"));

// Claude Code plugin.
put(
  "plugins/claude-code/.claude-plugin/plugin.json",
  json({
    name: "behold",
    version,
    description: listing.short,
    author: { name: "INTENTIUS" },
    homepage: "https://github.com/INTENTIUS/behold",
    repository: "https://github.com/INTENTIUS/behold",
    license: "Apache-2.0",
    keywords: ["terraform", "infrastructure", "graph", "mcp"],
  }),
);
put("plugins/claude-code/.mcp.json", json(mcpConfig));
put("plugins/claude-code/.claude-plugin/icon.png", icon);
for (const [rel, text] of Object.entries(sharedSkills("Claude Code"))) put(join("plugins/claude-code/skills", rel), text);
put(
  "plugins/claude-code/README.md",
  `# behold for Claude Code\n\n${listing.paragraph}\n\n` +
    `## Install\n\n` +
    "```\nclaude plugin marketplace add INTENTIUS/behold\nclaude plugin install behold@behold\n```\n\n" +
    `The plugin registers the \`behold\` MCP server (\`npx -p @intentius/behold@${version} -p @modelcontextprotocol/sdk@1.30.1 behold mcp\`) and adds one skill, ` +
    `\`open-in-behold\`, which starts \`${listing.command}\` in the background and prints the URL. ` +
    `Claude Code does not render MCP App views, so the graph opens in a browser tab.\n\n` +
    `## Try it\n\nIn a folder of Terraform, ask Claude to open the repo in behold.\n`,
);
put(
  ".claude-plugin/marketplace.json",
  json({
    name: "behold",
    owner: { name: "INTENTIUS" },
    metadata: { description: listing.line },
    plugins: [
      {
        name: "behold",
        source: "./plugins/claude-code",
        description: listing.short,
        version,
        category: "development",
        keywords: ["terraform", "infrastructure", "graph", "mcp"],
      },
    ],
  }),
);

// Cursor plugin. The MCP config is the same shape at the plugin root (mcp.json,
// which Cursor discovers by default); the marketplace file at the repo root
// lets Cursor read the repository as a one-plugin marketplace.
const cursorKeywords = ["terraform", "infrastructure", "graph", "mcp"];
put(
  "plugins/cursor/.cursor-plugin/plugin.json",
  json({
    name: "behold",
    version,
    description: listing.short,
    author: { name: "INTENTIUS" },
    homepage: "https://github.com/INTENTIUS/behold",
    repository: "https://github.com/INTENTIUS/behold",
    license: "Apache-2.0",
    keywords: cursorKeywords,
    logo: "assets/logo.png",
  }),
);
put("plugins/cursor/mcp.json", json(mcpConfig));
put("plugins/cursor/assets/logo.png", icon);
for (const [rel, text] of Object.entries(sharedSkills("Cursor"))) put(join("plugins/cursor/skills", rel), text);
put(
  "plugins/cursor/README.md",
  `# behold for Cursor\n\n${listing.paragraph}\n\n` +
    `## Install\n\n` +
    `Install behold from the Cursor Marketplace. To try it from a clone of this repository, copy ` +
    "\`plugins/cursor\` to \`~/.cursor/plugins/local/behold\` and run Developer: Reload Window.\n\n" +
    `The plugin registers the \`behold\` MCP server (\`npx -p @intentius/behold@${version} -p @modelcontextprotocol/sdk@1.30.1 behold mcp\`) and adds one skill, ` +
    `\`open-in-behold\`, which starts \`${listing.command}\` in the background and prints the URL. ` +
    `The server's tools are \`ask\`, \`show\`, \`shot\` and \`capabilities\`; they return text and a link, ` +
    `so the graph opens in a browser tab.\n\n` +
    `## Try it\n\nIn a folder of Terraform, ask the agent to open the repo in behold.\n`,
);
put(
  ".cursor-plugin/marketplace.json",
  json({
    name: "behold",
    owner: { name: "INTENTIUS" },
    metadata: { description: listing.line },
    plugins: [
      {
        name: "behold",
        source: "./plugins/cursor",
        description: listing.short,
        version,
        category: "development",
        keywords: cursorKeywords,
      },
    ],
  }),
);

let stale = 0;
for (const [path, text] of Object.entries(files)) {
  const current = existsSync(path) ? readFileSync(path) : undefined;
  if (current && current.equals(Buffer.from(text))) continue;
  if (check) {
    stale++;
    process.stderr.write(`stale: ${relative(root, path)}\n`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    process.stdout.write(`wrote ${relative(root, path)}\n`);
  }
}
if (check && stale) {
  process.stderr.write("run `node plugins/sync.mjs` and commit the result\n");
  process.exit(1);
}
