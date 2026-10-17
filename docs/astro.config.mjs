// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const SHARE_IMAGE = 'https://intentius.io/behold/brand/share.png';
const SHARE_ALT = 'The pixel behold logo above the word BEHOLD and the line: a live infrastructure loop you can watch.';

// Published at intentius.io/behold, the same shape as the chant docs.
export default defineConfig({
	site: 'https://intentius.io',
	base: '/behold',
	// Starlight merges the docs schema into a room page's front matter
	// (pages/for/[id].astro), which needs zod 4's safeExtend. Left external,
	// the prerender's `zod/v4` resolves to the zod 3 the lockfile hoists to
	// node_modules/zod; bundled, it is astro's own zod 4.
	vite: { environments: { prerender: { resolve: { noExternal: [/^zod(\/|$)/] } } } },
	integrations: [
		starlight({
			title: 'behold',
			description:
				'A live control plane on chant. See your whole estate, every substrate in one graph coloured by drift, then act through delegated, gated Ops.',
			// The pixel face with glasses and its lens (scripts/brand/), Geist, and
			// the app's Catppuccin palette as tokens for both themes.
			customCss: ['./src/styles/custom.css'],
			// The title gets "Copy page as Markdown", the llms.txt pointer and the
			// page's agent prompt. The site title and footer carry the logo, the
			// header a Docs link, and the theme starts dark.
			components: {
				PageTitle: './src/components/PageTitle.astro',
				Footer: './src/components/Footer.astro',
				SocialIcons: './src/components/SocialIcons.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				ThemeProvider: './src/components/ThemeProvider.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
			},
			// public/favicon.svg is the logo, drawn by scripts/brand/logo.py; the
			// PNG is the fallback for browsers without SVG favicons.
			favicon: '/favicon.svg',
			// behold#571: link previews (LinkedIn, Slack, X) show the share image,
			// public/brand/share.png, drawn by scripts/brand/share.mjs. The crawlers
			// ignore a relative og:image, so it is absolute.
			head: [
				{ tag: 'link', attrs: { rel: 'icon', href: '/behold/favicon-48.png', sizes: '48x48', type: 'image/png' } },
				{ tag: 'meta', attrs: { property: 'og:image', content: SHARE_IMAGE } },
				{ tag: 'meta', attrs: { property: 'og:image:type', content: 'image/png' } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: SHARE_ALT } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: SHARE_IMAGE } },
				{ tag: 'meta', attrs: { name: 'twitter:image:alt', content: SHARE_ALT } },
			],
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/INTENTIUS/behold' }],
			// Every group starts collapsed; Starlight opens the one holding the
			// current page. "Your starting point" lists the room pages under /for/
			// in the order of src/data/rooms.mjs's tiles and roles
			// (scripts/check-rooms.mjs holds the two together).
			sidebar: [
				{
					label: 'Start here',
					collapsed: true,
					items: [
						{ label: 'What behold is', slug: 'start/what-it-is' },
						{ label: 'Run it in five minutes', slug: 'start/run-it' },
						{ label: 'Open your own project', slug: 'start/your-project' },
					],
				},
				{
					label: 'Your starting point',
					collapsed: true,
					items: [
						{ label: 'A chant workspace', link: '/for/workspace/' },
						{ label: 'Terraform', link: '/for/terraform/' },
						{ label: 'terragucci', link: '/for/terragucci/' },
						{ label: 'SQL Yodeler', link: '/for/sql-yodeler/' },
						{ label: 'choudoufu', link: '/for/choudoufu/' },
						{ label: 'A carve-out', link: '/for/carve/' },
						{ label: 'No project yet', link: '/for/demo/' },
						{ label: 'With a coding agent', link: '/for/agents/' },
						{ label: 'Platform teams', link: '/for/platform/' },
						{ label: 'Security review', link: '/for/security/' },
						{ label: 'Evaluating behold', link: '/for/evaluate/' },
					],
				},
				{
					label: 'Using it',
					collapsed: true,
					items: [
						{ label: 'Reading the graph', slug: 'using/reading-the-graph' },
						{ label: 'Acting on it', slug: 'using/acting' },
						{ label: 'Approving a gate', slug: 'using/approving' },
						{ label: 'The trunk lane', slug: 'using/trunk' },
						{ label: 'Export a snapshot', slug: 'using/export' },
						{ label: 'Driving it from an agent', slug: 'using/agents' },
					],
				},
				{
					label: 'Look at',
					collapsed: true,
					items: [
						{ label: 'Serve a chant workspace', slug: 'using/workspace' },
						{ label: 'Look at a Terraform estate', slug: 'using/terraform' },
						{ label: 'Look at a terragucci estate', slug: 'using/terragucci' },
						{ label: 'Look at a SQL Yodeler project', slug: 'using/sql-yodeler' },
						{ label: 'Look at a choudoufu estate', slug: 'using/choudoufu' },
						{ label: 'Look at a Terraform carve-out', slug: 'using/carve' },
					],
				},
			],
		}),
	],
});
