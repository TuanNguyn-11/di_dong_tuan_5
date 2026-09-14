// ============================================================
// types.ts — Kiểu dữ liệu dùng chung
// Fall Guard — Phát hiện té ngã dành cho người có nguy cơ
// ============================================================
//
// Từ bản tích hợp Firebase, dự án được đóng gói bằng esbuild nên các file
// dùng import/export như module ES chuẩn.

import type { Timestamp } from 'firebase/firestore';

/** Vai trò tài khoản — quyết định app nào được phép làm gì */
export type AppRole = 'faller' | 'guardian';

/** Hồ sơ tài khoản lưu tại users/{uid} */
export interface UserDoc {
  email: string;
  displayName: string;
  role: AppRole;
  deviceId?: string; // chỉ có với role 'faller'
  createdAt?: Timestamp;
}

/** Hồ sơ người dùng cache tại máy (bản sao nhẹ của UserDoc) */
export interface UserProfile {
  uid: string;
  email: string;
  name: string;
  deviceId: string; // 12 chữ số, sinh 1 lần
  createdAt: string; // ISO date
}

/** Liên hệ khẩn cấp — tối đa 3 người, chỉ lưu tại máy */
export interface EmergencyContact {
  id: string;
  name: string;
  phone: string;
  relation: string;
}

/** Một mẫu cảm biến tại một thời điểm */
export interface SensorSample {
  t: number; // timestamp ms
  ax: number; ay: number; az: number; // accelerometer m/s²
  gx: number; gy: number; gz: number; // gyroscope rad/s
}

/** Cửa sổ dữ liệu cảm biến để gửi cho AI xác nhận */
export interface SensorWindow {
  samples: SensorSample[];
  sampleRateHz: number;
  windowMs: number;
}

/** Kết quả xác nhận té ngã từ AI (mock hoặc model thật) */
export interface FallAiResult {
  isFall: boolean;
  confidence: number; // 0-1
  source: 'mock' | 'model';
}

/**
 * Trạng thái sự kiện té ngã.
 * Từ bản này trở đi chỉ còn ghi 'sent': báo động giả (người dùng kịp bấm
 * "Tôi ổn") không được ghi lên Firestore nữa. Giữ lại 'cancelled' để đọc được
 * những bản ghi cũ và lọc chúng ra khỏi lịch sử.
 */
export type FallEventStatus = 'sent' | 'cancelled';

/** Một sự kiện té ngã được ghi nhận (bản hiển thị tại máy) */
export interface FallEvent {
  id: string;
  timestamp: string; // HH:MM:SS
  date: string; // DD/MM/YYYY
  latitude: number;
  longitude: number;
  status: FallEventStatus;
  confidence: number; // %
}

/** Bản ghi sự kiện té ngã trên Firestore: devices/{deviceId}/events/{eventId} */
export interface FallEventDoc {
  status: FallEventStatus;
  confidence: number;
  lat: number;
  lng: number;
  source: 'sensor' | 'demo';
  createdAt: Timestamp | null;
}

/** Tài liệu thiết bị trên Firestore: devices/{deviceId} */
export interface DeviceDoc {
  ownerUid: string;
  name: string;
  guardianUids: string[];
  monitoringEnabled: boolean;
  battery: number | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  alertCount: number;
  lastSeen: Timestamp | null;
  locationUpdatedAt: Timestamp | null;
  createdAt: Timestamp | null;
}

/** Yêu cầu ghép cặp: devices/{deviceId}/requests/{guardianUid} */
export type PairRequestState = 'pending' | 'approved' | 'rejected';

export interface PairRequestDoc {
  guardianUid: string;
  guardianEmail: string;
  guardianName: string;
  code: string; // OTP 6 số người thân đã nhập
  state: PairRequestState;
  message: string;
  createdAt: Timestamp | null;
}

/** Người thân đang theo dõi máy này (hiển thị trong trang Kết nối) */
export interface LinkedGuardian {
  uid: string;
  email: string;
  name: string;
}

/** Cài đặt ứng dụng */
export interface AppSettings {
  sensitivity: 'low' | 'medium' | 'high';
  cancelCountdownSec: number; // 5 | 10 | 15
  includeGpsInAlert: boolean;
  monitoringEnabled: boolean;
  /** Tắt còi hú khi phát hiện té ngã (vẫn gửi cảnh báo, chỉ im tiếng) */
  alarmMuted: boolean;
}

/** Trạng thái từng cảm biến */
export interface SensorStatus {
  gps: 'active' | 'off' | 'error';
  accelerometer: 'active' | 'off' | 'error';
  gyroscope: 'active' | 'off' | 'error';
}

/** Tên các trang trong ứng dụng SPA */
export type PageName =
  | 'login'
  | 'register'
  | 'otp'
  | 'forgot'
  | 'onboarding'
  | 'home'
  | 'fallAlert'
  | 'pairing'
  | 'history'
  | 'contacts'
  | 'settings';
