// The copies in src/behold are behold's own cut, document type and Mermaid
// writer. While this folder sits inside behold they must match; once it has
// its own repository the source is gone and there is nothing to compare.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

it('the copies in src/behold match behold when the folder sits in behold', () => {
  const check = () =>
    execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'sync-behold.mjs'), '--check'], { stdio: 'pipe' });
  expect(check).not.toThrow();
});
