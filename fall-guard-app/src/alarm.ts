// ============================================================
// alarm.ts — Còi báo động trên máy người có nguy cơ té ngã
// ============================================================
// Âm thanh được TỔNG HỢP bằng Web Audio API chứ không phát từ file .mp3.
// Lý do: không cần đóng gói thêm tài nguyên, không phụ thuộc mạng, và chỉnh
// được cao độ / nhịp hú tuỳ ý.
//
// Khi app chạy dưới dạng APK và màn hình đã tắt, WebView bị Android tạm dừng
// nên Web Audio cũng câm. Lúc đó phần native (FallGuardSensorPlugin) sẽ phát
// chuông báo thức của hệ điều hành thay thế — xem android/.../AlarmPlayer.java.

import { getSensorPlugin } from './native';

/** Trình duyệt chỉ cho phép phát tiếng sau khi người dùng chạm vào màn hình */
let audioContext: AudioContext | null = null;
let sirenTimerId: number | null = null;
let currentNodes: { osc: OscillatorNode; gain: GainNode } | null = null;
let muted = false;

/** Bật/tắt tiếng theo cài đặt người dùng. Đang kêu mà tắt thì im ngay. */
export function setAlarmMuted(value: boolean): void {
  muted = value;
  getSensorPlugin()?.setAlarmMuted({ muted: value }).catch(() => undefined);
  if (muted) stopAlarm();
}

export function isAlarmMuted(): boolean {
  return muted;
}

function getContext(): AudioContext | null {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  if (!audioContext) {
    try {
      audioContext = new Ctor();
    } catch {
      return null;
    }
  }
  return audioContext;
}

/**
 * Gọi khi người dùng chạm vào màn hình lần đầu.
 * Android và iOS chặn phát tiếng cho tới khi có một thao tác thật của người dùng,
 * nên phải "mở khoá" trước, không thì lúc té ngã mới gọi sẽ không kêu.
 */
export function unlockAudio(): void {
  const ctx = getContext();
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }
}

/**
 * Bắt đầu hú còi cho tới khi gọi stopAlarm().
 * Tiếng hú lên xuống giữa hai cao độ, kiểu còi cứu thương, để người xung quanh
 * nghe là biết ngay có chuyện.
 */
export function startAlarm(): void {
  if (muted) return;

  // Ưu tiên chuông báo thức của hệ điều hành: to hơn, kêu được cả khi màn hình
  // tắt, và đi theo âm lượng báo thức chứ không phải âm lượng media.
  const plugin = getSensorPlugin();
  if (plugin) {
    plugin.startAlarm().catch(() => startWebAudioSiren());
    return;
  }

  startWebAudioSiren();
}

function startWebAudioSiren(): void {
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  if (sirenTimerId !== null) return; // đang kêu rồi

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.value = 660;
  gain.gain.value = 0.0001;

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();

  // Vào tiếng mượt trong 80 ms cho đỡ "bụp"
  gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.08);
  currentNodes = { osc, gain };

  let high = false;
  sirenTimerId = window.setInterval(() => {
    if (!currentNodes || !audioContext) return;
    high = !high;
    currentNodes.osc.frequency.setTargetAtTime(
      high ? 990 : 660,
      audioContext.currentTime,
      0.05
    );
  }, 500);
}

/** Tắt còi ngay lập tức */
export function stopAlarm(): void {
  getSensorPlugin()?.stopAlarm().catch(() => undefined);

  if (sirenTimerId !== null) {
    window.clearInterval(sirenTimerId);
    sirenTimerId = null;
  }

  if (currentNodes && audioContext) {
    const { osc, gain } = currentNodes;
    currentNodes = null;
    try {
      // Tắt dần trong 60 ms rồi mới dừng, tránh tiếng "cụp" khó chịu
      gain.gain.setTargetAtTime(0.0001, audioContext.currentTime, 0.02);
      osc.stop(audioContext.currentTime + 0.06);
    } catch {
      /* nút đã dừng từ trước */
    }
  }
}

/** Kêu một tiếng bíp ngắn — dùng để người dùng thử tiếng trong Cài đặt */
export function playTestBeep(): void {
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = 880;
  gain.gain.value = 0.0001;
  osc.connect(gain);
  gain.connect(ctx.destination);

  const now = ctx.currentTime;
  osc.start(now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
  gain.gain.setTargetAtTime(0.0001, now + 0.18, 0.03);
  osc.stop(now + 0.35);
}
