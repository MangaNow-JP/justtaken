export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireValue(value: unknown, code = 'CONFIGURATION_REQUIRED'): asserts value {
  if (!value)
    throw new ApiError(503, code, 'サービスの設定を確認しています。時間をおいてお試しください。');
}
export function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
export async function bodyJSON(request: Request, max = 32_768): Promise<any> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    fail(415, 'JSON_REQUIRED', 'JSON形式で送信してください。');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'BODY_REQUIRED', 'データがありません。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader!.cancel();
        fail(413, 'BODY_TOO_LARGE', 'データが大きすぎます。');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = parseUniqueJSON(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      fail(400, 'OBJECT_REQUIRED', 'JSONオブジェクトを送信してください。');
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return fail(400, 'INVALID_JSON', 'JSONを読み込めませんでした。');
  }
}
// Reject ambiguous duplicate member names before JSON.parse discards them, including escaped names.
export function parseUniqueJSON(text: string): unknown {
  let i = 0;
  const ws = () => {
    while (/\s/.test(text[i] ?? '') && i < text.length) i++;
  };
  function string(): string {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') i++;
      else if (c === '"') return JSON.parse(text.slice(start, i));
    }
    throw new Error('Unterminated string');
  }
  function value(depth: number): void {
    if (depth > 32) throw new Error('Too deeply nested');
    ws();
    if (text[i] === '"') {
      string();
      return;
    }
    if (text[i] === '{') {
      i++;
      ws();
      const keys = new Set<string>();
      if (text[i] === '}') {
        i++;
        return;
      }
      while (true) {
        ws();
        if (text[i] !== '"') throw new Error('Expected key');
        const key = string();
        if (keys.has(key)) throw new Error('Duplicate key');
        keys.add(key);
        ws();
        if (text[i++] !== ':') throw new Error('Expected colon');
        value(depth + 1);
        ws();
        const c = text[i++];
        if (c === '}') return;
        if (c !== ',') throw new Error('Expected comma');
      }
    }
    if (text[i] === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      while (true) {
        value(depth + 1);
        ws();
        const c = text[i++];
        if (c === ']') return;
        if (c !== ',') throw new Error('Expected comma');
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(i),
    );
    if (!match) throw new Error('Invalid value');
    i += match[0].length;
  }
  value(0);
  ws();
  if (i !== text.length) throw new Error('Trailing data');
  return JSON.parse(text);
}
export function token(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
export async function sha(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Buffer.from(await crypto.subtle.digest('SHA-256', bytes as BufferSource)).toString('hex');
}
export function validID(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
export type Result<T> =
  { ok: true; value: T } | { ok: false; status: number; code: string; message: string };
export async function rpc<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof ApiError)
      return { ok: false, status: error.status, code: error.code, message: error.message };
    console.error(
      JSON.stringify({
        event: 'operation_failed',
        type: error instanceof Error ? error.name : 'Unknown',
      }),
    );
    return {
      ok: false,
      status: 503,
      code: 'TEMPORARILY_UNAVAILABLE',
      message: '処理を完了できませんでした。時間をおいて再試行してください。',
    };
  }
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new ApiError(result.status, result.code, result.message);
  return result.value;
}
