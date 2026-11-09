const aborted = () => new DOMException('Aborted', 'AbortError');
export function nativeAudioDevices(api = globalThis.window?.desktop) {
  return api?.listAudioOutputs ? {enumerateDevices: () => api.listAudioOutputs()} : undefined;
}
export async function playNativeAudio(api, blob, signal, volume = 1, outputDeviceId = '') {
  if (signal?.aborted) throw aborted();
  if (blob.size > 20_000_000) throw new Error('音声データが大きすぎます。');
  const id = crypto.randomUUID();
  let started = false;
  const stop = () => {if (started) void api.stopAudio(id).catch(() => {});};
  signal?.addEventListener('abort', stop, {once: true});
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (signal?.aborted) throw aborted();
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    started = true;
    await api.playAudio({id, data: btoa(binary), outputDeviceId, volume: Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1))});
    if (signal?.aborted) throw aborted();
  } catch (error) {
    if (signal?.aborted) throw aborted();
    throw error instanceof Error ? error : new Error(String(error));
  } finally {signal?.removeEventListener('abort', stop);}
}
