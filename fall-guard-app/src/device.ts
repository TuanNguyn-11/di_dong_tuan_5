// ============================================================
// device.ts — Đồng bộ thiết bị với Cloud Firestore
// ============================================================
// Đây là "cầu nối" giữa Fall Guard và Healthcare Map. Mọi thứ người thân nhìn
// thấy đều đi qua các hàm trong file này.
//
// Cấu trúc dữ liệu trên Firestore:
//
//   devices/{deviceId}                      ← deviceId là mã 12 chữ số
//       ownerUid, name, guardianUids[], guardianInfo{},
//       lat, lng, accuracy, battery, monitoringEnabled,
//       alertCount, lastSeen, locationUpdatedAt, createdAt
//
//   devices/{deviceId}/events/{eventId}     ← từng lần té ngã
//       status, confidence, lat, lng, source, createdAt
//
//   devices/{deviceId}/requests/{guardianUid}  ← yêu cầu ghép cặp chờ duyệt
//       guardianUid, guardianEmail, guardianName, code, state, message, createdAt
//
// Quy tắc vàng về OTP: mã 6 số do CHÍNH máy này sinh ra và chỉ hiện trên màn
// hình máy này, không bao giờ được ghi lên Firestore. Người thân gửi mã họ nhập
// vào trường `code` của yêu cầu, máy này tự so sánh rồi duyệt hoặc từ chối.
// Nhờ vậy người thân không thể đọc trộm mã từ cơ sở dữ liệu.

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';
import type {
  DeviceDoc,
  FallEvent,
  FallEventStatus,
  LinkedGuardian,
  PairRequestDoc,
} from './types';

// ------------------------------------------------------------
// MÃ THIẾT BỊ 12 CHỮ SỐ
// ------------------------------------------------------------

/**
 * Sinh mã thiết bị 12 chữ số ngẫu nhiên.
 * Ghép hai nửa 6 chữ số để tránh vượt quá giới hạn số nguyên an toàn của
 * JavaScript mà không cần tới BigInt (WebView cũ có thể chưa hỗ trợ).
 */
export function generateDeviceId(): string {
  const arr = new Uint32Array(2);
  crypto.getRandomValues(arr);
  const high = (arr[0] % 1_000_000).toString().padStart(6, '0');
  const low = (arr[1] % 1_000_000).toString().padStart(6, '0');
  return high + low;
}

// ------------------------------------------------------------
// TẠO / ĐỌC TÀI LIỆU THIẾT BỊ
// ------------------------------------------------------------

/**
 * Sinh mã 12 số rồi tạo tài liệu devices/{deviceId}, trả về mã đã dùng.
 *
 * Không thể kiểm tra trước xem mã đã tồn tại hay chưa: security rules chỉ cho
 * chủ máy và người thân đã ghép cặp đọc tài liệu thiết bị, nên một lần đọc thử
 * sẽ luôn bị từ chối. Thay vào đó cứ ghi thẳng — nếu mã trùng với thiết bị của
 * người khác, lệnh ghi trở thành "update" và bị rules chặn, lúc đó ta đổi mã
 * khác rồi thử lại. Xác suất trùng vốn chỉ 1 phần 1000 tỉ.
 */
export async function createDeviceWithNewId(ownerUid: string, name: string): Promise<string> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const deviceId = generateDeviceId();
    try {
      await setDoc(doc(db, 'devices', deviceId), {
        ownerUid,
        name,
        guardianUids: [],
        guardianInfo: {},
        monitoringEnabled: false,
        battery: null,
        lat: null,
        lng: null,
        accuracy: null,
        alertCount: 0,
        lastSeen: serverTimestamp(),
        locationUpdatedAt: null,
        createdAt: serverTimestamp(),
      });
      return deviceId;
    } catch (error) {
      lastError = error;
      if ((error as { code?: string }).code !== 'permission-denied') throw error;
      // Mã trùng với thiết bị của người khác — thử mã mới.
    }
  }

  throw lastError ?? new Error('Không tạo được thiết bị. Vui lòng thử lại.');
}

export async function fetchDevice(deviceId: string): Promise<DeviceDoc | null> {
  const snapshot = await getDoc(doc(db, 'devices', deviceId));
  return snapshot.exists() ? (snapshot.data() as DeviceDoc) : null;
}

/** Theo dõi realtime tài liệu thiết bị (để biết ai đang theo dõi mình) */
export function subscribeDevice(
  deviceId: string,
  onChange: (device: DeviceDoc | null) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, 'devices', deviceId),
    (snapshot) => onChange(snapshot.exists() ? (snapshot.data() as DeviceDoc) : null),
    (error) => onError?.(error)
  );
}

/** Đổi tên hiển thị của người dùng thiết bị */
export async function updateDeviceName(deviceId: string, name: string): Promise<void> {
  await updateDoc(doc(db, 'devices', deviceId), { name });
}

// ------------------------------------------------------------
// NHỊP TIM (HEARTBEAT) — VỊ TRÍ, PIN, TRẠNG THÁI GIÁM SÁT
// ------------------------------------------------------------

export interface HeartbeatPayload {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  battery: number | null;
  monitoringEnabled: boolean;
}

/**
 * Đẩy trạng thái hiện tại lên Firestore. Healthcare Map dựa vào `lastSeen`
 * để kết luận thiết bị online hay offline, nên hàm này cần được gọi đều đặn.
 */
export async function pushHeartbeat(deviceId: string, payload: HeartbeatPayload): Promise<void> {
  const patch: Record<string, unknown> = {
    monitoringEnabled: payload.monitoringEnabled,
    battery: payload.battery,
    lastSeen: serverTimestamp(),
  };

  if (payload.lat !== null && payload.lng !== null) {
    patch.lat = payload.lat;
    patch.lng = payload.lng;
    patch.accuracy = payload.accuracy;
    patch.locationUpdatedAt = serverTimestamp();
  }

  await updateDoc(doc(db, 'devices', deviceId), patch);
}

// ------------------------------------------------------------
// SỰ KIỆN TÉ NGÃ
// ------------------------------------------------------------

export interface NewFallEvent {
  confidence: number; // phần trăm 0-100
  lat: number;
  lng: number;
  source: 'sensor' | 'demo';
}

/**
 * Ghi một sự kiện té ngã lên Firestore. Người thân sẽ thấy ngay lập tức
 * nhờ onSnapshot bên app Healthcare Map.
 *
 * CHỈ gọi hàm này khi cảnh báo THẬT SỰ được gửi đi (hết thời gian đếm ngược).
 * Nếu người dùng kịp bấm "Tôi ổn" thì coi như báo động giả, không ghi gì cả —
 * người thân không cần biết tới những lần đó.
 */
export async function pushFallEvent(deviceId: string, event: NewFallEvent): Promise<string> {
  const ref = await addDoc(collection(db, 'devices', deviceId, 'events'), {
    ...event,
    status: 'sent' as FallEventStatus,
    createdAt: serverTimestamp(),
  });

  await updateDoc(doc(db, 'devices', deviceId), { alertCount: increment(1) });

  return ref.id;
}

/** Theo dõi realtime toàn bộ lịch sử té ngã của thiết bị này */
export function subscribeFallEvents(
  deviceId: string,
  onChange: (events: FallEvent[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  const q = query(
    collection(db, 'devices', deviceId, 'events'),
    orderBy('createdAt', 'desc'),
    limit(200)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const events: FallEvent[] = snapshot.docs
        // Bỏ qua các bản ghi "đã huỷ" còn sót lại từ bản cũ của ứng dụng —
        // báo động giả không còn được ghi nhận nữa.
        .filter((docSnap) => docSnap.data().status !== 'cancelled')
        .map((docSnap) => {
          const data = docSnap.data();
          const created: Date =
            data.createdAt && typeof data.createdAt.toDate === 'function'
              ? data.createdAt.toDate()
              : new Date();
          return {
            id: docSnap.id,
            timestamp: formatTime(created),
            date: formatDate(created),
            latitude: typeof data.lat === 'number' ? data.lat : 0,
            longitude: typeof data.lng === 'number' ? data.lng : 0,
            status: 'sent' as FallEventStatus,
            confidence: typeof data.confidence === 'number' ? data.confidence : 0,
          };
        });
      onChange(events);
    },
    (error) => onError?.(error)
  );
}

function formatTime(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

// ------------------------------------------------------------
// GHÉP CẶP — MÃ OTP 6 SỐ HIỂN THỊ TRÊN MÁY NÀY
// ------------------------------------------------------------

const OTP_TTL_MS = 5 * 60_000; // mã sống 5 phút rồi tự đổi

interface LocalOtp {
  code: string;
  expiresAt: number;
}

let currentOtp: LocalOtp | null = null;
/** Mã vừa hết hạn — vẫn chấp nhận thêm 60 giây để tránh "lỡ tay" lúc giao mã */
let previousOtp: LocalOtp | null = null;

function newOtpCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return (arr[0] % 1_000_000).toString().padStart(6, '0');
}

/** Sinh mã OTP mới ngay lập tức (nút "Đổi mã khác") */
export function rotateOtp(): string {
  if (currentOtp) previousOtp = currentOtp;
  currentOtp = { code: newOtpCode(), expiresAt: Date.now() + OTP_TTL_MS };
  return currentOtp.code;
}

/** Lấy mã đang hiệu lực, tự sinh mã mới nếu chưa có hoặc đã hết hạn */
export function getCurrentOtp(): string {
  if (!currentOtp || Date.now() > currentOtp.expiresAt) {
    return rotateOtp();
  }
  return currentOtp.code;
}

/** Số mili-giây còn lại của mã hiện tại (để vẽ đồng hồ đếm ngược) */
export function getOtpRemainingMs(): number {
  if (!currentOtp) return 0;
  return Math.max(0, currentOtp.expiresAt - Date.now());
}

/** Mã người thân gửi lên có khớp với mã đang hiển thị trên máy này không? */
function isOtpAcceptable(code: string): boolean {
  const now = Date.now();
  if (currentOtp && currentOtp.code === code && now <= currentOtp.expiresAt) return true;
  // Khoan dung 60 giây cho mã vừa đổi
  if (previousOtp && previousOtp.code === code && now <= previousOtp.expiresAt + 60_000) return true;
  return false;
}

/** Theo dõi realtime các yêu cầu ghép cặp gửi tới thiết bị này */
export function subscribePairRequests(
  deviceId: string,
  onChange: (requests: Array<PairRequestDoc & { id: string }>) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(
    collection(db, 'devices', deviceId, 'requests'),
    (snapshot) => {
      const requests = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as PairRequestDoc),
      }));
      onChange(requests);
    },
    (error) => onError?.(error)
  );
}

export interface PairDecision {
  approved: boolean;
  message: string;
}

/**
 * Xử lý một yêu cầu ghép cặp: so mã OTP, nếu đúng thì thêm người thân vào
 * danh sách guardianUids của thiết bị.
 */
export async function resolvePairRequest(
  deviceId: string,
  request: PairRequestDoc & { id: string }
): Promise<PairDecision> {
  const requestRef = doc(db, 'devices', deviceId, 'requests', request.id);

  if (!isOtpAcceptable(request.code)) {
    await updateDoc(requestRef, {
      state: 'rejected',
      message: 'Mã OTP không đúng hoặc đã hết hạn. Hãy hỏi lại mã mới đang hiện trên máy người dùng.',
    });
    return { approved: false, message: 'Đã từ chối một yêu cầu kết nối (mã OTP sai).' };
  }

  const deviceRef = doc(db, 'devices', deviceId);
  const snapshot = await getDoc(deviceRef);
  const data = (snapshot.data() ?? {}) as DeviceDoc & { guardianInfo?: Record<string, unknown> };

  const guardianUids = Array.isArray(data.guardianUids) ? [...data.guardianUids] : [];
  if (!guardianUids.includes(request.guardianUid)) {
    guardianUids.push(request.guardianUid);
  }

  const guardianInfo = { ...(data.guardianInfo ?? {}) } as Record<string, unknown>;
  guardianInfo[request.guardianUid] = {
    email: request.guardianEmail,
    name: request.guardianName,
    pairedAt: Date.now(),
  };

  await updateDoc(deviceRef, { guardianUids, guardianInfo });
  await updateDoc(requestRef, { state: 'approved', message: 'Đã kết nối thành công.' });

  return { approved: true, message: `Đã kết nối với ${request.guardianName || request.guardianEmail}.` };
}

/** Xoá yêu cầu đã xử lý xong khỏi Firestore cho gọn */
export async function deletePairRequest(deviceId: string, requestId: string): Promise<void> {
  await deleteDoc(doc(db, 'devices', deviceId, 'requests', requestId));
}

// ------------------------------------------------------------
// QUẢN LÝ NGƯỜI THÂN ĐÃ KẾT NỐI
// ------------------------------------------------------------

/** Chuyển guardianUids + guardianInfo thành danh sách hiển thị được */
export function toLinkedGuardians(device: DeviceDoc | null): LinkedGuardian[] {
  if (!device || !Array.isArray(device.guardianUids)) return [];
  const info = ((device as unknown as { guardianInfo?: Record<string, { email?: string; name?: string }> })
    .guardianInfo) ?? {};

  return device.guardianUids.map((uid) => ({
    uid,
    email: info[uid]?.email ?? '(không rõ email)',
    name: info[uid]?.name ?? 'Người thân',
  }));
}

/** Ngắt kết nối một người thân khỏi thiết bị này */
export async function removeGuardian(deviceId: string, guardianUid: string): Promise<void> {
  const deviceRef = doc(db, 'devices', deviceId);
  const snapshot = await getDoc(deviceRef);
  const data = (snapshot.data() ?? {}) as DeviceDoc & { guardianInfo?: Record<string, unknown> };

  const guardianUids = (data.guardianUids ?? []).filter((uid) => uid !== guardianUid);
  const guardianInfo = { ...(data.guardianInfo ?? {}) };
  delete guardianInfo[guardianUid];

  await updateDoc(deviceRef, { guardianUids, guardianInfo });
}
