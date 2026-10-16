// A room as Markdown, the same sections as components/Room.astro in the same
// order, for "Copy page as Markdown" and llms-full.txt.
import { roomProof } from './proof.mjs';
import { siteHref } from './href.mjs';

export function roomMarkdown(r, site) {
	const link = (l) => `[${l.label}](${siteHref(site, l.href)})`;
	const out = [r.lede, '', '## Works', '', ...r.works.map((w) => `- ${w}`), '', '## Needs', '', ...r.needs.map((n) => `- ${n}`), '', '## First step', ''];
	if (r.first.note) out.push(r.first.note, '');
	out.push('```' + (r.first.lang ?? 'sh'), r.first.command, '```', '');
	out.push(`Next: ${link(r.first.link)}.`, '', '## Proof', '');
	for (const e of roomProof(r)) out.push(`- [${e.path}](${e.href})`);
	out.push('', '## Then read', '');
	for (const [label, links] of [['Tasks', r.tasks], ['Background', r.background], ['Reference', r.reference]]) {
		if (links.length) out.push(`### ${label}`, '', ...links.map((l) => `- ${link(l)}`), '');
	}
	return out.join('\n');
}
