// ============================================================
// types.ts — Kiểu dữ liệu dùng chung
// Healthcare Map — App của người thân, theo dõi thiết bị phát hiện té ngã
// ============================================================

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

/** Trạng thái kết nối của thiết bị được theo dõi */
export type DeviceStatus = 'online' | 'offline';

/** Tài liệu thiết bị thô đọc từ devices/{deviceId} */
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

/** Bản đã "chín" để hiển thị lên giao diện */
export interface DeviceView {
  id: string;
  /** Tên do người thân tự đặt (alias), ưu tiên hơn tên gốc trên thiết bị */
  alias: string;
  /** Tên người dùng tự đặt bên app Fall Guard */
  ownerName: string;
  status: DeviceStatus;
  battery: number | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  alertCount: number;
  monitoringEnabled: boolean;
  /** Lần cuối máy báo "tôi còn sống" — dùng để tính online/offline */
  lastSeen: Date | null;
  /** Lần cuối toạ độ GPS thật sự thay đổi (tắt giám sát thì đứng yên) */
  locationUpdatedAt: Date | null;
  /** Thiết bị vừa bị chủ máy ngắt kết nối → không còn quyền đọc */
  revoked: boolean;
}

/** Liên kết lưu tại guardians/{uid}/links/{deviceId} */
export interface DeviceLink {
  deviceId: string;
  alias: string;
  pairedAt: Timestamp | null;
}

/** Một sự kiện té ngã đã được ghi nhận */
export interface FallEvent {
  id: string;
  timestamp: string; // HH:MM:SS
  date: string; // DD/MM/YYYY
  latitude: number;
  longitude: number;
  /** Luôn là 'sent' — báo động giả không còn được ghi nhận, xem link.ts */
  status: 'sent' | 'cancelled';
  confidence: number;
}

/** Trạng thái yêu cầu ghép cặp */
export type PairRequestState = 'pending' | 'approved' | 'rejected';

export interface PairRequestDoc {
  guardianUid: string;
  guardianEmail: string;
  guardianName: string;
  code: string;
  state: PairRequestState;
  message: string;
  createdAt: Timestamp | null;
}

/** Cài đặt thông báo và ngưỡng cảnh báo của người dùng */
export interface AppSettings {
  fallAlertEnabled: boolean;
  deviceOfflineAlertEnabled: boolean;
  lowBatteryThreshold: number; // %, khoảng 10-50
  /** Tắt chuông khi nhận cảnh báo té ngã (vẫn hiện thông báo, chỉ im tiếng) */
  alertSoundMuted: boolean;
}

/** Tên các trang trong ứng dụng SPA */
export type PageName =
  | 'login'
  | 'register'
  | 'otp'
  | 'forgot'
  | 'devices'
  | 'dashboard'
  | 'map'
  | 'history'
  | 'settings';
