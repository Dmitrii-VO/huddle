// Connection diagnostics: the "Связь" indicator for people, and a stats line in the server log
// (journalctl -u huddle) for debugging lag: which side is slow and why.
const $ = (id) => document.getElementById(id);

export function startDiag({ getPc, log, toast }) {
  let info = '', tick = 0;
  const prevBytes = new Map(); // outbound-rtp id -> [bytesSent, timestamp]

  setInterval(async () => {
    const pc = getPc();
    if (pc?.connectionState !== 'connected') return ($('net').hidden = true);
    const stats = await pc.getStats();
    let pair = null;
    const out = [], inn = [];
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair ??= r;
      if (r.kind === 'video' && r.type === 'outbound-rtp') out.push(r);
      if (r.kind === 'video' && r.type === 'inbound-rtp') inn.push(r);
    });
    if (!pair) return;

    const rtt = Math.round((pair.currentRoundTripTime ?? 0) * 1000);
    const relay = [pair.localCandidateId, pair.remoteCandidateId].some((id) => stats.get(id)?.candidateType === 'relay');
    const codec = (r) => stats.get(r.codecId)?.mimeType?.split('/')[1] ?? '?';
    const video = (r) => `${codec(r)} ${r.frameWidth ?? 0}x${r.frameHeight ?? 0} ${Math.round(r.framesPerSecond ?? 0)}fps`;
    const kbps = (r) => {
      const [bytes, ts] = prevBytes.get(r.id) ?? [r.bytesSent, r.timestamp];
      prevBytes.set(r.id, [r.bytesSent, r.timestamp]);
      return ts === r.timestamp ? 0 : Math.round(((r.bytesSent - bytes) * 8) / (r.timestamp - ts));
    };
    const outs = out.map((r) => ({
      v: video(r),
      kbps: kbps(r),
      limit: r.qualityLimitationReason, // none | cpu | bandwidth
      encMs: r.framesEncoded ? Math.round((r.totalEncodeTime / r.framesEncoded) * 1000) : null,
    }));
    const ins = inn.map((r) => ({
      v: video(r),
      bufMs: r.jitterBufferEmittedCount ? Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) : null,
      decMs: r.framesDecoded ? Math.round((r.totalDecodeTime / r.framesDecoded) * 1000) : null,
      lost: r.packetsLost,
    }));

    $('net').hidden = false;
    $('net').className = `tb ${rtt < 150 ? 'good' : rtt < 300 ? 'fair' : 'poor'}`;
    $('net').querySelector('span').textContent = `${rtt} мс`;
    const fpsIn = Math.max(0, ...inn.map((r) => Math.round(r.framesPerSecond ?? 0)));
    const busy = outs.find((o) => o.limit && o.limit !== 'none');
    info = `${relay ? 'Через сервер' : 'Напрямую'} · задержка сети ${rtt} мс · входящее видео ${fpsIn} к/с` +
      (busy ? ` · отправка ограничена: ${busy.limit === 'cpu' ? 'не хватает процессора' : 'не хватает сети'}` : '');

    if (tick++ % 5 === 0) log({ ev: 'stats', path: relay ? 'relay' : 'direct', rtt, out: outs, in: ins });
  }, 2000);

  $('net').onclick = () => toast(info);
}
