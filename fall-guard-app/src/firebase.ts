// ============================================================
// firebase.ts — Khởi tạo Firebase App / Auth / Firestore
// ============================================================
// Chỉ khởi tạo MỘT lần cho toàn app rồi export ra dùng chung.

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { getDatabase, type Database } from 'firebase/database';
import { firebaseConfig, isRealtimeDbConfigured } from './firebase-config';

export const firebaseApp: FirebaseApp = initializeApp(firebaseConfig);

export const auth: Auth = getAuth(firebaseApp);

/**
 * Bật cache ngoại tuyến (IndexedDB): nếu điện thoại mất mạng tạm thời, các lệnh
 * ghi (vị trí GPS, sự kiện té ngã) vẫn được xếp hàng và tự đẩy lên khi có mạng
 * trở lại. Rất quan trọng với app cảnh báo té ngã.
 */
export const db: Firestore = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }),
});

/**
 * Realtime Database — chỉ dùng để phát dạng sóng cảm biến trực tiếp.
 * Firestore tính hạn mức theo LƯỢT GHI nên không kham nổi 25 mẫu/giây
 * (~86.400 lượt/ngày so với hạn mức 20.000). Realtime Database tính theo dung
 * lượng lưu trữ và tải về nên hợp với luồng dữ liệu dày như thế này.
 *
 * Trả về null khi chưa điền databaseURL — mọi chức năng còn lại vẫn chạy.
 */
export const rtdb: Database | null = isRealtimeDbConfigured() ? getDatabase(firebaseApp) : null;
