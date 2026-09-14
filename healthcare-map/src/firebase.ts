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
import { firebaseConfig } from './firebase-config';

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
