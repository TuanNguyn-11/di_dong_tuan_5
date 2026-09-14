// ============================================================
// stream.ts — Đọc dạng sóng trực tiếp từ Realtime Database
// ============================================================
// Đối xứng với fall-guard-app/src/live-stream.ts.
// App Fall Guard đẩy lên từng gói 1 giây; file này gom các gói lại thành một
// dải mẫu liên tục để vẽ.

import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import {
  limitToLast,
  off,
  onChildAdded,
  onValue,
  query,
  ref,
  type Unsubscribe,
} from 'firebase/database';
import { db, rtdb } from './firebase';

/** Một gói dữ liệu đúng như app Fall Guard đã ghi lên */
interface ChunkDoc {
  t0: number;
  hz: number;
  ax: number[];
  ay: number[];
  az: number[];
  gx: number[];
  gy: number[];
  gz: number[];
}

/** Một mẫu đã trải phẳng, kèm mốc thời gian tuyệt đối */
export interface Sample {
  t: number; // ms
  ax: number; ay: number; az: number;
  gx: number; gy: number; gz: number;
}

export interface StreamMeta {
  name: string;
  streaming: boolean;
  hz: number;
  updatedAt: number;
}

/** Một thiết bị mà tài khoản đang đăng nhập được phép xem */
export interface ViewableDevice {
  deviceId: string;
  label: string;
  /** 'own' = máy của chính mình, 'linked' = máy người thân đã ghép cặp */
  kind: 'own' | 'linked';
}

// ------------------------------------------------------------
// DANH SÁCH THIẾT BỊ (lấy từ Firestore)
// ------------------------------------------------------------

/**
 * Gộp hai nguồn: thiết bị của chính tài khoản này (nếu là người dùng Fall Guard)
 * và các thiết bị đã ghép cặp (nếu là người thân).
 */
export async function listViewableDevices(uid: string): Promise<ViewableDevice[]> {
  const devices: ViewableDevice[] = [];

  try {
    const userSnap = await getDoc(doc(db, 'users', uid));
    const userData = userSnap.exists() ? userSnap.data() : null;
    const ownDeviceId = userData ? (userData.deviceId as string | undefined) : undefined;
    if (userData && ownDeviceId) {
      const name = (userData.displayName as string | undefined) ?? 'Máy của tôi';
      devices.push({ deviceId: ownDeviceId, label: `${name} (máy của tôi)`, kind: 'own' });
    }
  } catch {
    // Không đọc được hồ sơ thì bỏ qua, vẫn còn nguồn thứ hai bên dưới.
  }

  try {
    const linksSnap = await getDocs(collection(db, 'guardians', uid, 'links'));
    linksSnap.forEach((linkDoc) => {
      const data = linkDoc.data() as { deviceId?: string; alias?: string };
      const deviceId = data.deviceId ?? linkDoc.id;
      if (devices.some((d) => d.deviceId === deviceId)) return;
      devices.push({ deviceId, label: data.alias ?? deviceId, kind: 'linked' });
    });
  } catch {
    // Tài khoản này không theo dõi máy nào — chuyện bình thường.
  }

  return devices;
}

// ------------------------------------------------------------
// THEO DÕI DẠNG SÓNG
// ------------------------------------------------------------

export interface StreamHandle {
  stop: () => void;
}

/**
 * Bám vào luồng của một thiết bị.
 * `onSamples` được gọi mỗi khi có gói mới (khoảng 1 lần/giây).
 */
export function subscribeStream(
  deviceId: string,
  handlers: {
    onMeta: (meta: StreamMeta | null) => void;
    onSamples: (samples: Sample[]) => void;
    onError: (message: string) => void;
  }
): StreamHandle {
  if (!rtdb) {
    handlers.onError(
      'Chưa bật Realtime Database. Điền databaseURL trong fall-guard-app/src/firebase-config.ts rồi build lại.'
    );
    return { stop: () => undefined };
  }

  const database = rtdb;
  const metaRef = ref(database, `live/${deviceId}/meta`);
  // Chỉ lấy ~60 gói gần nhất — đúng bằng lượng mà app Fall Guard giữ lại.
  const chunksQuery = query(ref(database, `live/${deviceId}/chunks`), limitToLast(60));

  const unsubMeta: Unsubscribe = onValue(
    metaRef,
    (snapshot) => {
      const value = snapshot.val() as Partial<StreamMeta> | null;
      handlers.onMeta(
        value
          ? {
              name: value.name ?? '',
              streaming: value.streaming === true,
              hz: typeof value.hz === 'number' ? value.hz : 25,
              updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
            }
          : null
      );
    },
    (error) => {
      handlers.onError(
        error.message.includes('permission')
          ? 'Tài khoản này không có quyền xem thiết bị đó. Hãy ghép cặp trong app Healthcare Map trước.'
          : 'Lỗi đọc dữ liệu: ' + error.message
      );
    }
  );

  // onChildAdded chỉ trả về gói MỚI sau lần đầu, nên không phải tải lại cả dải.
  const unsubChunks: Unsubscribe = onChildAdded(
    chunksQuery,
    (snapshot) => {
      const chunk = snapshot.val() as ChunkDoc | null;
      if (!chunk || !Array.isArray(chunk.ax)) return;
      handlers.onSamples(flattenChunk(chunk));
    },
    (error) => handlers.onError('Lỗi đọc dạng sóng: ' + error.message)
  );

  return {
    stop: () => {
      unsubMeta();
      unsubChunks();
      off(metaRef);
    },
  };
}

/** Trải một gói thành từng mẫu, suy ra mốc thời gian từ t0 và tần số */
function flattenChunk(chunk: ChunkDoc): Sample[] {
  const step = 1000 / (chunk.hz || 25);
  const count = Math.min(
    chunk.ax.length,
    chunk.ay.length,
    chunk.az.length,
    chunk.gx.length,
    chunk.gy.length,
    chunk.gz.length
  );

  const out: Sample[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = {
      t: chunk.t0 + i * step,
      ax: chunk.ax[i],
      ay: chunk.ay[i],
      az: chunk.az[i],
      gx: chunk.gx[i],
      gy: chunk.gy[i],
      gz: chunk.gz[i],
    };
  }
  return out;
}
