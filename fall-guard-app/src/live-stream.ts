// ============================================================
// live-stream.ts — Phát dạng sóng cảm biến trực tiếp qua Realtime Database
// ============================================================
// Vì sao KHÔNG dùng Firestore cho việc này?
//   Firestore gói miễn phí cho 20.000 lượt ghi/ngày. Đẩy 1 gói mẫu mỗi giây là
//   86.400 lượt/ngày — vượt gấp hơn 4 lần. Realtime Database tính theo dung
//   lượng lưu trữ (1 GB) và tải về (10 GB/tháng), không giới hạn lượt ghi, nên
//   hợp với luồng dữ liệu dày và ngắn hạn như dạng sóng.
//
// Cấu trúc dữ liệu:
//
//   live/{deviceId}/meta
//       ownerUid   : uid chủ máy — dùng cho security rules
//       viewers    : { uid: true } bản sao guardianUids, để rules biết ai được xem
//       name       : tên hiển thị
//       streaming  : đang phát hay đã dừng
//       hz         : tần số lấy mẫu của luồng
//       updatedAt  : mốc thời gian máy chủ
//
//   live/{deviceId}/chunks/{pushId}
//       t0 : mốc thời gian (ms) của mẫu ĐẦU TIÊN trong gói
//       hz : tần số lấy mẫu
//       ax, ay, az, gx, gy, gz : mảng số, mỗi mảng một kênh
//
// Chỉ giữ lại khoảng 60 giây gần nhất rồi tự xoá, để không phình cơ sở dữ liệu.

import {
  ref,
  push,
  remove,
  serverTimestamp,
  set,
  update,
} from 'firebase/database';
import { rtdb } from './firebase';
import type { SensorSample } from './types';

/** Tần số mẫu của luồng phát. 25 Hz đủ mịn để nhìn cú va đập khi té ngã. */
export const STREAM_HZ = 25;

/** Mỗi gói gom đúng 1 giây dữ liệu */
const SAMPLES_PER_CHUNK = STREAM_HZ;

/** Giữ lại bao nhiêu gói (≈ bấy nhiêu giây) trước khi xoá dần */
const MAX_CHUNKS = 60;

let deviceId: string | null = null;
let streaming = false;

/** Bộ đệm các mẫu đã hạ tần số, chờ đủ 1 giây thì đẩy đi */
let pending: SensorSample[] = [];

/** Mốc thời gian của mẫu cuối cùng đã nhận, dùng để hạ tần số */
let lastAcceptedAt = 0;

/** Khoá của các gói đã đẩy lên, để xoá gói cũ nhất mà không cần đọc lại */
let pushedKeys: string[] = [];

export function isLiveStreamAvailable(): boolean {
  return rtdb !== null;
}

/**
 * Bắt đầu phát. Ghi khối `meta` trước để security rules của Realtime Database
 * biết ai là chủ và ai được phép xem.
 */
export async function startLiveStream(
  targetDeviceId: string,
  ownerUid: string,
  name: string,
  viewerUids: string[]
): Promise<void> {
  if (!rtdb) return;

  deviceId = targetDeviceId;
  streaming = true;
  pending = [];
  lastAcceptedAt = 0;
  pushedKeys = [];

  const viewers: Record<string, boolean> = {};
  viewerUids.forEach((uid) => {
    viewers[uid] = true;
  });

  await set(ref(rtdb, `live/${targetDeviceId}/meta`), {
    ownerUid,
    viewers,
    name,
    streaming: true,
    hz: STREAM_HZ,
    updatedAt: serverTimestamp(),
  });
}

/** Cập nhật danh sách người thân được xem, gọi mỗi khi guardianUids đổi */
export async function updateStreamViewers(
  targetDeviceId: string,
  viewerUids: string[]
): Promise<void> {
  if (!rtdb) return;

  const viewers: Record<string, boolean> = {};
  viewerUids.forEach((uid) => {
    viewers[uid] = true;
  });

  await update(ref(rtdb, `live/${targetDeviceId}/meta`), {
    viewers,
    updatedAt: serverTimestamp(),
  }).catch(() => undefined);
}

/** Dừng phát. Giữ lại dữ liệu cũ để người xem còn cuộn lại được một lúc. */
export async function stopLiveStream(): Promise<void> {
  if (!rtdb || !deviceId) {
    streaming = false;
    return;
  }

  const id = deviceId;
  streaming = false;
  pending = [];
  deviceId = null;

  await update(ref(rtdb, `live/${id}/meta`), {
    streaming: false,
    updatedAt: serverTimestamp(),
  }).catch(() => undefined);
}

/**
 * Nhận một mẫu từ cảm biến. Hạ tần số xuống STREAM_HZ rồi gom đủ 1 giây mới đẩy.
 * Hàm này được gọi rất dày (20-60 lần/giây) nên phải thật nhẹ.
 */
export function feedSample(sample: SensorSample): void {
  if (!streaming || !rtdb || !deviceId) return;

  // Hạ tần số: bỏ qua mẫu nào tới sớm hơn chu kỳ mong muốn.
  const minGapMs = 1000 / STREAM_HZ;
  if (sample.t - lastAcceptedAt < minGapMs) return;
  lastAcceptedAt = sample.t;

  pending.push(sample);
  if (pending.length >= SAMPLES_PER_CHUNK) {
    void flushChunk();
  }
}

async function flushChunk(): Promise<void> {
  if (!rtdb || !deviceId || pending.length === 0) return;

  const batch = pending;
  pending = [];
  const id = deviceId;

  // Làm tròn 3 chữ số thập phân: đủ chính xác để vẽ, mà nhẹ hơn hẳn khi truyền.
  const round = (n: number) => Math.round(n * 1000) / 1000;

  try {
    const chunkRef = await push(ref(rtdb, `live/${id}/chunks`), {
      t0: batch[0].t,
      hz: STREAM_HZ,
      ax: batch.map((s) => round(s.ax)),
      ay: batch.map((s) => round(s.ay)),
      az: batch.map((s) => round(s.az)),
      gx: batch.map((s) => round(s.gx)),
      gy: batch.map((s) => round(s.gy)),
      gz: batch.map((s) => round(s.gz)),
    });

    if (chunkRef.key) pushedKeys.push(chunkRef.key);
    await pruneOldChunks(id);
  } catch {
    // Mất mạng chốc lát thì bỏ gói này. Dạng sóng là dữ liệu tức thời, không
    // đáng để xếp hàng chờ gửi lại — gói cũ không còn giá trị quan sát nữa.
  }
}

/**
 * Xoá bớt gói cũ. Dựa vào danh sách khoá ghi nhớ tại máy nên KHÔNG tốn lượt đọc.
 */
async function pruneOldChunks(id: string): Promise<void> {
  // Gán ra biến cục bộ để TypeScript giữ được kết luận "khác null" bên trong closure.
  const database = rtdb;
  if (!database || pushedKeys.length <= MAX_CHUNKS) return;

  const excess = pushedKeys.splice(0, pushedKeys.length - MAX_CHUNKS);
  await Promise.all(
    excess.map((key) => remove(ref(database, `live/${id}/chunks/${key}`)).catch(() => undefined))
  );
}
