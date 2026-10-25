// Baseline for every Worker response. Static pages get the same baseline from public/_headers,
// which Cloudflare does not apply to responses generated here.
export const HSTS = 'max-age=63072000; includeSubDomains';
// JSON, plain text and empty responses are never rendered as documents with active content.
const DATA_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function isData(headers: Headers): boolean {
  const type = headers.get('Content-Type');
  return !type || /^(application\/json|text\/plain)\b/i.test(type);
}

export function applySecurityHeaders(request: Request, response: Response): Response {
  const headers = response.headers;
  if (new URL(request.url).protocol === 'https:') headers.set('Strict-Transport-Security', HSTS);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  if (!headers.has('X-Frame-Options')) headers.set('X-Frame-Options', 'DENY');
  if (isData(headers)) {
    if (!headers.has('Content-Security-Policy'))
      headers.set('Content-Security-Policy', DATA_POLICY);
    if (!headers.has('Cross-Origin-Resource-Policy'))
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  }
  return response;
}

// RFC 9116. Renew Expires yearly; npm run verify:production fails within 30 days of it.
export const SECURITY_TXT_EXPIRES = '2027-10-24T15:00:00.000Z';
export const securityTxt = [
  'Contact: mailto:info@imakai.co.jp',
  'Contact: https://imakai.co.jp/contact',
  `Expires: ${SECURITY_TXT_EXPIRES}`,
  'Preferred-Languages: ja, en',
  'Canonical: https://justtaken.app/.well-known/security.txt',
  '',
].join('\n');

export function securityTxtRoute(request: Request): Response | undefined {
  if (!['GET', 'HEAD'].includes(request.method)) return;
  if (new URL(request.url).pathname !== '/.well-known/security.txt') return;
  return new Response(request.method === 'HEAD' ? null : securityTxt, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
