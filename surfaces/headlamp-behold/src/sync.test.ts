import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// The copies in src/behold are the modules behold runs in its own page. While
// this folder sits inside behold they must match web/; once it has its own
// repository the source is gone and the check has nothing to compare.
it('the copies in src/behold match behold web/ when the folder sits in behold', () => {
  for (const f of ['cut-around.js', 'neighbourhood.js', 'outside-refs.js']) {
    let source: string;
    try {
      source = readFileSync(join(__dirname, '..', '..', '..', 'web', f), 'utf8');
    } catch {
      return;
    }
    expect(readFileSync(join(__dirname, 'behold', f), 'utf8'), f).toBe(source);
  }
});
