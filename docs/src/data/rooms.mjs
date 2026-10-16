// The home page's picker and the room pages under /behold/for/<id>/, from one
// file. Each tile (what the reader points behold at, plus the demo for no
// project yet) and each role is a room. pages/for/[id].astro renders every
// room with the same sections in the same order: the lede, Works, Needs,
// First step, Proof and Then read. components/Picker.astro reads the same
// lists, so the picker and the rooms cannot disagree.
//
// A link's href is a page of this site, as its slug with an optional #anchor
// ('using/terragucci', 'start/what-it-is#read-only-core-delegated-writes'),
// or a full https:// address. scripts/check-rooms.mjs runs after `astro
// build` and fails the build when a room or the picker links a page or anchor
// that does not exist. A room's `proof` are paths in this repository (example
// projects, end-to-end scripts); data/proof.mjs fails the build when one is
// missing. behold has no claims record, so no room shows a proven count.
//
// Each room's `prompt` starts an agent on the room's path; it names the room's
// own address and ends with the never-line (scripts/lint-prompts.mjs).

import { SITE, neverLine, setupPrompt } from '../prompts.ts';
import { LIVE, LIVE_TOOLS } from './live.mjs';

const liveTool = (label) => LIVE_TOOLS.find((t) => t.label === label).href;

/** @typedef {{ label: string, href: string }} Link */

/** What the reader points behold at: the tiles on the home page. */
export const TILES = [
	{ id: 'workspace', label: 'A chant workspace', blurb: 'chant.workspace.json, or one project', room: 'workspace' },
	{ id: 'terraform', label: 'Terraform', blurb: 'Roots, modules and their references', room: 'terraform' },
	{ id: 'terragucci', label: 'terragucci', blurb: 'The pipeline\'s reports, per root', room: 'terragucci' },
	{ id: 'sql-yodeler', label: 'SQL Yodeler', blurb: 'Schema, gates and releases', room: 'sql-yodeler' },
	{ id: 'choudoufu', label: 'choudoufu', blurb: 'Tag ownership on AWS and Kubernetes', room: 'choudoufu' },
	{ id: 'carve', label: 'A carve-out', blurb: 'What moves off Terraform first', room: 'carve' },
	{ id: 'demo', label: 'No project yet', blurb: 'The demo on a local emulator', room: 'demo' },
];

/** The roles: the line of chips under the tiles. */
export const ROLES = [
	{ id: 'agents', label: 'I work with a coding agent', room: 'agents' },
	{ id: 'platform', label: 'I run a platform team', room: 'platform' },
	{ id: 'security', label: 'I review security', room: 'security' },
	{ id: 'evaluate', label: 'I am evaluating', room: 'evaluate' },
];

/** A room's prompt: read the room, the steps that start an agent on its path, and the never-line. */
const prompt = (id, ...lines) => [`Read ${SITE}/for/${id}/.`, ...lines, neverLine].join('\n');

/**
 * The rooms, one per tile and role. `first.command` goes in a `sh` block
 * unless `first.lang` names another; `first.note` comes before it. `task` is
 * the agent's steps; the room's prompt and the "Look at" page's prompt both
 * carry them (scripts/lint-prompts.mjs).
 */
export const ROOMS = [
	{
		id: 'workspace',
		title: 'behold on a chant workspace',
		lede: 'Serve a directory whose chant.workspace.json lists its members and see every member in one graph. One chant project on its own works the same way.',
		works: [
			'`behold serve ./estate` reads the member list through `chant workspace ls --json`',
			'A box per member: resources for chant and Terraform members, instances for choudoufu',
			'A member chant cannot read draws as one card that names the reason code',
			'`behold doctor ./estate --fix` turns a `.behold.json` member list into a `chant.workspace.json`',
		],
		needs: [
			"A chant install the workspace root resolves, or behold's own",
			'Read credentials for the environment that `--env` names',
		],
		first: {
			note: 'To try it first, `npx @intentius/behold demo argo-estate` serves a declared workspace without Docker.',
			command: 'npx @intentius/behold serve ./estate',
			link: { label: 'Serve a chant workspace', href: 'using/workspace' },
		},
		task: [
			'Serve this directory with `npx @intentius/behold serve .` and tell me the URL.',
			'Name each member that draws as one card, and the reason code on it.',
			'If it does not serve, show me what `npx @intentius/behold doctor .` reports.',
		],
		proof: ['example-argo-estate', 'example-flux-estate', 'e2e/workbench-e2e.sh'],
		tasks: [
			{ label: 'Serve a chant workspace', href: 'using/workspace' },
			{ label: 'Open your own project', href: 'start/your-project' },
		],
		background: [
			{ label: 'Reading the graph', href: 'using/reading-the-graph' },
			{ label: 'What behold is', href: 'start/what-it-is' },
		],
		reference: [
			{ label: 'behold doctor', href: 'start/your-project#if-it-doesnt-look-right-behold-doctor' },
			{ label: 'Converting a member list', href: 'using/workspace#converting-a-beholdjson-member-list' },
		],
	},
	{
		id: 'terraform',
		title: 'behold on a Terraform estate',
		lede: 'Draw a directory of Terraform roots straight from the checkout. Each root is a box of resource cards, and the references the configuration states are its edges.',
		works: [
			'A probe finds the roots and names each skipped directory',
			"Module calls open into their contents, joined by the references chant's Terraform lexicon resolves",
			'Outputs and variables join the cards at the attributes zoom',
			'A read across two roots stays on its card as text',
		],
		needs: [
			'`@intentius/chant-lexicon-terraform` and `@cdktn/hcl2json` beside behold',
			'Only the checkout: behold reads the `.tf` files without a cloud account or a `terraform` binary',
		],
		first: {
			command: 'npm install --no-save @intentius/chant-lexicon-terraform@^0.124.0 @cdktn/hcl2json@^0.24.0\nnpx @intentius/behold serve ./infra',
			link: { label: 'Look at a Terraform estate', href: 'using/terraform' },
		},
		task: [
			'Install the two packages the page names beside behold.',
			"Serve this repository's Terraform with `npx @intentius/behold serve <dir>` and tell me the URL.",
			'List the roots it found and each directory it skipped, and why.',
		],
		proof: ['example-terraform-estate'],
		tasks: [
			{ label: 'Look at a Terraform estate', href: 'using/terraform' },
			{ label: 'Look at a Terraform carve-out', href: 'using/carve' },
		],
		background: [
			{ label: 'Roots and skips', href: 'using/terraform#roots-are-discovered-and-the-skips-are-reported' },
			{ label: 'What is a card', href: 'using/terraform#what-is-a-card' },
		],
		reference: [
			{ label: 'Export a snapshot', href: 'using/export' },
			{ label: 'Driving it from an agent', href: 'using/agents' },
			{ label: 'The live Terraform demo', href: liveTool('Terraform') },
		],
	},
	{
		id: 'terragucci',
		title: 'behold on a terragucci estate',
		lede: 'Serve a repo that terragucci runs and see every root in one graph. Each card carries what the newest run found about it.',
		works: [
			'A dated mark on each card the newest drift check or plan names',
			"Each mark links to its run's report",
			'A timeline from the audit record',
			'The waves that wait for an approval',
			'Gates and locks read from `chant/lifecycle`',
			'Apply progress per resource from the run view',
			"A view to publish beside terragucci's estate page",
		],
		needs: [
			'Read access to the reports bucket through your `aws` profile, or a local sync of it',
			"The repo's checkout for the graph",
		],
		first: {
			command: 'npx @intentius/behold serve . --terragucci s3://acme-terragucci-reports',
			link: { label: 'Look at a terragucci estate', href: 'using/terragucci' },
		},
		task: [
			'Ask me where the reports bucket is.',
			'Serve this repository with `npx @intentius/behold serve . --terragucci <source>` and tell me the URL.',
			'List the roots that carry a mark and the date on each.',
		],
		proof: ['example-terragucci-reports', 'e2e/terragucci-e2e.sh'],
		tasks: [
			{ label: 'Watch the live demo', href: LIVE },
			{ label: 'Look at a terragucci estate', href: 'using/terragucci' },
			{ label: 'Publish a view', href: 'using/terragucci#publish-a-view-beside-the-estate-page' },
			{ label: 'Export a terragucci estate', href: 'using/export#a-terragucci-estate' },
		],
		background: [
			{ label: 'What a mark means', href: 'using/terragucci#what-a-mark-means' },
			{ label: 'Waiting waves', href: 'using/terragucci#waiting-waves' },
		],
		reference: [
			{ label: 'The reports bucket', href: 'https://intentius.io/terragucci/reference/reports-bucket/' },
			{ label: 'terragucci docs', href: 'https://intentius.io/terragucci/' },
		],
	},
	{
		id: 'sql-yodeler',
		title: 'behold on a SQL Yodeler project',
		lede: 'Draw the schema a SQL Yodeler project declares. What each environment holds comes from the files yodel wrote and the `chant/lifecycle` branch.',
		works: [
			'Tables and indexes as cards named by kind, joined by each `REFERENCES`',
			"The Pipeline tab: each wave's gate and the plan digest it is bound to",
			'Who approved each gate, and how',
			"The Releases tab: each environment's newest release per component",
			'Drift files as dated corner tags on the cards they name',
		],
		needs: [
			"The project's checkout, with `chant/lifecycle` on its origin",
			'Report and drift JSON from `yodel` for the SQL Yodeler tab',
		],
		first: {
			command: 'yodel report --json > out/report.json\nyodel drift prod --json > out/drift-prod.json\nnpx @intentius/behold serve . --yodel-report out/',
			link: { label: 'Look at a SQL Yodeler project', href: 'using/sql-yodeler' },
		},
		task: [
			'Serve this SQL Yodeler project with `npx @intentius/behold serve .` and tell me the URL.',
			'List the environments the Releases tab shows.',
			'For each gate that waits, show me the `yodel approve` line to run myself.',
		],
		proof: ['e2e/fixtures/sql-yodeler-fk'],
		tasks: [
			{ label: 'Look at a SQL Yodeler project', href: 'using/sql-yodeler' },
			{ label: 'Report and drift', href: 'using/sql-yodeler#report-and-drift' },
		],
		background: [
			{ label: 'The pipeline', href: 'using/sql-yodeler#the-pipeline' },
			{ label: 'Releases', href: 'using/sql-yodeler#releases' },
		],
		reference: [
			{ label: 'Policy denials', href: 'using/workspace#policy-denials' },
			{ label: 'SQL Yodeler docs', href: 'https://intentius.io/sql-yodeler/' },
		],
	},
	{
		id: 'choudoufu',
		title: 'behold on a choudoufu estate',
		lede: 'choudoufu manages estates on AWS and Kubernetes and keeps ownership in marker tags on the live resources. behold reads those tags, so a green card means the resource is ours.',
		works: [
			"Each instance in choudoufu's own words for ownership",
			'Attribute drift on request, through Re-check live with plan in the command palette',
			"Adoptable cards that show what the sweep matched on next to choudoufu's adopt command",
			'Moves previewed with `live-mv -json -dry-run` and ready to copy',
		],
		needs: [
			"Credentials that read the estate's account, for `--env`",
			'`TOFU_LIVE_COLLECT_UNCLAIMED=1` in `spawnEnv` to sweep the whole account',
		],
		first: {
			note: 'The demo needs Docker and choudoufu installed.',
			command: 'npx @intentius/behold demo choudoufu-estate',
			link: { label: 'Look at a choudoufu estate', href: 'using/choudoufu' },
		},
		task: [
			'Start `npx @intentius/behold demo choudoufu-estate`, or serve this estate with `npx @intentius/behold serve . --env <env>`.',
			'Tell me the URL and list the cards that read unowned.',
			'Copy out each move preview for me to run.',
		],
		proof: ['example-choudoufu-estate', 'e2e/choudoufu-estate-floci-e2e.sh'],
		tasks: [
			{ label: 'Look at a choudoufu estate', href: 'using/choudoufu' },
			{ label: 'Serve a chant workspace', href: 'using/workspace' },
		],
		background: [
			{ label: 'A green card means ours', href: 'using/choudoufu#a-green-card-means-this-is-ours' },
			{ label: 'Unowned, and adoptable', href: 'using/choudoufu#unowned-and-adoptable' },
		],
		reference: [
			{ label: 'Splits are previewed', href: 'using/choudoufu#splits-are-previewed-never-run' },
			{ label: 'choudoufu on GitHub', href: 'https://github.com/INTENTIUS/choudoufu' },
			{ label: 'choudoufu in the live demo', href: liveTool('choudoufu') },
		],
	},
	{
		id: 'carve',
		title: 'behold on a Terraform carve-out',
		lede: "Move resources from Terraform to chant one at a time. behold draws chant's peelability report and ranks each resource by what carving it costs.",
		works: [
			'Cards banded by verdict, with carve now at the top',
			'The score arithmetic behind each rank in the inspect pane',
			'`behold demo carve` walks a half-migrated estate step by step',
			"Each carved resource's stage, read from chant's carve manifests",
		],
		needs: [
			'A peelability report from `chant carve advise`',
			"Docker and `terraform` on PATH for the demo's `--live` tier",
		],
		first: {
			command: 'chant carve advise --from ./terraform --report carve.json\nnpx behold carve carve.json',
			link: { label: 'Look at a Terraform carve-out', href: 'using/carve' },
		},
		task: [
			'Run `chant carve advise --from <terraform dir> --report carve.json`.',
			'Then serve the report with `npx behold carve carve.json` and tell me the URL.',
			'List the resources in the carve now band, and hand me the runbook commands to run myself.',
		],
		proof: ['example-carve'],
		tasks: [
			{ label: 'Look at a Terraform carve-out', href: 'using/carve' },
			{ label: 'The walkthrough', href: 'using/carve#the-walkthrough-behold-demo-carve' },
		],
		background: [
			{ label: 'The arithmetic behind a rank', href: 'using/carve#the-arithmetic-behind-a-rank' },
			{ label: 'What has graduated', href: 'using/carve#the-strangler-fig-what-has-actually-graduated' },
		],
		reference: [
			{ label: 'Look at a Terraform estate', href: 'using/terraform' },
			{ label: 'For agents', href: 'using/carve#for-agents' },
		],
	},
	{
		id: 'demo',
		title: 'behold with no project yet',
		lede: 'The bundled demo deploys an S3 bucket to a local emulator. Its cards turn green once behold observes it. To watch behold first, open the live demo, which needs no install.',
		works: [
			'An S3 bucket and its TLS policy on a local Floci emulator',
			'Deploy on the control panel streams each phase as it runs',
			'`behold demo k8s` runs an nginx Deployment on a throwaway k3d cluster',
			'`behold demo --list` names the rest of the catalog',
		],
		needs: ['Docker'],
		first: {
			command: 'npx @intentius/behold demo',
			link: { label: 'Run it in five minutes', href: 'start/run-it' },
		},
		task: [
			'Start `npx @intentius/behold demo` and tell me the URL.',
			'Walk me through Deploy on the control panel so I watch the bucket turn green.',
			'When Docker is not running, say so.',
		],
		proof: ['example-writes', 'example-k8s'],
		tasks: [
			{ label: 'Watch the live demo', href: LIVE },
			{ label: 'Run it in five minutes', href: 'start/run-it' },
			{ label: 'Open your own project', href: 'start/your-project' },
		],
		background: [
			{ label: 'What behold is', href: 'start/what-it-is' },
			{ label: 'Reading the graph', href: 'using/reading-the-graph' },
		],
		reference: [
			{ label: 'The Kubernetes demo', href: 'start/run-it#the-kubernetes-demo-and-three-things-only-k8s-can-show' },
			{ label: 'Export a snapshot', href: 'using/export' },
		],
	},
	{
		id: 'agents',
		title: 'Working with a coding agent',
		lede: 'Hand behold to a coding agent. Every pane is plain JSON over HTTP, and each write stays with you.',
		works: [
			'`GET /api` lists every route and what it does',
			'`/api/graph` returns the graph as `{ ir, svg, meta }` with drift status on each node',
			'A failed precondition answers `{code, error, remedy}`, so an agent branches on `code`',
			'`behold preview` and `serve --public` refuse every write',
		],
		needs: ['An agent that can run commands', 'Read-only credentials in the shell that starts behold, when nothing should be applied'],
		first: {
			note: 'Hand the agent this prompt:',
			command: setupPrompt,
			lang: 'text',
			link: { label: 'Driving it from an agent', href: 'using/agents' },
		},
		task: [
			'Serve this project with `npx @intentius/behold preview .`.',
			'Fetch `GET /api` and `GET /api/graph`, then tell me what the graph holds.',
		],
		proof: ['AGENTS.md'],
		tasks: [
			{ label: 'Driving it from an agent', href: 'using/agents' },
			{ label: 'Run it in five minutes', href: 'start/run-it' },
		],
		background: [
			{ label: 'The read loop', href: 'using/agents#the-read-loop' },
			{ label: 'Read-only core, delegated writes', href: 'start/what-it-is#read-only-core-delegated-writes' },
		],
		reference: [
			{ label: 'The contract', href: 'using/agents#the-contract' },
			{ label: 'AGENTS.md', href: 'https://github.com/INTENTIUS/behold/blob/main/AGENTS.md' },
		],
	},
	{
		id: 'platform',
		title: 'Running behold for a platform team',
		lede: 'Give a platform team one graph per estate across substrates. Deploys go through the Ops and forges the team already runs.',
		works: [
			'Each substrate in the graph keeps its own meaning of deployed',
			"An environment designated to a forge deploys through that forge's workflow and your `gh`",
			'Auto-sync routes drift to the Op that owns its substrate',
			'`behold export` writes a static snapshot any host serves',
		],
		needs: ['Read roles for every substrate the estate spans', 'Write roles only where Deploy runs from behold'],
		first: {
			command: 'npx @intentius/behold serve . --env prod --poll 30',
			link: { label: 'Acting on it', href: 'using/acting' },
		},
		task: [
			'Serve this estate with `npx @intentius/behold serve . --env <env> --poll 30` and tell me the URL.',
			'List the nodes it reports as unobserved.',
			'Name the Ops it offers so I can decide on them.',
		],
		proof: ['example-flux-estate', 'example-argo-estate', 'e2e/ci-executor-github-e2e.sh'],
		tasks: [
			{ label: 'Acting on it', href: 'using/acting' },
			{ label: 'Deploying through a forge', href: 'using/acting#deploying-through-a-forge' },
			{ label: 'Export a snapshot', href: 'using/export' },
		],
		background: [
			{ label: 'The mixed estate', href: 'start/what-it-is#the-mixed-estate-is-the-point' },
			{ label: 'Auto-sync', href: 'using/acting#auto-sync' },
		],
		reference: [
			{ label: 'Reading the graph', href: 'using/reading-the-graph' },
			{ label: 'Serve a chant workspace', href: 'using/workspace' },
		],
	},
	{
		id: 'security',
		title: 'Security review',
		lede: 'Review what behold reads and where each of its writes runs.',
		works: [
			'Every view is a read and needs read roles only',
			"Each write starts a committed Op or chant's local executor, on the credentials behold was started with",
			'A terragucci or SQL Yodeler repo refuses every write behold could start',
			'One delegated write runs at a time, and auto-sync leaves every gate for a person',
			'An export cuts each absolute path down to its directory name',
		],
		needs: ['The credentials of the shell that starts behold, which set what Deploy can change'],
		first: {
			command: 'npx @intentius/behold doctor . --json',
			link: { label: 'Read-only core, delegated writes', href: 'start/what-it-is#read-only-core-delegated-writes' },
		},
		task: [
			'Run `npx @intentius/behold doctor . --json` in this project and summarise it.',
			'List the Ops this project commits so I can review which ones behold would offer.',
		],
		proof: ['AGENTS.md', 'e2e/ci-executor-github-e2e.sh'],
		tasks: [
			{ label: 'Acting on it', href: 'using/acting' },
			{ label: 'Export a snapshot', href: 'using/export#what-it-leaves-out' },
		],
		background: [
			{ label: 'Read-only core, delegated writes', href: 'start/what-it-is#read-only-core-delegated-writes' },
			{ label: 'Gates', href: 'using/acting#gates' },
		],
		reference: [
			{ label: 'The act loop', href: 'using/agents#the-act-loop-delegated-and-never-direct' },
			{ label: 'behold doctor', href: 'start/your-project#if-it-doesnt-look-right-behold-doctor' },
		],
	},
	{
		id: 'evaluate',
		title: 'Evaluating behold',
		lede: "Try the demo on a local emulator first. Then draw your own project's source graph with nothing set up.",
		works: [
			'The demo turns a bucket green on a local emulator without a cloud account',
			"`behold preview` draws any chant project's declared graph with no config",
			'More demos for Kubernetes and Terraform estates, named by `behold demo --list`',
			'`behold doctor` names what each project still needs',
		],
		needs: ['Docker for the demo', 'A chant project for `behold preview`'],
		first: {
			command: 'npx @intentius/behold demo',
			link: { label: 'Run it in five minutes', href: 'start/run-it' },
		},
		task: [
			'Start `npx @intentius/behold demo` and tell me the URL.',
			'Then run `npx @intentius/behold demo --list` and tell me which demos run on this machine.',
		],
		proof: ['example-writes', 'example-terraform-estate', 'example-argo-estate'],
		tasks: [
			{ label: 'Run it in five minutes', href: 'start/run-it' },
			{ label: 'Open your own project', href: 'start/your-project' },
		],
		background: [
			{ label: 'What behold is', href: 'start/what-it-is' },
			{ label: 'Reading the graph', href: 'using/reading-the-graph' },
		],
		reference: [
			{ label: 'Driving it from an agent', href: 'using/agents' },
			{ label: 'behold on GitHub', href: 'https://github.com/INTENTIUS/behold' },
		],
	},
];

for (const r of ROOMS) r.prompt = prompt(r.id, ...r.task);

/** Every room link, with the room it sits in, for the post-build check. */
export function roomLinks() {
	const out = [];
	for (const r of ROOMS) {
		for (const l of [r.first.link, ...r.tasks, ...r.background, ...r.reference]) out.push({ room: r.id, ...l });
	}
	return out;
}

/** A room by id; throws on one that does not exist. */
export function room(id) {
	const r = ROOMS.find((x) => x.id === id);
	if (!r) throw new Error(`docs/src/data/rooms.mjs: no room ${id}`);
	return r;
}

/** Each tile and role names a room, and each room is a tile's or a role's. Throws on the first that does not. */
export function checkRooms() {
	const named = [...TILES, ...ROLES].map((x) => x.room);
	for (const id of named) room(id);
	for (const r of ROOMS) if (!named.includes(r.id)) throw new Error(`docs/src/data/rooms.mjs: room ${r.id} is no tile's or role's`);
}
