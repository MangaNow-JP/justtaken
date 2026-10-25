import { capturePolicy } from '@justtaken/contracts';
import { DurableObject } from 'cloudflare:workers';
import { Records } from './storage';
import { b64, fail, requireValue, rpc, sha, token } from './http';
import { verifyIdentity } from './identity';
import type { Bindings, Profile, Principal } from './types';
type Challenge = {
  id: string;
  provider: 'apple' | 'google';
  nonce: string;
  verifierHash?: string;
  expires: number;
  consumed: boolean;
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
  create(id: string, provider: 'apple' | 'google', verifierHash?: string) {
    return rpc(async () => {
      if (this.records.get('challenge'))
        fail(409, 'CHALLENGE_EXISTS', 'もう一度ログインしてください。');
      requireValue(
        provider === 'apple'
          ? this.env.APPLE_AUDIENCE
          : this.env.GOOGLE_CLIENT_ID &&
              this.env.GOOGLE_CLIENT_SECRET &&
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
          prompt: 'select_account',
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
    const c = this.records.get<Challenge>('challenge');
    if (!c || c.consumed || c.expires <= Date.now())
      fail(401, 'LOGIN_EXPIRED', 'ログインの有効時間が過ぎました。もう一度お試しください。');
    return c!;
  }
  private async profile(provider: 'apple' | 'google', sub: string): Promise<Profile> {
    // Identity is issuer+subject, never an email address. An email change cannot merge accounts.
    const userId = 'u_' + (await sha(provider + '\0' + sub));
    const bucket = parseInt(userId.slice(2, 4), 16);
    await this.env.HOME.batch([
      this.env.HOME.prepare(
        'INSERT OR IGNORE INTO profiles(user_id,bucket_id,display_name,created_at) VALUES(?,?,?,?)',
      ).bind(userId, bucket, 'あなた', new Date().toISOString()),
      this.env.HOME.prepare(
        'INSERT OR IGNORE INTO quota_accounts(user_id,limit_bytes) VALUES(?,?)',
      ).bind(userId, capturePolicy.quotaBytes),
    ]);
    const profile = await this.env.HOME.prepare(
      'SELECT user_id,display_name,is_private,status,session_epoch FROM profiles WHERE user_id=?',
    )
      .bind(userId)
      .first<Profile>();
    if (!profile || profile.status !== 'ACTIVE')
      fail(403, 'ACCOUNT_UNAVAILABLE', 'このアカウントは利用できません。');
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
            isPrivate: !!profile.is_private,
          }
        : undefined,
    };
  }
  exchangeApple(idToken: string) {
    return rpc(async () => {
      const c = this.challenge();
      if (c.provider !== 'apple') fail(400, 'WRONG_PROVIDER', 'ログインをやり直してください。');
      const sub = await verifyIdentity('apple', idToken, c.nonce, this.env);
      const profile = await this.profile('apple', sub);
      const creds = await this.credentials(profile);
      this.records.atomic(() => {
        const current = this.challenge();
        this.records.put('challenge', { ...current, consumed: true });
        this.records.put('session', creds.session);
      });
      await this.ctx.storage.setAlarm(creds.session.refreshExpires);
      return this.response(c.id, creds, profile);
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
      const result = await response.json<{ id_token?: string }>();
      if (!result.id_token) fail(401, 'INVALID_IDENTITY', 'ログインをやり直してください。');
      const sub = await verifyIdentity('google', result.id_token!, c.nonce, this.env);
      const profile = await this.profile('google', sub);
      const handoff = token(),
        hash = await sha(handoff);
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
      if (
        !handoff ||
        handoff.used ||
        handoff.expires <= Date.now() ||
        handoff.hash !== hash ||
        c?.verifierHash !== verifierHash
      )
        fail(401, 'INVALID_HANDOFF', 'ログインをやり直してください。');
      const creds = await this.credentials(handoff!.profile);
      this.records.atomic(() => {
        if (this.records.get<{ used: boolean }>('handoff')?.used)
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
  async alarm() {
    const s = this.records.get<Session>('session');
    if (s && s.refreshExpires > Date.now()) {
      await this.ctx.storage.setAlarm(s.refreshExpires);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
