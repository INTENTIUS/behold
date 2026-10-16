// The paths each room's Proof lists: example projects and end-to-end scripts
// in this repository, read at build time. A path that does not exist fails
// the build, so a room only lists what is there. Nothing here is a count.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// `astro build` runs in docs/, so the repository root is its parent.
const root = resolve(process.cwd(), '..');
if (!existsSync(join(root, 'demos.json'))) throw new Error(`docs/src/data/proof.mjs: expected the behold repository at ${root}`);

export const repoTree = 'https://github.com/INTENTIUS/behold/tree/main';

/** A room's proof paths, each checked to exist, as { path, href }. */
export function roomProof(room) {
	return room.proof.map((path) => {
		if (!existsSync(join(root, path))) {
			throw new Error(`docs/src/data/rooms.mjs: room ${room.id} names ${path}, which is not in the repository`);
		}
		return { path, href: `${repoTree}/${path}` };
	});
}
