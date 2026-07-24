// tests/architecture/boundaries.test.ts — executable form of ARCHITECTURE.md (HEX-15).
// Walks domain/ and application/ and asserts every static import/export specifier is on that
// layer's allowlist, plus a forbidden-substring sweep over the source text.
//
// A forbidden import in domain/ or application/ fails `bun test`. This is a gate, not a lint
// suggestion — if a rule in ARCHITECTURE.md changes, change this file in the same commit.
// No new dependency: bun:test + Bun.Glob only.
import { describe, expect, test } from 'bun:test';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

// Static `import ... from '<spec>'` and `export ... from '<spec>'`, both quote styles.
// `import type` is covered because the `type` keyword sits before `from`.
const SPECIFIER_RE = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;

// Bare `import 'side-effect'` form.
const BARE_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;

// Word-boundary patterns rather than naive substrings: a naive `Response(` also matches the
// legitimate domain function `normalizeResponse(`, and `Headers` matches `ParsedGroqHeaders`.
// Every concept named in ARCHITECTURE.md §6 is still covered — as the construct, not the spelling.
const FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
    { label: 'groq-sdk', pattern: /groq-sdk/ },
    { label: '@cerebras/', pattern: /@cerebras\// },
    { label: 'zod', pattern: /from\s*['"]zod['"]/ },
    { label: 'process.env', pattern: /process\.env/ },
    { label: 'Bun.*', pattern: /\bBun\.[A-Za-z]/ },
    { label: 'Headers (WHATWG type)', pattern: /\bnew Headers\b|:\s*Headers\b|<\s*Headers\b/ },
    { label: 'Response (HTTP type)', pattern: /\bnew Response\b|:\s*Response\b|<\s*Response\b/ },
    { label: 'Request (HTTP type)', pattern: /\bnew Request\b|:\s*Request\b|<\s*Request\b/ },
    { label: 'FormData', pattern: /\bnew FormData\b|:\s*FormData\b/ },
];

async function collect(pattern: string): Promise<string[]> {
    const glob = new Bun.Glob(pattern);
    const found: string[] = [];
    for await (const file of glob.scan({ cwd: REPO_ROOT })) {
        found.push(file);
    }
    return found.sort();
}

function specifiersOf(source: string): string[] {
    const specs = new Set<string>();
    for (const match of source.matchAll(SPECIFIER_RE)) {
        if (match[1]) specs.add(match[1]);
    }
    for (const match of source.matchAll(BARE_IMPORT_RE)) {
        if (match[1]) specs.add(match[1]);
    }
    return [...specs];
}

/** Resolve a relative specifier against the importing file's directory, repo-root-relative. */
function resolveSpecifier(fromFile: string, spec: string): string {
    const dir = fromFile.split('/').slice(0, -1);
    const parts = spec.split('/');
    const stack = [...dir];
    for (const part of parts) {
        if (part === '.' || part === '') continue;
        if (part === '..') stack.pop();
        else stack.push(part);
    }
    return stack.join('/');
}

describe('architecture boundaries', () => {
    test('domain/ imports only other domain/ modules', async () => {
        const files = await collect('domain/**/*.ts');
        // A directory rename must not silently disable this guard.
        expect(files.length).toBeGreaterThan(0);

        const violations: string[] = [];

        for (const file of files) {
            const source = await Bun.file(`${REPO_ROOT}${file}`).text();
            for (const spec of specifiersOf(source)) {
                if (!spec.startsWith('./') && !spec.startsWith('../')) {
                    violations.push(`${file}: bare specifier '${spec}'`);
                    continue;
                }
                const resolved = resolveSpecifier(file, spec);
                if (!resolved.startsWith('domain/')) {
                    violations.push(`${file}: '${spec}' resolves outside domain/ (${resolved})`);
                }
            }
        }

        expect(violations).toEqual([]);
    });

    test('application/ imports only application/ and domain/ modules', async () => {
        const files = await collect('application/**/*.ts');
        expect(files.length).toBeGreaterThan(0);

        const violations: string[] = [];

        for (const file of files) {
            const source = await Bun.file(`${REPO_ROOT}${file}`).text();
            for (const spec of specifiersOf(source)) {
                if (!spec.startsWith('./') && !spec.startsWith('../')) {
                    violations.push(`${file}: bare specifier '${spec}'`);
                    continue;
                }
                const resolved = resolveSpecifier(file, spec);
                if (!resolved.startsWith('application/') && !resolved.startsWith('domain/')) {
                    violations.push(`${file}: '${spec}' resolves outside application/ and domain/ (${resolved})`);
                }
            }
        }

        expect(violations).toEqual([]);
    });

    test('domain/ and application/ contain no forbidden vendor or transport tokens', async () => {
        const files = [...await collect('domain/**/*.ts'), ...await collect('application/**/*.ts')];
        expect(files.length).toBeGreaterThan(0);

        const violations: string[] = [];

        for (const file of files) {
            const source = await Bun.file(`${REPO_ROOT}${file}`).text();
            for (const { label, pattern } of FORBIDDEN_PATTERNS) {
                if (pattern.test(source)) {
                    violations.push(`${file}: forbidden token '${label}'`);
                }
            }
        }

        expect(violations).toEqual([]);
    });

    // Plan 08-03: use cases are orchestration, not delivery. They must not name an HTTP type,
    // emit SSE framing, or reach an adapter — presenters own every byte of wire format.
    test('application/use-cases/ contains no delivery-layer constructs', async () => {
        const files = await collect('application/use-cases/**/*.ts');
        expect(files.length).toBeGreaterThan(0);

        const forbidden: Array<{ label: string; pattern: RegExp }> = [
            { label: 'Response (HTTP type)', pattern: /\bnew Response\b|:\s*Response\b|<\s*Response\b/ },
            { label: 'Request (HTTP type)', pattern: /\bnew Request\b|:\s*Request\b|<\s*Request\b/ },
            { label: 'Headers (WHATWG type)', pattern: /\bnew Headers\b|:\s*Headers\b|<\s*Headers\b/ },
            { label: 'text/event-stream', pattern: /text\/event-stream/ },
            { label: 'SSE data frame', pattern: /["'`]data: / },
            { label: '[DONE] sentinel', pattern: /\[DONE\]/ },
            { label: 'Bun.serve', pattern: /Bun\.serve/ },
            { label: 'zod', pattern: /from\s*['"]zod['"]/ },
            { label: 'groq-sdk', pattern: /groq-sdk/ },
            { label: '@cerebras/', pattern: /@cerebras\// },
            { label: 'process.env', pattern: /process\.env/ },
            { label: 'adapters import', pattern: /from\s*['"][^'"]*adapters\// },
            { label: 'config import', pattern: /from\s*['"][^'"]*\/config['"]/ },
        ];

        const violations: string[] = [];

        for (const file of files) {
            const source = await Bun.file(`${REPO_ROOT}${file}`).text();
            for (const { label, pattern } of forbidden) {
                if (pattern.test(source)) {
                    violations.push(`${file}: forbidden construct '${label}'`);
                }
            }
        }

        expect(violations).toEqual([]);
    });

    // Plan 08-04 (HEX-13): config.ts is the single ingress for process.env. The one documented
    // exception is routes/health.ts reading BUILD_VERSION, which is a build stamp, not config.
    test('no stray process.env reads outside config.ts', async () => {
        const files = [
            ...await collect('domain/**/*.ts'),
            ...await collect('application/**/*.ts'),
            ...await collect('adapters/**/*.ts'),
            ...await collect('composition/**/*.ts'),
        ];
        expect(files.length).toBeGreaterThan(0);

        const ALLOWED = new Set(['adapters/inbound/http/routes/health.ts']);
        const violations: string[] = [];

        for (const file of files) {
            if (ALLOWED.has(file)) continue;
            const source = await Bun.file(`${REPO_ROOT}${file}`).text();
            if (/process\.env/.test(source)) {
                violations.push(`${file}: reads process.env (only config.ts may)`);
            }
        }

        expect(violations).toEqual([]);
    });

    // Plan 08-04 (HEX-13): importing a layer module must construct nothing. Wiring happens only
    // inside a function body — i.e. on an indented line, never at column 0.
    test('no import-time construction in domain/, application/, or adapters/', async () => {
        const files = [
            ...await collect('domain/**/*.ts'),
            ...await collect('application/**/*.ts'),
            ...await collect('adapters/**/*.ts'),
        ];
        expect(files.length).toBeGreaterThan(0);

        const CONSTRUCTS = [
            'new Cerebras(',
            'new Groq(',
            'new HttpWhisperService(',
            'JSON.parse(',
            'createProviderStateStore(',
        ];
        const violations: string[] = [];

        for (const file of files) {
            const source = await Bun.file(`${REPO_ROOT}${file}`).text();
            const lines = source.split('\n');
            for (const [i, line] of lines.entries()) {
                // Top-level statement = first character is not whitespace.
                if (/^\s/.test(line) || line.length === 0) continue;
                for (const construct of CONSTRUCTS) {
                    if (!line.includes(construct)) continue;
                    // A declaration is not a call: `export function createProviderStateStore(...)`
                    // defines the factory, it does not invoke it at import time.
                    if (line.includes(`function ${construct}`)) continue;
                    violations.push(`${file}:${i + 1}: top-level '${construct}'`);
                }
            }
        }

        expect(violations).toEqual([]);
    });

    // Plan 08-04 (HEX-13): the compatibility shims are gone and must not come back. A production
    // module whose entire body is re-export lines is a shim. index.ts is the documented exception —
    // its `export { createServer }` is the public entry point.
    test('no compatibility shims in the production tree', async () => {
        const files = [
            ...await collect('domain/**/*.ts'),
            ...await collect('application/**/*.ts'),
            ...await collect('adapters/**/*.ts'),
            ...await collect('composition/**/*.ts'),
        ];
        expect(files.length).toBeGreaterThan(0);

        const violations: string[] = [];

        for (const file of files) {
            const source = await Bun.file(`${REPO_ROOT}${file}`).text();
            const code = source
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
            if (code.length === 0) continue;
            const allReExports = code.every((l) => /^export\s+(\*|type\s*\{|\{)/.test(l) && / from ['"]/.test(l));
            if (allReExports) {
                violations.push(`${file}: is a pure re-export shim`);
            }
        }

        expect(violations).toEqual([]);
    });

    test('adapters/ and config are never reachable from the inner layers', async () => {
        const files = [...await collect('domain/**/*.ts'), ...await collect('application/**/*.ts')];
        expect(files.length).toBeGreaterThan(0);

        const violations: string[] = [];

        for (const file of files) {
            const source = await Bun.file(`${REPO_ROOT}${file}`).text();
            for (const spec of specifiersOf(source)) {
                const resolved = resolveSpecifier(file, spec);
                if (resolved.startsWith('adapters/') || spec.includes('adapters/')) {
                    violations.push(`${file}: reaches an adapter via '${spec}'`);
                }
                if (resolved === 'config' || spec.endsWith('/config') || spec === './config') {
                    violations.push(`${file}: imports config via '${spec}'`);
                }
            }
            // domain/ additionally may not reach application/
            if (file.startsWith('domain/')) {
                for (const spec of specifiersOf(source)) {
                    if (spec.includes('application/')) {
                        violations.push(`${file}: domain reaches application via '${spec}'`);
                    }
                }
            }
        }

        expect(violations).toEqual([]);
    });
});
