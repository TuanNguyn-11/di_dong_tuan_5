// ============================================================
// alarm.ts — Chuông báo khi có cảnh báo té ngã mới
// ============================================================
// Có HAI đường phát tiếng, ưu tiên từ trên xuống:
//
//   1. Plugin native (bản APK) — phát chuông báo thức của hệ thống qua luồng
//      ALARM. Đi theo âm lượng báo thức nên kêu cả khi máy để im lặng, và không
//      phụ thuộc AudioContext của WebView.
//
//   2. Web Audio (trình duyệt máy tính) — tự tổng hợp tiếng, không cần file .mp3.
//
// Vì sao không chỉ dùng Web Audio: trong WebView, Web Audio phát qua luồng MEDIA.
// Rất nhiều người để âm lượng chuông to nhưng âm lượng media bằng 0, thế là
// chuông báo té ngã im re mà không ai biết — đúng triệu chứng đã gặp khi thử máy thật.

import { getAlarmPlugin } from './native';

let audioContext: AudioContext | null = null;
let muted = false;

/** Đường phát tiếng của lần gọi gần nhất — dùng cho nút "Nghe thử tiếng" báo lại */
export type SoundRoute = 'native' | 'webaudio' | 'none';

export function setChimeMuted(value: boolean): void {
  muted = value;
  if (muted) stopAlert();
}

export function isChimeMuted(): boolean {
  return muted;
}

// ------------------------------------------------------------
// WEB AUDIO (dự phòng cho trình duyệt)
// ------------------------------------------------------------

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
 * Gọi mỗi khi người dùng chạm vào màn hình.
 * Trình duyệt di động chặn phát tiếng cho tới khi có thao tác thật của người
 * dùng. Cố tình gọi ở MỌI lần chạm chứ không chỉ lần đầu, vì Android treo
 * AudioContext mỗi lần app xuống nền.
 */
export function unlockAudio(): void {
  const ctx = getContext();
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }
}

/** Một tiếng bíp đơn tại thời điểm `at` (giây, theo đồng hồ của AudioContext) */
function beepAt(ctx: AudioContext, at: number, frequency: number, duration: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = frequency;

  osc.connect(gain);
  gain.connect(ctx.destination);

  // setValueAtTime là MỐC NEO bắt buộc: exponentialRampToValueAtTime cần một sự
  // kiện đứng trước để biết ramp bắt đầu từ đâu và từ lúc nào. Thiếu nó thì ramp
  // tính từ thời điểm hiện tại chứ không phải `at`, và tiếng bíp hẹn giờ trong
  // tương lai sẽ ra sai hoặc câm.
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.6, at + 0.02);
  gain.gain.setTargetAtTime(0.0001, at + duration * 0.6, 0.05);

  osc.start(at);
  osc.stop(at + duration + 0.1);
}

/** Hẹn giờ ba hồi chuông, mỗi hồi cách nhau 1,2 giây */
function scheduleChime(ctx: AudioContext, rounds: number): void {
  const start = ctx.currentTime + 0.05;
  for (let round = 0; round < rounds; round++) {
    const base = start + round * 1.2;
    beepAt(ctx, base, 880, 0.16);
    beepAt(ctx, base + 0.22, 1108, 0.16);
    beepAt(ctx, base + 0.44, 1318, 0.34);
  }
}

/**
 * Phát bằng Web Audio. Trả về true nếu đã hẹn giờ được.
 *
 * PHẢI đợi resume() xong rồi mới hẹn giờ: lúc AudioContext bị treo, đồng hồ
 * ctx.currentTime đứng yên, hẹn giờ ngay thì tới khi context chạy lại mọi mốc
 * thời gian đã nằm trong quá khứ và tiếng chuông rơi vào im lặng.
 */
function playWebAudio(rounds: number): boolean {
  const ctx = getContext();
  if (!ctx) return false;

  if (ctx.state === 'suspended') {
    void ctx.resume().then(() => scheduleChime(ctx, rounds)).catch(() => undefined);
  } else {
    scheduleChime(ctx, rounds);
  }
  return true;
}

function vibrateFallback(): void {
  try {
    navigator.vibrate?.([0, 400, 200, 400, 200, 400, 200, 600]);
  } catch {
    /* trình duyệt không hỗ trợ rung */
  }
}

// ------------------------------------------------------------
// PHÁT CHUÔNG
// ------------------------------------------------------------

/**
 * Chuông báo cảnh báo té ngã.
 * Trên APK: chuông báo thức hệ thống, lặp 15 giây rồi tự tắt.
 * Trên trình duyệt: ba hồi chuông tổng hợp bằng Web Audio.
 */
export async function playAlertChime(): Promise<SoundRoute> {
  if (muted) return 'none';
  return playSound({ loop: true, durationMs: 15000, webAudioRounds: 3 });
}

/** Nghe thử trong Cài đặt — kêu ngắn, không lặp. Bỏ qua trạng thái tắt tiếng. */
export async function playTestChime(): Promise<SoundRoute> {
  return playSound({ loop: false, durationMs: 4000, webAudioRounds: 1 });
}

async function playSound(options: {
  loop: boolean;
  durationMs: number;
  webAudioRounds: number;
}): Promise<SoundRoute> {
  const plugin = getAlarmPlugin();

  if (plugin) {
    try {
      const result = await plugin.play({
        loop: options.loop,
        durationMs: options.durationMs,
        vibrate: true,
      });
      if (result.played) return 'native';
    } catch {
      // Plugin lỗi — rơi xuống Web Audio bên dưới.
    }
  }

  vibrateFallback();
  return playWebAudio(options.webAudioRounds) ? 'webaudio' : 'none';
}

/** Tắt chuông đang kêu */
export function stopAlert(): void {
  getAlarmPlugin()?.stop().catch(() => undefined);
}

/** Mô tả đường phát tiếng bằng tiếng Việt, để hiện lên màn hình cho dễ chẩn đoán */
export function describeRoute(route: SoundRoute): string {
  if (route === 'native') return 'Đã phát chuông báo thức của hệ thống.';
  if (route === 'webaudio') {
    return 'Đã phát bằng Web Audio. Nếu không nghe thấy, hãy tăng âm lượng ĐA PHƯƠNG TIỆN của máy.';
  }
  return 'Máy này không phát được tiếng.';
}
