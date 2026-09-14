// ============================================================
// firebase-config.ts — Cấu hình Firebase & EmailJS
// ============================================================
//
//  ⚠️  FILE NÀY LÀ FILE DUY NHẤT BẠN PHẢI SỬA BẰNG TAY.
//      Xem hướng dẫn từng bước trong ../../FIREBASE-SETUP.md
//
//  Nội dung của firebaseConfig phải GIỐNG HỆT file cùng tên bên
//  healthcare-map/src/firebase-config.ts — hai app dùng CHUNG một dự án
//  Firebase thì mới "nhìn thấy" dữ liệu của nhau.
// ============================================================

/**
 * Dán khối config lấy từ Firebase Console vào đây.
 * Firebase Console → ⚙️ Project settings → General → Your apps → SDK setup and
 * configuration → chọn "Config" → copy toàn bộ object.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyBCTuZ1ZY3A9LgTj_AkOolmoim_leobFEM",
  authDomain: "fall-guard-gps.firebaseapp.com",
  projectId: "fall-guard-gps",
  // Chỉ có sau khi tạo Realtime Database (mục 7 trong FIREBASE-SETUP.md).
  // Chưa dùng chức năng xem dạng sóng thì để nguyên chuỗi mẫu — app vẫn chạy đủ.
  databaseURL: 'https://fall-guard-gps-default-rtdb.asia-southeast1.firebasedatabase.app/',
  storageBucket: "fall-guard-gps.firebasestorage.app",
  messagingSenderId: "308552916225",
  appId: "1:308552916225:web:a7fc69493378fcd1374f00"
};
/**
 * Cấu hình EmailJS — dùng để gửi mã OTP 6 số xác thực email khi ĐĂNG KÝ.
 * Lấy tại https://dashboard.emailjs.com :
 *   - serviceId  : Email Services  → Service ID   (vd: service_ab12cde)
 *   - templateId : Email Templates → Template ID  (vd: template_xy34fgh)
 *   - publicKey  : Account → General → Public Key (vd: qwErTy123_AbCdEf)
 */
export const emailjsConfig = {
  serviceId: 'service_lcu9ssg',
  templateId: 'template_0frtpza',
  publicKey: 'MLFBGB8JcFGmjGgiG',
};

/** Cấu hình đã được điền thật hay vẫn còn là chỗ trống mẫu? */
export function isFirebaseConfigured(): boolean {
  return !firebaseConfig.apiKey.startsWith('DAN_');
}

export function isEmailjsConfigured(): boolean {
  return !emailjsConfig.serviceId.startsWith('DAN_');
}

/**
 * Realtime Database chỉ phục vụ chức năng xem dạng sóng cảm biến trực tiếp.
 * Chưa điền thì app vẫn chạy đủ mọi chức năng khác, chỉ là không stream sóng.
 */
export function isRealtimeDbConfigured(): boolean {
  return !firebaseConfig.databaseURL.startsWith('DAN_');
}
