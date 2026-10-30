// TEST ENTRY POINT ONLY. Never imported by src/index.ts or deployed.
import { communityPolicy } from '@justtaken/contracts/community';
import { AuthSession } from '../src/auth-object';
import { CaptureSecurity } from '../src/capture-object';
import application, { handleRequest } from '../src/app';
import { Records } from '../src/storage';
import { sha, json } from '../src/http';
import type { Bindings } from '../src/types';
import { processAnchor, anchorStatus } from '../src/anchors';
import { externalFetch } from '../src/anchor-client';
import { processAccountDeletions } from '../src/account-deletion';
import { encryptProviderToken } from '../src/provider-tokens';
import { timestampRequest } from '../src/anchor-crypto';
export class FixtureAuth extends AuthSession {
  async seed(userId: string, access: string, refresh: string) {
    new Records(this.ctx.storage).put('session', {
      userId,
      epoch: 0,
      accessHash: await sha(access),
      accessExpires: Date.now() + 900000,
      refreshHash: await sha(refresh),
      refreshExpires: Date.now() + 86400000,
      revoked: false,
    });
  }
}
export class FixtureCapture extends CaptureSecurity {
  storedLocationPresent(id: string): boolean {
    const capture = new Records(this.ctx.storage).get<{ manifest?: { location?: unknown } }>(
      'capture:' + id,
    );
    return capture?.manifest?.location !== undefined;
  }

  patchCapture(id: string, patch: Record<string, unknown>) {
    const records = new Records(this.ctx.storage);
    records.put('capture:' + id, {
      ...records.get<Record<string, unknown>>('capture:' + id)!,
      ...patch,
    });
  }
  expireCapture(id: string) {
    const records = new Records(this.ctx.storage);
    const capture = records.get<Record<string, unknown>>('capture:' + id)!;
    records.put('capture:' + id, { ...capture, uploadExpiresAt: Date.now() - 1 });
  }

  seed(id: string, userId: string, publicKey: string) {
    new Records(this.ctx.storage).put('installation', {
      id,
      userId,
      accountBindingId: 'binding_test',
      platform: 'ios',
      active: true,
      counter: 0,
      publicKey,
      keyId: 'fixture-key',
      environment: 'test',
    });
  }
}
export default {
  scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    return application.scheduled(event, { ...env, PROOF_ANCHOR_PROVIDER: 'sigstore-v1' }, ctx);
  },
  async fetch(request: Request, env: Bindings) {
    if (new URL(request.url).pathname === '/__fixture/deletions') {
      await processAccountDeletions(env);
      return json({ processed: true });
    }
    if (new URL(request.url).pathname === '/__fixture/provider') {
      const d = await request.json<any>();
      const value = await encryptProviderToken(env, d.userId, 'fixture-provider-token');
      await env.HOME.prepare('INSERT OR REPLACE INTO provider_credentials VALUES(?,?,?,?)')
        .bind(d.userId, 'apple', value, Date.now())
        .run();
      return json({ seeded: true });
    }
    if (new URL(request.url).pathname === '/__fixture/has-location') {
      const d = await request.json<{ installationId: string; captureId: string }>();
      const present = await (env.CAPTURE as unknown as DurableObjectNamespace<FixtureCapture>)
        .getByName(d.installationId)
        .storedLocationPresent(d.captureId);
      return json({ present });
    }
    if (new URL(request.url).pathname === '/__fixture/patch-capture') {
      const d = await request.json<any>();
      await (env.CAPTURE as unknown as DurableObjectNamespace<FixtureCapture>)
        .getByName(d.installationId)
        .patchCapture(d.captureId, d.patch);
      return json({ patched: true });
    }
    if (new URL(request.url).pathname === '/__fixture/network') {
      const d = await request.json<{ certificate: string; nonce: string }>();
      try {
        const result = await externalFetch('https://timestamp.sigstore.dev/api/v1/timestamp', {
          method: 'POST',
          body: timestampRequest(d.certificate, d.nonce),
        });
        return json({ status: result.status });
      } catch (e) {
        return json({ error: String((e as Error).cause) });
      }
    }
    if (new URL(request.url).pathname === '/__fixture/anchor') {
      const d = await request.json<{ id: string; certificate: string }>();
      const enabled = { ...env, PROOF_ANCHOR_PROVIDER: 'sigstore-v1' as const };
      await processAnchor(enabled, d.id);
      return json(await anchorStatus(enabled, d.id, d.certificate));
    }
    if (new URL(request.url).pathname === '/__fixture/expire') {
      const data = await request.json<{ installationId: string; captureId: string }>();
      await (env.CAPTURE as unknown as DurableObjectNamespace<FixtureCapture>)
        .getByName(data.installationId)
        .expireCapture(data.captureId);
      return json({ expired: true });
    }
    if (new URL(request.url).pathname === '/__fixture/seed') {
      const d = await request.json<any>();
      await env.HOME.batch([
        env.HOME.prepare(
          "INSERT OR IGNORE INTO profiles(user_id,bucket_id,display_name,created_at) VALUES(?,0,'Test',?)",
        ).bind(d.userId, new Date().toISOString()),
        env.HOME.prepare('INSERT OR IGNORE INTO quota_accounts(user_id) VALUES(?)').bind(d.userId),
      ]);
      await (env.AUTH as unknown as DurableObjectNamespace<FixtureAuth>)
        .getByName(d.sessionId)
        .seed(d.userId, d.access, d.refresh);
      await (env.CAPTURE as unknown as DurableObjectNamespace<FixtureCapture>)
        .getByName(d.installationId)
        .seed(d.installationId, d.userId, d.publicKey);
      await env.HOME.batch([
        env.HOME.prepare(
          'INSERT OR IGNORE INTO user_auth_sessions(session_id,user_id) VALUES(?,?)',
        ).bind(d.sessionId, d.userId),
        env.HOME.prepare(
          'INSERT OR IGNORE INTO user_installations(installation_id,user_id) VALUES(?,?)',
        ).bind(d.installationId, d.userId),
        env.HOME.prepare('INSERT OR IGNORE INTO user_consents VALUES(?,?,?,?,?,?)').bind(
          d.userId,
          communityPolicy.termsVersion,
          communityPolicy.privacyVersion,
          new Date().toISOString(),
          communityPolicy.ageConfirmationVersion,
          new Date().toISOString(),
        ),
      ]);
      return json({ seeded: true });
    }
    const response = await handleRequest(request, env);
    // Miniflare's loopback HTTP bridge can emit EPIPE while sending an 8 MiB body
    // after the real handler has rejected its headers. Drain only in this fixture
    // so the test observes the actual status, without buffering or changing policy.
    if (request.body && !request.bodyUsed && !request.body.locked)
      await request.body.pipeTo(new WritableStream({ write() {} })).catch(() => {});
    return response;
  },
};
