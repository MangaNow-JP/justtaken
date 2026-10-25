import { capturePolicy } from '@justtaken/contracts/policy';
import { bodyJSON, fail, json, requireValue, rpc, unwrap, validID } from './http';
import { integrityConfigured } from './proof';
import { stage, uploadPart } from './media';
import { postRoutes } from './posts';
import { proofRoutes, publicProofRoutes } from './proofs';
import { publicProofKeys } from './proof-keys';
import { verifierRoutes } from './verifier';
import { anchorsEnabled, retryAnchors } from './anchors';
import { earlyAccessRoutes, purgeExpiredEarlyAccess } from './early-access';
import type { Bindings, Principal, Profile } from './types';
function splitToken(value: unknown) {
  if (typeof value !== 'string' || !/^[-A-Za-z0-9_]{36}\.[-A-Za-z0-9_]{43}$/.test(value))
    fail(401, 'INVALID_TOKEN', 'ログインが必要です。');
  return (value as string).split('.');
}
async function authenticate(request: Request, env: Bindings): Promise<Principal> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer '))
    fail(401, 'AUTHENTICATION_REQUIRED', 'ログインが必要です。');
  const [id, secret] = splitToken(authorization!.slice(7));
  requireValue(env.AUTH && env.HOME);
  const principal = unwrap(await env.AUTH.getByName(id).authenticate(secret, id));
  const p = await env.HOME.prepare('SELECT status,session_epoch FROM profiles WHERE user_id=?')
    .bind(principal.userId)
    .first<Profile>();
  if (!p || p.status !== 'ACTIVE' || p.session_epoch !== principal.epoch)
    fail(401, 'SESSION_REVOKED', '再ログインが必要です。');
  return principal;
}
export async function route(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (path === '/.well-known/capture-jwks.json' && method === 'GET') {
    return json(publicProofKeys(env));
  }
  const verifier = verifierRoutes(request);
  if (verifier) return verifier;
  const earlyAccess = await earlyAccessRoutes(request, env);
  if (earlyAccess) return earlyAccess;
  const sharedProof = await publicProofRoutes(request, env);
  if (sharedProof) return sharedProof;
  const auth = {
    apple: !!env.APPLE_AUDIENCE,
    google: !!(
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.API_ORIGIN &&
      env.APP_RETURN_URL
    ),
  };
  const verification = !!(
    env.RECEIPT_PRIVATE_JWK &&
    env.RECEIPT_KEY_ID &&
    env.MEDIA_SECRET &&
    (integrityConfigured(env, 'ios') || integrityConfigured(env, 'android'))
  );
  if (path === '/health' && method === 'GET')
    return json({
      service: 'JustTaken',
      version: '0.2.0',
      status: 'ok',
      capabilities: {
        authentication: auth.apple || auth.google,
        captureVerification: verification,
        publication: verification,
        externalAnchoring: anchorsEnabled(env),
      },
      providers: auth,
    });
  if (path === '/v1/policy' && method === 'GET')
    return json({
      capture: capturePolicy,
      accountDefault: 'private',
      captureEnabled: verification,
      providers: auth,
      videoEnabled: true,
    });
  if (path === '/v1/auth/challenge' && method === 'POST') {
    const data = await bodyJSON(request, 4096);
    if (!['apple', 'google'].includes(data.provider))
      fail(400, 'INVALID_PROVIDER', 'ログイン方法を選んでください。');
    const id = crypto.randomUUID();
    return json(
      unwrap(await env.AUTH.getByName(id).create(id, data.provider, data.codeChallenge)),
      201,
    );
  }
  if (path === '/v1/auth/google/callback' && method === 'GET') {
    const id = url.searchParams.get('state'),
      code = url.searchParams.get('code');
    if (!validID(id) || !code || code.length > 4096)
      fail(
        400,
        'LOGIN_CANCELLED',
        'ログインを完了できませんでした。アプリに戻ってお試しください。',
      );
    const result = unwrap(await env.AUTH.getByName(id!).googleCallback(code!));
    requireValue(env.APP_RETURN_URL);
    const destination = new URL(env.APP_RETURN_URL!);
    destination.search = new URLSearchParams({ challengeId: id!, code: result.code }).toString();
    return new Response(null, {
      status: 303,
      headers: {
        Location: destination.href,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }
  if (path === '/v1/auth/exchange' && method === 'POST') {
    const data = await bodyJSON(request);
    if (!validID(data.challengeId))
      fail(400, 'INVALID_CHALLENGE', 'ログインをやり直してください。');
    const obj = env.AUTH.getByName(data.challengeId);
    if (data.provider === 'apple' && typeof data.idToken === 'string')
      return json(unwrap(await obj.exchangeApple(data.idToken)));
    if (
      data.provider === 'google' &&
      typeof data.code === 'string' &&
      typeof data.verifier === 'string' &&
      data.verifier.length >= 43 &&
      data.verifier.length <= 128
    )
      return json(unwrap(await obj.exchangeGoogle(data.code, data.verifier)));
    fail(400, 'INVALID_LOGIN', 'ログイン情報を確認してください。');
  }
  if (path === '/v1/auth/refresh' && method === 'POST') {
    const data = await bodyJSON(request, 4096);
    const [id, secret] = splitToken(data.refreshToken);
    return json(unwrap(await env.AUTH.getByName(id).refresh(secret, id)));
  }
  if (!path.startsWith('/v1/')) fail(404, 'NOT_FOUND', 'APIが見つかりません。');
  const principal = await authenticate(request, env);
  if (path === '/v1/me' && method === 'GET') {
    const profile = await env.HOME.prepare(
      'SELECT user_id,display_name,is_private FROM profiles WHERE user_id=?',
    )
      .bind(principal.userId)
      .first<Profile>();
    const quota = await env.HOME.prepare(
      'SELECT limit_bytes,used_bytes,reserved_bytes FROM quota_accounts WHERE user_id=?',
    )
      .bind(principal.userId)
      .first();
    return json({
      profile: {
        userId: profile!.user_id,
        displayName: profile!.display_name,
        isPrivate: !!profile!.is_private,
      },
      quota,
    });
  }
  if (['/v1/auth/logout', '/v1/auth/logout-all'].includes(path) && method === 'POST') {
    if (path.endsWith('logout-all'))
      await env.HOME.prepare('UPDATE profiles SET session_epoch=session_epoch+1 WHERE user_id=?')
        .bind(principal.userId)
        .run();
    return json(unwrap(await env.AUTH.getByName(principal.sessionId).revoke()));
  }
  if (path === '/v1/installations' && method === 'POST') {
    const data = await bodyJSON(request, 4096);
    if (!['ios', 'android'].includes(data.platform))
      fail(400, 'UNSUPPORTED_PLATFORM', 'iOSまたはAndroidアプリでご利用ください。');
    const id = crypto.randomUUID();
    return json(
      unwrap(await env.CAPTURE.getByName(id).create(id, principal.userId, data.platform)),
      201,
    );
  }
  const enrollment = /^\/v1\/installations\/([A-Za-z0-9_-]+)\/attest$/.exec(path);
  if (enrollment && method === 'POST') {
    const data = await bodyJSON(request);
    return json(
      unwrap(await env.CAPTURE.getByName(enrollment[1]).enroll(principal.userId, data.proof)),
    );
  }
  if (path === '/v1/capture-sessions' && method === 'POST') {
    const data = await bodyJSON(request, 4096);
    if (!validID(data.installationId))
      fail(400, 'INVALID_INSTALLATION', '端末を登録してください。');
    return json(
      unwrap(await env.CAPTURE.getByName(data.installationId).issue(principal.userId)),
      201,
    );
  }
  const partRoute =
    /^\/v1\/installations\/([A-Za-z0-9_-]+)\/captures\/([A-Za-z0-9_-]+)\/assets\/(original|thumbnail|poster)\/(multipart|uploaded|parts\/(\d+))$/.exec(
      path,
    );
  if (partRoute) {
    const object = env.CAPTURE.getByName(partRoute[1]),
      id = partRoute[2],
      assetId = partRoute[3];
    if (partRoute[4] === 'multipart' && method === 'POST')
      return json(unwrap(await object.beginMultipart(principal.userId, id, assetId)));
    if (partRoute[4] === 'uploaded' && method === 'POST')
      return json(unwrap(await object.finishMultipart(principal.userId, id, assetId)));
    if (partRoute[5] && method === 'PUT') {
      const number = Number(partRoute[5]),
        digest = request.headers.get('X-Chunk-SHA256') ?? '';
      const info = unwrap(
        await object.uploadPartInfo(principal.userId, id, assetId, number, digest),
      );
      if (
        request.headers.get('Content-Length') !== String(info.bytes) ||
        request.headers.get('Content-Type') !== info.mime ||
        !request.body
      )
        fail(400, 'INVALID_PART', '分割データのサイズまたは形式が一致しません。');
      if (info.uploaded) {
        await request.body.cancel();
        return json({ uploaded: true });
      }
      const part = await uploadPart(
        env.STAGING,
        info.key,
        info.uploadId,
        number,
        info.bytes,
        digest,
        request.body,
      );
      unwrap(await object.uploadedPart(principal.userId, id, assetId, number, digest, part));
      return json({ uploaded: true });
    }
  }
  const capture =
    /^\/v1\/installations\/([A-Za-z0-9_-]+)\/captures\/([A-Za-z0-9_-]+)(?:\/(commit|complete|assets\/(original|thumbnail|poster)))?$/.exec(
      path,
    );
  if (capture) {
    const object = env.CAPTURE.getByName(capture[1]),
      id = capture[2];
    if (capture[3] === 'commit' && method === 'POST') {
      const data = await bodyJSON(request);
      return json(unwrap(await object.commit(principal.userId, id, data.manifest, data.proof)));
    }
    if (capture[3] === 'complete' && method === 'POST')
      return json(unwrap(await object.complete(principal.userId, id)));
    if (capture[4] && method === 'PUT') {
      const { asset, key } = unwrap(await object.asset(principal.userId, id, capture[4]));
      await stage(env.STAGING, key, asset, request);
      return json({ uploaded: true });
    }
    if (!capture[3] && method === 'GET')
      return json(unwrap(await object.status(principal.userId, id)));
    if (!capture[3] && method === 'DELETE')
      return json(unwrap(await object.cancel(principal.userId, id)));
  }
  const posts = await postRoutes(request, env, principal);
  if (posts) return posts;
  const proofs = await proofRoutes(request, env, principal);
  if (proofs) return proofs;
  return fail(404, 'NOT_FOUND', 'APIが見つかりません。');
}
export async function handleRequest(
  request: Request,
  env: Bindings = {} as Bindings,
): Promise<Response> {
  const origin = request.headers.get('Origin'),
    allowed = origin && env.ALLOWED_ORIGINS?.split(',').includes(origin);
  if (request.method === 'OPTIONS')
    return new Response(null, {
      status: allowed ? 204 : 403,
      headers: allowed
        ? {
            'Access-Control-Allow-Origin': origin!,
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,HEAD,OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type,Range,X-Chunk-SHA256',
            'Access-Control-Max-Age': '600',
            Vary: 'Origin',
          }
        : {},
    });
  const result = await rpc(async () => {
    if (request.method !== 'OPTIONS' && env.REQUEST_LIMIT) {
      const limit = await env.REQUEST_LIMIT.limit({
        key: request.headers.get('CF-Connecting-IP') ?? 'local',
      });
      if (!limit.success) fail(429, 'RATE_LIMITED', '少し待ってから再試行してください。');
    }
    return route(request, env);
  });
  const requestId = crypto.randomUUID();
  const response = result.ok
    ? result.value
    : json({ error: { code: result.code, message: result.message, requestId } }, result.status);
  response.headers.set('X-Request-ID', requestId);
  response.headers.set('Referrer-Policy', 'no-referrer');
  if (allowed) {
    response.headers.set('Access-Control-Allow-Origin', origin!);
    response.headers.set('Vary', 'Origin');
  }
  return response;
}
export default {
  fetch: handleRequest,
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([retryAnchors(env), purgeExpiredEarlyAccess(env)]));
  },
};
