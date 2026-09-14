// ============================================================
// app.ts — Điều hướng, xác thực, cảm biến, AI mock & đồng bộ Firestore
// Fall Guard — Phát hiện té ngã dành cho người có nguy cơ
// ============================================================

import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth } from './firebase';
import { isFirebaseConfigured } from './firebase-config';
import {
  cancelRegistration,
  describeAuthError,
  ensureUserDoc,
  hasCorrectRole,
  WRONG_ROLE_MESSAGE,
  getPendingEmail,
  getResendCooldownSeconds,
  patchUserDoc,
  resendOtp,
  sendResetPasswordEmail,
  signIn,
  signOutUser,
  startRegistration,
  verifyOtpAndCreateAccount,
} from './auth';
import {
  createDeviceWithNewId,
  deletePairRequest,
  getCurrentOtp,
  getOtpRemainingMs,
  pushFallEvent,
  pushHeartbeat,
  removeGuardian,
  resolvePairRequest,
  rotateOtp,
  subscribeDevice,
  subscribeFallEvents,
  subscribePairRequests,
  toLinkedGuardians,
  updateDeviceName,
} from './device';
import {
  isNativePlatform,
  readBatteryLevel,
  requestBatteryExemption,
  setNativeThreshold,
  startNativeMonitor,
  watchLocation,
  type GeoWatchHandle,
  type NativeMonitorHandle,
  type SensorBatch,
} from './native';
import {
  feedSample,
  isLiveStreamAvailable,
  startLiveStream,
  stopLiveStream,
  updateStreamViewers,
} from './live-stream';
import {
  isAlarmMuted,
  playTestBeep,
  setAlarmMuted,
  startAlarm,
  stopAlarm,
  unlockAudio,
} from './alarm';
import type {
  AppSettings,
  DeviceDoc,
  EmergencyContact,
  FallAiResult,
  FallEvent,
  LinkedGuardian,
  PageName,
  SensorSample,
  SensorStatus,
  SensorWindow,
  UserProfile,
} from './types';

// ------------------------------------------------------------
// STATE — dữ liệu ứng dụng
// ------------------------------------------------------------

let currentUser: User | null = null;
let userProfile: UserProfile | null = null;
let deviceDoc: DeviceDoc | null = null;
let linkedGuardians: LinkedGuardian[] = [];

let emergencyContacts: EmergencyContact[] = [];
let fallEvents: FallEvent[] = [];
/** Các mốc thời gian đếm ngược cho phép chọn (giây) */
const COUNTDOWN_CHOICES = [5, 10, 15];
const DEFAULT_COUNTDOWN_SEC = 10;

let appSettings: AppSettings = {
  sensitivity: 'medium',
  cancelCountdownSec: DEFAULT_COUNTDOWN_SEC,
  includeGpsInAlert: true,
  monitoringEnabled: false,
  alarmMuted: false,
};
let sensorStatus: SensorStatus = {
  gps: 'off',
  accelerometer: 'off',
  gyroscope: 'off',
};

// Vị trí hiện tại — null khi chưa có định vị thật lần nào
let currentLatitude: number | null = null;
let currentLongitude: number | null = null;
let currentAccuracy: number | null = null;
let currentBattery: number | null = null;

// Sensor rolling buffer
const SENSOR_BUFFER_MAX = 100; // ~2 giây ở 50Hz
let sensorBuffer: SensorSample[] = [];
let monitoringIntervalId: number | null = null;
let countdownIntervalId: number | null = null;
let geoWatch: GeoWatchHandle | null = null;
let nativeMonitor: NativeMonitorHandle | null = null;
let heartbeatIntervalId: number | null = null;
let otpTickIntervalId: number | null = null;
let countdownRemaining = 0;
let currentFallConfidence = 0;

// Huỷ đăng ký các luồng realtime khi đăng xuất
let unsubscribeDevice: (() => void) | null = null;
let unsubscribeEvents: (() => void) | null = null;
let unsubscribeRequests: (() => void) | null = null;

// Các yêu cầu ghép cặp đang được xử lý — tránh xử lý trùng
const handlingRequests = new Set<string>();
let pairingLog: string[] = [];

// Ngưỡng phát hiện sơ bộ theo độ nhạy (m/s², gia tốc tổng hợp)
/** Gia tốc trọng trường, m/s². Dùng để quy đổi giữa m/s² và g. */
const G = 9.81;

/**
 * Ngưỡng phát hiện va đập, tính bằng **g²** — tức bình phương biên độ gia tốc
 * tổng hợp đã chuẩn hoá theo trọng lực.
 *
 * Vì sao so sánh bình phương thay vì lấy căn:
 *   |a| > T   hoàn toàn tương đương   |a|² > T²   (cả hai vế đều dương)
 * nên bỏ được phép căn bậc hai ở mỗi mẫu. Với 50 mẫu/giây chạy liên tục dưới nền
 * thì đây là phép tối ưu đáng giá, lại đúng cách các bài báo về phát hiện té ngã
 * hay trình bày ngưỡng (đơn vị g²).
 *
 * Quy đổi:  T(g) = √(T(g²))        T(m/s²) = T(g) × 9.81
 *   Thấp  4.00 g²  →  2.0 g  ≈ 19.6 m/s²
 *   Vừa   2.56 g²  →  1.6 g  ≈ 15.7 m/s²
 *   Cao   1.96 g²  →  1.4 g  ≈ 13.7 m/s²
 */
const SENSITIVITY_THRESHOLDS_G2: Record<string, number> = {
  low: 4.0,
  medium: 2.56,
  high: 1.96,
};

/** Ngưỡng mặc định khi giá trị độ nhạy không hợp lệ */
const DEFAULT_THRESHOLD_G2 = 2.56;

/**
 * Mốc "va đập mạnh" dùng để quy đổi độ tin cậy: 3 g → 9 g².
 * Chỉ là mốc tham chiếu để hiển thị, không tham gia quyết định có té ngã hay không.
 */
const SEVERE_IMPACT_G2 = 9.0;

/** Ngưỡng g² đang áp dụng theo độ nhạy người dùng chọn */
function currentThresholdG2(): number {
  return SENSITIVITY_THRESHOLDS_G2[appSettings.sensitivity] ?? DEFAULT_THRESHOLD_G2;
}

/** Bình phương biên độ gia tốc tổng hợp, tính bằng g²: (ax²+ay²+az²) / g² */
function magnitudeSquaredG2(ax: number, ay: number, az: number): number {
  return (ax * ax + ay * ay + az * az) / (G * G);
}

/** Quy đổi ngưỡng g² sang m/s² để gửi xuống dịch vụ nền native */
function thresholdG2ToMs2(thresholdG2: number): number {
  return Math.sqrt(thresholdG2) * G;
}

/** Nhịp đẩy trạng thái lên Firestore (ms). Healthcare Map coi > 90s là offline. */
const HEARTBEAT_MS = 30_000;

// ------------------------------------------------------------
// TIỆN ÍCH CHUNG
// ------------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Định dạng giờ hiện tại theo HH:MM:SS */
function formatNowTime(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** Hiển thị thông báo toast ngắn ở dưới màn hình */
function showToast(message: string): void {
  const toast = document.getElementById('toast') as HTMLDivElement | null;
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout((showToast as unknown as { _t?: number })._t);
  (showToast as unknown as { _t?: number })._t = window.setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

/** Chống chèn HTML khi in dữ liệu người dùng nhập ra màn hình */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Sao chép text vào clipboard */
function copyToClipboard(text: string, successMessage: string): void {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => showToast(successMessage))
      .catch(() => fallbackCopy(text, successMessage));
  } else {
    fallbackCopy(text, successMessage);
  }
}

function fallbackCopy(text: string, successMessage: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast(successMessage);
  } catch {
    showToast('Không thể sao chép');
  }
  document.body.removeChild(ta);
}

/** Bật/tắt trạng thái "đang xử lý" cho một nút bấm */
function setButtonBusy(button: HTMLButtonElement, busy: boolean, busyLabel = 'Đang xử lý...'): void {
  if (busy) {
    button.dataset.originalLabel = button.textContent ?? '';
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel ?? button.textContent ?? '';
    button.disabled = false;
  }
}

// ------------------------------------------------------------
// PERSISTENCE — localStorage (chỉ dữ liệu riêng của máy)
// ------------------------------------------------------------
// Danh bạ khẩn cấp và cài đặt độ nhạy là thứ chỉ máy này dùng, để dưới máy cho
// nhanh. Mọi dữ liệu người thân cần thấy đều nằm trên Firestore.

function storageKey(suffix: string): string {
  return `fg_${suffix}_${currentUser ? currentUser.uid : 'anon'}`;
}

function loadContacts(): void {
  const saved = localStorage.getItem(storageKey('contacts'));
  if (saved) {
    try {
      emergencyContacts = JSON.parse(saved);
    } catch {
      emergencyContacts = [];
    }
  } else {
    emergencyContacts = [];
  }
}

function saveContacts(): void {
  localStorage.setItem(storageKey('contacts'), JSON.stringify(emergencyContacts));
}

function loadSettings(): void {
  appSettings = {
    sensitivity: 'medium',
    cancelCountdownSec: DEFAULT_COUNTDOWN_SEC,
    includeGpsInAlert: true,
    monitoringEnabled: false,
    alarmMuted: false,
  };
  const saved = localStorage.getItem(storageKey('settings'));
  if (saved) {
    try {
      appSettings = { ...appSettings, ...JSON.parse(saved) };
    } catch {
      /* dùng mặc định */
    }
  }

  // Bản cũ cho chọn 10/20/30 giây. Nếu máy còn lưu giá trị cũ (20 hoặc 30) thì
  // không nút nào khớp và giao diện trông như chưa chọn gì — đưa về mặc định.
  if (!COUNTDOWN_CHOICES.includes(appSettings.cancelCountdownSec)) {
    appSettings.cancelCountdownSec = DEFAULT_COUNTDOWN_SEC;
  }

  setAlarmMuted(appSettings.alarmMuted === true);
}

function saveSettings(): void {
  localStorage.setItem(storageKey('settings'), JSON.stringify(appSettings));
}

// ------------------------------------------------------------
// ĐIỀU HƯỚNG (SPA PATTERN)
// ------------------------------------------------------------

interface NavItem {
  key: PageName;
  label: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    key: 'home',
    label: 'Trang chủ',
    icon: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>',
  },
  {
    key: 'pairing',
    label: 'Kết nối',
    icon: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><path d="M8 12h8"/>',
  },
  {
    key: 'history',
    label: 'Lịch sử',
    icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  },
  {
    key: 'contacts',
    label: 'Danh bạ',
    icon:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>' +
      '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
  },
  {
    key: 'settings',
    label: 'Cài đặt',
    icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.63 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.37 9a1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
  },
];

/**
 * Dựng thanh điều hướng dưới cùng cho mọi trang có `data-nav-host`.
 * Viết bằng JS để khỏi lặp lại khối HTML giống hệt nhau ở 5 trang.
 */
function buildBottomNavs(): void {
  document.querySelectorAll<HTMLElement>('[data-nav-host]').forEach((host) => {
    host.innerHTML = NAV_ITEMS.map(
      (item) => `
      <button type="button" class="bottom-nav__item" data-nav="${item.key}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${item.icon}</svg>
        <span>${item.label}</span>
      </button>`
    ).join('');
  });
}

function setActivePage(page: PageName): void {
  document.querySelectorAll<HTMLElement>('.page').forEach((el) => {
    el.classList.toggle('page--active', el.dataset.page === page);
  });

  document.querySelectorAll<HTMLButtonElement>('.bottom-nav__item').forEach((btn) => {
    btn.classList.toggle('bottom-nav__item--active', btn.dataset.nav === page);
  });

  window.scrollTo(0, 0);
}

function showLogin(): void {
  setActivePage('login');
}

function showRegister(): void {
  setActivePage('register');
}

function showOtpPage(): void {
  $<HTMLSpanElement>('otp-email-label').textContent = getPendingEmail() ?? '';
  $<HTMLInputElement>('otp-input').value = '';
  $<HTMLParagraphElement>('error-otp').textContent = '';
  startResendCooldownTicker();
  setActivePage('otp');
}

function showForgot(): void {
  $<HTMLParagraphElement>('forgot-success').hidden = true;
  setActivePage('forgot');
}

function showOnboarding(): void {
  setActivePage('onboarding');
}

function showHome(): void {
  renderHome();
  setActivePage('home');
}

function showPairing(): void {
  renderPairing();
  startOtpTicker();
  setActivePage('pairing');
}

function showFallAlert(confidence: number): void {
  // Chốt chặn cuối: tắt giám sát thì tuyệt đối không có cảnh báo nào được phát.
  if (!appSettings.monitoringEnabled) return;

  currentFallConfidence = confidence;
  renderFallAlert();
  setActivePage('fallAlert');
  startAlarm();
  startCountdown();
}

function showHistory(): void {
  renderHistory();
  setActivePage('history');
}

function showContacts(): void {
  renderContacts();
  setActivePage('contacts');
}

function showSettings(): void {
  renderSettings();
  setActivePage('settings');
}

// ------------------------------------------------------------
// XÁC THỰC — ĐĂNG NHẬP
// ------------------------------------------------------------

function initLoginPage(): void {
  const form = $<HTMLFormElement>('login-form');
  const emailInput = $<HTMLInputElement>('login-email');
  const passwordInput = $<HTMLInputElement>('login-password');
  const errorEmail = $<HTMLParagraphElement>('error-login-email');
  const errorPassword = $<HTMLParagraphElement>('error-login-password');
  const submitBtn = $<HTMLButtonElement>('login-submit');
  const toggleBtn = $<HTMLButtonElement>('toggle-login-password');

  toggleBtn.addEventListener('click', () => {
    const isVisible = toggleBtn.dataset.visible === 'true';
    passwordInput.type = isVisible ? 'password' : 'text';
    toggleBtn.dataset.visible = (!isVisible).toString();
    toggleBtn.setAttribute('aria-label', isVisible ? 'Hiện mật khẩu' : 'Ẩn mật khẩu');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    let valid = true;

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      errorEmail.textContent = 'Vui lòng nhập đúng định dạng email.';
      emailInput.classList.add('input--invalid');
      valid = false;
    } else {
      errorEmail.textContent = '';
      emailInput.classList.remove('input--invalid');
    }

    if (password.length < 6) {
      errorPassword.textContent = 'Mật khẩu phải có ít nhất 6 ký tự.';
      passwordInput.classList.add('input--invalid');
      valid = false;
    } else {
      errorPassword.textContent = '';
      passwordInput.classList.remove('input--invalid');
    }

    if (!valid) return;

    setButtonBusy(submitBtn, true, 'Đang đăng nhập...');
    try {
      await signIn(email, password);
      passwordInput.value = '';
      // onAuthStateChanged sẽ tự chuyển sang trang phù hợp.
    } catch (error) {
      errorPassword.textContent = describeAuthError(error);
    } finally {
      setButtonBusy(submitBtn, false);
    }
  });

  $<HTMLAnchorElement>('link-to-register').addEventListener('click', (e) => {
    e.preventDefault();
    showRegister();
  });

  $<HTMLAnchorElement>('link-to-forgot').addEventListener('click', (e) => {
    e.preventDefault();
    $<HTMLInputElement>('forgot-email').value = emailInput.value.trim();
    showForgot();
  });
}

// ------------------------------------------------------------
// XÁC THỰC — ĐĂNG KÝ + OTP QUA EMAIL
// ------------------------------------------------------------

function initRegisterPage(): void {
  const form = $<HTMLFormElement>('register-form');
  const nameInput = $<HTMLInputElement>('register-name');
  const emailInput = $<HTMLInputElement>('register-email');
  const passwordInput = $<HTMLInputElement>('register-password');
  const confirmInput = $<HTMLInputElement>('register-password2');
  const submitBtn = $<HTMLButtonElement>('register-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirm = confirmInput.value;
    let valid = true;

    const setError = (id: string, input: HTMLInputElement, message: string) => {
      $<HTMLParagraphElement>(id).textContent = message;
      input.classList.toggle('input--invalid', message !== '');
      if (message) valid = false;
    };

    setError('error-register-name', nameInput, name ? '' : 'Vui lòng nhập họ tên.');
    setError(
      'error-register-email',
      emailInput,
      /^\S+@\S+\.\S+$/.test(email) ? '' : 'Vui lòng nhập đúng định dạng email.'
    );
    setError(
      'error-register-password',
      passwordInput,
      password.length >= 6 ? '' : 'Mật khẩu phải có ít nhất 6 ký tự.'
    );
    setError(
      'error-register-password2',
      confirmInput,
      password === confirm ? '' : 'Mật khẩu nhập lại không khớp.'
    );

    if (!valid) return;

    setButtonBusy(submitBtn, true, 'Đang gửi mã...');
    try {
      await startRegistration(name, email, password);
      showToast('Đã gửi mã OTP tới email của bạn.');
      showOtpPage();
    } catch (error) {
      $<HTMLParagraphElement>('error-register-email').textContent = describeAuthError(error);
    } finally {
      setButtonBusy(submitBtn, false);
    }
  });

  $<HTMLAnchorElement>('link-back-login').addEventListener('click', (e) => {
    e.preventDefault();
    showLogin();
  });
}

let resendTickerId: number | null = null;

function startResendCooldownTicker(): void {
  if (resendTickerId !== null) window.clearInterval(resendTickerId);
  const hint = $<HTMLParagraphElement>('otp-resend-hint');
  const resendBtn = $<HTMLButtonElement>('btn-resend-otp');

  const tick = () => {
    const seconds = getResendCooldownSeconds();
    if (seconds > 0) {
      resendBtn.disabled = true;
      hint.textContent = `Có thể gửi lại sau ${seconds} giây`;
    } else {
      resendBtn.disabled = false;
      hint.textContent = 'Không nhận được mã? Kiểm tra hộp thư Spam hoặc gửi lại.';
      if (resendTickerId !== null) {
        window.clearInterval(resendTickerId);
        resendTickerId = null;
      }
    }
  };

  tick();
  resendTickerId = window.setInterval(tick, 1000);
}

function initOtpPage(): void {
  const otpInput = $<HTMLInputElement>('otp-input');
  const errorOtp = $<HTMLParagraphElement>('error-otp');
  const verifyBtn = $<HTMLButtonElement>('btn-verify-otp');
  const resendBtn = $<HTMLButtonElement>('btn-resend-otp');

  otpInput.addEventListener('input', () => {
    otpInput.value = otpInput.value.replace(/\D/g, '').slice(0, 6);
  });

  verifyBtn.addEventListener('click', async () => {
    const code = otpInput.value.trim();
    if (code.length !== 6) {
      errorOtp.textContent = 'Mã OTP gồm đúng 6 chữ số.';
      return;
    }

    setButtonBusy(verifyBtn, true, 'Đang xác thực...');
    try {
      await verifyOtpAndCreateAccount(code);
      showToast('Tạo tài khoản thành công!');
      // onAuthStateChanged sẽ đưa sang màn hình đặt tên / trang chủ.
    } catch (error) {
      errorOtp.textContent = describeAuthError(error);
    } finally {
      setButtonBusy(verifyBtn, false);
    }
  });

  resendBtn.addEventListener('click', async () => {
    setButtonBusy(resendBtn, true, 'Đang gửi...');
    try {
      await resendOtp();
      showToast('Đã gửi lại mã OTP.');
      startResendCooldownTicker();
    } catch (error) {
      errorOtp.textContent = describeAuthError(error);
    } finally {
      setButtonBusy(resendBtn, false);
    }
  });

  $<HTMLAnchorElement>('link-otp-back').addEventListener('click', (e) => {
    e.preventDefault();
    cancelRegistration();
    showRegister();
  });
}

// ------------------------------------------------------------
// XÁC THỰC — QUÊN MẬT KHẨU
// ------------------------------------------------------------

function initForgotPage(): void {
  const form = $<HTMLFormElement>('forgot-form');
  const emailInput = $<HTMLInputElement>('forgot-email');
  const errorEmail = $<HTMLParagraphElement>('error-forgot-email');
  const successBox = $<HTMLParagraphElement>('forgot-success');
  const submitBtn = $<HTMLButtonElement>('btn-send-reset');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      errorEmail.textContent = 'Vui lòng nhập đúng định dạng email.';
      return;
    }
    errorEmail.textContent = '';

    setButtonBusy(submitBtn, true, 'Đang gửi...');
    try {
      await sendResetPasswordEmail(email);
      successBox.hidden = false;
      successBox.textContent = `Đã gửi link đặt lại mật khẩu tới ${email}. Mở email, bấm vào link rồi đặt mật khẩu mới.`;
    } catch (error) {
      errorEmail.textContent = describeAuthError(error);
    } finally {
      setButtonBusy(submitBtn, false);
    }
  });

  $<HTMLAnchorElement>('link-forgot-back').addEventListener('click', (e) => {
    e.preventDefault();
    showLogin();
  });
}

// ------------------------------------------------------------
// ONBOARDING — đặt tên & sinh mã thiết bị (chỉ chạy lần đầu)
// ------------------------------------------------------------

function initOnboarding(): void {
  const form = $<HTMLFormElement>('onboarding-form');
  const nameInput = $<HTMLInputElement>('onboarding-name');
  const errorName = $<HTMLParagraphElement>('error-name');
  const resultSection = $<HTMLDivElement>('onboarding-result');
  const deviceIdDisplay = $<HTMLSpanElement>('onboarding-device-id');
  const copyBtn = $<HTMLButtonElement>('btn-copy-device-id');
  const startBtn = $<HTMLButtonElement>('btn-start-app');
  const submitBtn = $<HTMLButtonElement>('onboarding-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) return;

    const name = nameInput.value.trim();
    if (!name) {
      errorName.textContent = 'Vui lòng nhập tên của bạn.';
      nameInput.classList.add('input--invalid');
      return;
    }
    errorName.textContent = '';
    nameInput.classList.remove('input--invalid');

    setButtonBusy(submitBtn, true, 'Đang tạo mã thiết bị...');
    try {
      const deviceId = await createDeviceWithNewId(currentUser.uid, name);
      await patchUserDoc(currentUser.uid, { deviceId, displayName: name });

      userProfile = {
        uid: currentUser.uid,
        email: currentUser.email ?? '',
        name,
        deviceId,
        createdAt: new Date().toISOString(),
      };

      deviceIdDisplay.textContent = deviceId;
      form.hidden = true;
      resultSection.hidden = false;
      attachDeviceStreams(deviceId);
    } catch (error) {
      errorName.textContent = describeAuthError(error);
    } finally {
      setButtonBusy(submitBtn, false);
    }
  });

  copyBtn.addEventListener('click', () => {
    if (userProfile) copyToClipboard(userProfile.deviceId, 'Đã sao chép mã thiết bị');
  });

  startBtn.addEventListener('click', () => {
    form.hidden = false;
    resultSection.hidden = true;
    showHome();
  });
}

// ------------------------------------------------------------
// TRANG CHỦ / GIÁM SÁT
// ------------------------------------------------------------

function renderHome(): void {
  if (!userProfile) return;

  $<HTMLSpanElement>('home-user-name').textContent = userProfile.name;
  $<HTMLSpanElement>('home-device-id').textContent = userProfile.deviceId;

  const monitorToggle = $<HTMLInputElement>('toggle-monitoring');
  const monitorStatus = $<HTMLSpanElement>('monitoring-status-text');
  monitorToggle.checked = appSettings.monitoringEnabled;
  monitorStatus.textContent = appSettings.monitoringEnabled ? 'Đang bật' : 'Đã tắt';
  monitorStatus.className = appSettings.monitoringEnabled
    ? 'monitor-status monitor-status--on'
    : 'monitor-status monitor-status--off';

  const updateSensorDot = (dotId: string, labelId: string, status: string) => {
    $<HTMLSpanElement>(dotId).className = 'sensor-dot sensor-dot--' + status;
    const label = $<HTMLSpanElement>(labelId);
    if (status === 'active') label.textContent = 'Hoạt động';
    else if (status === 'error') label.textContent = 'Lỗi';
    else label.textContent = 'Tắt';
  };

  updateSensorDot('sensor-gps-dot', 'sensor-gps-status', sensorStatus.gps);
  updateSensorDot('sensor-accel-dot', 'sensor-accel-status', sensorStatus.accelerometer);
  updateSensorDot('sensor-gyro-dot', 'sensor-gyro-status', sensorStatus.gyroscope);

  $<HTMLSpanElement>('current-lat').textContent =
    currentLatitude !== null ? currentLatitude.toFixed(6) + '°' : 'chưa có';
  $<HTMLSpanElement>('current-lng').textContent =
    currentLongitude !== null ? currentLongitude.toFixed(6) + '°' : 'chưa có';

  // Thẻ tóm tắt tình trạng kết nối người thân
  const linkSummary = $<HTMLSpanElement>('home-guardian-count');
  linkSummary.textContent =
    linkedGuardians.length === 0
      ? 'Chưa có người thân nào'
      : `${linkedGuardians.length} người thân đang theo dõi`;
}

function initHomePage(): void {
  const monitorToggle = $<HTMLInputElement>('toggle-monitoring');
  monitorToggle.addEventListener('change', () => {
    appSettings.monitoringEnabled = monitorToggle.checked;
    saveSettings();
    if (appSettings.monitoringEnabled) startMonitoring();
    else stopMonitoring();
    renderHome();
    void sendHeartbeat();
    showToast(appSettings.monitoringEnabled ? 'Đã bật giám sát' : 'Đã tắt giám sát');
  });

  $<HTMLButtonElement>('btn-copy-home-id').addEventListener('click', () => {
    if (userProfile) copyToClipboard(userProfile.deviceId, 'Đã sao chép mã thiết bị');
  });

  $<HTMLButtonElement>('btn-open-pairing').addEventListener('click', () => showPairing());
}

// ------------------------------------------------------------
// CẢM BIẾN — MOCK + REAL SENSOR SERVICE
// ------------------------------------------------------------

/**
 * Bắt đầu giám sát cảm biến.
 * Trên trình duyệt desktop: dùng mock sensor.
 * Trên thiết bị có cảm biến thật: dùng DeviceMotionEvent + Geolocation.
 */
function startMonitoring(): void {
  if (monitoringIntervalId !== null) return;

  sensorStatus.accelerometer = 'active';
  sensorStatus.gyroscope = 'active';
  sensorBuffer = [];

  if (userProfile && currentUser && isLiveStreamAvailable()) {
    void startLiveStream(
      userProfile.deviceId,
      currentUser.uid,
      userProfile.name,
      linkedGuardians.map((g) => g.uid)
    ).catch(() => undefined);
  }

  void startGpsTracking();

  // Thứ tự ưu tiên:
  //   1. Dịch vụ nền native  — chạy được cả khi màn hình tắt (bản APK)
  //   2. devicemotion        — chỉ chạy khi app đang mở trên màn hình
  //   3. Mock sensor         — trên trình duyệt máy tính, để demo giao diện
  void startNativeMonitor(
    {
      thresholdMs2: thresholdG2ToMs2(currentThresholdG2()),
      alarmMuted: appSettings.alarmMuted,
    },
    handleNativeBatch,
    handleNativeFall
  ).then((handle) => {
    if (handle) {
      nativeMonitor = handle;
      sensorStatus.accelerometer = 'active';
      sensorStatus.gyroscope = 'active';
      renderHome();
      return;
    }
    startWebSensorFallback();
  });
}

/** Cảm biến của WebView (chỉ chạy khi app đang mở) hoặc dữ liệu giả trên máy tính */
function startWebSensorFallback(): void {
  const hasRealSensor = typeof DeviceMotionEvent !== 'undefined' && isNativePlatform();
  if (hasRealSensor) {
    try {
      window.addEventListener('devicemotion', handleDeviceMotion);
      sensorStatus.accelerometer = 'active';
      sensorStatus.gyroscope = 'active';
    } catch {
      sensorStatus.accelerometer = 'error';
      sensorStatus.gyroscope = 'error';
      startMockSensor();
    }
  } else {
    startMockSensor();
  }
}

/** Trải một lô mẫu từ dịch vụ nền thành từng mẫu rồi đưa vào luồng xử lý chung */
function handleNativeBatch(batch: SensorBatch): void {
  const step = 1000 / (batch.hz || 50);
  const count = Math.min(batch.ax.length, batch.ay.length, batch.az.length);

  for (let i = 0; i < count; i++) {
    addSampleToBuffer({
      t: batch.t0 + i * step,
      ax: batch.ax[i],
      ay: batch.ay[i],
      az: batch.az[i],
      gx: batch.gx[i] ?? 0,
      gy: batch.gy[i] ?? 0,
      gz: batch.gz[i] ?? 0,
    });
  }
}

/**
 * Phần Java đã dò thấy va đập vượt ngưỡng và đang hú còi.
 * Bên này chỉ còn việc hiện màn hình đếm ngược và lo phần Firestore.
 */
function handleNativeFall(peakMs2: number): void {
  if (!appSettings.monitoringEnabled) return;

  // Java gửi đỉnh theo m/s²; đổi sang g² rồi dùng CHUNG công thức với
  // confirmFallWithAI để hai đường phát hiện không cho ra con số lệch nhau.
  const peakG2 = (peakMs2 * peakMs2) / (G * G);
  showFallAlert(Math.round(peakToConfidence(peakG2) * 100));
}

function stopMonitoring(): void {
  if (monitoringIntervalId !== null) {
    window.clearInterval(monitoringIntervalId);
    monitoringIntervalId = null;
  }
  window.removeEventListener('devicemotion', handleDeviceMotion);
  nativeMonitor?.stop();
  nativeMonitor = null;
  void stopLiveStream().catch(() => undefined);
  geoWatch?.stop();
  geoWatch = null;

  // Quên vị trí cuối cùng. Giữ lại chỉ khiến trang chủ và app người thân hiện
  // một toạ độ cũ như thể vẫn đang định vị.
  currentLatitude = null;
  currentLongitude = null;
  currentAccuracy = null;

  sensorStatus.accelerometer = 'off';
  sensorStatus.gyroscope = 'off';
  sensorStatus.gps = 'off';
  sensorBuffer = [];
}

/** Xử lý sự kiện DeviceMotionEvent từ cảm biến thật */
function handleDeviceMotion(event: DeviceMotionEvent): void {
  const acc = event.accelerationIncludingGravity;
  const rot = event.rotationRate;
  if (!acc) return;

  addSampleToBuffer({
    t: Date.now(),
    ax: acc.x ?? 0,
    ay: acc.y ?? 0,
    az: acc.z ?? 0,
    gx: rot?.alpha ?? 0,
    gy: rot?.beta ?? 0,
    gz: rot?.gamma ?? 0,
  });
}

/**
 * MOCK SENSOR — phát sinh dữ liệu giả để test luồng trên trình duyệt.
 * Dữ liệu mô phỏng gia tốc bình thường ~9.8 m/s² (trọng lực) + nhiễu nhỏ.
 * KHÔNG tự tạo "sốc" ngẫu nhiên — chỉ dùng nút "Giả lập té ngã" để demo.
 */
function startMockSensor(): void {
  monitoringIntervalId = window.setInterval(() => {
    const noise = () => (Math.random() - 0.5) * 2; // ±1 m/s²
    addSampleToBuffer({
      t: Date.now(),
      ax: noise(),
      ay: noise(),
      az: 9.8 + noise(),
      gx: (Math.random() - 0.5) * 0.2,
      gy: (Math.random() - 0.5) * 0.2,
      gz: (Math.random() - 0.5) * 0.2,
    });
  }, 50);
}

/** Thêm mẫu vào buffer và kiểm tra ngưỡng sơ bộ */
function addSampleToBuffer(sample: SensorSample): void {
  // Gửi sang luồng phát dạng sóng (tự hạ tần số, tự bỏ qua nếu chưa bật).
  feedSample(sample);

  sensorBuffer.push(sample);
  if (sensorBuffer.length > SENSOR_BUFFER_MAX) sensorBuffer.shift();
  if (sensorBuffer.length >= 20) checkForFallCandidate();
}

/**
 * Bật theo dõi GPS. Ưu tiên plugin @capacitor/geolocation trên Android vì nó
 * xin quyền đúng chuẩn hệ điều hành; không có thì dùng Geolocation API.
 */
async function startGpsTracking(): Promise<void> {
  if (geoWatch !== null) return;

  const refreshHomeIfVisible = () => {
    if (document.querySelector<HTMLElement>('.page--active')?.dataset.page === 'home') renderHome();
  };

  geoWatch = await watchLocation(
    (fix) => {
      currentLatitude = fix.latitude;
      currentLongitude = fix.longitude;
      currentAccuracy = fix.accuracy;
      sensorStatus.gps = 'active';
      refreshHomeIfVisible();
    },
    (message) => {
      sensorStatus.gps = 'error';
      refreshHomeIfVisible();
      showToast(message);
    }
  );
}

// ------------------------------------------------------------
// PHÁT HIỆN TÉ NGÃ — NGƯỠNG SƠ BỘ + AI XÁC NHẬN
// ------------------------------------------------------------

/** Kiểm tra buffer có "nghi ngờ té ngã" dựa trên ngưỡng gia tốc đơn giản */
function checkForFallCandidate(): void {
  // Đang hiện màn hình cảnh báo thì thôi dò tiếp. Nếu không, người dùng cựa
  // quậy hay với tay lấy điện thoại sẽ tạo thêm đỉnh gia tốc, kích hoạt lại
  // showFallAlert và đồng hồ đếm ngược nhảy về đầu — cảnh báo không bao giờ gửi đi.
  if (document.querySelector<HTMLElement>('.page--active')?.dataset.page === 'fallAlert') return;

  const thresholdG2 = currentThresholdG2();
  const latest = sensorBuffer[sensorBuffer.length - 1];
  const magnitudeG2 = magnitudeSquaredG2(latest.ax, latest.ay, latest.az);

  if (magnitudeG2 > thresholdG2) {
    const windowSamples = [...sensorBuffer];
    const sensorWindow: SensorWindow = {
      samples: windowSamples,
      sampleRateHz: 20,
      windowMs: windowSamples.length * 50,
    };

    // Tạm dừng kiểm tra để tránh kích hoạt liên tục
    sensorBuffer = [];

    void confirmFallWithAI(sensorWindow).then((result) => {
      if (result.isFall) showFallAlert(Math.round(result.confidence * 100));
    });
  }
}

/**
 * MOCK — hàm giả lập xác nhận té ngã bằng AI.
 * TODO: Khi đồng đội bàn giao model (.pkl / .pt) đã huấn luyện xong, thay toàn
 * bộ nội dung hàm này bằng suy luận model thật. Hai hướng khả thi tuỳ framework
 * train (hỏi đồng đội):
 *   - Nếu train bằng Keras/TensorFlow → convert sang TensorFlow.js
 *     (`tensorflowjs_converter`), chạy on-device bằng @tensorflow/tfjs.
 *   - Nếu train bằng PyTorch → export sang ONNX (`torch.onnx.export`), chạy
 *     bằng onnxruntime-web.
 * Giữ nguyên chữ ký hàm bên dưới để không phải sửa chỗ gọi.
 */
async function confirmFallWithAI(sensorWindow: SensorWindow): Promise<FallAiResult> {
  // MOCK — tính biên độ đỉnh gia tốc trong cửa sổ, map sang độ tin cậy 0-1.
  const peakG2 = Math.max(
    ...sensorWindow.samples.map((s) => magnitudeSquaredG2(s.ax, s.ay, s.az))
  );

  // Ngưỡng ở checkForFallCandidate đã quyết định rồi, nên ở đây luôn đồng ý.
  // Bản cũ đặt thêm một ngưỡng ngầm thứ hai ở đây, khiến mức "Cao" bị chính nó
  // bác bỏ và hành xử y hệt mức "Vừa" — đã bỏ.
  // Khi có model thật, chỗ này mới là nơi được phép trả về isFall = false.
  return {
    isFall: true,
    confidence: peakToConfidence(peakG2),
    source: 'mock',
  };
}

/**
 * Quy đỉnh va đập (g²) sang độ tin cậy 0-1, lấy 3 g (= 9 g²) làm mốc 100%.
 * Chỉ dùng để lưu vào lịch sử, KHÔNG tham gia quyết định có cảnh báo hay không.
 */
function peakToConfidence(peakG2: number): number {
  return Math.min(1, Math.max(0, peakG2 / SEVERE_IMPACT_G2));
}

// ------------------------------------------------------------
// MÀN HÌNH CẢNH BÁO TÉ NGÃ (full-screen, nền đỏ)
// ------------------------------------------------------------

function renderFallAlert(): void {
  countdownRemaining = appSettings.cancelCountdownSec;
  $<HTMLSpanElement>('alert-countdown').textContent = countdownRemaining.toString();

  const contactsList = $<HTMLDivElement>('alert-contacts-list');
  contactsList.innerHTML = '';

  if (emergencyContacts.length === 0) {
    contactsList.innerHTML = '<p class="alert-no-contacts">Chưa có liên hệ khẩn cấp</p>';
    return;
  }

  emergencyContacts.forEach((contact) => {
    const item = document.createElement('a');
    item.className = 'alert-contact-item';
    item.href = `tel:${contact.phone}`;
    item.innerHTML = `
      <span class="alert-contact-item__name">${escapeHtml(contact.name)}</span>
      <span class="alert-contact-item__relation">${escapeHtml(contact.relation)}</span>
      <span class="alert-contact-item__phone">📞 ${escapeHtml(contact.phone)}</span>
    `;
    contactsList.appendChild(item);
  });
}

function startCountdown(): void {
  if (countdownIntervalId !== null) window.clearInterval(countdownIntervalId);

  const countdownEl = $<HTMLSpanElement>('alert-countdown');
  const countdownRing = document.getElementById('countdown-ring-progress') as SVGCircleElement | null;
  const totalSeconds = appSettings.cancelCountdownSec;
  const circumference = 2 * Math.PI * 54; // radius=54

  countdownIntervalId = window.setInterval(() => {
    countdownRemaining--;
    countdownEl.textContent = countdownRemaining.toString();

    if (countdownRing) {
      const progress = countdownRemaining / totalSeconds;
      countdownRing.style.strokeDashoffset = (circumference * (1 - progress)).toString();
    }

    if (countdownRemaining <= 0) {
      window.clearInterval(countdownIntervalId!);
      countdownIntervalId = null;
      void onAlertExpired();
    }
  }, 1000);
}

/**
 * Ghi sự kiện té ngã lên Firestore; nếu lỗi mạng vẫn báo cho người dùng biết.
 * Chỉ được gọi khi cảnh báo thật sự gửi đi — báo động giả không ghi gì cả.
 */
async function recordFallEvent(): Promise<void> {
  if (!userProfile) return;
  try {
    await pushFallEvent(userProfile.deviceId, {
      confidence: currentFallConfidence,
      lat: appSettings.includeGpsInAlert && currentLatitude !== null ? currentLatitude : 0,
      lng: appSettings.includeGpsInAlert && currentLongitude !== null ? currentLongitude : 0,
      source: 'demo',
    });
  } catch (error) {
    showToast('Không gửi được lên máy chủ: ' + describeAuthError(error));
  }
}

function cancelAlert(): void {
  if (countdownIntervalId !== null) {
    window.clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }

  stopAlarm();

  // Báo động giả: KHÔNG ghi lên Firestore, không tính vào số cảnh báo, và
  // không hiện trong lịch sử bên app người thân.
  showToast('Đã huỷ cảnh báo — không gửi gì tới người thân');
  showHome();
}

async function onAlertExpired(): Promise<void> {
  stopAlarm();
  await recordFallEvent();
  showToast('Đã gửi cảnh báo tới người thân');

  const alertTitle = $<HTMLHeadingElement>('alert-title');
  const cancelBtn = $<HTMLButtonElement>('btn-cancel-alert');
  alertTitle.textContent = '✅ Đã gửi cảnh báo tới người thân';
  cancelBtn.style.display = 'none';

  window.setTimeout(() => {
    alertTitle.textContent = '⚠️ Phát hiện té ngã';
    cancelBtn.style.display = '';
    showHome();
  }, 2500);
}

function initFallAlert(): void {
  $<HTMLButtonElement>('btn-cancel-alert').addEventListener('click', cancelAlert);
}

// ------------------------------------------------------------
// TRANG KẾT NỐI NGƯỜI THÂN — HIỂN THỊ MÃ OTP 6 SỐ
// ------------------------------------------------------------

function renderPairing(): void {
  if (!userProfile) return;

  $<HTMLSpanElement>('pairing-device-id').textContent = userProfile.deviceId;
  $<HTMLSpanElement>('pairing-otp-code').textContent = formatOtpForDisplay(getCurrentOtp());
  updateOtpCountdownLabel();
  renderGuardianList();
  renderPairingLog();
}

function formatOtpForDisplay(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function updateOtpCountdownLabel(): void {
  const label = document.getElementById('pairing-otp-countdown');
  if (!label) return;
  const seconds = Math.ceil(getOtpRemainingMs() / 1000);
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  label.textContent = `Mã đổi sau ${mm}:${ss.toString().padStart(2, '0')}`;
}

/** Đồng hồ đếm ngược mã OTP, chỉ chạy khi đang ở trang Kết nối */
function startOtpTicker(): void {
  if (otpTickIntervalId !== null) return;
  otpTickIntervalId = window.setInterval(() => {
    const onPairingPage =
      document.querySelector<HTMLElement>('.page--active')?.dataset.page === 'pairing';
    if (!onPairingPage) return;

    if (getOtpRemainingMs() <= 0) {
      $<HTMLSpanElement>('pairing-otp-code').textContent = formatOtpForDisplay(getCurrentOtp());
    }
    updateOtpCountdownLabel();
  }, 1000);
}

function renderGuardianList(): void {
  const list = $<HTMLDivElement>('pairing-guardians');
  const empty = $<HTMLDivElement>('pairing-guardians-empty');
  list.innerHTML = '';

  if (linkedGuardians.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  linkedGuardians.forEach((guardian) => {
    const card = document.createElement('div');
    card.className = 'contact-card';
    card.innerHTML = `
      <div class="contact-card__info">
        <div class="contact-card__name">${escapeHtml(guardian.name)}</div>
        <div class="contact-card__relation">${escapeHtml(guardian.email)}</div>
      </div>
      <div class="contact-card__actions">
        <button type="button" class="btn btn--sm btn--danger-outline" data-unlink="${escapeHtml(guardian.uid)}">Ngắt</button>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll<HTMLButtonElement>('[data-unlink]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!userProfile) return;
      if (!confirm('Ngắt kết nối người thân này? Họ sẽ không xem được vị trí của bạn nữa.')) return;
      setButtonBusy(btn, true, '...');
      try {
        await removeGuardian(userProfile.deviceId, btn.dataset.unlink!);
        showToast('Đã ngắt kết nối');
      } catch (error) {
        showToast(describeAuthError(error));
      } finally {
        setButtonBusy(btn, false);
      }
    });
  });
}

function renderPairingLog(): void {
  const box = $<HTMLDivElement>('pairing-log');
  if (pairingLog.length === 0) {
    box.innerHTML = '<p class="pairing-log__empty">Chưa có yêu cầu kết nối nào.</p>';
    return;
  }
  box.innerHTML = pairingLog
    .map((line) => `<p class="pairing-log__line">${escapeHtml(line)}</p>`)
    .join('');
}

function addPairingLog(message: string): void {
  pairingLog.unshift(`${formatNowTime()} — ${message}`);
  pairingLog = pairingLog.slice(0, 8);
  if (document.querySelector<HTMLElement>('.page--active')?.dataset.page === 'pairing') {
    renderPairingLog();
  }
}

function initPairingPage(): void {
  $<HTMLButtonElement>('btn-rotate-otp').addEventListener('click', () => {
    rotateOtp();
    $<HTMLSpanElement>('pairing-otp-code').textContent = formatOtpForDisplay(getCurrentOtp());
    updateOtpCountdownLabel();
    showToast('Đã tạo mã OTP mới');
  });

  $<HTMLButtonElement>('btn-copy-pairing-id').addEventListener('click', () => {
    if (userProfile) copyToClipboard(userProfile.deviceId, 'Đã sao chép mã thiết bị');
  });

  $<HTMLButtonElement>('pairing-back-btn').addEventListener('click', () => showHome());
}

/**
 * Tự động xử lý yêu cầu ghép cặp từ app Healthcare Map.
 * Máy này giữ mã OTP thật, nên chính nó là bên có quyền phán quyết.
 */
async function handleIncomingRequest(request: Parameters<typeof resolvePairRequest>[1]): Promise<void> {
  if (!userProfile) return;
  if (request.state !== 'pending') return;
  if (handlingRequests.has(request.id)) return;

  handlingRequests.add(request.id);
  try {
    const decision = await resolvePairRequest(userProfile.deviceId, request);
    addPairingLog(decision.message);
    showToast(decision.message);
  } catch (error) {
    addPairingLog('Lỗi xử lý yêu cầu: ' + describeAuthError(error));
  } finally {
    handlingRequests.delete(request.id);
  }
}

// ------------------------------------------------------------
// LỊCH SỬ CẢNH BÁO (dữ liệu lấy realtime từ Firestore)
// ------------------------------------------------------------

function groupEventsByDate(events: FallEvent[]): Map<string, FallEvent[]> {
  const groups = new Map<string, FallEvent[]>();
  events.forEach((ev) => {
    if (!groups.has(ev.date)) groups.set(ev.date, []);
    groups.get(ev.date)!.push(ev);
  });
  return groups;
}

function renderHistory(): void {
  const container = $<HTMLDivElement>('history-list');
  const emptyState = $<HTMLDivElement>('history-empty');
  container.innerHTML = '';

  if (fallEvents.length === 0) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  // fallEvents đã được Firestore sắp xếp mới nhất trước.
  groupEventsByDate(fallEvents).forEach((events, date) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'history-group';

    const dateEl = document.createElement('div');
    dateEl.className = 'history-group__date';
    dateEl.textContent = date;
    groupEl.appendChild(dateEl);

    const itemsEl = document.createElement('div');
    itemsEl.className = 'history-group__items';

    events.forEach((ev) => {
      // Lịch sử giờ chỉ còn những lần cảnh báo THẬT SỰ được gửi đi.
      const place =
        ev.latitude === 0 && ev.longitude === 0
          ? 'Không kèm vị trí'
          : `${ev.latitude.toFixed(6)}°N, ${ev.longitude.toFixed(6)}°E`;

      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <div class="history-item__icon">🚨</div>
        <div class="history-item__body">
          <div class="history-item__title">Phát hiện té ngã</div>
          <div class="history-item__meta">
            <span>⏰ ${ev.timestamp}</span>
            <span>📍 ${place}</span>
          </div>
        </div>
        <div class="history-item__right">
          <span class="status-badge status-badge--sent">Đã gửi</span>
        </div>
      `;
      itemsEl.appendChild(item);
    });

    groupEl.appendChild(itemsEl);
    container.appendChild(groupEl);
  });
}

// ------------------------------------------------------------
// DANH BẠ KHẨN CẤP — CRUD tối đa 3 liên hệ (lưu tại máy)
// ------------------------------------------------------------

function renderContacts(): void {
  const list = $<HTMLDivElement>('contacts-list');
  const addBtn = $<HTMLButtonElement>('btn-add-contact');
  const emptyState = $<HTMLDivElement>('contacts-empty');

  list.innerHTML = '';

  if (emergencyContacts.length === 0) {
    emptyState.hidden = false;
  } else {
    emptyState.hidden = true;
    emergencyContacts.forEach((contact) => {
      const card = document.createElement('div');
      card.className = 'contact-card';
      card.innerHTML = `
        <div class="contact-card__info">
          <div class="contact-card__name">${escapeHtml(contact.name)}</div>
          <div class="contact-card__relation">${escapeHtml(contact.relation)}</div>
          <a href="tel:${escapeHtml(contact.phone)}" class="contact-card__phone">📞 ${escapeHtml(contact.phone)}</a>
        </div>
        <div class="contact-card__actions">
          <button type="button" class="btn btn--sm btn--secondary" data-edit-id="${contact.id}">Sửa</button>
          <button type="button" class="btn btn--sm btn--danger-outline" data-delete-id="${contact.id}">Xoá</button>
        </div>
      `;
      list.appendChild(card);
    });

    list.querySelectorAll<HTMLButtonElement>('[data-edit-id]').forEach((btn) => {
      btn.addEventListener('click', () => openContactForm(btn.dataset.editId!));
    });

    list.querySelectorAll<HTMLButtonElement>('[data-delete-id]').forEach((btn) => {
      btn.addEventListener('click', () => deleteContact(btn.dataset.deleteId!));
    });
  }

  addBtn.style.display = emergencyContacts.length >= 3 ? 'none' : '';
}

function openContactForm(editId?: string): void {
  const overlay = $<HTMLDivElement>('contact-form-overlay');
  const formTitle = $<HTMLHeadingElement>('contact-form-title');
  const nameInput = $<HTMLInputElement>('contact-name-input');
  const phoneInput = $<HTMLInputElement>('contact-phone-input');
  const relationInput = $<HTMLInputElement>('contact-relation-input');

  if (editId) {
    const contact = emergencyContacts.find((c) => c.id === editId);
    if (!contact) return;
    formTitle.textContent = 'Sửa liên hệ khẩn cấp';
    nameInput.value = contact.name;
    phoneInput.value = contact.phone;
    relationInput.value = contact.relation;
    overlay.dataset.editId = editId;
  } else {
    formTitle.textContent = 'Thêm liên hệ khẩn cấp';
    nameInput.value = '';
    phoneInput.value = '';
    relationInput.value = '';
    delete overlay.dataset.editId;
  }

  overlay.hidden = false;
}

function closeContactForm(): void {
  $<HTMLDivElement>('contact-form-overlay').hidden = true;
}

function saveContact(): void {
  const overlay = $<HTMLDivElement>('contact-form-overlay');
  const name = $<HTMLInputElement>('contact-name-input').value.trim();
  const phone = $<HTMLInputElement>('contact-phone-input').value.trim();
  const relation = $<HTMLInputElement>('contact-relation-input').value.trim();

  if (!name || !phone) {
    showToast('Vui lòng nhập tên và số điện thoại');
    return;
  }

  const editId = overlay.dataset.editId;

  if (editId) {
    const idx = emergencyContacts.findIndex((c) => c.id === editId);
    if (idx !== -1) {
      emergencyContacts[idx].name = name;
      emergencyContacts[idx].phone = phone;
      emergencyContacts[idx].relation = relation;
    }
    showToast('Đã cập nhật liên hệ');
  } else {
    if (emergencyContacts.length >= 3) {
      showToast('Tối đa 3 liên hệ khẩn cấp');
      return;
    }
    emergencyContacts.push({ id: Date.now().toString(), name, phone, relation });
    showToast('Đã thêm liên hệ khẩn cấp');
  }

  saveContacts();
  closeContactForm();
  renderContacts();
}

function deleteContact(id: string): void {
  emergencyContacts = emergencyContacts.filter((c) => c.id !== id);
  saveContacts();
  renderContacts();
  showToast('Đã xoá liên hệ');
}

function initContactsPage(): void {
  $<HTMLButtonElement>('btn-add-contact').addEventListener('click', () => openContactForm());
  $<HTMLButtonElement>('btn-save-contact').addEventListener('click', saveContact);
  $<HTMLButtonElement>('btn-cancel-contact').addEventListener('click', closeContactForm);
  $<HTMLButtonElement>('btn-close-contact-form').addEventListener('click', closeContactForm);

  const overlay = $<HTMLDivElement>('contact-form-overlay');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeContactForm();
  });
}

// ------------------------------------------------------------
// CÀI ĐẶT
// ------------------------------------------------------------

function renderSettings(): void {
  if (!userProfile) return;

  $<HTMLInputElement>('settings-name-input').value = userProfile.name;
  $<HTMLSpanElement>('settings-device-id').textContent = userProfile.deviceId;
  $<HTMLSpanElement>('settings-account-email').textContent = userProfile.email;

  document.querySelectorAll<HTMLButtonElement>('.sensitivity-btn').forEach((btn) => {
    btn.classList.toggle('sensitivity-btn--active', btn.dataset.sensitivity === appSettings.sensitivity);
  });

  document.querySelectorAll<HTMLButtonElement>('.countdown-btn').forEach((btn) => {
    btn.classList.toggle(
      'countdown-btn--active',
      btn.dataset.countdown === appSettings.cancelCountdownSec.toString()
    );
  });

  $<HTMLInputElement>('toggle-gps-alert').checked = appSettings.includeGpsInAlert;
  $<HTMLInputElement>('toggle-alarm-sound').checked = !appSettings.alarmMuted;
}

function initSettingsPage(): void {
  const nameInput = $<HTMLInputElement>('settings-name-input');
  nameInput.addEventListener('change', async () => {
    const newName = nameInput.value.trim();
    if (!newName || !userProfile || !currentUser) return;
    try {
      await updateDeviceName(userProfile.deviceId, newName);
      await patchUserDoc(currentUser.uid, { displayName: newName });
      userProfile.name = newName;
      showToast('Đã cập nhật tên — người thân sẽ thấy tên mới');
    } catch (error) {
      showToast(describeAuthError(error));
    }
  });

  $<HTMLButtonElement>('btn-copy-settings-id').addEventListener('click', () => {
    if (userProfile) copyToClipboard(userProfile.deviceId, 'Đã sao chép mã thiết bị');
  });

  document.querySelectorAll<HTMLButtonElement>('.sensitivity-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      appSettings.sensitivity = btn.dataset.sensitivity as AppSettings['sensitivity'];
      saveSettings();
      setNativeThreshold(thresholdG2ToMs2(currentThresholdG2()));
      renderSettings();
      showToast(`Độ nhạy: ${btn.textContent}`);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.countdown-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      appSettings.cancelCountdownSec = Number(btn.dataset.countdown);
      saveSettings();
      renderSettings();
      showToast(`Thời gian đếm ngược: ${btn.dataset.countdown}s`);
    });
  });

  const gpsToggle = $<HTMLInputElement>('toggle-gps-alert');
  gpsToggle.addEventListener('change', () => {
    appSettings.includeGpsInAlert = gpsToggle.checked;
    saveSettings();
    showToast(gpsToggle.checked ? 'Gửi kèm GPS khi cảnh báo' : 'Không gửi GPS khi cảnh báo');
  });

  // Công tắc bật/tắt còi hú
  const alarmToggle = $<HTMLInputElement>('toggle-alarm-sound');
  alarmToggle.addEventListener('change', () => {
    appSettings.alarmMuted = !alarmToggle.checked;
    saveSettings();
    setAlarmMuted(appSettings.alarmMuted);
    if (!appSettings.alarmMuted) playTestBeep();
    showToast(appSettings.alarmMuted ? 'Đã tắt tiếng còi báo động' : 'Đã bật tiếng còi báo động');
  });

  $<HTMLButtonElement>('btn-battery-exemption').addEventListener('click', async () => {
    if (!isNativePlatform()) {
      showToast('Chỉ dùng được trên bản APK cài vào điện thoại.');
      return;
    }
    const granted = await requestBatteryExemption();
    showToast(
      granted
        ? 'Ứng dụng đã được miễn trừ tiết kiệm pin.'
        : 'Hãy chọn "Cho phép" ở hộp thoại vừa mở để app chạy nền ổn định.'
    );
  });

  $<HTMLButtonElement>('btn-test-alarm').addEventListener('click', () => {
    if (isAlarmMuted()) {
      showToast('Đang tắt tiếng — bật công tắc phía trên để nghe thử.');
      return;
    }
    playTestBeep();
  });

  $<HTMLButtonElement>('btn-logout').addEventListener('click', async () => {
    if (!confirm('Đăng xuất khỏi tài khoản này?')) return;
    await signOutUser();
  });
}

// ------------------------------------------------------------
// NHỊP TIM — ĐẨY VỊ TRÍ / PIN / TRẠNG THÁI LÊN FIRESTORE
// ------------------------------------------------------------

async function sendHeartbeat(): Promise<void> {
  if (!userProfile) return;
  currentBattery = await readBatteryLevel();

  // Đang tắt giám sát thì vẫn báo "máy còn sống" (lastSeen, pin) nhưng KHÔNG
  // gửi vị trí. Nếu cứ gửi lại toạ độ cũ kèm dấu thời gian mới, app người thân
  // sẽ tưởng đang theo dõi thật trong khi thực tế GPS đã tắt.
  const tracking = appSettings.monitoringEnabled;

  try {
    await pushHeartbeat(userProfile.deviceId, {
      lat: tracking ? currentLatitude : null,
      lng: tracking ? currentLongitude : null,
      accuracy: tracking ? currentAccuracy : null,
      battery: currentBattery,
      monitoringEnabled: appSettings.monitoringEnabled,
    });
  } catch {
    // Mất mạng tạm thời là chuyện bình thường — cache ngoại tuyến của Firestore
    // sẽ tự đẩy lên khi có mạng lại, không cần làm phiền người dùng.
  }
}

function startHeartbeat(): void {
  if (heartbeatIntervalId !== null) return;
  void sendHeartbeat();
  heartbeatIntervalId = window.setInterval(() => void sendHeartbeat(), HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeatIntervalId !== null) {
    window.clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
}

// ------------------------------------------------------------
// GẮN / GỠ CÁC LUỒNG REALTIME CỦA FIRESTORE
// ------------------------------------------------------------

function attachDeviceStreams(deviceId: string): void {
  detachDeviceStreams();

  unsubscribeDevice = subscribeDevice(
    deviceId,
    (device) => {
      deviceDoc = device;
      linkedGuardians = toLinkedGuardians(device);

      // Rules của Realtime Database không đọc được Firestore, nên phải sao chép
      // danh sách người thân sang meta/viewers thì họ mới xem được dạng sóng.
      if (appSettings.monitoringEnabled && isLiveStreamAvailable()) {
        void updateStreamViewers(deviceId, linkedGuardians.map((g) => g.uid));
      }
      if (device && userProfile) userProfile.name = device.name || userProfile.name;

      const page = document.querySelector<HTMLElement>('.page--active')?.dataset.page;
      if (page === 'home') renderHome();
      if (page === 'pairing') renderGuardianList();
    },
    (error) => showToast('Lỗi đọc thiết bị: ' + describeAuthError(error))
  );

  unsubscribeEvents = subscribeFallEvents(
    deviceId,
    (events) => {
      fallEvents = events;
      if (document.querySelector<HTMLElement>('.page--active')?.dataset.page === 'history') {
        renderHistory();
      }
    },
    (error) => showToast('Lỗi đọc lịch sử: ' + describeAuthError(error))
  );

  unsubscribeRequests = subscribePairRequests(
    deviceId,
    (requests) => {
      requests.forEach((request) => void handleIncomingRequest(request));
      // Dọn các yêu cầu đã xử lý xong quá 2 phút cho gọn cơ sở dữ liệu.
      requests
        .filter((r) => r.state !== 'pending' && r.createdAt !== null)
        .forEach((r) => {
          // createdAt null nghĩa là serverTimestamp chưa kịp về — chưa xoá vội,
          // kẻo xoá mất trước khi app người thân đọc được kết quả.
          if (Date.now() - r.createdAt!.toMillis() > 120_000) {
            void deletePairRequest(deviceId, r.id).catch(() => undefined);
          }
        });
    },
    (error) => showToast('Lỗi đọc yêu cầu kết nối: ' + describeAuthError(error))
  );

  startHeartbeat();
}

function detachDeviceStreams(): void {
  unsubscribeDevice?.();
  unsubscribeEvents?.();
  unsubscribeRequests?.();
  unsubscribeDevice = null;
  unsubscribeEvents = null;
  unsubscribeRequests = null;
  stopHeartbeat();
}

// ------------------------------------------------------------
// ĐIỀU HƯỚNG CHUNG: bottom nav
// ------------------------------------------------------------

function initGlobalNavigation(): void {
  document.querySelectorAll<HTMLButtonElement>('.bottom-nav__item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav as PageName;
      if (target === 'home') showHome();
      else if (target === 'pairing') showPairing();
      else if (target === 'history') showHistory();
      else if (target === 'contacts') showContacts();
      else if (target === 'settings') showSettings();
    });
  });
}

// ------------------------------------------------------------
// PHẢN ỨNG VỚI TRẠNG THÁI ĐĂNG NHẬP
// ------------------------------------------------------------

async function onSignedIn(user: User): Promise<void> {
  currentUser = user;
  loadContacts();
  loadSettings();

  try {
    const userDoc = await ensureUserDoc(user);

    // Phiên cũ còn lưu trên máy vẫn có thể là tài khoản của app kia — chặn luôn.
    if (!hasCorrectRole(userDoc)) {
      await signOutUser();
      showToast(WRONG_ROLE_MESSAGE);
      return;
    }

    if (!userDoc.deviceId) {
      // Tài khoản mới — cần đặt tên và sinh mã thiết bị.
      userProfile = null;
      $<HTMLFormElement>('onboarding-form').hidden = false;
      $<HTMLDivElement>('onboarding-result').hidden = true;
      $<HTMLInputElement>('onboarding-name').value = userDoc.displayName ?? '';
      showOnboarding();
      return;
    }

    userProfile = {
      uid: user.uid,
      email: user.email ?? userDoc.email,
      name: userDoc.displayName || 'Người dùng',
      deviceId: userDoc.deviceId,
      createdAt: new Date().toISOString(),
    };

    attachDeviceStreams(userDoc.deviceId);
    showHome();

    if (appSettings.monitoringEnabled) startMonitoring();
  } catch (error) {
    showToast('Không đọc được hồ sơ: ' + describeAuthError(error));
    showLogin();
  }
}

function onSignedOut(): void {
  detachDeviceStreams();
  stopMonitoring();
  currentUser = null;
  userProfile = null;
  deviceDoc = null;
  linkedGuardians = [];
  fallEvents = [];
  pairingLog = [];
  handlingRequests.clear();
  showLogin();
}

// ------------------------------------------------------------
// KHỞI TẠO ỨNG DỤNG
// ------------------------------------------------------------

function initApp(): void {
  buildBottomNavs();

  // Trình duyệt di động chặn phát tiếng cho tới khi người dùng chạm màn hình.
  // Mở khoá ngay ở lần chạm đầu tiên, không thì lúc té ngã mới gọi sẽ câm.
  // Gắn ở MỌI lần chạm chứ không gỡ sau lần đầu: Android treo AudioContext mỗi
  // lần app xuống nền, mở khoá một lần lúc khởi động là không đủ.
  document.addEventListener('pointerdown', unlockAudio);
  document.addEventListener('keydown', unlockAudio);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') unlockAudio();
  });

  initLoginPage();
  initRegisterPage();
  initOtpPage();
  initForgotPage();
  initOnboarding();
  initHomePage();
  initPairingPage();
  initFallAlert();
  initContactsPage();
  initSettingsPage();
  initGlobalNavigation();

  if (!isFirebaseConfigured()) {
    $<HTMLDivElement>('config-warning').hidden = false;
    document.body.classList.add('has-config-warning');
    showLogin();
    return;
  }

  onAuthStateChanged(auth, (user) => {
    if (user) void onSignedIn(user);
    else onSignedOut();
  });
}

document.addEventListener('DOMContentLoaded', initApp);

// `deviceDoc` hiện chỉ dùng để debug trong DevTools, giữ tham chiếu cho tiện.
(window as unknown as { __fallGuardDebug?: unknown }).__fallGuardDebug = {
  getDevice: () => deviceDoc,
  getGuardians: () => linkedGuardians,
};
