// The agent index, built from the docs collection and the rooms so it never
// drifts from the site. llms.txt lists every page; llms-full.txt carries
// their text. A page's prompt rides with it.
import { getCollection } from 'astro:content';
import { bodyMarkdown, pageUrl } from '../markdown';
import { SITE } from '../prompts';
import { ROOMS } from '../data/rooms.mjs';
import { roomMarkdown } from '../data/room-markdown.mjs';

// The agents page first, the home page next, then the sidebar's order.
const ORDER = [
	'using/agents',
	'index',
	'start/what-it-is',
	'start/run-it',
	'start/your-project',
	'using/reading-the-graph',
	'using/acting',
	'using/export',
	'using/workspace',
	'using/terraform',
	'using/terragucci',
	'using/sql-yodeler',
	'using/choudoufu',
	'using/carve',
];

export type LlmsPage = { id: string; title: string; description: string; url: string; prompt?: string; body: string };

export async function pages(): Promise<LlmsPage[]> {
	const docs = await getCollection('docs');
	const rank = (id: string) => {
		const i = ORDER.indexOf(id);
		return i === -1 ? ORDER.length : i;
	};
	const docPages = docs
		.filter((d) => d.id !== '404')
		.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
		.map((d) => ({
			id: d.id,
			title: d.data.title,
			description: d.data.description ?? '',
			url: pageUrl(d.id),
			prompt: d.data.prompt,
			body: bodyMarkdown(d.body ?? ''),
		}));
	const rooms = ROOMS.map((r) => ({
		id: `for/${r.id}`,
		title: r.title,
		description: r.lede.replace(/`/g, ''),
		url: pageUrl(`for/${r.id}`),
		prompt: r.prompt,
		body: roomMarkdown(r, SITE),
	}));
	return [...docPages, ...rooms];
}

export const PREAMBLE = `# behold

> A live control plane on chant (https://intentius.io/chant/). behold draws an estate as one graph coloured by what the live estate holds. It reads the estates of the other INTENTIUS tools as well as chant's. Every view is a read. Each write starts an Op the project committed or a forge workflow, on the credentials behold was started with.

An agent driving behold starts with ${SITE}/using/agents/. Every pane is plain JSON over HTTP, and \`GET /api\` lists the routes. A person new to it starts with ${SITE}/start/run-it/.

A read-only live demo of behold on real terragucci pipelines runs at https://demo.intentius.io/kiosk. Each tool has its own page there, such as https://demo.intentius.io/terraform.

Each page under /for/ is a starting point for one kind of estate or one role. A page with a prompt carries it under "Optional: hand this page to your coding agent", and llms.txt lists it under the page. Every prompt ends with the same line, which keeps each write with the person.`;
