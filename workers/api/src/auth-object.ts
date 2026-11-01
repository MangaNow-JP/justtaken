import { capturePolicy } from '@justtaken/contracts';
import { communityPolicy } from '@justtaken/contracts/community';
import { DurableObject } from 'cloudflare:workers';
import { Records } from './storage';
import { b64, fail, requireValue, rpc, sha, token } from './http';
import { verifyIdentity } from './identity';
import { appleConfigured, exchangeAppleCode, storeProviderToken } from './provider-tokens';
import { registerAuthSession } from './account-deletion';
import type { Bindings, Profile, Principal } from './types';
type Challenge = {
  id: string;
  provider: 'apple' | 'google';
  nonce: string;
  verifierHash?: string;
  expires: number;
  consumed: boolean;
  ageConfirmationVersion?: string;
  ageConfirmedAt?: string;
};
type Session = {
  userId: string;
  epoch: number;
  accessHash: string;
  accessExpires: number;
  refreshHash: string;
  refreshExpires: number;
  revoked: boolean;
};
export class AuthSession extends DurableObject<Bindings> {
  private records: Records;
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.records = new Records(ctx.storage);
  }
  create(
    id: string,
    provider: 'apple' | 'google',
    verifierHash?: string,
    ageConfirmed18Plus?: boolean,
  ) {
    return rpc(async () => {
      if (ageConfirmed18Plus !== true)
        fail(403, 'AGE_CONFIRMATION_REQUIRED', '18歳以上であることをご自身で確認してください。');
      if (this.records.get('challenge'))
        fail(409, 'CHALLENGE_EXISTS', 'もう一度ログインしてください。');
      requireValue(
        provider === 'apple'
          ? appleConfigured(this.env)
          : this.env.GOOGLE_CLIENT_ID &&
              this.env.GOOGLE_CLIENT_SECRET &&
              this.env.PROVIDER_TOKEN_KEY &&
              this.env.API_ORIGIN &&
              this.env.APP_RETURN_URL,
      );
      if (provider === 'google' && (!verifierHash || !/^[A-Za-z0-9_-]{43}$/.test(verifierHash)))
        fail(400, 'PKCE_REQUIRED', 'ログインをやり直してください。');
      const challenge: Challenge = {
        id,
        provider,
        nonce: token(),
        verifierHash,
        expires: Date.now() + 300_000,
        consumed: false,
        ageConfirmationVersion: communityPolicy.ageConfirmationVersion,
        ageConfirmedAt: new Date().toISOString(),
      };
      this.records.put('challenge', challenge);
      await this.ctx.storage.setAlarm(challenge.expires + 60_000);
      let authorizationURL: string | undefined;
      if (provider === 'google') {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({
          client_id: this.env.GOOGLE_CLIENT_ID!,
          redirect_uri: this.env.API_ORIGIN + '/v1/auth/google/callback',
          response_type: 'code',
          scope: 'openid',
          state: id,
          nonce: challenge.nonce,
          access_type: 'offline',
          prompt: 'consent select_account',
        }).toString();
        authorizationURL = url.href;
      }
      return {
        challengeId: id,
        nonce: challenge.nonce,
        expiresAt: challenge.expires,
        authorizationURL,
      };
    });
  }
  private challenge(): Challenge {
    if (this.records.get('account-deleted'))
      fail(401, 'ACCOUNT_UNAVAILABLE', 'このアカウントは利用できません。');
    const c = this.records.get<Challenge>('challenge');
    if (!c || c.consumed || c.expires <= Date.now())
      fail(401, 'LOGIN_EXPIRED', 'ログインの有効時間が過ぎました。もう一度お試しください。');
    this.requireAdultDeclaration(c);
    return c!;
  }
  private requireAdultDeclaration(challenge: Challenge | undefined) {
    // Self-declaration is an eligibility statement, not verified age or identity.
    // Reject pre-policy challenges as well as requests that omit the declaration.
    if (
      challenge?.ageConfirmationVersion !== communityPolicy.ageConfirmationVersion ||
      !challenge.ageConfirmedAt
    )
      fail(403, 'AGE_CONFIRMATION_REQUIRED', '18歳以上であることをご自身で確認してください。');
  }
  private async profile(provider: 'apple' | 'google', sub: string): Promise<Profile> {
    // Identity is issuer+subject, never an email address. An email change cannot merge accounts.
    const userId = 'u_' + (await sha(provider + '\0' + sub));
    const deletedHash = await sha(userId);
    const bucket = parseInt(userId.slice(2, 4), 16);
    await this.env.HOME.batch([
      this.env.HOME.prepare(
        `INSERT OR IGNORE INTO profiles(user_id,bucket_id,display_name,created_at)
         SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE user_id_hash=?)`,
      ).bind(userId, bucket, 'あなた', new Date().toISOString(), deletedHash),
      this.env.HOME.prepare(
        "INSERT OR IGNORE INTO quota_accounts(user_id,limit_bytes) SELECT user_id,? FROM profiles WHERE user_id=? AND status='ACTIVE'",
      ).bind(capturePolicy.quotaBytes, userId),
    ]);
    const profile = await this.env.HOME.prepare(
      'SELECT user_id,display_name,bio,is_private,status,session_epoch FROM profiles WHERE user_id=?',
    )
      .bind(userId)
      .first<Profile>();
    if (!profile || profile.status !== 'ACTIVE')
      fail(403, 'ACCOUNT_UNAVAILABLE', 'このアカウントは利用できません。');
    await this.env.HOME.prepare(
      "UPDATE profiles SET auth_provider=? WHERE user_id=? AND status='ACTIVE'",
    )
      .bind(provider, userId)
      .run();
    return profile!;
  }
  private async credentials(profile: Profile) {
    const access = token(),
      refresh = token();
    const session: Session = {
      userId: profile.user_id,
      epoch: profile.session_epoch,
      accessHash: await sha(access),
      accessExpires: Date.now() + 900_000,
      refreshHash: await sha(refresh),
      refreshExpires: Date.now() + 30 * 86400_000,
      revoked: false,
    };
    return { access, refresh, session };
  }
  private response(
    id: string,
    credentials: { access: string; refresh: string; session: Session },
    profile?: Profile,
  ) {
    return {
      accessToken: id + '.' + credentials.access,
      refreshToken: id + '.' + credentials.refresh,
      expiresAt: credentials.session.accessExpires,
      profile: profile
        ? {
            userId: profile.user_id,
            displayName: profile.display_name,
            bio: profile.bio,
            isPrivate: !!profile.is_private,
          }
        : undefined,
    };
  }
  exchangeApple(idToken: string, authorizationCode: string) {
    let stage = 'challenge';
    return rpc(async () => {
      const c = this.challenge();
      if (c.provider !== 'apple') fail(400, 'WRONG_PROVIDER', 'ログインをやり直してください。');
      stage = 'native_identity';
      const sub = await verifyIdentity('apple', idToken, c.nonce, this.env);
      stage = 'authorization_code';
      const providerToken = await exchangeAppleCode(this.env, authorizationCode, c.nonce, sub);
      stage = 'profile';
      const profile = await this.profile('apple', sub);
      stage = 'provider_storage';
      await storeProviderToken(this.env, profile.user_id, 'apple', providerToken);
      stage = 'session';
      const creds = await this.credentials(profile);
      await registerAuthSession(this.env, profile.user_id, c.id);
      this.records.atomic(() => {
        if (this.records.get('account-deleted'))
          fail(403, 'ACCOUNT_UNAVAILABLE', 'このアカウントは利用できません。');
        const current = this.challenge();
        this.records.put('challenge', { ...current, consumed: true });
        this.records.put('session', creds.session);
      });
      await this.ctx.storage.setAlarm(creds.session.refreshExpires);
      return this.response(c.id, creds, profile);
    }).then((result) => {
      // Fixed stage/error codes only: never record tokens, nonces, identities or request data.
      if (!result.ok)
        console.warn(JSON.stringify({ event: 'apple_login_failed', stage, code: result.code }));
      return result;
    });
  }
  googleCallback(code: string) {
    return rpc(async () => {
      const c = this.challenge();
      if (c.provider !== 'google') fail(400, 'WRONG_PROVIDER', 'ログインをやり直してください。');
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.env.GOOGLE_CLIENT_ID!,
          client_secret: this.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: this.env.API_ORIGIN + '/v1/auth/google/callback',
          grant_type: 'authorization_code',
        }),
      });
      if (!response.ok) fail(401, 'GOOGLE_LOGIN_FAILED', 'Googleログインを完了できませんでした。');
      const result = await response.json<{ id_token?: string; refresh_token?: string }>();
      if (!result.id_token || !result.refresh_token)
        fail(401, 'INVALID_IDENTITY', 'ログインをやり直してください。');
      const sub = await verifyIdentity('google', result.id_token!, c.nonce, this.env);
      const profile = await this.profile('google', sub);
      await storeProviderToken(this.env, profile.user_id, 'google', result.refresh_token!);
      const handoff = token(),
        hash = await sha(handoff);
      await registerAuthSession(this.env, profile.user_id, c.id);
      this.records.atomic(() => {
        const current = this.challenge();
        this.records.put('challenge', { ...current, consumed: true });
        this.records.put('handoff', { hash, profile, expires: Date.now() + 60_000, used: false });
      });
      return { code: handoff };
    });
  }
  exchangeGoogle(code: string, verifier: string) {
    return rpc(async () => {
      const hash = await sha(code);
      const verifierHash = b64(Buffer.from(await sha(verifier), 'hex'));
      const handoff = this.records.get<{
        hash: string;
        profile: Profile;
        expires: number;
        used: boolean;
      }>('handoff');
      const c = this.records.get<Challenge>('challenge');
      this.requireAdultDeclaration(c);
      if (
        !handoff ||
        handoff.used ||
        handoff.expires <= Date.now() ||
        handoff.hash !== hash ||
        c?.verifierHash !== verifierHash
      )
        fail(401, 'INVALID_HANDOFF', 'ログインをやり直してください。');
      const creds = await this.credentials(handoff!.profile);
      await registerAuthSession(this.env, handoff!.profile.user_id, c!.id);
      this.records.atomic(() => {
        if (
          this.records.get('account-deleted') ||
          !this.records.get('handoff') ||
          this.records.get<{ used: boolean }>('handoff')?.used
        )
          fail(401, 'HANDOFF_USED', 'ログインをやり直してください。');
        this.records.put('handoff', { ...handoff, used: true });
        this.records.put('session', creds.session);
      });
      await this.ctx.storage.setAlarm(creds.session.refreshExpires);
      return this.response(c!.id, creds, handoff!.profile);
    });
  }
  authenticate(secret: string, sessionId: string) {
    return rpc(async (): Promise<Principal> => {
      const hash = await sha(secret);
      const s = this.records.get<Session>('session');
      if (!s || s.revoked || s.accessHash !== hash || s.accessExpires <= Date.now())
        fail(401, 'SESSION_EXPIRED', '再ログインが必要です。');
      return { userId: s!.userId, sessionId, epoch: s!.epoch };
    });
  }
  refresh(secret: string, sessionId: string) {
    return rpc(async () => {
      const hash = await sha(secret);
      const nextAccess = token(),
        nextRefresh = token();
      const accessHash = await sha(nextAccess),
        refreshHash = await sha(nextRefresh);
      const outcome = this.records.atomic(() => {
        const s = this.records.get<Session>('session');
        if (!s || s.revoked || s.refreshExpires <= Date.now()) return null;
        if (this.records.get('used:' + hash)) {
          this.records.put('session', { ...s, revoked: true });
          return null;
        }
        if (s.refreshHash !== hash) return null;
        const next = { ...s, accessHash, refreshHash, accessExpires: Date.now() + 900_000 };
        this.records.put('used:' + hash, { at: Date.now() });
        this.records.put('session', next);
        return next;
      });
      if (!outcome) fail(401, 'REFRESH_REJECTED', '再ログインが必要です。');
      const p = await this.env.HOME.prepare(
        'SELECT status,session_epoch FROM profiles WHERE user_id=?',
      )
        .bind(outcome!.userId)
        .first<{ status: string; session_epoch: number }>();
      if (p?.status !== 'ACTIVE' || p.session_epoch !== outcome!.epoch) {
        await this.revoke();
        fail(401, 'SESSION_REVOKED', '再ログインが必要です。');
      }
      return this.response(sessionId, {
        access: nextAccess,
        refresh: nextRefresh,
        session: outcome!,
      });
    });
  }
  revoke() {
    return rpc(() => {
      const s = this.records.get<Session>('session');
      if (s) this.records.put('session', { ...s, revoked: true });
      return { loggedOut: true };
    });
  }
  purgeAccount(userId: string) {
    return rpc(() => {
      const session = this.records.get<Session>('session');
      const handoff = this.records.get<{ profile: Profile }>('handoff');
      if ((session && session.userId !== userId) || (handoff && handoff.profile.user_id !== userId))
        fail(409, 'OWNERSHIP_MISMATCH', 'アカウント情報が一致しません。');
      this.records.atomic(() => {
        for (const row of this.records.all('')) this.records.delete(row.key);
        // Boolean marker blocks a suspended OAuth exchange from recreating its session.
        this.records.put('account-deleted', true);
      });
      return { purged: true };
    });
  }
  async alarm() {
    if (this.records.get('account-deleted')) return;
    const s = this.records.get<Session>('session');
    if (s && s.refreshExpires > Date.now()) {
      await this.ctx.storage.setAlarm(s.refreshExpires);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
