import type { CaptureSecurity } from './capture-object';
import type { AuthSession } from './auth-object';
export interface Bindings {
  PROOF_ANCHOR_PROVIDER?: 'sigstore-v1' | 'disabled';
  ENVIRONMENT: string;
  REQUEST_LIMIT?: RateLimit;
  EARLY_ACCESS_LIMIT?: RateLimit;
  HOME: D1Database;
  AUTH: DurableObjectNamespace<AuthSession>;
  CAPTURE: DurableObjectNamespace<CaptureSecurity>;
  STAGING: R2Bucket;
  ORIGINALS: R2Bucket;
  APPLE_AUDIENCE?: string;
  APPLE_TEAM_ID?: string;
  APPLE_BUNDLE_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_SERVICE_ACCOUNT?: string;
  ANDROID_PACKAGE?: string;
  ANDROID_CERTIFICATES?: string;
  ANDROID_MIN_VERSION?: string;
  API_ORIGIN?: string;
  APP_RETURN_URL?: string;
  RECEIPT_PRIVATE_JWK?: string;
  RECEIPT_KEY_ID?: string;
  RECEIPT_PUBLIC_JWKS?: string;
  REVOKED_RECEIPT_KEY_IDS?: string;
  MEDIA_SECRET?: string;
  ALLOWED_ORIGINS?: string;
}
export interface Principal {
  userId: string;
  sessionId: string;
  epoch: number;
}
export interface Profile {
  user_id: string;
  display_name: string;
  is_private: number;
  status: string;
  session_epoch: number;
}
