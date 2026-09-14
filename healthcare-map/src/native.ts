// ============================================================
// native.ts — Cầu nối tới plugin native của bản APK
// ============================================================
// Truy cập plugin qua `window.Capacitor.Plugins` thay vì `import`, để dự án vẫn
// biên dịch và chạy được trên trình duyệt máy tính — nơi không có plugin nào.
// Mọi nơi gọi đều phải chịu được giá trị undefined.

export interface AlarmSoundPlayResult {
  played: boolean;
  reason?: string;
}

/**
 * Plugin phát chuông báo, mã nguồn ở
 * android/app/src/main/java/com/healthcaremap/tracker/AlarmSoundPlugin.java
 */
export interface AlarmSoundPlugin {
  isAvailable: () => Promise<{ available: boolean }>;
  play: (options: {
    loop?: boolean;
    durationMs?: number;
    vibrate?: boolean;
  }) => Promise<AlarmSoundPlayResult>;
  stop: () => Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: {
    AlarmSound?: AlarmSoundPlugin;
  };
}

function capacitor(): CapacitorGlobal | undefined {
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** App có đang chạy trong vỏ native Android (Capacitor) không? */
export function isNativePlatform(): boolean {
  const cap = capacitor();
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform();
}

/** Plugin chuông báo, hoặc undefined khi chạy trên trình duyệt */
export function getAlarmPlugin(): AlarmSoundPlugin | undefined {
  return capacitor()?.Plugins?.AlarmSound;
}
