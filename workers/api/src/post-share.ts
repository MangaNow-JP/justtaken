export function postSharePage(request: Request, appReturnUrl?: string): Response | undefined {
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const match = /^\/public\/posts\/([A-Za-z0-9_-]{1,128})$/.exec(new URL(request.url).pathname);
  if (!match) return;
  // Any well-formed ID gets the same shell. The app checks access before showing any post data.
  const scheme = appReturnUrl === 'justtaken-dev://auth' ? 'justtaken-dev' : 'justtaken';
  const english = /^en\b/i.test(request.headers.get('Accept-Language') ?? '');
  const title = english ? 'Shared post' : 'シェアされた投稿';
  const description = english
    ? 'Open the link on a phone with JustTaken installed and sign in to view the post.'
    : 'JustTakenをインストールしたスマートフォンでこのリンクを開き、ログインして投稿をご覧ください。';
  const html = `<!doctype html><html lang="${english ? 'en' : 'ja'}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | JustTaken</title><link rel="stylesheet" href="/assets/site.css?v=11">
<link rel="stylesheet" href="/assets/legal.css?v=3"></head>
<body class="legal-page"><main class="legal-shell"><div class="legal-heading">
<p><a href="/">JustTaken</a></p><h1>${title}</h1><p>${description}</p>
<p><a href="${scheme}://post/${match[1]}">${english ? 'Open in JustTaken' : 'JustTakenで開く'}</a></p>
</div></main></body></html>`;
  return new Response(request.method === 'HEAD' ? null : html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Robots-Tag': 'noindex, nofollow',
      Vary: 'Accept-Language',
    },
  });
}
