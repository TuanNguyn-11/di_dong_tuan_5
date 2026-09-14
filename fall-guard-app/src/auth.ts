// ============================================================
// auth.ts — Đăng ký / đăng nhập / quên mật khẩu
// ============================================================
// Luồng đăng ký:
//   1. Người dùng nhập họ tên + email + mật khẩu.
//   2. App sinh OTP 6 số, gửi qua EmailJS tới chính email đó.
//   3. Người dùng nhập đúng OTP  ->  app gọi Firebase Auth tạo tài khoản thật.
//
// OTP được giữ TRONG BỘ NHỚ của app, không ghi lên Firestore. Lý do: nếu ghi
// lên Firestore thì phải mở quyền đọc collection đó cho người CHƯA đăng nhập,
// tức là ai cũng đọc trộm được mã của người khác — hại nhiều hơn lợi.
//
// Quên mật khẩu dùng sendPasswordResetEmail có sẵn của Firebase (gửi link đặt
// lại mật khẩu). Firebase Auth không cho phép đổi mật khẩu bằng OTP tự chế nếu
// không có backend riêng, nên đây là cách an toàn và miễn phí duy nhất.

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut as fbSignOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { generateOtp, sendOtpEmail } from './emailjs';
import type { AppRole, UserDoc } from './types';

/** Vai trò của app này. Fall Guard = người có nguy cơ té ngã. */
export const APP_ROLE: AppRole = 'faller';

const OTP_EXPIRE_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60_000;

interface PendingRegistration {
  email: string;
  password: string;
  displayName: string;
  otp: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

let pending: PendingRegistration | null = null;

// ------------------------------------------------------------
// DỊCH LỖI FIREBASE SANG TIẾNG VIỆT
// ------------------------------------------------------------

const AUTH_ERROR_VI: Record<string, string> = {
  'auth/invalid-email': 'Địa chỉ email không hợp lệ.',
  'auth/email-already-in-use':
    'Email này đã được đăng ký rồi. Lưu ý mỗi app cần một tài khoản riêng — '
    + 'nếu email này đang dùng cho app còn lại thì hãy đăng ký bằng email khác.',
  'auth/weak-password': 'Mật khẩu quá yếu — cần ít nhất 6 ký tự.',
  'auth/user-not-found': 'Không tìm thấy tài khoản với email này.',
  'auth/wrong-password': 'Mật khẩu không đúng.',
  'auth/invalid-credential': 'Email hoặc mật khẩu không đúng.',
  'auth/too-many-requests': 'Bạn thử quá nhiều lần. Vui lòng đợi ít phút rồi thử lại.',
  'auth/network-request-failed': 'Mất kết nối mạng. Kiểm tra Internet rồi thử lại.',
  'auth/operation-not-allowed':
    'Chưa bật phương thức Email/Password. Vào Firebase Console → Authentication → Sign-in method để bật.',
  'auth/api-key-not-valid': 'API key Firebase không đúng. Kiểm tra lại src/firebase-config.ts.',
};

export function describeAuthError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && AUTH_ERROR_VI[code]) return AUTH_ERROR_VI[code];
  const message = (error as { message?: string } | null)?.message;
  if (message && message.includes('api-key-not-valid')) return AUTH_ERROR_VI['auth/api-key-not-valid'];
  return message || 'Đã xảy ra lỗi không xác định.';
}

// ------------------------------------------------------------
// ĐĂNG KÝ — BƯỚC 1: GỬI OTP
// ------------------------------------------------------------

/**
 * Sinh OTP rồi gửi email. Chưa tạo tài khoản Firebase ở bước này —
 * tài khoản chỉ được tạo sau khi nhập đúng mã.
 */
export async function startRegistration(
  displayName: string,
  email: string,
  password: string
): Promise<void> {
  const otp = generateOtp();
  await sendOtpEmail({
    toEmail: email,
    toName: displayName,
    otp,
    expireMinutes: OTP_EXPIRE_MINUTES,
  });

  pending = {
    email,
    password,
    displayName,
    otp,
    expiresAt: Date.now() + OTP_EXPIRE_MINUTES * 60_000,
    attempts: 0,
    lastSentAt: Date.now(),
  };
}

/** Email đang chờ xác thực OTP (để hiển thị trên màn hình nhập mã) */
export function getPendingEmail(): string | null {
  return pending ? pending.email : null;
}

/** Số giây còn lại trước khi được bấm "Gửi lại mã" */
export function getResendCooldownSeconds(): number {
  if (!pending) return 0;
  const remain = OTP_RESEND_COOLDOWN_MS - (Date.now() - pending.lastSentAt);
  return remain > 0 ? Math.ceil(remain / 1000) : 0;
}

/** Gửi lại mã OTP mới cho cùng email đang chờ */
export async function resendOtp(): Promise<void> {
  if (!pending) throw new Error('Không có yêu cầu đăng ký nào đang chờ.');
  const cooldown = getResendCooldownSeconds();
  if (cooldown > 0) {
    throw new Error(`Vui lòng đợi ${cooldown} giây nữa rồi gửi lại.`);
  }

  const otp = generateOtp();
  await sendOtpEmail({
    toEmail: pending.email,
    toName: pending.displayName,
    otp,
    expireMinutes: OTP_EXPIRE_MINUTES,
  });

  pending.otp = otp;
  pending.expiresAt = Date.now() + OTP_EXPIRE_MINUTES * 60_000;
  pending.attempts = 0;
  pending.lastSentAt = Date.now();
}

export function cancelRegistration(): void {
  pending = null;
}

// ------------------------------------------------------------
// ĐĂNG KÝ — BƯỚC 2: XÁC THỰC OTP & TẠO TÀI KHOẢN
// ------------------------------------------------------------

/**
 * So mã người dùng nhập với mã đang chờ. Đúng thì tạo tài khoản Firebase Auth
 * và ghi hồ sơ vào users/{uid}.
 */
export async function verifyOtpAndCreateAccount(code: string): Promise<User> {
  if (!pending) throw new Error('Phiên đăng ký đã hết hạn. Vui lòng đăng ký lại.');

  if (Date.now() > pending.expiresAt) {
    pending = null;
    throw new Error('Mã OTP đã hết hạn. Vui lòng đăng ký lại để nhận mã mới.');
  }

  if (code !== pending.otp) {
    pending.attempts += 1;
    const left = OTP_MAX_ATTEMPTS - pending.attempts;
    if (left <= 0) {
      pending = null;
      throw new Error('Nhập sai quá 5 lần. Phiên đăng ký đã bị huỷ, vui lòng đăng ký lại.');
    }
    throw new Error(`Mã OTP không đúng. Bạn còn ${left} lần thử.`);
  }

  const credential = await createUserWithEmailAndPassword(auth, pending.email, pending.password);
  await updateProfile(credential.user, { displayName: pending.displayName });

  await setDoc(doc(db, 'users', credential.user.uid), {
    email: pending.email,
    displayName: pending.displayName,
    role: APP_ROLE,
    createdAt: serverTimestamp(),
  });

  pending = null;
  return credential.user;
}

// ------------------------------------------------------------
// ĐĂNG NHẬP / ĐĂNG XUẤT / QUÊN MẬT KHẨU
// ------------------------------------------------------------

/** Thông báo khi đăng nhập nhầm app */
export const WRONG_ROLE_MESSAGE =
  'Email này đang là tài khoản NGƯỜI THÂN (app Healthcare Map), không đăng nhập được vào Fall Guard. '
      + 'Mỗi app cần một tài khoản riêng — hãy đăng ký tài khoản mới bằng email khác.';

/**
 * Tài khoản này có đúng vai trò của app đang chạy không?
 * Hai app dùng chung một dự án Firebase nên nếu không chặn, tài khoản người thân
 * sẽ đăng nhập được vào app người té ngã và ngược lại — dẫn tới một tài khoản
 * vừa là chủ thiết bị vừa là người theo dõi, rối cả dữ liệu lẫn phân quyền.
 */
export function hasCorrectRole(userDoc: UserDoc): boolean {
  return userDoc.role === APP_ROLE;
}

export async function signIn(email: string, password: string): Promise<User> {
  const credential = await signInWithEmailAndPassword(auth, email, password);

  // Tài khoản tạo từ app kia có thể chưa có hồ sơ bên này — bổ sung cho đủ.
  const userDoc = await ensureUserDoc(credential.user);

  if (!hasCorrectRole(userDoc)) {
    await fbSignOut(auth);
    throw new Error(WRONG_ROLE_MESSAGE);
  }

  return credential.user;
}

export async function signOutUser(): Promise<void> {
  await fbSignOut(auth);
}

export async function sendResetPasswordEmail(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

/** Tạo users/{uid} nếu chưa tồn tại (tài khoản cũ, hoặc tạo từ app còn lại) */
export async function ensureUserDoc(user: User): Promise<UserDoc> {
  const ref = doc(db, 'users', user.uid);
  const snapshot = await getDoc(ref);

  if (snapshot.exists()) {
    return snapshot.data() as UserDoc;
  }

  const userDoc: UserDoc = {
    email: user.email ?? '',
    displayName: user.displayName ?? (user.email ?? '').split('@')[0],
    role: APP_ROLE,
  };
  await setDoc(ref, { ...userDoc, createdAt: serverTimestamp() });
  return userDoc;
}

/** Đọc hồ sơ users/{uid}; trả về null nếu chưa có */
export async function fetchUserDoc(uid: string): Promise<UserDoc | null> {
  const snapshot = await getDoc(doc(db, 'users', uid));
  return snapshot.exists() ? (snapshot.data() as UserDoc) : null;
}

/** Cập nhật một vài trường của users/{uid} */
export async function patchUserDoc(uid: string, patch: Partial<UserDoc>): Promise<void> {
  await setDoc(doc(db, 'users', uid), patch, { merge: true });
}
