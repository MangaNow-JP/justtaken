// Local test server only; reuses the synthetic proof and its ephemeral public key.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { verifierRoutes } from '../workers/api/src/verifier';
createServer(async (request, response) => {
  const path = new URL(request.url!, 'http://localhost:8799').pathname;
  const result =
    path === '/.well-known/capture-jwks.json'
      ? new Response(await readFile('artifacts/proof-ui/trusted-test-jwks.json'), {
          headers: { 'Content-Type': 'application/json' },
        })
      : verifierRoutes(new Request('http://localhost:8799' + path, { method: request.method }));
  console.log(request.method, path);
  response.writeHead(result?.status ?? 404, result ? Object.fromEntries(result.headers) : {});
  response.end(result ? Buffer.from(await result.arrayBuffer()) : 'Not found');
}).listen(8799, '127.0.0.1', () =>
  console.log('Synthetic external-proof UI fixture: http://localhost:8799/verify'),
);
