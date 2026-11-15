import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundle } from '../scripts/build.mjs';

// Argo CD 3.5 moved to React 19 and exposes the JSX runtime as
// window.ReactJSXRuntime. A bundle that carries its own copy fails to load with
// a TypeError, so the build must leave react and react/jsx-runtime to the host.
describe('the built extension', () => {
  it('takes react and the jsx runtime from the host and bundles neither', async () => {
    const file = await bundle();
    const js = readFileSync(file, 'utf8');
    expect(file).toBe(join(__dirname, '..', 'dist', 'resources', 'extension-behold.js', 'extension-behold.js'));
    expect(js).toContain('window.React');
    expect(js).toContain('window.ReactJSXRuntime');
    expect(js).not.toContain('__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED');
    expect(js).not.toContain('react.element');
    expect(js).toContain('registerResourceExtension');
  });
});
