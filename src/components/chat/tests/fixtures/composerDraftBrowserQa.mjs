// Run from the repository root with Node 22. A fresh loopback origin isolates
// synthetic draft data from the real desktop/web app. No backend is started.
import { createServer } from 'vite';
import { createServer as portProbe } from 'node:net';

const probe = portProbe();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  publicDir: false,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': `${process.cwd()}/src` } },
  server: { host: '127.0.0.1', port, strictPort: true },
  plugins: [{
    name: 'isolated-composer-draft-fixture',
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url?.startsWith('/api/')) {
          response.setHeader('content-type', 'application/json');
          response.end(request.url.endsWith('/images') ? '{"images":[]}' : '[]');
          return;
        }
        if (request.url !== '/') { next(); return; }
        response.setHeader('content-type', 'text/html');
        response.end(await vite.transformIndexHtml('/', `<!doctype html><html><head><title>Composer draft persistence QA</title></head><body><div id="root"></div><script type="module">
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { ComposerDraftPersistenceHarness } from '/src/components/chat/tests/fixtures/ComposerDraftPersistenceHarness.tsx';
          createRoot(document.getElementById('root')).render(React.createElement(ComposerDraftPersistenceHarness));
        </script></body></html>`));
      });
    },
  }],
});
await server.listen();
server.printUrls();
const close = async () => { await server.close(); process.exit(0); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
