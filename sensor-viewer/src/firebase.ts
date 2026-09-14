// ============================================================
// firebase.ts — Khởi tạo Firebase cho web xem dạng sóng
// ============================================================

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getDatabase, type Database } from 'firebase/database';
import { firebaseConfig, isRealtimeDbConfigured } from './firebase-config';

export const firebaseApp: FirebaseApp = initializeApp(firebaseConfig);
export const auth: Auth = getAuth(firebaseApp);

/** Firestore chỉ dùng để lấy danh sách thiết bị mà tài khoản này được xem */
export const db: Firestore = getFirestore(firebaseApp);

/** Realtime Database là nơi chứa dạng sóng */
export const rtdb: Database | null = isRealtimeDbConfigured() ? getDatabase(firebaseApp) : null;
