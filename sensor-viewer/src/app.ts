// ============================================================
// app.ts — Web xem dạng sóng cảm biến theo thời gian thực
// ============================================================
// Chạy trên máy tính, dùng chung tài khoản với hai app điện thoại.
// Đăng nhập bằng tài khoản nào cũng được:
//   - tài khoản Fall Guard  → xem máy của chính mình
//   - tài khoản người thân  → xem các máy đã ghép cặp
//
// Dữ liệu tới từ Realtime Database, do app Fall Guard đẩy lên khi đang bật
// "Giám sát cảm biến".

import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth';
import { auth } from './firebase';
import { isFirebaseConfigured, isRealtimeDbConfigured } from './firebase-config';
import {
  listViewableDevices,
  subscribeStream,
  type Sample,
  type StreamHandle,
  type StreamMeta,
  type ViewableDevice,
} from './stream';
import { ACCEL_CHANNELS, GYRO_CHANNELS, drawChart } from './chart';

// ------------------------------------------------------------
// STATE
// ------------------------------------------------------------

let currentUser: User | null = null;
let devices: ViewableDevice[] = [];
let selectedDeviceId: string | null = null;
let streamHandle: StreamHandle | null = null;
let meta: StreamMeta | null = null;

/** Toàn bộ mẫu đang giữ trong bộ nhớ, sắp xếp theo thời gian tăng dần */
let samples: Sample[] = [];

/** Giữ tối đa 3 phút dữ liệu — quá nữa thì vừa tốn RAM vừa chẳng ai xem lại */
const MAX_BUFFER_MS = 180_000;

let windowMs = 10_000;
let paused = false;
/** Thời điểm bấm tạm dừng, để khung hình đứng yên đúng chỗ đó */
let pausedAt = 0;

const visibleChannels = new Set<string>(['ax', 'ay', 'az', 'gx', 'gy', 'gz']);
let animationId = 0;

// ------------------------------------------------------------
// TIỆN ÍCH
// ------------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function showToast(message: string): void {
  const toast = $<HTMLDivElement>('toast');
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout((showToast as unknown as { _t?: number })._t);
  (showToast as unknown as { _t?: number })._t = window.setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showScreen(name: 'login' | 'viewer'): void {
  $<HTMLElement>('screen-login').hidden = name !== 'login';
  $<HTMLElement>('screen-viewer').hidden = name !== 'viewer';
}

// ------------------------------------------------------------
// ĐĂNG NHẬP
// ------------------------------------------------------------

function initLogin(): void {
  const form = $<HTMLFormElement>('login-form');
  const emailInput = $<HTMLInputElement>('login-email');
  const passwordInput = $<HTMLInputElement>('login-password');
  const errorBox = $<HTMLParagraphElement>('login-error');
  const submitBtn = $<HTMLButtonElement>('login-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Đang đăng nhập...';

    try {
      await signInWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value);
      passwordInput.value = '';
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      errorBox.textContent =
        code === 'auth/invalid-credential' || code === 'auth/wrong-password'
          ? 'Email hoặc mật khẩu không đúng.'
          : 'Không đăng nhập được: ' + ((error as Error).message ?? code);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Đăng nhập';
    }
  });

  $<HTMLButtonElement>('btn-logout').addEventListener('click', () => void signOut(auth));
}

// ------------------------------------------------------------
// DANH SÁCH THIẾT BỊ
// ------------------------------------------------------------

async function loadDevices(): Promise<void> {
  if (!currentUser) return;

  const select = $<HTMLSelectElement>('device-select');
  select.innerHTML = '<option value="">Đang tải...</option>';

  devices = await listViewableDevices(currentUser.uid);

  if (devices.length === 0) {
    select.innerHTML = '<option value="">(không có thiết bị nào)</option>';
    showToast(
      'Tài khoản này chưa gắn với thiết bị nào. Đăng nhập bằng tài khoản Fall Guard, hoặc bằng tài khoản người thân đã ghép cặp.'
    );
    return;
  }

  select.innerHTML = devices
    .map((d) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label)}</option>`)
    .join('');

  selectDevice(devices[0].deviceId);
}

function selectDevice(deviceId: string): void {
  if (selectedDeviceId === deviceId) return;

  streamHandle?.stop();
  streamHandle = null;
  samples = [];
  meta = null;
  selectedDeviceId = deviceId;
  $<HTMLSelectElement>('device-select').value = deviceId;
  $<HTMLSpanElement>('device-id-label').textContent = deviceId;

  streamHandle = subscribeStream(deviceId, {
    onMeta: (value) => {
      meta = value;
      renderStatus();
    },
    onSamples: (batch) => {
      appendSamples(batch);
    },
    onError: (message) => showToast(message),
  });

  renderStatus();
}

function appendSamples(batch: Sample[]): void {
  if (batch.length === 0) return;

  samples = samples.concat(batch);
  samples.sort((a, b) => a.t - b.t);

  // Cắt bớt phần quá cũ
  const cutoff = samples[samples.length - 1].t - MAX_BUFFER_MS;
  const firstKeep = samples.findIndex((s) => s.t >= cutoff);
  if (firstKeep > 0) samples = samples.slice(firstKeep);

  renderStatus();
}

// ------------------------------------------------------------
// TRẠNG THÁI & BIỂU ĐỒ
// ------------------------------------------------------------

function renderStatus(): void {
  const dot = $<HTMLSpanElement>('status-dot');
  const text = $<HTMLSpanElement>('status-text');

  if (!meta) {
    dot.className = 'status-dot status-dot--off';
    text.textContent = 'Chưa có luồng nào — máy người dùng chưa từng bật giám sát.';
  } else if (!meta.streaming) {
    dot.className = 'status-dot status-dot--off';
    text.textContent = 'Đã dừng phát (máy người dùng tắt giám sát). Vẫn xem lại được dữ liệu cũ.';
  } else {
    const lastAge = samples.length > 0 ? Date.now() - samples[samples.length - 1].t : Infinity;
    if (lastAge < 5000) {
      dot.className = 'status-dot status-dot--live';
      text.textContent = `Đang phát trực tiếp · ${meta.hz} Hz`;
    } else {
      dot.className = 'status-dot status-dot--stale';
      text.textContent = 'Đang bật giám sát nhưng chưa nhận được dữ liệu — có thể máy đang mất mạng.';
    }
  }

  $<HTMLSpanElement>('sample-count').textContent = `${samples.length} mẫu trong bộ nhớ`;
}

function currentEndTime(): number {
  if (paused) return pausedAt;
  // Bám theo mẫu mới nhất, không bám đồng hồ máy tính: hai máy lệch giờ vài giây
  // là chuyện thường, bám đồng hồ sẽ thấy sóng bị đẩy lệch khỏi khung.
  return samples.length > 0 ? samples[samples.length - 1].t : Date.now();
}

function renderFrame(): void {
  const endTime = currentEndTime();
  drawChart($<HTMLCanvasElement>('chart-accel'), {
    samples,
    channels: ACCEL_CHANNELS,
    visible: visibleChannels,
    windowMs,
    endTime,
    unit: 'm/s²',
    title: 'Gia tốc kế',
  });
  drawChart($<HTMLCanvasElement>('chart-gyro'), {
    samples,
    channels: GYRO_CHANNELS,
    visible: visibleChannels,
    windowMs,
    endTime,
    unit: '°/s',
    title: 'Con quay hồi chuyển',
  });

  animationId = window.requestAnimationFrame(renderFrame);
}

// ------------------------------------------------------------
// ĐIỀU KHIỂN
// ------------------------------------------------------------

function initControls(): void {
  $<HTMLSelectElement>('device-select').addEventListener('change', (e) => {
    const value = (e.target as HTMLSelectElement).value;
    if (value) selectDevice(value);
  });

  $<HTMLButtonElement>('btn-reload-devices').addEventListener('click', () => void loadDevices());

  document.querySelectorAll<HTMLButtonElement>('[data-window]').forEach((btn) => {
    btn.addEventListener('click', () => {
      windowMs = Number(btn.dataset.window) * 1000;
      document
        .querySelectorAll<HTMLButtonElement>('[data-window]')
        .forEach((b) => b.classList.toggle('chip--active', b === btn));
    });
  });

  document.querySelectorAll<HTMLInputElement>('[data-channel]').forEach((box) => {
    box.addEventListener('change', () => {
      const key = box.dataset.channel!;
      if (box.checked) visibleChannels.add(key);
      else visibleChannels.delete(key);
    });
  });

  const pauseBtn = $<HTMLButtonElement>('btn-pause');
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pausedAt = currentEndTime();
    pauseBtn.textContent = paused ? '▶ Tiếp tục' : '⏸ Tạm dừng';
    pauseBtn.classList.toggle('btn--warning', paused);
  });

  $<HTMLButtonElement>('btn-export').addEventListener('click', exportCsv);
  $<HTMLButtonElement>('btn-clear').addEventListener('click', () => {
    samples = [];
    renderStatus();
    showToast('Đã xoá dữ liệu trong bộ nhớ (không đụng tới dữ liệu trên máy chủ)');
  });
}

/** Xuất toàn bộ mẫu đang giữ ra CSV để đồng đội dùng huấn luyện model */
function exportCsv(): void {
  if (samples.length === 0) {
    showToast('Chưa có dữ liệu để xuất.');
    return;
  }

  const header = 'timestamp_ms,iso_time,ax,ay,az,gx,gy,gz\n';
  const rows = samples
    .map((s) =>
      [
        s.t,
        new Date(s.t).toISOString(),
        s.ax,
        s.ay,
        s.az,
        s.gx,
        s.gy,
        s.gz,
      ].join(',')
    )
    .join('\n');

  const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  link.href = url;
  link.download = `sensor-${selectedDeviceId ?? 'device'}-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast(`Đã xuất ${samples.length} mẫu ra file CSV.`);
}

// ------------------------------------------------------------
// KHỞI TẠO
// ------------------------------------------------------------

function initApp(): void {
  initLogin();
  initControls();

  if (!isFirebaseConfigured()) {
    $<HTMLDivElement>('config-warning').hidden = false;
    $<HTMLDivElement>('config-warning').textContent =
      'Chưa cấu hình Firebase. Điền fall-guard-app/src/firebase-config.ts rồi chạy lại npm run build.';
    return;
  }

  if (!isRealtimeDbConfigured()) {
    $<HTMLDivElement>('config-warning').hidden = false;
    $<HTMLDivElement>('config-warning').textContent =
      'Chưa bật Realtime Database. Điền databaseURL trong fall-guard-app/src/firebase-config.ts, dán database.rules.json, rồi chạy lại npm run build ở cả fall-guard-app và sensor-viewer.';
  }

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (user) {
      $<HTMLSpanElement>('account-email').textContent = user.email ?? '';
      showScreen('viewer');
      void loadDevices();
      if (animationId === 0) animationId = window.requestAnimationFrame(renderFrame);
    } else {
      streamHandle?.stop();
      streamHandle = null;
      selectedDeviceId = null;
      samples = [];
      meta = null;
      if (animationId !== 0) {
        window.cancelAnimationFrame(animationId);
        animationId = 0;
      }
      showScreen('login');
    }
  });
}

document.addEventListener('DOMContentLoaded', initApp);
