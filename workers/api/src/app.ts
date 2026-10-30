import { capturePolicy } from '@justtaken/contracts/policy';
import {
  authChallengeInputSchema,
  communityPolicy,
  requiresCommunityConsent,
} from '@justtaken/contracts/community';
import { bodyJSON, fail, json, requireValue, rpc, unwrap, validID } from './http';
import { integrityConfigured } from './proof';
import { stage, uploadPart } from './media';
import { postRoutes } from './posts';
import { proofRoutes, publicProofRoutes } from './proofs';
import { publicProofKeys } from './proof-keys';
import { verifierRoutes } from './verifier';
import { anchorsEnabled, retryAnchors } from './anchors';
import { earlyAccessRoutes, purgeExpiredEarlyAccess } from './early-access';
import { applySecurityHeaders, securityTxtRoute } from './security-headers';
import { communityRoutes, requireCommunityConsent } from './community';
import {
  accountDeletionRoutes,
  processAccountDeletions,
  registerInstallation,
} from './account-deletion';
import type { Bindings, Principal, Profile } from './types';
import { appleConfigured } from './provider-tokens';
import { accountRoutes, deletionStatus } from './accounts';
import { isModerator, safetyRoutes } from './safety';
// Bound a slow client upload so a deletion sweep has a finite drain window.
function uploadBody(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout>;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        controller.error(new Error('UPLOAD_TIMEOUT'));
        void reader.cancel().catch(() => {});
      }, 300_000);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          clearTimeout(timer);
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        clearTimeout(timer);
        controller.error(error);
      }
    },
    async cancel(reason) {
      clearTimeout(timer);
      await reader.cancel(reason);
    },
  });
}
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
  const securityTxt = securityTxtRoute(request);
  if (securityTxt) return securityTxt;
  const verifier = verifierRoutes(request);
  if (verifier) return verifier;
  const earlyAccess = await earlyAccessRoutes(request, env);
  if (earlyAccess) return earlyAccess;
  const sharedProof = await publicProofRoutes(request, env);
  if (sharedProof) return sharedProof;
  const auth = {
    apple: appleConfigured(env),
    google: !!(
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.PROVIDER_TOKEN_KEY &&
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
      community: communityPolicy,
    });
  if (path === '/v1/auth/challenge' && method === 'POST') {
    const data = await bodyJSON(request, 4096);
    if (data.ageConfirmed18Plus !== true)
      fail(403, 'AGE_CONFIRMATION_REQUIRED', '18歳以上であることをご自身で確認してください。');
    if (!['apple', 'google'].includes(data.provider))
      fail(400, 'INVALID_PROVIDER', 'ログイン方法を選んでください。');
    const parsed = authChallengeInputSchema.safeParse(data);
    if (!parsed.success) fail(400, 'INVALID_LOGIN', 'ログイン情報を確認してください。');
    const id = crypto.randomUUID();
    return json(
      unwrap(
        await env.AUTH.getByName(id).create(
          id,
          parsed.data.provider,
          parsed.data.codeChallenge,
          parsed.data.ageConfirmed18Plus,
        ),
      ),
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
    if (
      data.provider === 'apple' &&
      typeof data.idToken === 'string' &&
      typeof data.authorizationCode === 'string'
    )
      return json(unwrap(await obj.exchangeApple(data.idToken, data.authorizationCode)));
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
  const deleted = await deletionStatus(request, env);
  if (deleted) return deleted;
  if (!path.startsWith('/v1/')) fail(404, 'NOT_FOUND', 'APIが見つかりません。');
  const principal = await authenticate(request, env);
  const account = await accountRoutes(request, env, principal);
  if (account) return account;
  const deletion = await accountDeletionRoutes(request, env, principal);
  if (deletion) return deletion;
  const community = await communityRoutes(request, env, principal);
  if (community) return community;
  if (requiresCommunityConsent(method, path)) await requireCommunityConsent(env, principal.userId);
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
        moderator: isModerator(env, principal.userId),
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
    await registerInstallation(env, principal.userId, id);
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
      try {
        const part = await uploadPart(
          env.STAGING,
          info.key,
          info.uploadId,
          number,
          info.bytes,
          digest,
          uploadBody(request.body!),
        );
        unwrap(await object.uploadedPart(principal.userId, id, assetId, number, digest, part));
      } catch (error) {
        const live = await object.asset(principal.userId, id, assetId);
        if (!live.ok) {
          await env.STAGING.resumeMultipartUpload(info.key, info.uploadId).abort();
          await env.STAGING.delete(info.key);
        }
        throw error;
      }
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
      try {
        const bounded = new Request(request, {
          body: request.body ? uploadBody(request.body) : null,
        });
        await stage(env.STAGING, key, asset, bounded);
        unwrap(await object.asset(principal.userId, id, capture[4]));
      } catch (error) {
        const live = await object.asset(principal.userId, id, capture[4]);
        if (!live.ok) await env.STAGING.delete(key);
        throw error;
      }
      return json({ uploaded: true });
    }
    if (!capture[3] && method === 'GET')
      return json(unwrap(await object.status(principal.userId, id)));
    if (!capture[3] && method === 'DELETE')
      return json(unwrap(await object.cancel(principal.userId, id)));
  }
  const safety = await safetyRoutes(request, env, principal);
  if (safety) return safety;
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
    return applySecurityHeaders(
      request,
      new Response(null, {
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
      }),
    );
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
  applySecurityHeaders(request, response);
  if (allowed) {
    response.headers.set('Access-Control-Allow-Origin', origin!);
    response.headers.set('Vary', 'Origin');
  }
  return response;
}
export default {
  fetch: handleRequest,
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(
      Promise.all([retryAnchors(env), purgeExpiredEarlyAccess(env), processAccountDeletions(env)]),
    );
  },
};
