// The read-next table on the home page (components/LinkRows.astro), kept out
// of index.mdx so its prose stays prose. Each href is a path under the site's
// base.

export const NEXT = [
	{ label: 'Start', links: [
		{ label: 'What behold is', href: '/start/what-it-is/' },
		{ label: 'Run it in five minutes', href: '/start/run-it/' },
		{ label: 'Open your own project', href: '/start/your-project/' },
	] },
	{ label: 'Read it', links: [
		{ label: 'Reading the graph', href: '/using/reading-the-graph/' },
		{ label: 'Acting on it', href: '/using/acting/' },
		{ label: 'Export a snapshot', href: '/using/export/' },
	] },
	{ label: 'Point it at', links: [
		{ label: 'A chant workspace', href: '/using/workspace/' },
		{ label: 'Terraform', href: '/using/terraform/' },
		{ label: 'terragucci', href: '/using/terragucci/' },
		{ label: 'SQL Yodeler', href: '/using/sql-yodeler/' },
		{ label: 'choudoufu', href: '/using/choudoufu/' },
		{ label: 'A carve-out', href: '/using/carve/' },
	] },
	{ label: 'Agents', links: [
		{ label: 'Driving it from an agent', href: '/using/agents/' },
		{ label: 'llms.txt', href: '/llms.txt' },
	] },
];
