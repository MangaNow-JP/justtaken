import { bodyJSON, fail, json, requireValue, sha, token } from './http';
import type { Bindings } from './types';

export const EARLY_ACCESS_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
// Bundle: terms 2026-10-25.1 and privacy 2026-10-25.2. Existing registrations retain their version.
const CONSENT_VERSION = '2026-10-25.2';
// The browser's own type=email grammar, with a dotted domain. Double quotes, commas, semicolons,
// spaces and control characters never reach storage, so a mailer cannot gain extra recipients.
const EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export async function earlyAccessRoutes(
  request: Request,
  env: Bindings,
): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== '/public/early-access') return;
  if (!['POST', 'DELETE'].includes(request.method))
    return json(
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'この操作は利用できません。' } },
      405,
    );
  // Browser form only. Cross-origin requests and requests without an Origin fail closed.
  const expectedOrigin = env.API_ORIGIN ?? new URL(request.url).origin;
  if (request.headers.get('Origin') !== expectedOrigin)
    fail(403, 'ORIGIN_NOT_ALLOWED', 'このページからもう一度お試しください。');
  requireValue(env.HOME);
  if (env.EARLY_ACCESS_LIMIT) {
    const limit = await env.EARLY_ACCESS_LIMIT.limit({
      key: request.headers.get('CF-Connecting-IP') ?? 'local',
    });
    if (!limit.success) fail(429, 'RATE_LIMITED', '少し時間をおいて、もう一度お試しください。');
  }
  const data = await bodyJSON(request, 4096);
  if (request.method === 'DELETE') {
    if (
      typeof data.cancellationToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.cancellationToken)
    )
      fail(400, 'INVALID_CANCELLATION', '取り消しリンクを確認してください。');
    await env.HOME.prepare('DELETE FROM early_access_registrations WHERE cancellation_hash=?')
      .bind(await sha(data.cancellationToken))
      .run();
    // A repeated cancellation has the same response and never discloses an email address.
    return json({ cancelled: true });
  }
  if (typeof data.email !== 'string')
    fail(400, 'INVALID_EMAIL', 'メールアドレスを確認してください。');
  const email = data.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email))
    fail(400, 'INVALID_EMAIL', 'メールアドレスを確認してください。');
  if (data.consent !== true)
    fail(400, 'CONSENT_REQUIRED', '公開案内の受け取りに同意してください。');
  if (!['ios', 'android', 'both'].includes(data.platform))
    fail(400, 'INVALID_PLATFORM', '利用予定の端末を選んでください。');
  const cancellationToken = token();
  const now = Date.now();
  const expiresAt = now + EARLY_ACCESS_RETENTION_MS;
  // The invisible field catches simple form bots without tracking visitors.
  if (typeof data.website !== 'string' || data.website.length > 0)
    return json({ accepted: true, cancellationToken, expiresAt }, 202);
  // Clear an expired copy before a new registration; never refresh someone else's consent.
  await env.HOME.batch([
    env.HOME.prepare('DELETE FROM early_access_registrations WHERE email=? AND expires_at<=?').bind(
      email,
      now,
    ),
    env.HOME.prepare(
      `INSERT OR IGNORE INTO early_access_registrations
      (id,email,platform,consent_version,created_at,expires_at,cancellation_hash) VALUES(?,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(),
      email,
      data.platform,
      CONSENT_VERSION,
      now,
      expiresAt,
      await sha(cancellationToken),
    ),
  ]);
  // Duplicate addresses receive the same envelope but no key to the existing registration.
  return json({ accepted: true, cancellationToken, expiresAt }, 202);
}

export async function purgeExpiredEarlyAccess(env: Bindings): Promise<void> {
  await env.HOME.prepare('DELETE FROM early_access_registrations WHERE expires_at<=?')
    .bind(Date.now())
    .run();
}
