import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { captureModule } from '@justtaken/capture';

const STORAGE_KEY = 'justtaken.capture-location.v1';
type Preference = {
  enabled: boolean;
  ready: boolean;
  saving: boolean;
  permission: boolean;
  supported: boolean;
  error: string;
  update: (enabled: boolean) => Promise<void>;
};
const Context = createContext<Preference | null>(null);
export function LocationPreferenceProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(false),
    [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false),
    [permission, setPermission] = useState(false);
  const [error, setError] = useState('');
  const writing = useRef(false);
  const supported =
    !!captureModule?.getLocationPermission && !!captureModule?.requestLocationPermission;
  useEffect(() => {
    let active = true;
    async function refreshPermission() {
      try {
        const allowed = supported ? await captureModule!.getLocationPermission() : false;
        if (active) setPermission(allowed);
      } catch {
        if (active) setPermission(false);
      }
    }
    void AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (active) setEnabled(value === 'on');
      })
      .catch(() => {
        if (active) setError('GPS設定を読み込めなかったため、オフにしています。');
      })
      .finally(() => {
        if (active) setReady(true);
      });
    void refreshPermission();
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshPermission();
      else if (active) setPermission(false);
    });
    return () => {
      active = false;
      listener.remove();
    };
  }, [supported]);
  async function update(value: boolean) {
    if (!ready || writing.current) return;
    writing.current = true;
    setSaving(true);
    setError('');
    // Turning off stops current collection immediately, even if persistence fails.
    if (!value) setEnabled(false);
    try {
      if (value && Platform.OS !== 'web') {
        if (!supported) throw new Error('GPS対応の専用アプリに更新してください。');
        const allowed = await captureModule!.requestLocationPermission();
        setPermission(allowed);
        if (!allowed) throw new Error('位置情報が許可されていません。端末の設定から許可できます。');
      }
      await AsyncStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
      setEnabled(value);
    } catch (e) {
      setError(
        e instanceof Error && e.message.includes('。')
          ? e.message
          : value
            ? 'GPS設定を保存できませんでした。もう一度お試しください。'
            : 'GPSは停止しましたが、設定を保存できませんでした。再起動前にもう一度オフを保存してください。',
      );
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }
  return (
    <Context.Provider value={{ enabled, ready, saving, permission, supported, error, update }}>
      {children}
    </Context.Provider>
  );
}
export function useLocationPreference() {
  const value = useContext(Context);
  if (!value) throw new Error('LocationPreferenceProvider is required');
  return value;
}
