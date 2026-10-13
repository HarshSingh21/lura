/**
 * Module resolution for the client's `node --test` unit tests.
 *
 * Node strips TypeScript types itself, but it resolves imports the way Node
 * does, not the way Metro and tsc do: it knows neither the `@/` alias nor an
 * import without its `.ts` extension. A module the app imports as
 * `import { project } from './projection'` therefore loads fine in the app and
 * fails under Node. Importing this file first registers a resolve hook that
 * fills in both, so a test can load real app modules that import each other.
 *
 * Static imports are linked before any module body runs, so a test imports
 * this statically and the modules under test dynamically, after it:
 *
 *   import '../../test/clientgeo.resolve.mts';
 *   const { translateFence } = await import('./fenceOps.ts');
 *
 * Only plain TypeScript modules resolve: React Native, Expo and anything with
 * JSX are still out of reach, which is why the logic under test lives in pure
 * modules beside the components.
 */
import { existsSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

function candidate(base: string): string | null {
  for (const p of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let base: string | null = null;
    if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
    else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
      base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
    }
    if (base) {
      const file = candidate(base);
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
