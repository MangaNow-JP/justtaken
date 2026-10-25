import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const path=fileURLToPath(new URL('../workers/api/.dev.vars',import.meta.url));
if(existsSync(path)){console.log('Existing .dev.vars preserved.');process.exit(0);}
const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const jwk=privateKey.export({format:'jwk'});
const text=`# LOCAL DEVELOPMENT ONLY. Never use these keys in production.\nRECEIPT_PRIVATE_JWK='${JSON.stringify(jwk)}'\nRECEIPT_KEY_ID=local-development-v1\nMEDIA_SECRET=${randomBytes(32).toString('base64url')}\n`;
writeFileSync(path,text,{mode:0o600,flag:'wx'});
console.log('Created local signing keys in workers/api/.dev.vars (values not printed). Add your app-specific provider IDs to enable login/attestation.');
