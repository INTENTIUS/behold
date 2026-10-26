/**
 * Written by scripts/chant-release.ts from CHANT_RELEASE (src/chant-release.ts,
 * behold#1005). Edit the switch and run the script, not this file.
 *
 * chant's drift record module, `@intentius/chant/drift-record`
 * (INTENTIUS/chant#4451), or undefined when the chant beside behold has none.
 * src/drift-line.ts decodes with it when it is here.
 */

/** What src/drift-line.ts uses of chant's module. */
export interface ChantDriftModule {
  decodeDriftLine(text: string): unknown;
  DRIFT_STATUSES: readonly string[];
}

// chant 0.124.53 is not released: the published chant behold depends on has
// no drift-record module, and a static import would fail to resolve. So it is
// looked for at run time, under a specifier the type checker and the bundler
// leave alone. A local build of chant's integration branch installed beside
// behold has it, under tsx and vitest. The bundled dist/cli.js under plain node
// does not load chant's TypeScript source from node_modules and gets
// undefined, as does a chant without the module: src/drift-line.ts then
// decodes with its own copy.
const SPECIFIER: string = "@intentius/chant/drift-record";

export const chantDriftModule: ChantDriftModule | undefined = await import(/* @vite-ignore */ SPECIFIER).then(
  (m: Partial<ChantDriftModule>) => (typeof m.decodeDriftLine === "function" && Array.isArray(m.DRIFT_STATUSES) ? (m as ChantDriftModule) : undefined),
  () => undefined,
);
