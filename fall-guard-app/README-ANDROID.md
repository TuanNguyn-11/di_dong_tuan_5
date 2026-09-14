# Fall Guard — Hướng dẫn build Android

> ⚠️ **Làm trước tiên:** app không chạy được nếu chưa cấu hình Firebase.
> Xem [`../FIREBASE-SETUP.md`](../FIREBASE-SETUP.md) và điền `src/firebase-config.ts`.

## Yêu cầu
- Node.js >= 18
- Android Studio (đã cài, có SDK)
- JDK 17+

## Bước 1: Cài dependencies
```bash
npm install
```

## Bước 2: Build
```bash
npm run build
```
Lệnh này kiểm tra kiểu TypeScript (`tsc --noEmit`) rồi dùng **esbuild** đóng gói
`src/*.ts` cùng toàn bộ SDK Firebase thành một file duy nhất `www/app.js`.

Khi đang code, chạy `npm run watch` để tự build lại mỗi lần lưu file.

## Bước 3: Thêm platform Android (chạy 1 lần)
```bash
npx cap add android
```

## Bước 4: Thêm quyền vị trí
Mở `android/app/src/main/AndroidManifest.xml`, tìm khối `<!-- Permissions -->` và thêm:
```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
```

Cài thêm 2 plugin để lấy GPS và pin đúng chuẩn Android:
```bash
npm install @capacitor/geolocation @capacitor/device
```

`src/native.ts` được viết để **tự dùng plugin nếu có, tự quay về API trình duyệt
nếu không có** — không cài vẫn chạy được trên máy tính, nhưng trên điện thoại thật
WebView thường từ chối `navigator.geolocation` vì không hiện được hộp thoại xin quyền.

## Bước 5: Sync web → Android
```bash
npm run sync
```
Lệnh này tự chạy `npm run build` rồi `cap sync android`.

## Bước 6: Mở Android Studio (tuỳ chọn)
```bash
npm run open:android
```

## Bước 7: Build APK debug (không cần mở Android Studio)
```bash
npm run apk
```
APK nằm tại: `android/app/build/outputs/apk/debug/app-debug.apk`

## Test nhanh trên máy tính
```bash
npm run serve
```
Rồi mở <http://localhost:5173>.

> ⚠️ **Không** mở `www/index.html` bằng cách nhấp đúp file. Firebase Authentication
> chặn giao thức `file://`, app sẽ hiện giao diện nhưng đăng nhập luôn thất bại.
> Bắt buộc phải chạy qua `http://localhost`.

## Lưu ý
- Toàn bộ mã nguồn nằm trong `src/`. **Không sửa `www/app.js`** — file này do esbuild sinh ra.
- Trên máy tính không có cảm biến thật, app dùng **mock sensor** (dữ liệu giả quanh 9.8 m/s²).
- Nút **"Giả lập té ngã"** cho phép demo trọn vẹn luồng cảnh báo mà không cần rung lắc điện thoại.
- Mã OTP ghép cặp chỉ nằm trong bộ nhớ máy này, **không** ghi lên Firestore — xem
  `src/device.ts` phần "GHÉP CẶP".
