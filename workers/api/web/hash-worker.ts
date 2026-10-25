import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  try {
    const { file } = event.data;
    if (!file.size || file.size > 512 * 1024 * 1024)
      throw new Error('原本は512 MiB以下のファイルを選んでください。');
    const hash = sha256.create();
    for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
      hash.update(new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer()));
      self.postMessage({ progress: Math.min(1, (offset + 1024 * 1024) / file.size) });
    }
    self.postMessage({ sha256: bytesToHex(hash.digest()), bytes: file.size });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'ファイルを読み込めません。',
    });
  }
};
