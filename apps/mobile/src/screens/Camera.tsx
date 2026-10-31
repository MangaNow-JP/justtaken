import { useLocationPreference } from '../preferences/LocationPreference';
import { useEffect, useState } from 'react';
import { Image, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  NativeCaptureView,
  captureModule,
  type LocalCapture,
  type PhotoFormat,
  type CaptureSessionBinding,
} from '@justtaken/capture';
import { Icon, IconButton, Button } from '../components/UI';
import { colors as c } from '../theme';
import { prepareCapture } from '../services/capture';

export function Camera({
  onClose,
  onCapture,
  userId,
  onLogin,
}: {
  userId?: string;
  onLogin: () => void;
  onClose: () => void;
  onCapture: (capture: LocalCapture) => void;
}) {
  const gps = useLocationPreference();
  const [permission, setPermission] = useState<'pending' | 'granted' | 'denied'>('pending');
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [photoFormat, setPhotoFormat] = useState<PhotoFormat>('jpeg');
  const [photoFormats, setPhotoFormats] = useState<PhotoFormat[]>([]);
  const [flash, setFlash] = useState(false);
  const [shutter, setShutter] = useState(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [error, setError] = useState('');
  const [binding, setBinding] = useState<CaptureSessionBinding | null>(null);
  const [preparing, setPreparing] = useState(false);
  async function prepare() {
    if (!userId) return;
    setPreparing(true);
    setError('');
    try {
      setBinding(await prepareCapture(userId));
    } catch (e) {
      setError(e instanceof Error ? e.message : '撮影の準備ができませんでした。');
    } finally {
      setPreparing(false);
    }
  }
  useEffect(() => {
    if (userId && captureModule?.supportsPhotoCapture) void prepare();
    else setBinding(null);
  }, [userId]);
  const [mode, setMode] = useState<'photo' | 'video'>('photo');
  async function enableAudio() {
    if (!captureModule || busy) return;
    setMicBusy(true);
    try {
      setAudioEnabled(await captureModule.requestMicrophonePermission());
    } catch {
      setAudioEnabled(false);
    } finally {
      setMicBusy(false);
    }
  }
  function changeMode(next: 'photo' | 'video') {
    if (busy || micBusy || next === mode) return;
    setReady(false);
    setMode(next);
    setError('');
    if (next === 'video' && supported) void enableAudio();
  }
  useEffect(() => {
    let active = true;
    if (captureModule?.supportsPhotoCapture)
      captureModule
        .requestPermission()
        .then((ok) => {
          if (active) setPermission(ok ? 'granted' : 'denied');
        })
        .catch(() => {
          if (active) setPermission('denied');
        });
    return () => {
      active = false;
    };
  }, []);
  const supported = !!NativeCaptureView && permission === 'granted';
  const continuousLight = Platform.OS === 'ios' || mode === 'video';
  return (
    <View style={s.root}>
      {supported && NativeCaptureView ? (
        <NativeCaptureView
          style={StyleSheet.absoluteFill}
          captureSession={binding ? JSON.stringify(binding) : ''}
          facing={facing}
          flash={flash}
          shutter={shutter}
          mode={mode}
          photoFormat={photoFormat}
          audioEnabled={audioEnabled}
          locationEnabled={gps.ready && gps.enabled}
          onRecording={({ nativeEvent: event }) => {
            setRecording(event.recording);
            setFinalizing(event.finalizing);
            setDuration(event.durationMs);
            setBusy(event.recording || event.finalizing);
          }}
          onReady={({ nativeEvent }) => {
            setReady(nativeEvent.ready);
            if (nativeEvent.photoFormats) setPhotoFormats(nativeEvent.photoFormats);
          }}
          onError={(event) => {
            setError(event.nativeEvent.message);
            setBusy(false);
            setRecording(false);
            setFinalizing(false);
          }}
          onCapture={async (event) => {
            try {
              const draft = await captureModule!.finalize(event.nativeEvent.handle);
              onCapture(draft);
            } catch {
              setError('撮影データを保存できませんでした。もう一度撮影してください。');
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : (
        <>
          <Image
            source={require('../../assets/forest.jpg')}
            style={[StyleSheet.absoluteFill, { width: '100%', height: '100%' }]}
            blurRadius={2}
          />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#071A1566' }]} />
        </>
      )}
      <View style={s.top}>
        <IconButton
          name="x"
          color="white"
          label="カメラを閉じる"
          disabled={busy}
          onPress={onClose}
          style={s.round}
        />
        <View style={{ alignItems: 'center', gap: 5 }}>
          <Text style={s.topLabel}>JUST THIS MOMENT.</Text>
          <Text style={{ color: 'white', fontSize: 10 }}>
            {!gps.ready
              ? 'GPS設定を読み込み中…'
              : gps.enabled
                ? Platform.OS === 'web'
                  ? 'GPS オン · 表示プレビュー'
                  : 'GPS オン · 撮影開始時の位置を記録'
                : 'GPS オフ'}
          </Text>
        </View>
        {/* iOS keeps a continuous light in both modes, also mid-recording. Android photos still
            fire the flash at capture. */}
        <IconButton
          name={flash ? 'zap' : 'zap-off'}
          color="white"
          label={`${continuousLight ? 'ライト' : 'フラッシュ'}を${flash ? 'オフ' : 'オン'}`}
          disabled={
            !supported || (busy && !(recording && Platform.OS === 'ios')) || facing === 'front'
          }
          onPress={() => setFlash(!flash)}
          style={s.round}
        />
      </View>
      <View pointerEvents="none" style={s.frame}>
        <View style={[s.corner, s.tl]} />
        <View style={[s.corner, s.tr]} />
        <View style={[s.corner, s.bl]} />
        <View style={[s.corner, s.br]} />
      </View>
      {!supported && (
        <View style={s.message}>
          <Icon name="camera" color={c.lime} size={30} />
          <Text style={s.messageTitle}>
            {permission === 'denied' ? 'カメラへのアクセスを許可' : 'いま、この瞬間を。'}
          </Text>
          <Text style={s.messageText}>
            {permission === 'denied'
              ? '設定でカメラを許可すると、このアプリ内で写真・動画を撮れます。'
              : Platform.OS === 'web'
                ? '写真・動画の撮影はiPhone・Androidの専用アプリから。\n背景はサンプル写真です。'
                : !captureModule?.supportsPhotoCapture
                  ? 'シミュレーターでは撮影できません。実機でお試しください。\n背景はサンプル写真です。'
                  : 'ログインすると、専用カメラで撮影できます。'}
          </Text>
          {!userId && <Button onPress={onLogin}>ログインしてはじめる</Button>}
          {permission === 'denied' && (
            <Button
              onPress={() => {
                void Linking.openSettings();
              }}
            >
              設定を開く
            </Button>
          )}
        </View>
      )}
      {supported && !userId && (
        <View style={s.message}>
          <Text style={s.messageTitle}>ログインして撮影しよう</Text>
          <Button onPress={onLogin}>ログインしてはじめる</Button>
        </View>
      )}
      {!!error && (
        <View style={s.error}>
          <Text style={s.errorText}>{error}</Text>
          {!!userId && !preparing && !busy && (
            <Button onPress={() => void prepare()}>撮影の準備をやり直す</Button>
          )}
        </View>
      )}
      <View style={s.bottom}>
        <View style={s.zoom}>
          <Text style={s.zoomText}>1×</Text>
        </View>
        <View style={s.modes}>
          <Pressable
            accessibilityRole="button"
            disabled={busy || micBusy}
            onPress={() => changeMode('photo')}
          >
            <Text style={[s.mode, mode === 'photo' && s.modeActive]}>写真</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || micBusy}
            onPress={() => changeMode('video')}
          >
            <Text style={[s.mode, mode === 'video' && s.modeActive]}>動画</Text>
          </Pressable>
        </View>
        {mode === 'photo' && (
          <View style={{ alignItems: 'center', gap: 8 }}>
            <View
              style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}
            >
              {(
                [
                  ['jpeg', 'JPEG'],
                  ['heif', 'HEIF'],
                  ['raw', 'RAW'],
                  ['proraw', 'ProRAW'],
                  ['hdr', 'HDR'],
                ] as const
              )
                .filter(
                  ([format]) =>
                    !(Platform.OS === 'ios' && format === 'hdr') &&
                    !(Platform.OS === 'android' && format === 'proraw'),
                )
                .map(([format, label]) => {
                  const available = photoFormats.includes(format);
                  return (
                    <Pressable
                      key={format}
                      accessibilityRole="button"
                      accessibilityLabel={`${label}${available ? '' : '・このカメラでは未対応'}`}
                      accessibilityState={{
                        selected: photoFormat === format,
                        disabled: busy || !available,
                      }}
                      disabled={busy || !available}
                      onPress={() => {
                        if (photoFormat !== format) {
                          setReady(false);
                          setError('');
                          setPhotoFormat(format);
                        }
                      }}
                      style={{
                        paddingHorizontal: 11,
                        paddingVertical: 8,
                        borderRadius: 16,
                        backgroundColor: photoFormat === format ? c.lime : '#FFFFFF22',
                        opacity: available ? 1 : 0.35,
                      }}
                    >
                      <Text
                        style={{ color: photoFormat === format ? c.ink : 'white', fontSize: 12 }}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
            </View>
            <Text style={[s.note, { textAlign: 'center', paddingHorizontal: 20 }]}>
              原本をそのまま保存 · 対応形式は端末・レンズによります{'\n'}
              HDR情報はカメラが出力した場合に保持します
            </Text>
            {flash && !continuousLight && (
              <Text style={s.note}>フラッシュ オン · 撮影の瞬間に発光します</Text>
            )}
          </View>
        )}
        {mode === 'video' && (
          <View style={{ alignItems: 'center', gap: 10 }}>
            <Text
              accessibilityLiveRegion="polite"
              style={[s.note, { fontSize: 16, fontVariant: ['tabular-nums'] }]}
            >
              {finalizing
                ? '動画を保存中…'
                : recording
                  ? `● 00:${String(Math.floor(duration / 1000)).padStart(2, '0')} · 残り${Math.max(0, 60 - Math.ceil(duration / 1000))}秒`
                  : '最大60秒 · 原画を保持'}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={audioEnabled ? '音声収録をオフ' : '音声収録を許可'}
              disabled={busy || micBusy || !supported}
              onPress={() => (audioEnabled ? setAudioEnabled(false) : void enableAudio())}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
            >
              <Icon name={audioEnabled ? 'mic' : 'mic-off'} color="white" size={16} />
              <Text style={s.note}>
                {micBusy
                  ? 'マイクを確認中…'
                  : audioEnabled
                    ? '音声あり'
                    : '無音で撮影 · タップして音声を許可'}
              </Text>
            </Pressable>
          </View>
        )}
        <View style={s.controls}>
          <View style={{ width: 48 }} />
          <Pressable
            disabled={
              !supported || !ready || !gps.ready || !binding || micBusy || (busy && !recording)
            }
            accessibilityRole="button"
            accessibilityLabel={
              recording ? '録画を停止' : mode === 'video' ? '動画の録画を開始' : '写真を撮る'
            }
            accessibilityState={{
              disabled:
                !supported || !ready || !gps.ready || !binding || micBusy || (busy && !recording),
            }}
            onPress={() => {
              if (recording) {
                setRecording(false);
                setFinalizing(true);
                setShutter((n) => n + 1);
                return;
              }
              if (
                !binding ||
                binding.commitExpiresAt <= Date.now() + (mode === 'video' ? 75_000 : 0)
              ) {
                setError('撮影の有効時間が過ぎました。撮影の準備をやり直してください。');
                setBinding(null);
                return;
              }
              setBusy(true);
              setError('');
              setShutter((n) => n + 1);
            }}
            style={[s.shutter, (!supported || !ready) && { opacity: 0.55 }]}
          >
            <View
              style={[
                s.shutterInner,
                mode === 'video' && { backgroundColor: '#EE6258' },
                recording && { borderRadius: 8, margin: 14 },
              ]}
            >
              {busy && !recording && <Text>…</Text>}
            </View>
          </Pressable>
          <IconButton
            name="refresh-cw"
            label="前後のカメラを切り替える"
            color="white"
            disabled={!supported || busy || micBusy}
            onPress={() => {
              if (!busy) {
                setReady(false);
                setFlash(false);
                setFacing((f) => (f === 'back' ? 'front' : 'back'));
              }
            }}
            style={s.round}
          />
        </View>
        <Text style={s.note}>
          {preparing
            ? '端末認証と撮影の準備中…'
            : binding
              ? '撮影記録を添えて、下書きに保存します'
              : 'ログインして撮影の準備をしましょう'}
        </Text>
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#10221C' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20 },
  topLabel: { color: '#FFFFFFBB', fontSize: 9, letterSpacing: 2 },
  round: { backgroundColor: '#10241C90' },
  frame: { position: 'absolute', width: 205, height: 205, alignSelf: 'center', top: '29%' },
  corner: { position: 'absolute', width: 28, height: 28, borderColor: '#FFFFFFCC' },
  tl: { left: 0, top: 0, borderLeftWidth: 3, borderTopWidth: 3, borderTopLeftRadius: 13 },
  tr: { right: 0, top: 0, borderRightWidth: 3, borderTopWidth: 3, borderTopRightRadius: 13 },
  bl: { left: 0, bottom: 0, borderLeftWidth: 3, borderBottomWidth: 3, borderBottomLeftRadius: 13 },
  br: {
    right: 0,
    bottom: 0,
    borderRightWidth: 3,
    borderBottomWidth: 3,
    borderBottomRightRadius: 13,
  },
  message: {
    position: 'absolute',
    top: '24%',
    alignSelf: 'center',
    width: '86%',
    backgroundColor: '#0F2C23E8',
    padding: 25,
    borderRadius: 24,
    alignItems: 'center',
    gap: 16,
  },
  messageTitle: { fontSize: 20, fontWeight: '600', color: 'white' },
  messageText: { fontSize: 13, lineHeight: 23, color: '#E8EEE7', textAlign: 'center' },
  bottom: {
    marginTop: 'auto',
    alignItems: 'center',
    paddingBottom: 24,
    gap: 20,
    paddingTop: 20,
    backgroundColor: '#0C1D1580',
  },
  zoom: {
    backgroundColor: '#FFFFFF22',
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 16,
  },
  zoomText: { color: 'white', fontSize: 14 },
  modes: { flexDirection: 'row', gap: 40 },
  mode: { color: '#C0C7C0', fontSize: 14, paddingBottom: 8 },
  modeActive: { color: 'white', fontWeight: '700', borderBottomWidth: 3, borderColor: c.lime },
  controls: {
    flexDirection: 'row',
    width: '100%',
    paddingHorizontal: 35,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  shutter: {
    width: 82,
    height: 82,
    borderRadius: 41,
    borderWidth: 3,
    borderColor: 'white',
    padding: 5,
  },
  shutterInner: {
    flex: 1,
    borderRadius: 40,
    backgroundColor: c.lime,
    alignItems: 'center',
    justifyContent: 'center',
  },
  note: { color: '#E6EADD', fontSize: 11 },
  error: { padding: 15, backgroundColor: '#163A30E8', margin: 22, borderRadius: 10 },
  errorText: { color: 'white', fontSize: 13, lineHeight: 21 },
});
