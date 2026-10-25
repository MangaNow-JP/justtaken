import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'justtaken.photo-watermark.v1';
type Preference = {
  enabled: boolean;
  ready: boolean;
  saving: boolean;
  error: string;
  update: (enabled: boolean) => Promise<void>;
};
const Context = createContext<Preference | null>(null);

// A device display preference. It never enters a capture manifest or changes file bytes.
export function WatermarkPreferenceProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const writing = useRef(false);
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (active) setEnabled(value !== 'off');
      })
      .catch(() => {
        if (active)
          setError('表示設定を読み込めませんでした。設定を変更すると保存を再試行します。');
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  async function update(value: boolean) {
    if (!ready || writing.current) return;
    writing.current = true;
    setSaving(true);
    setError('');
    try {
      await AsyncStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
      setEnabled(value);
    } catch {
      setError('設定を保存できませんでした。もう一度お試しください。');
    } finally {
      writing.current = false;
      setSaving(false);
    }
  }
  return (
    <Context.Provider value={{ enabled, ready, saving, error, update }}>
      {children}
    </Context.Provider>
  );
}
export function useWatermarkPreference() {
  const value = useContext(Context);
  if (!value) throw new Error('WatermarkPreferenceProvider is required');
  return value;
}
