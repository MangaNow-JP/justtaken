import { requireOptionalNativeModule, requireNativeViewManager } from 'expo-modules-core';
import { Platform, type ViewProps } from 'react-native';
import type { ComponentType } from 'react';
import type { CaptureLocation } from '@justtaken/contracts';

export interface LocalCapture {
  handle: string;
  policyVersion?: 'capture-v1' | 'capture-v2' | 'capture-v3';
  previewUri: string;
  capturedAt: string;
  location?: CaptureLocation;
  kind: 'photo' | 'video';
  mediaUri?: string;
  verification: 'unverified';
  session?: CaptureSessionBinding;
  assets: {
    id: 'original' | 'thumbnail' | 'poster';
    role: 'original' | 'thumbnail' | 'poster';
    mime: 'image/jpeg' | 'image/heic' | 'image/x-adobe-dng' | 'video/mp4';
    preservation?: 'camera-original';
    hasGainMap?: boolean;
    durationMs?: number;
    videoCodec?: 'h264' | 'hevc';
    orientation?: number;
    rotationDegrees?: 0 | 90 | 180 | 270;
    videoBitDepth?: 8 | 10;
    colorTransfer?: 'sdr' | 'hlg' | 'pq';
    audioCodec?: 'aac-lc';
    fpsNumerator?: number;
    fpsDenominator?: number;
    bytes: number;
    width: number;
    height: number;
    sha256: string;
  }[];
}
interface CaptureModule {
  supportsPhotoCapture: boolean;
  setHDRDisplay(enabled: boolean): Promise<void>;
  requestPermission(): Promise<boolean>;
  requestMicrophonePermission(): Promise<boolean>;
  getLocationPermission(): Promise<boolean>;
  requestLocationPermission(): Promise<boolean>;
  finalize(handle: string): Promise<LocalCapture>;
  discard(handle: string): Promise<void>;
  listDrafts(): Promise<LocalCapture[]>;
  enroll(installationId: string, challenge: string): Promise<unknown>;
  forgetInstallation(installationId: string): Promise<void>;
  prepareProof(handle: string): Promise<{ manifest: unknown; proof: unknown }>;
  upload(handle: string, assetId: string, accessToken: string): Promise<void>;
}
export interface CaptureSessionBinding {
  sessionId: string;
  installationId: string;
  accountBindingId: string;
  nonce: string;
  commitExpiresAt: number;
}
export type PhotoFormat = 'jpeg' | 'heif' | 'raw' | 'proraw' | 'hdr';
export interface CaptureViewProps extends ViewProps {
  captureSession: string;
  facing: 'back' | 'front';
  flash: boolean;
  shutter: number;
  mode: 'photo' | 'video';
  photoFormat: PhotoFormat;
  audioEnabled: boolean;
  locationEnabled: boolean;
  onRecording: (event: {
    nativeEvent: { recording: boolean; finalizing: boolean; durationMs: number };
  }) => void;
  onCapture: (event: { nativeEvent: { handle: string } }) => void;
  onReady: (event: { nativeEvent: { ready: boolean; photoFormats?: PhotoFormat[] } }) => void;
  onError: (event: { nativeEvent: { message: string } }) => void;
}
export const captureModule =
  Platform.OS === 'web' ? null : requireOptionalNativeModule<CaptureModule>('JustTakenCapture');
export const NativeCaptureView: ComponentType<CaptureViewProps> | null = captureModule
  ? requireNativeViewManager('JustTakenCapture')
  : null;
