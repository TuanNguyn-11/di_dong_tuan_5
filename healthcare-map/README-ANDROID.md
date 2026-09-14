# Healthcare Map — Đóng gói thành ứng dụng Android

Ứng dụng web `healthcare-map` (TypeScript thuần) đã được bọc bằng **Capacitor** để chạy
như một app Android thật. Toàn bộ mã nguồn ứng dụng vẫn viết bằng **TypeScript** — thư mục
`android/` chỉ là vỏ native do Capacitor sinh ra, không phải mã bạn phải viết.

> ⚠️ **Làm trước tiên:** app không chạy được nếu chưa cấu hình Firebase.
> Xem [`../FIREBASE-SETUP.md`](../FIREBASE-SETUP.md) và điền `src/firebase-config.ts`.

---

## 1. Cấu trúc thư mục

```
healthcare-map/
├── src/                    ← MÃ NGUỒN TypeScript (chỉ sửa ở đây)
│   ├── app.ts              ← điều hướng + giao diện
│   ├── auth.ts             ← đăng ký / đăng nhập / quên mật khẩu
│   ├── link.ts             ← ghép cặp & theo dõi thiết bị qua Firestore
│   ├── emailjs.ts          ← gửi mã OTP 6 số
│   ├── firebase.ts         ← khởi tạo Firebase
│   ├── firebase-config.ts  ← ⚠️ FILE DUY NHẤT PHẢI SỬA TAY
│   └── types.ts
├── www/                    ← Thư mục web hoàn chỉnh (Capacitor đóng gói từ đây)
│   ├── index.html
│   ├── styles.css
│   └── app.js              ← do esbuild sinh ra, KHÔNG sửa tay
├── android/                ← Project Android Studio (Capacitor sinh ra)
├── capacitor.config.ts     ← Cấu hình app (tên, appId, quyền điều hướng)
├── tsconfig.json
└── package.json
```

Chạy bản web để thử nhanh:

```bash
npm run serve
```

rồi mở <http://localhost:5173>.

> ⚠️ **Không** mở `www/index.html` bằng cách nhấp đúp file nữa. Từ khi tích hợp
> Firebase, Authentication chặn giao thức `file://` — giao diện vẫn hiện nhưng đăng
> nhập luôn thất bại. Bắt buộc chạy qua `http://localhost`.

> **Cách đóng gói mã nguồn.** Trước đây dự án dùng script cổ điển (`types.ts` khai báo
> kiểu toàn cục, không `import`/`export`) để mở được bằng `file://`. Vì SDK Firebase chỉ
> phát hành dạng ES module, dự án nay dùng **esbuild** gói tất cả `src/*.ts` + Firebase
> thành một file `www/app.js` duy nhất. Nhờ vậy **được phép dùng `import` / `export`
> bình thường** khi thêm file `.ts` mới, và **không cần** thêm thẻ `<script>` nào vào
> `index.html` — chỉ cần `import` từ `app.ts` là esbuild tự gộp vào.

---

## 2. Yêu cầu cài đặt

| Phần mềm | Ghi chú |
|---|---|
| Node.js 18+ | để chạy `tsc` và Capacitor CLI |
| Android Studio | đã cài, kèm Android SDK Platform 35 và Build-Tools |
| JDK 17 | Android Studio đã kèm sẵn (Embedded JDK) |

Lần đầu, nếu thư mục `node_modules` chưa có:

```bash
npm install
```

---

## 3. Build file APK để gửi cho bạn bè

### Cách A — Dùng Android Studio (dễ nhất)

1. Mở Android Studio → **File ▸ Open** → chọn thư mục `healthcare-map/android`.
2. Chờ Gradle Sync xong (lần đầu tải thư viện khoảng 5–10 phút, cần mạng).
3. Menu **Build ▸ Build Bundle(s) / APK(s) ▸ Build APK(s)**.
4. Khi báo *"APK(s) generated successfully"*, bấm **locate** để mở thư mục chứa file.

File APK nằm ở:
```
android/app/build/outputs/apk/debug/app-debug.apk
```
Gửi file này qua Zalo / Messenger / Google Drive cho bạn bè là cài được ngay.

### Cách B — Dùng dòng lệnh (nhanh hơn khi đã build lần đầu)

Mở terminal ngay tại thư mục `healthcare-map`:

```bash
npm run build            # kiểm tra kiểu + đóng gói bằng esbuild sang www/app.js
npx cap sync android     # chép www/ vào project Android
cd android
gradlew.bat assembleDebug
```

Hoặc gộp lại một lệnh:

```bash
npm run apk
```

### Bản release (APK nhẹ hơn, đã ký sẵn — nên dùng khi gửi cho người khác)

```bash
npm run build
npx cap sync android
cd android
gradlew.bat assembleRelease
```

Kết quả: `android/app/build/outputs/apk/release/app-release.apk`

Project đã có sẵn keystore ký release tại `android/app/healthcare-map-release.jks`
(mật khẩu nằm trong `android/keystore.properties`). Hãy **giữ kỹ hai file này** — nếu mất,
bạn sẽ không thể phát hành bản cập nhật đè lên bản cũ.

---

## 4. Hướng dẫn cho người nhận APK

Android chặn cài app ngoài Play Store theo mặc định, nên nói bạn bè làm như sau:

1. Tải file `.apk` về máy.
2. Mở file → Android hỏi quyền → chọn **Cài đặt** / **Vẫn cài đặt**.
3. Nếu hiện *"Vì lý do bảo mật, điện thoại không được phép cài ứng dụng không rõ nguồn gốc"*:
   vào **Cài đặt ▸ Ứng dụng ▸ Quyền đặc biệt ▸ Cài ứng dụng không xác định** → bật cho
   trình duyệt hoặc app quản lý file đang dùng, rồi mở lại file APK.

App yêu cầu **kết nối Internet** để hiển thị bản đồ Google Maps.

---

## 5. Quy trình khi sửa code

Luôn sửa file trong `src/`, sau đó:

```bash
npm run build            # hoặc: npm run watch (tự biên dịch khi lưu file)
npx cap sync android
```

Rồi build lại APK. Nếu chỉ sửa giao diện (`www/index.html`, `www/styles.css`)
thì bỏ qua bước `npm run build`, chỉ cần `npx cap sync android`.

Lưu ý: sửa `src/firebase-config.ts` **vẫn phải** chạy lại `npm run build`, vì config
được nhúng thẳng vào `www/app.js` lúc đóng gói.

---

## 6. Những điều chỉnh đã thực hiện cho bản Android

| Mục | Chi tiết |
|---|---|
| Tên app | `Healthcare Map` — sửa tại `capacitor.config.ts` và `android/app/src/main/res/values/strings.xml` |
| Mã gói | `com.healthcaremap.tracker` |
| Icon | Icon riêng (giọt định vị + nhịp tim) ở `android/app/src/main/res/mipmap-*` |
| Bản đồ | `maps.google.com` được thêm vào `allowNavigation` để iframe bản đồ hiển thị **bên trong** app |
| Nút Chỉ đường | Trên app dùng `google.navigation:` để mở thẳng Google Maps; trên web vẫn dùng link cũ (hàm `buildDirectionsUrl` trong `src/app.ts`) |
| Zoom | Tắt pinch-zoom trong `www/index.html` để giống app native |
| Đóng gói | esbuild gộp `src/*.ts` + SDK Firebase thành một `www/app.js` (bản cũ dùng `tsc` sinh script cổ điển) |
| Dữ liệu | Cloud Firestore — xem `../FIREBASE-SETUP.md` |
| Quyền | Chỉ cần `INTERNET` — app này chỉ ĐỌC vị trí do máy Fall Guard gửi lên, không tự định vị |
| minSdk | 23 (Android 6.0 trở lên) |

---

## 7. Xử lý sự cố thường gặp

**Gradle Sync lỗi / tải thư viện chậm.** Cần mạng ổn định ở lần build đầu.
Nếu công ty/trường chặn, thử đổi mạng hoặc dùng VPN.

**Android Studio báo thiếu SDK Platform 35.** Vào **Tools ▸ SDK Manager** → tab
*SDK Platforms* → tích **Android 15 (API 35)** → Apply.

**Màn hình trắng khi mở app.** Do `www/` chưa được đồng bộ. Chạy lại
`npm run build && npx cap sync android` rồi build lại.

**Hiện banner vàng "Chưa cấu hình Firebase".** Chưa điền `src/firebase-config.ts`,
hoặc điền rồi mà quên chạy lại `npm run build`.

**Bấm "Đăng nhập" báo lỗi.** Mở DevTools (F12) → tab Console đọc mã lỗi. Bảng tra
các lỗi `auth/...` thường gặp nằm ở mục 13 của `../FIREBASE-SETUP.md`.

**"Mã thiết bị không tồn tại" dù gõ đúng.** Hai app đang trỏ về hai dự án Firebase
khác nhau. So lại `projectId` trong hai file `src/firebase-config.ts`.

**Bản đồ không hiện.** Kiểm tra điện thoại có mạng không. Bản đồ dùng iframe của Google,
bắt buộc phải online.
