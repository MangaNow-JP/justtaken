import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
execFileSync(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'deploy','--config',resolve(root,'workers/api/test/wrangler.fixture.jsonc'),'--dry-run','--outdir',resolve(root,'artifacts/test-worker')],{cwd:root,stdio:'inherit'});
execFileSync(process.execPath,['--import','tsx','workers/api/test/integration.ts'],{cwd:root,stdio:'inherit'});
