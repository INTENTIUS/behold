// Runs after `astro build` (npm run build) and fails it when a room page, the
// home page or src/data/rooms.mjs links a page or an anchor that does not
// exist, and when the sidebar's "Your starting point" group and the rooms'
// tiles and roles disagree. It checks the main column of every other built
// page too, so a docs page cannot link a page that is gone.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES, TILES, roomLinks } from '../src/data/rooms.mjs';
import { siteHref } from '../src/data/href.mjs';

const base = '/behold';
const docs = fileURLToPath(new URL('..', import.meta.url));
const dist = join(docs, 'dist');
const problems = [];

const ids = new Map();
const idsOf = (file) => {
	if (!ids.has(file)) ids.set(file, new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
	return ids.get(file);
};

/** The built file a site path is served from, or undefined. */
const target = (path) => {
	const p = join(dist, decodeURIComponent(path.slice(base.length)));
	if (existsSync(p) && statSync(p).isFile()) return p;
	if (existsSync(join(p, 'index.html'))) return join(p, 'index.html');
	return undefined;
};

/** Why a site address leads nowhere, or undefined when it resolves. `from` is the page it sits on. */
const broken = (href, from) => {
	if (/^(https?:|mailto:|data:|\/\/)/.test(href)) return undefined;
	const [path, anchor] = href.split('#');
	let file = from;
	if (path) {
		if (!path.startsWith(`${base}/`)) return `${href} is outside ${base}/`;
		file = target(path.split('?')[0]);
		if (!file) return `${href} leads nowhere`;
	}
	if (anchor && file?.endsWith('.html') && !idsOf(file).has(decodeURIComponent(anchor))) return `${href} names an anchor the page does not have`;
	return undefined;
};

if (!existsSync(dist)) {
	console.error('docs/dist is missing: run astro build first');
	process.exit(1);
}

// The links as rooms.mjs writes them.
for (const l of roomLinks()) {
	const why = broken(siteHref(base, l.href));
	if (why) problems.push(`src/data/rooms.mjs: room ${l.room} links "${l.label}": ${why}`);
}

// Every room was built.
const rooms = [...TILES, ...ROLES].map((x) => x.room);
for (const room of rooms) {
	if (!existsSync(join(dist, 'for', room, 'index.html'))) problems.push(`dist/for/${room}/: the room page was not built`);
}

// Every link in the main column of every built page, the picker included.
const walk = (dir) => readdirSync(dir).flatMap((n) => {
	const p = join(dir, n);
	return statSync(p).isDirectory() ? walk(p) : [p];
});
const pages = walk(dist).filter((f) => f.endsWith('.html') && !f.endsWith('404.html'));
for (const f of pages) {
	const page = readFileSync(f, 'utf8');
	const start = page.indexOf('<main');
	if (start === -1) {
		problems.push(`${relative(dist, f)}: no <main> to check`);
		continue;
	}
	const html = page.slice(start, page.lastIndexOf('</main>'));
	for (const [, raw] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
		const why = broken(raw.replace(/&amp;/g, '&'), f);
		if (why) problems.push(`${relative(dist, f)}: ${why}`);
	}
}

// The sidebar's "Your starting point" group, against the tiles and roles.
const config = readFileSync(join(docs, 'astro.config.mjs'), 'utf8');
const listed = [...config.matchAll(/link: '\/for\/([^/']+)\/'/g)].map((m) => m[1]);
if (listed.join(' ') !== rooms.join(' ')) {
	problems.push(`astro.config.mjs: "Your starting point" lists ${listed.join(', ')}, but rooms.mjs has ${rooms.join(', ')}`);
}

for (const p of problems) console.error(p);
if (problems.length) process.exit(1);
console.log(`rooms: ${rooms.length} rooms and ${pages.length} pages, every link resolves`);
