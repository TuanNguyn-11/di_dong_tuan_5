// ============================================================
// app.ts — Điều hướng, xác thực & theo dõi thiết bị qua Firestore
// Healthcare Map — App của người thân người có nguy cơ té ngã
// ============================================================

import { onAuthStateChanged, updateProfile, type User } from 'firebase/auth';
import { auth } from './firebase';
import { isFirebaseConfigured } from './firebase-config';
import {
  cancelRegistration,
  describeAuthError,
  ensureUserDoc,
  hasCorrectRole,
  patchUserDoc,
  WRONG_ROLE_MESSAGE,
  getPendingEmail,
  getResendCooldownSeconds,
  resendOtp,
  sendResetPasswordEmail,
  signIn,
  signOutUser,
  startRegistration,
  verifyOtpAndCreateAccount,
} from './auth';
import {
  clearPairRequest,
  deleteFallEvents,
  removeLink,
  renameLink,
  requestPairing,
  saveLink,
  subscribeDevice,
  subscribeFallEvents,
  subscribeLinks,
  toDeviceView,
} from './link';
import {
  describeRoute,
  isChimeMuted,
  playAlertChime,
  playTestChime,
  setChimeMuted,
  stopAlert,
  unlockAudio,
} from './alarm';
import type {
  AppSettings,
  DeviceDoc,
  DeviceLink,
  DeviceView,
  FallEvent,
  PageName,
} from './types';

// ------------------------------------------------------------
// STATE
// ------------------------------------------------------------

let currentUser: User | null = null;
let currentUserName = '';

let deviceLinks: DeviceLink[] = [];
let selectedDeviceId: string | null = null;
let selectedDeviceDoc: DeviceDoc | null = null;
let selectedDeviceView: DeviceView | null = null;
let fallEvents: FallEvent[] = [];

let appSettings: AppSettings = {
  fallAlertEnabled: true,
  deviceOfflineAlertEnabled: true,
  lowBatteryThreshold: 20,
  alertSoundMuted: false,
};

/** Tập hợp id các sự kiện đang được chọn để xoá trong dialog */
const selectedForDeletion = new Set<string>();

let unsubscribeLinks: (() => void) | null = null;
let unsubscribeDevice: (() => void) | null = null;
let unsubscribeEvents: (() => void) | null = null;
let statusTickIntervalId: number | null = null;
let resendTickerId: number | null = null;

/** Số sự kiện lần trước, dùng để nhận biết có cảnh báo té ngã MỚI */
let lastKnownEventCount = -1;

// ------------------------------------------------------------
// TIỆN ÍCH CHUNG
// ------------------------------------------------------------

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function formatTime(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

function storageKey(suffix: string): string {
  return `hm_${suffix}_${currentUser ? currentUser.uid : 'anon'}`;
}

/**
 * Kiểm tra ứng dụng có đang chạy trong vỏ native Android (Capacitor) hay không.
 * Biến toàn cục `Capacitor` chỉ được cầu nối native tiêm vào, trình duyệt thường không có.
 */
function isNativeApp(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform();
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
    key: 'devices',
    label: 'Thiết bị',
    icon: '<rect x="5" y="2" width="14" height="20" rx="3"/><path d="M11 18h2"/>',
  },
  {
    key: 'dashboard',
    label: 'Tổng quan',
    icon: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/>',
  },
  {
    key: 'map',
    label: 'Bản đồ',
    icon: '<path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/>',
  },
  {
    key: 'history',
    label: 'Lịch sử',
    icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  },
  {
    key: 'settings',
    label: 'Cài đặt',
    icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.63 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.37 9a1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
  },
];

/** Dựng thanh điều hướng dưới cùng cho mọi trang có `data-nav-host` */
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

function showDevices(): void {
  renderDeviceList();
  setActivePage('devices');
}

function showDashboard(): void {
  renderDashboard();
  setActivePage('dashboard');
}

function showMap(): void {
  renderMapPage();
  setActivePage('map');
}

function showHistory(): void {
  renderHistory();
  setActivePage('history');
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
// TRANG THIẾT BỊ — DANH SÁCH, THÊM, ĐỔI TÊN, BỎ THEO DÕI
// ------------------------------------------------------------

function renderDeviceList(): void {
  const list = $<HTMLDivElement>('devices-list');
  const empty = $<HTMLDivElement>('devices-empty');
  list.innerHTML = '';

  if (deviceLinks.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  deviceLinks.forEach((link) => {
    const isSelected = link.deviceId === selectedDeviceId;

    // Chỉ theo dõi realtime MỘT thiết bị tại một thời điểm, nên chỉ thiết bị đang
    // chọn mới biết được online/offline. Các thiết bị khác hiện gợi ý chạm để xem
    // thay vì một trạng thái bịa ra.
    const badge = isSelected
      ? `<span class="status-pill ${
          selectedDeviceView && selectedDeviceView.status === 'online' ? '' : 'status-pill--offline'
        }"><span class="status-pill__dot"></span>${
          selectedDeviceView && selectedDeviceView.status === 'online' ? 'Online' : 'Offline'
        }</span>`
      : '<span class="device-list-card__hint">Chạm để xem</span>';

    const card = document.createElement('div');
    card.className = 'device-list-card' + (isSelected ? ' device-list-card--active' : '');
    card.innerHTML = `
      <div class="device-list-card__main" data-select="${escapeHtml(link.deviceId)}">
        <div class="device-list-card__top">
          <span class="device-list-card__alias">${escapeHtml(link.alias)}</span>
          ${badge}
        </div>
        <div class="device-list-card__id">Mã: ${escapeHtml(link.deviceId)}</div>
      </div>
      <div class="device-list-card__actions">
        <button type="button" class="btn btn--sm btn--secondary" data-rename="${escapeHtml(link.deviceId)}">Đổi tên</button>
        <button type="button" class="btn btn--sm btn--danger-outline" data-unlink="${escapeHtml(link.deviceId)}">Bỏ theo dõi</button>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll<HTMLElement>('[data-select]').forEach((el) => {
    el.addEventListener('click', () => {
      selectDevice(el.dataset.select!);
      showDashboard();
    });
  });

  list.querySelectorAll<HTMLButtonElement>('[data-rename]').forEach((btn) => {
    btn.addEventListener('click', () => openRenameDialog(btn.dataset.rename!));
  });

  list.querySelectorAll<HTMLButtonElement>('[data-unlink]').forEach((btn) => {
    btn.addEventListener('click', () => void unlinkDevice(btn.dataset.unlink!));
  });
}

function openAddDeviceDialog(): void {
  $<HTMLInputElement>('add-device-id').value = '';
  $<HTMLInputElement>('add-device-otp').value = '';
  $<HTMLInputElement>('add-device-alias').value = '';
  $<HTMLParagraphElement>('error-add-device').textContent = '';
  $<HTMLDivElement>('add-device-overlay').hidden = false;
}

function closeAddDeviceDialog(): void {
  $<HTMLDivElement>('add-device-overlay').hidden = true;
}

async function submitAddDevice(): Promise<void> {
  if (!currentUser) return;

  const deviceId = $<HTMLInputElement>('add-device-id').value.replace(/\D/g, '');
  const otp = $<HTMLInputElement>('add-device-otp').value.replace(/\D/g, '');
  const aliasInput = $<HTMLInputElement>('add-device-alias').value.trim();
  const errorBox = $<HTMLParagraphElement>('error-add-device');
  const submitBtn = $<HTMLButtonElement>('btn-submit-add-device');

  if (deviceId.length !== 12) {
    errorBox.textContent = 'Mã thiết bị gồm đúng 12 chữ số.';
    return;
  }
  if (otp.length !== 6) {
    errorBox.textContent = 'Mã OTP gồm đúng 6 chữ số.';
    return;
  }
  if (deviceLinks.some((link) => link.deviceId === deviceId)) {
    errorBox.textContent = 'Bạn đã theo dõi thiết bị này rồi.';
    return;
  }

  errorBox.textContent = '';
  setButtonBusy(submitBtn, true, 'Đang chờ máy người dùng duyệt...');

  try {
    const result = await requestPairing({
      deviceId,
      otp,
      guardianUid: currentUser.uid,
      guardianEmail: currentUser.email ?? '',
      guardianName: currentUserName || currentUser.email || 'Người thân',
    });

    if (!result.ok) {
      errorBox.textContent = result.message;
      return;
    }

    const alias = aliasInput || `Thiết bị ${deviceId.slice(-4)}`;
    await saveLink(currentUser.uid, deviceId, alias);
    await clearPairRequest(deviceId, currentUser.uid);

    selectDevice(deviceId);
    closeAddDeviceDialog();
    showToast(`Đã kết nối với ${alias}`);
    showDashboard();
  } catch (error) {
    errorBox.textContent = describeAuthError(error);
  } finally {
    setButtonBusy(submitBtn, false);
  }
}

function openRenameDialog(deviceId: string): void {
  const link = deviceLinks.find((l) => l.deviceId === deviceId);
  if (!link) return;
  const overlay = $<HTMLDivElement>('rename-overlay');
  overlay.dataset.deviceId = deviceId;
  $<HTMLInputElement>('rename-alias').value = link.alias;
  overlay.hidden = false;
}

function closeRenameDialog(): void {
  $<HTMLDivElement>('rename-overlay').hidden = true;
}

async function submitRename(): Promise<void> {
  if (!currentUser) return;
  const overlay = $<HTMLDivElement>('rename-overlay');
  const deviceId = overlay.dataset.deviceId;
  const alias = $<HTMLInputElement>('rename-alias').value.trim();

  if (!deviceId) return;
  if (!alias) {
    showToast('Vui lòng nhập tên thiết bị');
    return;
  }

  try {
    await renameLink(currentUser.uid, deviceId, alias);
    closeRenameDialog();
    showToast('Đã đổi tên thiết bị');
  } catch (error) {
    showToast(describeAuthError(error));
  }
}

async function unlinkDevice(deviceId: string): Promise<void> {
  if (!currentUser) return;
  const link = deviceLinks.find((l) => l.deviceId === deviceId);
  if (!confirm(`Bỏ theo dõi "${link?.alias ?? deviceId}"?\nBạn sẽ không nhận được cảnh báo té ngã từ thiết bị này nữa.`)) {
    return;
  }

  try {
    await removeLink(currentUser.uid, deviceId);
    if (selectedDeviceId === deviceId) {
      detachDeviceStreams();
      selectedDeviceId = null;
      selectedDeviceDoc = null;
      selectedDeviceView = null;
      fallEvents = [];
    }
    showToast('Đã bỏ theo dõi thiết bị');
  } catch (error) {
    showToast(describeAuthError(error));
  }
}

function initDevicesPage(): void {
  $<HTMLButtonElement>('btn-add-device').addEventListener('click', openAddDeviceDialog);
  $<HTMLButtonElement>('btn-add-device-empty').addEventListener('click', openAddDeviceDialog);
  $<HTMLButtonElement>('btn-submit-add-device').addEventListener('click', () => void submitAddDevice());
  $<HTMLButtonElement>('btn-cancel-add-device').addEventListener('click', closeAddDeviceDialog);
  $<HTMLButtonElement>('btn-close-add-device').addEventListener('click', closeAddDeviceDialog);

  const idInput = $<HTMLInputElement>('add-device-id');
  idInput.addEventListener('input', () => {
    idInput.value = idInput.value.replace(/\D/g, '').slice(0, 12);
  });
  const otpInput = $<HTMLInputElement>('add-device-otp');
  otpInput.addEventListener('input', () => {
    otpInput.value = otpInput.value.replace(/\D/g, '').slice(0, 6);
  });

  $<HTMLButtonElement>('btn-save-rename').addEventListener('click', () => void submitRename());
  $<HTMLButtonElement>('btn-cancel-rename').addEventListener('click', closeRenameDialog);
  $<HTMLButtonElement>('btn-close-rename').addEventListener('click', closeRenameDialog);

  [$<HTMLDivElement>('add-device-overlay'), $<HTMLDivElement>('rename-overlay')].forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.hidden = true;
    });
  });
}

// ------------------------------------------------------------
// TRANG TỔNG QUAN (DASHBOARD)
// ------------------------------------------------------------

function renderDashboard(): void {
  const noDeviceBox = $<HTMLDivElement>('dashboard-no-device');
  const contentBox = $<HTMLDivElement>('dashboard-content');

  if (!selectedDeviceId) {
    noDeviceBox.hidden = false;
    contentBox.hidden = true;
    return;
  }
  noDeviceBox.hidden = true;
  contentBox.hidden = false;

  const link = deviceLinks.find((l) => l.deviceId === selectedDeviceId);
  const view = toDeviceView(selectedDeviceId, link?.alias ?? selectedDeviceId, selectedDeviceDoc);
  selectedDeviceView = view;

  const statusPill = $<HTMLSpanElement>('device-status-pill');
  const isOnline = view.status === 'online';
  statusPill.classList.toggle('status-pill--offline', !isOnline);
  $<HTMLSpanElement>('device-status-text').textContent = isOnline ? 'Online' : 'Offline';

  $<HTMLSpanElement>('device-alias').textContent = view.alias;
  $<HTMLSpanElement>('device-owner-name').textContent = view.ownerName;
  $<HTMLSpanElement>('device-id').textContent = view.id;
  $<HTMLSpanElement>('device-updated-time').textContent = view.lastSeen
    ? formatTime(view.lastSeen)
    : 'chưa có dữ liệu';

  const batteryValue = $<HTMLDivElement>('battery-value');
  const batteryFill = $<HTMLDivElement>('battery-fill');
  if (view.battery === null) {
    batteryValue.textContent = '—';
    batteryFill.style.width = '0%';
  } else {
    batteryValue.textContent = `${view.battery}%`;
    batteryFill.style.width = `${view.battery}%`;
    batteryFill.classList.toggle('progress-bar__fill--low', view.battery <= appSettings.lowBatteryThreshold);
  }

  const locationValue = $<HTMLDivElement>('location-value');
  locationValue.innerHTML =
    view.latitude === null || view.longitude === null
      ? 'Chưa có vị trí'
      : `N: ${view.latitude.toFixed(6)}°<br>E: ${view.longitude.toFixed(6)}°`;

  $<HTMLDivElement>('alert-count-value').textContent = `${view.alertCount} lần`;

  const monitorNote = $<HTMLParagraphElement>('dashboard-monitor-note');
  if (!isOnline) {
    monitorNote.hidden = false;
    monitorNote.textContent = '⚠️ Thiết bị đang offline — app Fall Guard có thể đã bị tắt hoặc mất mạng.';
    monitorNote.className = 'dashboard-note dashboard-note--warning';
  } else if (!view.monitoringEnabled) {
    monitorNote.hidden = false;
    monitorNote.textContent = '⚠️ Người dùng đang TẮT giám sát cảm biến — sẽ không phát hiện được té ngã.';
    monitorNote.className = 'dashboard-note dashboard-note--warning';
  } else {
    monitorNote.hidden = false;
    monitorNote.textContent = '✅ Đang giám sát cảm biến bình thường.';
    monitorNote.className = 'dashboard-note dashboard-note--ok';
  }

  const miniMapFrame = document.getElementById('mini-map-frame') as HTMLIFrameElement | null;
  if (miniMapFrame && view.latitude !== null && view.longitude !== null) {
    const nextSrc = buildMapEmbedUrl(view.latitude, view.longitude, 15);
    if (miniMapFrame.src !== nextSrc) miniMapFrame.src = nextSrc;
  }
}

/** Cứ 10 giây tính lại online/offline vì trạng thái này phụ thuộc thời gian */
function startStatusTicker(): void {
  if (statusTickIntervalId !== null) return;
  statusTickIntervalId = window.setInterval(() => {
    const page = document.querySelector<HTMLElement>('.page--active')?.dataset.page;
    if (page === 'dashboard') renderDashboard();
    else if (page === 'devices') renderDeviceList();
  }, 10_000);
}

function stopStatusTicker(): void {
  if (statusTickIntervalId !== null) {
    window.clearInterval(statusTickIntervalId);
    statusTickIntervalId = null;
  }
}

// ------------------------------------------------------------
// TRANG BẢN ĐỒ
// ------------------------------------------------------------

// Lớp bản đồ đang chọn: 'm' = bản đồ thường, 'k' = vệ tinh
let currentMapLayer: 'm' | 'k' = 'm';

/** Tạo URL nhúng Google Maps, luôn giữ đúng lớp bản đồ đang chọn */
function buildMapEmbedUrl(lat: number, lng: number, zoom: number): string {
  return `https://maps.google.com/maps?q=${lat},${lng}&z=${zoom}&output=embed&t=${currentMapLayer}`;
}

/**
 * Tạo liên kết chỉ đường phù hợp với môi trường đang chạy:
 * - Trên app Android: dùng lược đồ `google.navigation:` để mở thẳng app Google Maps.
 * - Trên trình duyệt: dùng liên kết web Google Maps như cũ.
 */
function buildDirectionsUrl(lat: number, lng: number): string {
  if (isNativeApp()) return `google.navigation:q=${lat},${lng}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

/** Toạ độ đang được hiển thị trên bản đồ toàn màn hình */
let mapFocus: { lat: number; lng: number; zoom: number; label: string } | null = null;

function renderMapPage(): void {
  const frame = $<HTMLIFrameElement>('gmap-frame');
  const infoBox = $<HTMLElement>('map-info-card');
  const emptyBox = $<HTMLDivElement>('map-empty');

  const view = selectedDeviceView;
  const focus =
    mapFocus ??
    (view && view.latitude !== null && view.longitude !== null
      ? { lat: view.latitude, lng: view.longitude, zoom: 16, label: view.alias }
      : null);

  if (!focus) {
    infoBox.hidden = true;
    emptyBox.hidden = false;
    return;
  }

  infoBox.hidden = false;
  emptyBox.hidden = true;

  const nextSrc = buildMapEmbedUrl(focus.lat, focus.lng, focus.zoom);
  if (frame.src !== nextSrc) frame.src = nextSrc;

  $<HTMLSpanElement>('map-device-name').textContent = focus.label;
  $<HTMLSpanElement>('map-coords').textContent = `${focus.lat.toFixed(6)}°N, ${focus.lng.toFixed(6)}°E`;
  // Cố tình dùng locationUpdatedAt chứ không phải lastSeen: người thân cần biết
  // TOẠ ĐỘ cũ bao lâu rồi, chứ không phải máy vừa báo còn sống lúc nào.
  $<HTMLSpanElement>('map-updated-time').textContent =
    view && view.locationUpdatedAt ? formatTime(view.locationUpdatedAt) : 'chưa có';
  $<HTMLSpanElement>('map-accuracy').textContent =
    view && view.accuracy !== null ? `± ${Math.round(view.accuracy)} m` : '—';

  $<HTMLAnchorElement>('btn-directions').href = buildDirectionsUrl(focus.lat, focus.lng);
}

function initMapPage(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.map-tabs__item');
  const frame = $<HTMLIFrameElement>('gmap-frame');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('map-tabs__item--active'));
      tab.classList.add('map-tabs__item--active');

      const mode = tab.dataset.maptab;
      currentMapLayer = mode === 'satellite' ? 'k' : 'm';
      frame.classList.toggle('map-frame--satellite', mode === 'satellite');
      renderMapPage();
    });
  });

  $<HTMLButtonElement>('map-locate-btn').addEventListener('click', () => {
    // Quay về vị trí hiện tại của thiết bị, bỏ qua sự kiện lịch sử đang xem.
    mapFocus = null;
    renderMapPage();
    showToast('Đã định vị về vị trí hiện tại của thiết bị');
  });

  $<HTMLButtonElement>('map-back-btn').addEventListener('click', () => showDashboard());
}

// ------------------------------------------------------------
// TRANG LỊCH SỬ
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
  const empty = $<HTMLDivElement>('history-empty');
  container.innerHTML = '';

  if (!selectedDeviceId) {
    empty.hidden = false;
    $<HTMLParagraphElement>('history-empty-text').textContent =
      'Chưa chọn thiết bị nào. Vào tab Thiết bị để thêm hoặc chọn thiết bị.';
    return;
  }

  if (fallEvents.length === 0) {
    empty.hidden = false;
    $<HTMLParagraphElement>('history-empty-text').textContent =
      'Chưa có sự kiện té ngã nào được ghi nhận.';
    return;
  }
  empty.hidden = true;

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
      // Lịch sử chỉ còn những lần cảnh báo thật sự được gửi đi.
      const hasLocation = !(ev.latitude === 0 && ev.longitude === 0);

      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <div class="history-item__icon">🚨</div>
        <div class="history-item__body">
          <div class="history-item__title">Té ngã — đã gửi cảnh báo</div>
          <div class="history-item__meta">
            <span>⏰ ${ev.timestamp}</span>
            <span>📍 ${hasLocation ? `${ev.latitude.toFixed(6)}°N, ${ev.longitude.toFixed(6)}°E` : 'không kèm vị trí'}</span>
          </div>
        </div>
        ${hasLocation ? `<button type="button" class="btn btn--secondary btn--sm" data-event-id="${ev.id}">Xem</button>` : ''}
      `;
      itemsEl.appendChild(item);
    });

    groupEl.appendChild(itemsEl);
    container.appendChild(groupEl);
  });

  // Click "Xem" → chuyển sang bản đồ và focus vị trí sự kiện đó
  container.querySelectorAll<HTMLButtonElement>('[data-event-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ev = fallEvents.find((e) => e.id === btn.dataset.eventId);
      if (!ev) return;
      mapFocus = {
        lat: ev.latitude,
        lng: ev.longitude,
        zoom: 17,
        label: `Té ngã lúc ${ev.timestamp} ${ev.date}`,
      };
      showMap();
    });
  });
}

// ------------------------------------------------------------
// TRANG CÀI ĐẶT
// ------------------------------------------------------------

function loadSettingsFromStorage(): void {
  appSettings = {
    fallAlertEnabled: true,
    deviceOfflineAlertEnabled: true,
    lowBatteryThreshold: 20,
    alertSoundMuted: false,
  };
  const saved = localStorage.getItem(storageKey('settings'));
  if (saved) {
    try {
      appSettings = { ...appSettings, ...JSON.parse(saved) };
    } catch {
      // Bỏ qua dữ liệu hỏng, dùng giá trị mặc định
    }
  }

  setChimeMuted(appSettings.alertSoundMuted === true);
}

function saveSettingsToStorage(): void {
  localStorage.setItem(storageKey('settings'), JSON.stringify(appSettings));
}

function renderSettings(): void {
  $<HTMLSpanElement>('settings-account-email').textContent = currentUser?.email ?? '—';
  $<HTMLSpanElement>('settings-account-name').textContent = currentUserName || '—';
  $<HTMLSpanElement>('settings-device-count').textContent = `${deviceLinks.length} thiết bị`;

  $<HTMLInputElement>('toggle-alert-sound').checked = !appSettings.alertSoundMuted;
  $<HTMLInputElement>('toggle-fall-alert').checked = appSettings.fallAlertEnabled;
  $<HTMLInputElement>('toggle-offline-alert').checked = appSettings.deviceOfflineAlertEnabled;
  $<HTMLInputElement>('battery-threshold-slider').value = appSettings.lowBatteryThreshold.toString();
  $<HTMLSpanElement>('battery-threshold-value').textContent = `${appSettings.lowBatteryThreshold}%`;
}

function initSettingsPage(): void {
  const fallToggle = $<HTMLInputElement>('toggle-fall-alert');
  const offlineToggle = $<HTMLInputElement>('toggle-offline-alert');
  const slider = $<HTMLInputElement>('battery-threshold-slider');
  const sliderValue = $<HTMLSpanElement>('battery-threshold-value');

  fallToggle.addEventListener('change', () => {
    appSettings.fallAlertEnabled = fallToggle.checked;
    saveSettingsToStorage();
    showToast(fallToggle.checked ? 'Đã bật cảnh báo té ngã' : 'Đã tắt cảnh báo té ngã');
  });

  offlineToggle.addEventListener('change', () => {
    appSettings.deviceOfflineAlertEnabled = offlineToggle.checked;
    saveSettingsToStorage();
  });

  slider.addEventListener('input', () => {
    appSettings.lowBatteryThreshold = Number(slider.value);
    sliderValue.textContent = `${slider.value}%`;
  });
  slider.addEventListener('change', () => {
    saveSettingsToStorage();
    renderDashboard();
  });

  const soundToggle = $<HTMLInputElement>('toggle-alert-sound');
  soundToggle.addEventListener('change', () => {
    appSettings.alertSoundMuted = !soundToggle.checked;
    saveSettingsToStorage();
    setChimeMuted(appSettings.alertSoundMuted);
    if (!appSettings.alertSoundMuted) void playTestChime();
    showToast(appSettings.alertSoundMuted ? 'Đã tắt tiếng chuông báo' : 'Đã bật tiếng chuông báo');
  });

  $<HTMLButtonElement>('btn-test-chime').addEventListener('click', async () => {
    if (isChimeMuted()) {
      showToast('Đang tắt tiếng — bật công tắc phía trên để nghe thử.');
      return;
    }
    const route = await playTestChime();
    showToast(describeRoute(route));
  });

  $<HTMLButtonElement>('logout-btn-settings').addEventListener('click', () => void doLogout());
}

// --- Đổi họ tên tài khoản ---

function openAccountNameDialog(): void {
  $<HTMLInputElement>('account-name-input').value = currentUserName;
  $<HTMLParagraphElement>('error-account-name').textContent = '';
  $<HTMLDivElement>('account-name-overlay').hidden = false;
}

function closeAccountNameDialog(): void {
  $<HTMLDivElement>('account-name-overlay').hidden = true;
}

async function saveAccountName(): Promise<void> {
  if (!currentUser) return;

  const input = $<HTMLInputElement>('account-name-input');
  const errorBox = $<HTMLParagraphElement>('error-account-name');
  const saveBtn = $<HTMLButtonElement>('btn-save-account-name');
  const name = input.value.trim();

  if (!name) {
    errorBox.textContent = 'Vui lòng nhập họ tên.';
    return;
  }
  if (name.length > 60) {
    errorBox.textContent = 'Họ tên quá dài (tối đa 60 ký tự).';
    return;
  }
  errorBox.textContent = '';

  setButtonBusy(saveBtn, true, 'Đang lưu...');
  try {
    await patchUserDoc(currentUser.uid, { displayName: name });
    await updateProfile(currentUser, { displayName: name });
    currentUserName = name;
    closeAccountNameDialog();
    renderSettings();

    // Tên đã lưu chỉ dùng cho những lần GHÉP CẶP SAU. Các máy đang theo dõi vẫn
    // hiện tên cũ, vì rules không cho người thân ghi vào tài liệu thiết bị.
    showToast('Đã đổi họ tên');
  } catch (error) {
    errorBox.textContent = describeAuthError(error);
  } finally {
    setButtonBusy(saveBtn, false);
  }
}

function initAccountNameDialog(): void {
  $<HTMLButtonElement>('btn-edit-account-name').addEventListener('click', openAccountNameDialog);
  $<HTMLButtonElement>('btn-save-account-name').addEventListener('click', () => void saveAccountName());
  $<HTMLButtonElement>('btn-cancel-account-name').addEventListener('click', closeAccountNameDialog);
  $<HTMLButtonElement>('btn-close-account-name').addEventListener('click', closeAccountNameDialog);

  const overlay = $<HTMLDivElement>('account-name-overlay');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeAccountNameDialog();
  });
}

// --- Dialog xoá lịch sử ---

function renderDeleteDialogList(): void {
  const list = $<HTMLDivElement>('delete-event-list');
  list.innerHTML = '';
  selectedForDeletion.clear();
  updateDeleteConfirmLabel();

  if (fallEvents.length === 0) {
    list.innerHTML = '<p class="modal__subtitle">Chưa có sự kiện nào để xoá.</p>';
    return;
  }

  fallEvents.forEach((ev) => {
    const row = document.createElement('label');
    row.className = 'modal-checkbox-row';
    row.innerHTML = `
      <input type="checkbox" data-event-id="${ev.id}">
      <span>${ev.timestamp} - ${ev.date}</span>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.eventId!;
      if (cb.checked) selectedForDeletion.add(id);
      else selectedForDeletion.delete(id);
      updateDeleteConfirmLabel();
    });
  });
}

function updateDeleteConfirmLabel(): void {
  $<HTMLButtonElement>('btn-confirm-delete').textContent = `Xoá (${selectedForDeletion.size})`;
}

function openDeleteDialog(): void {
  if (!selectedDeviceId) {
    showToast('Chưa chọn thiết bị nào');
    return;
  }
  renderDeleteDialogList();
  $<HTMLDivElement>('delete-dialog-overlay').hidden = false;
}

function closeDeleteDialog(): void {
  $<HTMLDivElement>('delete-dialog-overlay').hidden = true;
}

function initDeleteDialog(): void {
  $<HTMLButtonElement>('btn-open-delete-dialog').addEventListener('click', openDeleteDialog);
  $<HTMLButtonElement>('btn-cancel-delete').addEventListener('click', closeDeleteDialog);
  $<HTMLButtonElement>('btn-close-delete-dialog').addEventListener('click', closeDeleteDialog);

  $<HTMLButtonElement>('btn-select-all').addEventListener('click', () => {
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      '#delete-event-list input[type="checkbox"]'
    );
    const allChecked = [...checkboxes].every((cb) => cb.checked);
    checkboxes.forEach((cb) => {
      cb.checked = !allChecked;
      const id = cb.dataset.eventId!;
      if (cb.checked) selectedForDeletion.add(id);
      else selectedForDeletion.delete(id);
    });
    updateDeleteConfirmLabel();
  });

  $<HTMLButtonElement>('btn-confirm-delete').addEventListener('click', async () => {
    if (selectedForDeletion.size === 0 || !selectedDeviceId) {
      closeDeleteDialog();
      return;
    }
    const confirmBtn = $<HTMLButtonElement>('btn-confirm-delete');
    const ids = [...selectedForDeletion];

    setButtonBusy(confirmBtn, true, 'Đang xoá...');
    try {
      await deleteFallEvents(selectedDeviceId, ids);
      closeDeleteDialog();
      showToast(`Đã xoá ${ids.length} sự kiện`);
    } catch (error) {
      showToast('Không xoá được: ' + describeAuthError(error));
    } finally {
      setButtonBusy(confirmBtn, false);
    }
  });

  const overlay = $<HTMLDivElement>('delete-dialog-overlay');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDeleteDialog();
  });
}

// ------------------------------------------------------------
// LUỒNG REALTIME CỦA FIRESTORE
// ------------------------------------------------------------

function selectDevice(deviceId: string): void {
  if (selectedDeviceId === deviceId) return;

  detachDeviceStreams();
  selectedDeviceId = deviceId;
  selectedDeviceDoc = null;
  selectedDeviceView = null;
  fallEvents = [];
  lastKnownEventCount = -1;
  mapFocus = null;
  localStorage.setItem(storageKey('selectedDevice'), deviceId);

  unsubscribeDevice = subscribeDevice(
    deviceId,
    (data) => {
      selectedDeviceDoc = data;
      const page = document.querySelector<HTMLElement>('.page--active')?.dataset.page;
      renderDashboardIfVisible(page);
      if (page === 'devices') renderDeviceList();
      if (page === 'map') renderMapPage();
    },
    () => {
      showToast('Người dùng đã ngắt kết nối với bạn. Thiết bị này không còn theo dõi được.');
      selectedDeviceDoc = null;
      renderDashboard();
    }
  );

  unsubscribeEvents = subscribeFallEvents(
    deviceId,
    (events) => {
      notifyIfNewFall(events);
      fallEvents = events;
      const page = document.querySelector<HTMLElement>('.page--active')?.dataset.page;
      if (page === 'history') renderHistory();
      renderDashboardIfVisible(page);
    },
    (error) => showToast('Lỗi đọc lịch sử: ' + describeAuthError(error))
  );
}

function renderDashboardIfVisible(page: string | undefined): void {
  if (page === 'dashboard') renderDashboard();
  else if (selectedDeviceId) {
    // Vẫn cập nhật selectedDeviceView để tab Thiết bị / Bản đồ dùng tới.
    const link = deviceLinks.find((l) => l.deviceId === selectedDeviceId);
    selectedDeviceView = toDeviceView(
      selectedDeviceId,
      link?.alias ?? selectedDeviceId,
      selectedDeviceDoc
    );
  }
}

/** Báo cho người thân biết khi có sự kiện té ngã MỚI xuất hiện */
function notifyIfNewFall(events: FallEvent[]): void {
  if (lastKnownEventCount === -1) {
    lastKnownEventCount = events.length;
    return;
  }

  if (events.length > lastKnownEventCount && appSettings.fallAlertEnabled) {
    const latest = events[0];
    if (latest && latest.status === 'sent') {
      const link = deviceLinks.find((l) => l.deviceId === selectedDeviceId);
      showToast(`🚨 ${link?.alias ?? 'Thiết bị'} vừa phát hiện té ngã lúc ${latest.timestamp}!`);
      void playAlertChime(); // tự kèm rung, tự tôn trọng cài đặt tắt tiếng

      // Chuông lặp 15 giây rồi tự tắt. Đợi 1,5 giây mới cho phép chạm-để-tắt,
      // không thì chính cú chạm đang mở app sẽ dập chuông ngay lập tức.
      window.setTimeout(() => {
        document.addEventListener('pointerdown', stopAlert, { once: true });
      }, 1500);
    }
  }

  lastKnownEventCount = events.length;
}

function detachDeviceStreams(): void {
  unsubscribeDevice?.();
  unsubscribeEvents?.();
  unsubscribeDevice = null;
  unsubscribeEvents = null;
}

function attachLinkStream(uid: string): void {
  unsubscribeLinks?.();
  unsubscribeLinks = subscribeLinks(
    uid,
    (links) => {
      deviceLinks = links;

      // Thiết bị đang chọn vừa bị bỏ theo dõi → chọn thiết bị khác.
      if (selectedDeviceId && !links.some((l) => l.deviceId === selectedDeviceId)) {
        detachDeviceStreams();
        selectedDeviceId = null;
        selectedDeviceDoc = null;
        selectedDeviceView = null;
        fallEvents = [];
      }

      if (!selectedDeviceId && links.length > 0) {
        const remembered = localStorage.getItem(storageKey('selectedDevice'));
        const target = links.find((l) => l.deviceId === remembered) ?? links[0];
        selectDevice(target.deviceId);
      }

      const page = document.querySelector<HTMLElement>('.page--active')?.dataset.page;
      if (page === 'devices') renderDeviceList();
      if (page === 'dashboard') renderDashboard();
      if (page === 'settings') renderSettings();
    },
    (error) => showToast('Lỗi đọc danh sách thiết bị: ' + describeAuthError(error))
  );
}

// ------------------------------------------------------------
// ĐIỀU HƯỚNG CHUNG
// ------------------------------------------------------------

async function doLogout(): Promise<void> {
  if (!confirm('Đăng xuất khỏi tài khoản này?')) return;
  await signOutUser();
}

function initGlobalNavigation(): void {
  document.querySelectorAll<HTMLButtonElement>('.bottom-nav__item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav as PageName;
      if (target === 'devices') showDevices();
      else if (target === 'dashboard') showDashboard();
      else if (target === 'map') showMap();
      else if (target === 'history') showHistory();
      else if (target === 'settings') showSettings();
    });
  });

  $<HTMLButtonElement>('btn-fullscreen-map').addEventListener('click', () => {
    mapFocus = null;
    showMap();
  });

  $<HTMLButtonElement>('btn-goto-devices').addEventListener('click', () => showDevices());
  $<HTMLButtonElement>('logout-btn-dashboard').addEventListener('click', () => void doLogout());
  $<HTMLButtonElement>('btn-switch-device').addEventListener('click', () => showDevices());
}

// ------------------------------------------------------------
// PHẢN ỨNG VỚI TRẠNG THÁI ĐĂNG NHẬP
// ------------------------------------------------------------

async function onSignedIn(user: User): Promise<void> {
  currentUser = user;
  loadSettingsFromStorage();

  try {
    const userDoc = await ensureUserDoc(user);

    // Phiên cũ còn lưu trên máy vẫn có thể là tài khoản của app kia — chặn luôn.
    if (!hasCorrectRole(userDoc)) {
      await signOutUser();
      showToast(WRONG_ROLE_MESSAGE);
      return;
    }

    currentUserName = userDoc.displayName || user.displayName || (user.email ?? '');
  } catch (error) {
    showToast('Không đọc được hồ sơ: ' + describeAuthError(error));
    currentUserName = user.email ?? '';
  }

  attachLinkStream(user.uid);
  startStatusTicker();
  showDevices();
}

function onSignedOut(): void {
  unsubscribeLinks?.();
  unsubscribeLinks = null;
  detachDeviceStreams();
  stopStatusTicker();

  currentUser = null;
  currentUserName = '';
  deviceLinks = [];
  selectedDeviceId = null;
  selectedDeviceDoc = null;
  selectedDeviceView = null;
  fallEvents = [];
  lastKnownEventCount = -1;
  showLogin();
}

// ------------------------------------------------------------
// KHỞI TẠO ỨNG DỤNG
// ------------------------------------------------------------

function initApp(): void {
  buildBottomNavs();

  // Trình duyệt di động chặn phát tiếng cho tới khi người dùng chạm màn hình.
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
  initDevicesPage();
  initMapPage();
  initSettingsPage();
  initAccountNameDialog();
  initDeleteDialog();
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
