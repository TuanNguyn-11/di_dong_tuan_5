// ============================================================
// firebase-config.ts — KHÔNG sửa file này
// ============================================================
// Web xem dạng sóng dùng CHUNG cấu hình với app Fall Guard, nên file này chỉ
// xuất lại (re-export) từ đó. Nhờ vậy bạn chỉ phải điền config ở HAI nơi
// (fall-guard-app và healthcare-map) chứ không phải ba.
//
// Muốn sửa config thì mở: ../../fall-guard-app/src/firebase-config.ts

export {
  firebaseConfig,
  isFirebaseConfigured,
  isRealtimeDbConfigured,
} from '../../fall-guard-app/src/firebase-config';
