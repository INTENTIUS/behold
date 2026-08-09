// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Published at intentius.io/behold, the same shape as the chant docs.
export default defineConfig({
	site: 'https://intentius.io',
	base: '/behold',
	integrations: [
		starlight({
			title: 'behold',
			description:
				'A live control plane on chant. See your whole estate — every substrate in one graph, coloured by drift — then act through delegated, gated Ops.',
			customCss: ['./src/styles/custom.css'],
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/INTENTIUS/behold' }],
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'What behold is', slug: 'start/what-it-is' },
						{ label: 'Run it in five minutes', slug: 'start/run-it' },
						{ label: 'Open your own project', slug: 'start/your-project' },
					],
				},
				{
					label: 'Using it',
					items: [
						{ label: 'Reading the graph', slug: 'using/reading-the-graph' },
						{ label: 'Acting on it', slug: 'using/acting' },
						{ label: 'Export a snapshot', slug: 'using/export' },
						{ label: 'Driving it from an agent', slug: 'using/agents' },
					],
				},
			],
		}),
	],
});
