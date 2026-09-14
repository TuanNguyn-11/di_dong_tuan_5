// ============================================================
// link.ts — Ghép cặp & theo dõi thiết bị trên Cloud Firestore
// ============================================================
// Đây là phía "người thân" của cầu nối giữa hai app.
//
// Luồng ghép cặp (khớp với fall-guard-app/src/device.ts):
//
//   1. Người thân nhập mã thiết bị 12 số + mã OTP 6 số đang hiện trên máy
//      người dùng, app ghi vào  devices/{deviceId}/requests/{uid}
//   2. App Fall Guard đang mở sẽ thấy yêu cầu đó, tự so mã OTP:
//        - đúng  → thêm uid người thân vào devices/{deviceId}.guardianUids
//                  và đặt state = 'approved'
//        - sai   → đặt state = 'rejected' kèm lý do
//   3. App này lắng nghe chính tài liệu yêu cầu của mình, thấy 'approved' thì
//      lưu liên kết vào  guardians/{uid}/links/{deviceId}  rồi bắt đầu theo dõi.
//
// Mã OTP KHÔNG BAO GIỜ nằm trên Firestore ở dạng đọc được — app này chỉ gửi đi
// mã mà người dùng gõ vào, không đọc được mã thật.

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';
import type { DeviceDoc, DeviceLink, DeviceView, FallEvent, PairRequestDoc } from './types';

/** Quá bao lâu không nghe tin thiết bị thì coi là offline */
export const OFFLINE_AFTER_MS = 90_000;

/** App Fall Guard phải phản hồi yêu cầu ghép cặp trong khoảng thời gian này */
const PAIR_TIMEOUT_MS = 60_000;

// ------------------------------------------------------------
// GHÉP CẶP
// ------------------------------------------------------------

export interface PairInput {
  deviceId: string;
  otp: string;
  guardianUid: string;
  guardianEmail: string;
  guardianName: string;
}

export interface PairResult {
  ok: boolean;
  message: string;
}

/**
 * Gửi yêu cầu ghép cặp rồi chờ app Fall Guard duyệt.
 * Trả về khi có kết quả, hết giờ, hoặc gặp lỗi quyền truy cập.
 */
export async function requestPairing(input: PairInput): Promise<PairResult> {
  const requestRef = doc(db, 'devices', input.deviceId, 'requests', input.guardianUid);

  const payload: Omit<PairRequestDoc, 'createdAt'> = {
    guardianUid: input.guardianUid,
    guardianEmail: input.guardianEmail,
    guardianName: input.guardianName,
    code: input.otp,
    state: 'pending',
    message: '',
  };

  // Ghi XONG rồi mới lắng nghe. Nếu lắng nghe trước, ảnh chụp đầu tiên sẽ là
  // trạng thái CŨ của lần thử trước (thường là 'rejected') và ta sẽ báo hỏng
  // ngay lập tức dù lần thử mới còn chưa kịp gửi đi. Ghi trước thì không mất
  // kết quả nào, vì kết quả nằm luôn trong tài liệu — lắng nghe lúc nào cũng đọc được.
  try {
    await setDoc(requestRef, { ...payload, createdAt: serverTimestamp() });
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'permission-denied') {
      return {
        ok: false,
        message: 'Mã thiết bị không tồn tại. Hãy kiểm tra lại 12 chữ số trên máy người dùng.',
      };
    }
    return { ok: false, message: 'Không gửi được yêu cầu: ' + describeError(error) };
  }

  return new Promise<PairResult>((resolve) => {
    let settled = false;
    let unsubscribe: Unsubscribe | null = null;
    let timeoutId = 0;

    const finish = (result: PairResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      unsubscribe?.();
      resolve(result);
    };

    unsubscribe = onSnapshot(
      requestRef,
      (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.data() as PairRequestDoc;
        if (data.state === 'approved') {
          finish({ ok: true, message: data.message || 'Kết nối thành công.' });
        } else if (data.state === 'rejected') {
          finish({ ok: false, message: data.message || 'Mã OTP không đúng.' });
        }
      },
      () => {
        finish({
          ok: false,
          message: 'Không đọc được phản hồi. Kiểm tra lại mã thiết bị và kết nối mạng.',
        });
      }
    );

    timeoutId = window.setTimeout(() => {
      finish({
        ok: false,
        message:
          'Máy người dùng không phản hồi sau 60 giây. Hãy chắc chắn app Fall Guard đang mở, đang có mạng, và đang ở màn hình Kết nối.',
      });
    }, PAIR_TIMEOUT_MS);
  });
}

function describeError(error: unknown): string {
  return (error as { message?: string })?.message ?? 'lỗi không xác định';
}

/** Xoá tài liệu yêu cầu sau khi ghép cặp xong cho sạch cơ sở dữ liệu */
export async function clearPairRequest(deviceId: string, guardianUid: string): Promise<void> {
  await deleteDoc(doc(db, 'devices', deviceId, 'requests', guardianUid)).catch(() => undefined);
}

// ------------------------------------------------------------
// DANH SÁCH THIẾT BỊ ĐANG THEO DÕI
// ------------------------------------------------------------

/** Lưu liên kết mới vào guardians/{uid}/links/{deviceId} */
export async function saveLink(
  guardianUid: string,
  deviceId: string,
  alias: string
): Promise<void> {
  await setDoc(doc(db, 'guardians', guardianUid, 'links', deviceId), {
    deviceId,
    alias,
    pairedAt: serverTimestamp(),
  });
}

/** Đổi tên gợi nhớ mà người thân đặt cho thiết bị */
export async function renameLink(
  guardianUid: string,
  deviceId: string,
  alias: string
): Promise<void> {
  await updateDoc(doc(db, 'guardians', guardianUid, 'links', deviceId), { alias });
}

/**
 * Bỏ theo dõi một thiết bị: xoá liên kết bên mình VÀ tự gỡ uid của mình khỏi
 * danh sách guardianUids của thiết bị (rules chỉ cho phép tự gỡ chính mình).
 */
export async function removeLink(guardianUid: string, deviceId: string): Promise<void> {
  const deviceRef = doc(db, 'devices', deviceId);

  try {
    const snapshot = await getDoc(deviceRef);
    if (snapshot.exists()) {
      const data = snapshot.data() as DeviceDoc;
      const remaining = (data.guardianUids ?? []).filter((uid) => uid !== guardianUid);
      await updateDoc(deviceRef, { guardianUids: remaining });
    }
  } catch {
    // Chủ máy có thể đã ngắt kết nối trước rồi — vẫn phải dọn liên kết bên mình.
  }

  await deleteDoc(doc(db, 'guardians', guardianUid, 'links', deviceId));
}

/** Theo dõi realtime danh sách thiết bị mà tài khoản này đang theo dõi */
export function subscribeLinks(
  guardianUid: string,
  onChange: (links: DeviceLink[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  return onSnapshot(
    collection(db, 'guardians', guardianUid, 'links'),
    (snapshot) => {
      const links = snapshot.docs.map((docSnap) => docSnap.data() as DeviceLink);
      links.sort((a, b) => a.alias.localeCompare(b.alias, 'vi'));
      onChange(links);
    },
    (error) => onError?.(error)
  );
}

// ------------------------------------------------------------
// THEO DÕI MỘT THIẾT BỊ
// ------------------------------------------------------------

/** Chuyển tài liệu Firestore thô thành dữ liệu sẵn sàng hiển thị */
export function toDeviceView(deviceId: string, alias: string, data: DeviceDoc | null): DeviceView {
  if (!data) {
    return {
      id: deviceId,
      alias,
      ownerName: alias,
      status: 'offline',
      battery: null,
      latitude: null,
      longitude: null,
      accuracy: null,
      alertCount: 0,
      monitoringEnabled: false,
      lastSeen: null,
      locationUpdatedAt: null,
      revoked: false,
    };
  }

  const lastSeen =
    data.lastSeen && typeof data.lastSeen.toDate === 'function' ? data.lastSeen.toDate() : null;
  const locationUpdatedAt =
    data.locationUpdatedAt && typeof data.locationUpdatedAt.toDate === 'function'
      ? data.locationUpdatedAt.toDate()
      : null;
  const online = lastSeen !== null && Date.now() - lastSeen.getTime() < OFFLINE_AFTER_MS;

  return {
    id: deviceId,
    alias,
    ownerName: data.name || alias,
    status: online ? 'online' : 'offline',
    battery: typeof data.battery === 'number' ? data.battery : null,
    latitude: typeof data.lat === 'number' ? data.lat : null,
    longitude: typeof data.lng === 'number' ? data.lng : null,
    accuracy: typeof data.accuracy === 'number' ? data.accuracy : null,
    alertCount: typeof data.alertCount === 'number' ? data.alertCount : 0,
    monitoringEnabled: data.monitoringEnabled === true,
    lastSeen,
    locationUpdatedAt,
    revoked: false,
  };
}

/** Theo dõi realtime một thiết bị */
export function subscribeDevice(
  deviceId: string,
  onChange: (data: DeviceDoc | null) => void,
  onRevoked?: () => void
): Unsubscribe {
  return onSnapshot(
    doc(db, 'devices', deviceId),
    (snapshot) => onChange(snapshot.exists() ? (snapshot.data() as DeviceDoc) : null),
    (error) => {
      // permission-denied ở đây nghĩa là chủ máy đã ngắt kết nối với mình.
      if ((error as { code?: string }).code === 'permission-denied') onRevoked?.();
    }
  );
}

/** Theo dõi realtime lịch sử té ngã của một thiết bị */
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
      onChange(
        snapshot.docs
          // Báo động giả (người dùng kịp bấm "Tôi ổn") không còn được ghi lên
          // Firestore nữa. Lọc ở đây để những bản ghi cũ từ bản trước của ứng
          // dụng cũng không lọt vào lịch sử của người thân.
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
              status: 'sent',
              confidence: typeof data.confidence === 'number' ? data.confidence : 0,
            } as FallEvent;
          })
      );
    },
    (error) => onError?.(error)
  );
}

/** Xoá vĩnh viễn một số sự kiện té ngã khỏi Firestore */
export async function deleteFallEvents(deviceId: string, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;

  // writeBatch giới hạn 500 thao tác mỗi lần — chia nhỏ cho chắc.
  for (let i = 0; i < eventIds.length; i += 400) {
    const batch = writeBatch(db);
    eventIds.slice(i, i + 400).forEach((id) => {
      batch.delete(doc(db, 'devices', deviceId, 'events', id));
    });
    await batch.commit();
  }
}

function formatTime(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}
