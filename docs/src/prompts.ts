// The prompts handed to a coding agent. The setup prompt has this one source:
// the home page, the agents page and the agents room render it, and
// scripts/lint-prompts.mjs holds the copy in README.md to it. Every prompt
// carries neverLine word for word; lint-prompts.mjs fails a prompt that is
// missing any part of it.
//
// neverLine names behold's write paths as src/server.ts serves them: Deploy
// (`POST /api/apply`, and `POST /api/ci/dispatch` for a forge), the gate
// approvals, an Op run, a rollback pull request and auto-sync. `behold preview`
// and `serve --public` are the two serves that refuse writes, and an agent
// keeps them that way. The person runs every write.

export const SITE = 'https://intentius.io/behold';

export const neverLine =
	'Never deploy with the Deploy button, `POST /api/apply` or `POST /api/ci/dispatch`. Gate approvals stay mine as well (`/api/ops/:name/signal/:gate`, `/api/workspace/gates/approve`, `/api/operator/approve/:op/:gate`). Op runs (`/api/ops/:name/run`) and rollbacks (`/api/rollback`) are mine too. Leave `--auto-sync` off, and keep a `behold preview` or `--public` serve read-only.';

export const setupPrompt = [
	'Clone https://github.com/INTENTIUS/behold and get me looking at a live',
	'infrastructure graph in my browser.',
	'',
	'I want the bundled demo. It needs Docker and no cloud account. Install what',
	'it needs and start it, then tell me the URL.',
	'',
	'Walk me through what I am looking at: what the colours mean, and how I make a',
	'resource change colour while I watch.',
	'',
	'When Docker is not running, say so. Show me the source graph on its own',
	'instead.',
	'',
	`For anything past the demo, read ${SITE}/llms.txt and`,
	`${SITE}/using/agents/.`,
	'',
	neverLine,
].join('\n');

// A page's `prompt:` front matter, as its text. `prompt: setup` stands for the
// setup prompt, so a page can carry it without a second copy.
export function promptText(prompt: string | undefined): string | undefined {
	const text = prompt?.trim();
	if (!text) return undefined;
	return text === 'setup' ? setupPrompt : text;
}
