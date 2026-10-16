// The "Optional: hand this page to your coding agent" prompts, held to one
// rule: each names its own page's address and carries the never-line in
// src/prompts.ts word for word, so none can drop a write path. Every "Look
// at" page and every room carries a prompt, and a "Look at" page's steps are
// its room's (`task` in src/data/rooms.mjs); the agents page and the agents
// room carry the setup prompt, whose one source is src/prompts.ts. README.md,
// the home page (Landing.astro) and the agents page carry it from there.
//   node scripts/lint-prompts.mjs       (prints each prompt; npm run build runs it first)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE, neverLine, promptText, setupPrompt } from '../src/prompts.ts';
import { ROOMS, room } from '../src/data/rooms.mjs';

const docs = fileURLToPath(new URL('..', import.meta.url));
const content = join(docs, 'src/content/docs');

/** A page's `prompt:` front matter: one line, or a `|` or `>` block. */
export function frontPrompt(text) {
	const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
	const lines = front.split('\n');
	const at = lines.findIndex((l) => /^prompt:/.test(l));
	if (at === -1) return undefined;
	const head = lines[at].slice('prompt:'.length).trim();
	if (!/^[|>][+-]?$/.test(head)) return promptText(head.replace(/^(["'])(.*)\1$/, '$2'));
	const block = [];
	for (const line of lines.slice(at + 1)) {
		if (line.trim() && !/^\s/.test(line)) break;
		block.push(line.replace(/^ {2}/, ''));
	}
	const body = block.join('\n').trim();
	return promptText(head.startsWith('>') ? body.replace(/\n(?!\n)/g, ' ') : body);
}

const url = (name) => (name === 'index' ? `${SITE}/` : `${SITE}/${name}/`);
const flat = (text) => text.replace(/\s+/g, ' ');

// The never-line's parts, each named when a prompt lacks it.
const NEVER_PARTS = [
	['Never deploy with the Deploy button', 'the Deploy button'],
	['`POST /api/apply`', 'POST /api/apply'],
	['`POST /api/ci/dispatch`', 'POST /api/ci/dispatch'],
	['Gate approvals stay mine as well (`/api/ops/:name/signal/:gate`', 'an Op gate signal'],
	['`/api/workspace/gates/approve`', 'a workspace gate approval'],
	['`/api/operator/approve/:op/:gate`', 'a converge gate approval'],
	['Op runs (`/api/ops/:name/run`)', 'an Op run'],
	['rollbacks (`/api/rollback`)', 'a rollback'],
	['Leave `--auto-sync` off', '--auto-sync'],
	['keep a `behold preview` or `--public` serve read-only.', 'preview and --public'],
];

// The pages that must carry a prompt: the agents page and every page the picker's tiles lead to.
const MUST = ['using/agents', 'using/workspace', 'using/terraform', 'using/terragucci', 'using/sql-yodeler', 'using/choudoufu', 'using/carve'];

/** Problems with one prompt, the page it sits on named for the messages. */
export function checkPrompt(prompt, name, where) {
	const problems = [];
	if (!prompt.includes(url(name))) problems.push(`${where}: the prompt does not name its page, ${url(name)}`);
	if (!flat(prompt).includes(neverLine)) {
		const missing = NEVER_PARTS.filter(([text]) => !flat(prompt).includes(text)).map(([, part]) => part);
		const what = missing.length ? `misses ${missing.join(', ')}` : 'words it differently';
		problems.push(`${where}: the prompt ${what}; end it with the never-line from src/prompts.ts: "${neverLine}"`);
	}
	return problems;
}

const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).sort().flatMap((e) => walk(join(p, e))) : [p]);
const files = walk(content).filter((f) => /\.mdx?$/.test(f));
const problems = [];
const found = new Map();
for (const file of files) {
	const name = relative(content, file).replace(/\.mdx?$/, '');
	const prompt = frontPrompt(readFileSync(file, 'utf8'));
	if (prompt === undefined) continue;
	found.set(name, prompt);
	console.log(`${name}\n${prompt.replace(/^/gm, '  ')}\n`);
	problems.push(...checkPrompt(prompt, name, relative(docs, file)));
}
for (const name of MUST) if (!found.has(name)) problems.push(`src/content/docs/${name}.mdx: no \`prompt:\` front matter; add one that names ${url(name)} and ends with the never-line`);
// A tile's "Look at" page carries its room's steps: one source, in rooms.mjs's `task`.
for (const r of ROOMS) {
	const name = `using/${r.id}`;
	if (!MUST.includes(name) || name === 'using/agents') continue;
	const want = [`Read ${url(name)}.`, ...r.task, neverLine].join('\n');
	if (found.has(name) && found.get(name) !== want) problems.push(`src/content/docs/${name}.mdx: the prompt is not room ${r.id}'s steps; write "Read ${url(name)}.", then rooms.mjs's task lines, then the never-line`);
}
if (found.get('using/agents') !== setupPrompt) problems.push('src/content/docs/using/agents.mdx: carry the setup prompt with `prompt: setup`');

for (const r of ROOMS) {
	if (!r.prompt) {
		problems.push(`src/data/rooms.mjs: room ${r.id} has no prompt`);
		continue;
	}
	console.log(`for/${r.id}\n${r.prompt.replace(/^/gm, '  ')}\n`);
	problems.push(...checkPrompt(r.prompt, `for/${r.id}`, `src/data/rooms.mjs (room ${r.id})`));
}
if (room('agents').first.command !== setupPrompt) problems.push('src/data/rooms.mjs: the agents room\'s first step is the setup prompt');

if (!setupPrompt.includes(neverLine)) problems.push('src/prompts.ts: the setup prompt does not carry neverLine');
const readme = readFileSync(join(docs, '..', 'README.md'), 'utf8');
if (!readme.includes('```text\n' + setupPrompt + '\n```')) problems.push('README.md: the setup prompt is not the one in docs/src/prompts.ts; copy it from there');
if (!readFileSync(join(docs, 'src/components/Landing.astro'), 'utf8').includes('text={setupPrompt}')) problems.push('src/components/Landing.astro: render <AgentPrompt text={setupPrompt} />');

for (const p of problems) console.error(`FAIL prompt  ${p}`);
if (problems.length) process.exit(1);
console.log(`prompts: ${found.size} pages and ${ROOMS.length} rooms, each names its page and carries the never-line`);
