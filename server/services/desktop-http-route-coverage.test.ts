import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

type HandlerKind = 'wrapped' | 'raw-async' | 'raw-sync' | 'unresolved';
type Registration = { file: string; line: number; method: string; route: string; handler: string; kind: HandlerKind };
const routeMethods = new Set(['all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const wrapperSources = new Set(['@/shared/utils.js', '../shared/utils.js', './shared/utils.js']);

function productionRouteFiles(): string[] {
  const server = fileURLToPath(new URL('../', import.meta.url));
  const routes = readdirSync(path.join(server, 'routes'))
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
    .map((name) => path.join(server, 'routes', name));
  for (const module of readdirSync(path.join(server, 'modules'), { withFileTypes: true })) {
    if (!module.isDirectory()) continue;
    const directory = path.join(server, 'modules', module.name);
    routes.push(...readdirSync(directory).filter((name) => /routes\.(?:ts|js)$/u.test(name)).map((name) => path.join(directory, name)));
  }
  return [...routes, path.join(server, 'voice-proxy.js'), path.join(server, 'index.js')].sort();
}

// Inspect direct HTTP registration arguments, including local named handlers,
// aliases and handler arrays. Import bodies, dynamic registration, middleware
// and work detached from a handler's returned Promise are NOT proven covered.
function registrations(sources: Map<string, string>): Registration[] {
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (filename, languageVersion) => {
    const text = sources.get(filename);
    return text === undefined ? undefined : ts.createSourceFile(filename, text, languageVersion, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  const found: Registration[] = [];

  function resolveLocal(node: ts.Node, seen = new Set<ts.Node>()): ts.Node {
    if (seen.has(node)) return node;
    seen.add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return resolveLocal(node.expression, seen);
    }
    if (ts.isIdentifier(node)) {
      const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
      for (const declaration of declarations) {
        if (ts.isFunctionDeclaration(declaration)) return declaration;
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) return resolveLocal(declaration.initializer, seen);
      }
    }
    return node;
  }

  function isSharedWrapper(node: ts.Node): boolean {
    if (!ts.isCallExpression(node)) return false;
    const callee = resolveLocal(node.expression);
    if (!ts.isIdentifier(callee)) return false;
    return (checker.getSymbolAtLocation(callee)?.declarations ?? []).some((declaration) => {
      if (!ts.isImportSpecifier(declaration) || (declaration.propertyName ?? declaration.name).text !== 'asyncHandler') return false;
      const imported = declaration.parent.parent.parent;
      return ts.isImportDeclaration(imported) && ts.isStringLiteral(imported.moduleSpecifier)
        && wrapperSources.has(imported.moduleSpecifier.text);
    });
  }

  for (const file of program.getSourceFiles()) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && routeMethods.has(node.expression.name.text) && node.arguments.length >= 2) {
        const method = node.expression.name.text;
        const route = node.arguments[0];
        if (ts.isStringLiteralLike(route) || ts.isTemplateExpression(route)) {
          const record = (argument: ts.Expression): void => {
            const resolved = resolveLocal(argument);
            if (ts.isArrayLiteralExpression(resolved)) {
              for (const element of resolved.elements) record(element);
              return;
            }
            const callback = ts.isArrowFunction(resolved) || ts.isFunctionExpression(resolved) || ts.isFunctionDeclaration(resolved);
            const kind: HandlerKind = isSharedWrapper(resolved) ? 'wrapped'
              : callback ? resolved.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? 'raw-async' : 'raw-sync'
                : 'unresolved';
            found.push({
              file: file.fileName,
              line: file.getLineAndCharacterOfPosition(argument.getStart(file)).line + 1,
              method,
              route: ts.isStringLiteralLike(route) ? route.text : route.getText(file),
              handler: ts.isIdentifier(argument) ? argument.text : '<inline>',
              kind,
            });
          };
          for (const argument of node.arguments.slice(1)) record(argument);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

test('source scanner catches direct, named and aliased async HTTP handlers, including GET', () => {
  const found = registrations(new Map([['fixture.ts', `
    import { asyncHandler as wrap } from '@/shared/utils.js';
    import { authenticateToken } from './auth.js';
    async function named(req, res) { await work(); }
    const alias = named;
    const wrapped = wrap(named);
    router.get('/get', async (req, res) => { await work(); });
    app.post('/named', named);
    router.patch('/alias', alias);
    router.put('/array', [authenticateToken, async function callback(req, res) {}]);
    router.delete('/wrapped', wrap(alias));
    router.options('/wrapped-variable', wrapped);
    router.head('/sync', (req, res) => res.end());
    router.all('/dynamic', makeHandler());
    async function notARoute() { await work(); }
  `]]));
  assert.deepEqual(found.map(({ route, kind }) => [route, kind]), [
    ['/get', 'raw-async'], ['/named', 'raw-async'], ['/alias', 'raw-async'],
    ['/array', 'unresolved'], ['/array', 'raw-async'], ['/wrapped', 'wrapped'],
    ['/wrapped-variable', 'wrapped'], ['/sync', 'raw-sync'], ['/dynamic', 'unresolved'],
  ]);
});

test('source scanner respects lexical shadowing and only trusts the shared wrapper import', () => {
  const found = registrations(new Map([['fixture.ts', `
    import { asyncHandler } from '@/shared/utils.js';
    const named = async (req, res) => {};
    function register() {
      const named = (req, res) => res.end();
      router.post('/inner', named);
    }
    function impostor(asyncHandler) {
      router.post('/impostor', asyncHandler(named));
    }
    router.post('/outer', named);
    router.post('/wrapped', asyncHandler(named));
  `]]));
  assert.deepEqual(found.map(({ route, kind }) => [route, kind]), [
    ['/inner', 'raw-sync'], ['/impostor', 'unresolved'], ['/outer', 'raw-async'], ['/wrapped', 'wrapped'],
  ]);
});

test('production direct HTTP handlers use shared asyncHandler; bootstrap and authentication gaps stay explicit', (t) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const files = productionRouteFiles();
  const found = registrations(new Map(files.map((file) => [file, readFileSync(file, 'utf8')])));
  const relative = (file: string): string => path.relative(root, file).split(path.sep).join('/');
  assert.deepEqual([...new Set(found.map(({ file }) => file))].sort(), files, 'Every scoped route file must actually be inspected.');
  assert.deepEqual(found.filter(({ kind }) => kind === 'raw-async'), [], 'Raw async registration bypasses the desktop admission lease.');

  // Only parent-owned bootstrap/static registrations remain raw. This is an
  // inspection allowlist, not permission to restart: sendFile still needs a
  // lifetime owner and middleware still needs its own admission coverage.
  const knownRawRoutes = new Set([
    'server/index.js get /health',
    'server/index.js get *',
  ]);
  // authenticateToken may create the implicit owner before the inner route
  // lease. Its outer /api admission fence is verified by separate integration
  // tests; this direct-argument scanner cannot establish middleware ownership.
  const knownImportedMiddleware = new Set([
    'server/routes/auth.js get /user authenticateToken',
    'server/routes/user.js get /git-config authenticateToken',
    'server/routes/user.js post /git-config authenticateToken',
    'server/index.js get /api/browse-filesystem authenticateToken',
    'server/index.js post /api/create-folder authenticateToken',
    'server/index.js get /api/projects/:projectId/file authenticateToken',
    'server/index.js get /api/projects/:projectId/files/content authenticateToken',
    'server/index.js put /api/projects/:projectId/file authenticateToken',
    'server/index.js get /api/projects/:projectId/files authenticateToken',
    'server/index.js post /api/projects/:projectId/files/create authenticateToken',
    'server/index.js put /api/projects/:projectId/files/rename authenticateToken',
    'server/index.js delete /api/projects/:projectId/files authenticateToken',
    'server/index.js post /api/projects/:projectId/files/upload authenticateToken',
    'server/index.js get /api/projects/:projectId/sessions/:sessionId/token-usage authenticateToken',
  ]);
  for (const item of found) {
    const key = `${relative(item.file)} ${item.method} ${item.route}`;
    if (item.kind === 'raw-sync') assert.ok(knownRawRoutes.has(key), `Unreviewed raw registration: ${key}:${item.line}`);
    if (item.kind === 'unresolved') assert.ok(knownImportedMiddleware.has(`${key} ${item.handler}`), `Unresolved registration: ${key}:${item.line} ${item.handler}`);
  }
  t.diagnostic(`${found.filter(({ kind }) => kind === 'wrapped').length} wrapped registration arguments; ${found.filter(({ kind }) => kind === 'raw-sync').length} raw synchronous/callback registrations; ${found.filter(({ kind }) => kind === 'unresolved').length} imported middleware arguments.`);
  t.diagnostic('Wrapper presence does not prove stream, multer callback, spawned process, background job, or service-side producer completion.');
});
