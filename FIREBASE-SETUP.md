# Hướng dẫn kết nối 2 app qua Firebase + EmailJS

Đề tài: **Cảnh báo té ngã tích hợp GPS**
Gồm 2 ứng dụng dùng **chung một dự án Firebase**:

| App | Ai dùng | Vai trò |
|---|---|---|
| `fall-guard-app` | Người có nguy cơ té ngã | Sinh mã thiết bị 12 số, đọc cảm biến + GPS, hiển thị mã OTP 6 số, đẩy dữ liệu lên Firestore |
| `healthcare-map` | Người thân | Nhập mã 12 số + OTP để ghép cặp, xem vị trí & lịch sử té ngã theo thời gian thực |
| `sensor-viewer` | Bạn / đồng đội làm AI | Web chạy trên máy tính, xem dạng sóng cảm biến trực tiếp và xuất CSV (tuỳ chọn — xem mục 11b) |

> **Đọc trước khi làm:** toàn bộ hướng dẫn mất khoảng **45–60 phút** cho lần đầu.
> Bạn chỉ cần sửa **đúng 2 file** trong mã nguồn (mục 6), phần còn lại là thao tác trên web.

---

## 0. Hai app nói chuyện với nhau như thế nào?

```
   ĐIỆN THOẠI NGƯỜI TÉ NGÃ                 CLOUD FIRESTORE                 ĐIỆN THOẠI NGƯỜI THÂN
       (fall-guard-app)                    (máy chủ Google)                   (healthcare-map)
              │                                    │                                  │
   ┌──────────┴──────────┐                         │                     ┌────────────┴───────────┐
   │ Mã thiết bị: 12 số  │ ──── đọc cho nhau ──────┼─────────────────▶   │ Nhập mã 12 số + OTP    │
   │ Mã OTP:      6 số   │      (nói miệng)        │                     └────────────┬───────────┘
   └──────────┬──────────┘                         │                                  │
              │                            devices/{id}/requests/{uid}  ◀───── ghi ───┘
              │ ◀──── nghe realtime ───────────────┤     (kèm mã OTP người thân gõ)
   ┌──────────┴──────────────────┐                 │
   │ Tự so mã OTP với mã đang    │                 │
   │ hiện trên màn hình:         │ ──── ghi ──────▶│  devices/{id}.guardianUids += uid
   │   đúng → DUYỆT              │                 │
   │   sai  → TỪ CHỐI            │                 │
   └──────────┬──────────────────┘                 │                                  │
              │                                    │ ◀────── nghe realtime ────────────┤
   ┌──────────┴──────────────────┐                 │                                  │
   │ Mỗi 30 giây đẩy lên:        │ ──── ghi ──────▶│  devices/{id}: lat, lng, battery │
   │  vị trí GPS, pin, lastSeen  │                 │                                  │
   │ Khi té ngã đẩy thêm:        │ ──── ghi ──────▶│  devices/{id}/events/{eventId}   │
   │  sự kiện + toạ độ + độ tin  │                 │                    │             │
   └─────────────────────────────┘                 │                    └── hiện ngay ▶ Dashboard,
                                                   │                        Bản đồ, Lịch sử
```

**Điểm mấu chốt về bảo mật:** mã OTP 6 số **không bao giờ được ghi lên Firestore**.
Nó chỉ nằm trong bộ nhớ máy người té ngã. Người thân gửi lên mã họ *gõ*, còn máy
người té ngã mới là bên có quyền phán quyết đúng/sai. Vì vậy dù ai đó đọc trộm
được cơ sở dữ liệu cũng không lấy được mã OTP.

---

## 1. Tạo dự án Firebase

1. Vào <https://console.firebase.google.com> và đăng nhập bằng tài khoản Google (Gmail) của bạn.
2. Bấm **Add project** (Thêm dự án).
3. **Tên dự án:** gõ `fall-guard-gps`.
   Firebase sẽ tự thêm hậu tố cho đủ duy nhất, ví dụ `fall-guard-gps-4a7c2`.
   → **Ghi lại chuỗi đầy đủ này**, đó chính là `projectId` sẽ dùng ở mục 5.
4. Bấm **Continue**.
5. Màn hình **Google Analytics**: **gạt TẮT** (Disable). Đồ án không cần, bật lên chỉ thêm bước.
6. Bấm **Create project**, đợi ~30 giây, rồi bấm **Continue**.

> Toàn bộ đồ án chạy trọn vẹn trên **gói Spark (miễn phí)**. Không cần thẻ tín dụng.

---

## 2. Bật Authentication (đăng nhập bằng email + mật khẩu)

1. Menu trái → **Build** → **Authentication** → bấm **Get started**.
2. Tab **Sign-in method** → trong danh sách **Native providers** bấm **Email/Password**.
3. Gạt công tắc **Enable** ở dòng đầu tiên sang BẬT.
   (Dòng thứ hai "Email link / passwordless sign-in" thì **để TẮT**.)
4. Bấm **Save**.

### 2b. Việt hoá email đặt lại mật khẩu (khuyến khích)

Chức năng "Quên mật khẩu" dùng email do **chính Firebase gửi**, mặc định bằng tiếng Anh.

1. Vẫn trong **Authentication** → tab **Templates**.
2. Chọn **Password reset**.
3. Bấm biểu tượng 🌐 bên phải, đổi ngôn ngữ sang **Vietnamese (Tiếng Việt)**.
4. Nếu muốn sửa lời văn, bấm ✏️ (bút chì), sửa Subject/Message rồi **Save**.

> Email này thường rơi vào **hộp thư Spam** ở lần đầu — nhớ dặn người chấm đồ án.

---

## 3. Tạo Cloud Firestore

1. Menu trái → **Build** → **Firestore Database** → bấm **Create database**.
2. **Location:** chọn **`asia-southeast1 (Singapore)`** — gần Việt Nam nhất, độ trễ thấp nhất.
   ⚠️ **Không đổi được sau khi tạo**, hãy chọn đúng ngay lần đầu.
3. Chọn **Start in production mode** (chế độ khoá hết). Đừng chọn test mode —
   test mode tự hết hạn sau 30 ngày và sẽ khoá app đúng lúc bạn cần bảo vệ đồ án.
4. Bấm **Create** và đợi khởi tạo xong.

Lúc này cơ sở dữ liệu **chặn tất cả** — bước tiếp theo sẽ mở đúng những gì cần.

---

## 4. Dán Security Rules

1. Vẫn trong **Firestore Database** → tab **Rules**.
2. Bôi đen và **xoá sạch** nội dung mặc định.
3. Mở file `firestore.rules` ở thư mục gốc dự án (cùng cấp với 2 thư mục app),
   **copy toàn bộ** rồi dán vào ô soạn thảo.
4. Bấm **Publish**. Nếu báo lỗi cú pháp, kiểm tra xem đã copy thiếu dấu `}` ở cuối chưa.

File rules này làm đúng 4 việc:

| Ai | Được làm gì |
|---|---|
| Chưa đăng nhập | **Không đọc/ghi được gì cả** |
| Chủ thiết bị | Toàn quyền với thiết bị của mình (ghi GPS, ghi sự kiện, duyệt/từ chối người thân) |
| Người thân đã ghép cặp | Chỉ **đọc** thiết bị & lịch sử; xoá được lịch sử cũ; tự gỡ mình ra |
| Người thân chưa ghép cặp | Chỉ **gửi được yêu cầu ghép cặp**, không đọc được gì của thiết bị |

Người thân **không thể** tự thêm mình vào danh sách theo dõi, **không thể** giả mạo
vị trí GPS, và **không thể** dựng sự kiện té ngã giả.

---

## 5. Đăng ký Web App & lấy API key

Hai app chạy trên Capacitor (WebView) nên đăng ký kiểu **Web**, không phải Android.

1. Bấm ⚙️ (bánh răng, góc trên trái, cạnh chữ "Project Overview") → **Project settings**.
2. Cuộn xuống mục **Your apps** → bấm biểu tượng **`</>`** (Web).
3. **App nickname:** gõ `fall-guard-web`.
4. **KHÔNG tích** ô "Also set up Firebase Hosting".
5. Bấm **Register app**.
6. Màn hình kế tiếp hiện đoạn mã. Phần bạn cần là khối `firebaseConfig`:

```js
const firebaseConfig = {
  apiKey: "AIzaSyD-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  authDomain: "fall-guard-gps-4a7c2.firebaseapp.com",
  projectId: "fall-guard-gps-4a7c2",
  storageBucket: "fall-guard-gps-4a7c2.firebasestorage.app",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abc123def456"
};
```

7. **Copy 6 dòng này** (hoặc chụp màn hình lại). Bấm **Continue to console**.

> **Xem lại sau này ở đâu?** ⚙️ **Project settings** → tab **General** → cuộn xuống
> **Your apps** → chọn **Config** trong mục "SDK setup and configuration".

> **API key này có phải bí mật không?** **Không.** Với Firebase Web, `apiKey` chỉ
> là mã định danh dự án, ai xem mã nguồn web cũng thấy được — Google thiết kế vậy.
> Thứ thật sự bảo vệ dữ liệu là **Security Rules** ở mục 4. Vì thế đừng lo khi
> nộp mã nguồn đồ án có chứa key này.
>
> Chỉ **một mình** bạn nộp bài thì không sao. Nếu muốn chắc hơn, vào
> [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials),
> chọn key đó và đặt **Application restrictions**. Bước này **không bắt buộc**.

---

## 6. Dán config vào mã nguồn (bước duy nhất phải sửa code)

Mở **hai** file sau — nội dung `firebaseConfig` phải **giống hệt nhau**:

* `fall-guard-app/src/firebase-config.ts`
* `healthcare-map/src/firebase-config.ts`

Thay các chỗ `DAN_..._VAO_DAY` bằng giá trị thật ở mục 5:

```ts
export const firebaseConfig = {
  apiKey: 'AIzaSyD-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  authDomain: 'fall-guard-gps-4a7c2.firebaseapp.com',
  projectId: 'fall-guard-gps-4a7c2',
  storageBucket: 'fall-guard-gps-4a7c2.firebasestorage.app',
  messagingSenderId: '123456789012',
  appId: '1:123456789012:web:abc123def456',
};
```

⚠️ Chú ý 2 lỗi hay gặp:
* Trong TypeScript dùng **dấu nháy đơn** `'...'` và có **dấu phẩy** cuối mỗi dòng.
* Nếu chỉ sửa 1 trong 2 app, hai app sẽ không thấy dữ liệu của nhau.

Phần `emailjsConfig` để nguyên, mục 7 sẽ điền.

---

## 7. Cấu hình EmailJS để gửi mã OTP đăng ký

EmailJS cho phép gửi email thẳng từ trình duyệt, không cần máy chủ riêng.
Gói miễn phí: **200 email/tháng** — quá đủ cho đồ án.

### 7.1. Tạo tài khoản

1. Vào <https://www.emailjs.com> → **Sign Up** (đăng ký bằng chính Gmail của bạn cho nhanh).
2. Xác nhận email kích hoạt tài khoản.

### 7.2. Kết nối dịch vụ gửi mail

1. Menu trái → **Email Services** → **Add New Service**.
2. Chọn **Gmail**.
3. Bấm **Connect Account** → chọn tài khoản Google → bấm **Continue/Cho phép**
   (EmailJS xin quyền gửi mail thay bạn).
4. Đặt **Service Name**: `gmail-fallguard`.
5. Bấm **Create Service**.
6. **Ghi lại `Service ID`**, dạng `service_xxxxxxx`.

### 7.3. Tạo mẫu email chứa mã OTP

1. Menu trái → **Email Templates** → **Create New Template**.
2. Điền tab **Content**:

| Ô | Điền |
|---|---|
| **Subject** | `Mã xác thực Fall Guard: {{passcode}}` |
| **To Email** | `{{email}}` |
| **From Name** | `Fall Guard` |
| **Reply To** | để trống hoặc email của bạn |

3. Nội dung (**Content**) — xoá mẫu có sẵn rồi dán:

```
Xin chào {{to_name}},

Mã xác thực đăng ký tài khoản {{app_name}} của bạn là:

        {{passcode}}

Mã có hiệu lực trong {{expire_minutes}} phút (đến khoảng {{time}}).
Không chia sẻ mã này cho bất kỳ ai.

Nếu bạn không yêu cầu đăng ký, hãy bỏ qua email này.
```

4. Bấm **Save**.
5. **Ghi lại `Template ID`**, dạng `template_xxxxxxx`.

> ⚠️ Ô **To Email** bắt buộc phải là `{{email}}` — viết sai thì EmailJS sẽ báo
> `The recipients address is empty` và không gửi được.

### 7.4. Lấy Public Key

1. Menu trái → **Account** → tab **General**.
2. Copy **Public Key** (dạng `qwErTy123_AbCdEf`).

### 7.5. Cho phép gọi API

1. Menu trái → **Account** → tab **Security**.
2. Tìm **"Allow EmailJS API for non-browser applications"** → **BẬT**.
   App Android chạy trong WebView với origin `https://localhost`, nếu để tắt
   EmailJS có thể chặn và trả lỗi `403 API calls are disabled...`.
3. Nếu có mục **Allowed origins / Allow list**, thêm `https://localhost` và `http://localhost:5173`.

### 7.6. Điền vào mã nguồn

Vẫn trong **hai** file `src/firebase-config.ts`:

```ts
export const emailjsConfig = {
  serviceId: 'service_xxxxxxx',
  templateId: 'template_xxxxxxx',
  publicKey: 'qwErTy123_AbCdEf',
};
```

---

## 8. Cài đặt thư viện & build

### 8.0. Mở khoá PowerShell trước (chỉ làm 1 lần)

Máy này đang đặt `ExecutionPolicy = AllSigned` ở phạm vi LocalMachine, nên PowerShell
từ chối chạy `npm.ps1` và báo:

```
npm : File C:\DDisk\Apps\NodeJS\npm.ps1 cannot be loaded.
The file ... is not digitally signed.
```

Đây là cài đặt bảo mật của Windows, **không phải lỗi của dự án**. Chọn **một** trong hai cách:

**Cách A — sửa hẳn (khuyến nghị).** Chạy đúng một lần, không cần quyền Administrator:

```bash
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Gõ `Y` để xác nhận. `RemoteSigned` cho phép chạy script cài từ npm trên máy, nhưng vẫn
bắt buộc chữ ký với script tải từ Internet. Đây là thiết lập tiêu chuẩn của máy lập
trình viên Node trên Windows. Sau đó `npm` chạy bình thường.

**Cách B — không đụng vào cài đặt hệ thống.** Gõ `npm.cmd` thay cho `npm` ở mọi lệnh
(`npm.cmd install`, `npm.cmd run build`, ...). File `.cmd` không phải script PowerShell
nên không bị chặn. Tương tự dùng `npx.cmd` thay `npx`.

### 8.1. Cài đặt & build

Mở **PowerShell** tại thư mục gốc dự án, chạy lần lượt:

```bash
cd fall-guard-app
npm install
npm run build
```

```bash
cd ../healthcare-map
npm install
npm run build
```

`npm run build` làm 2 việc: kiểm tra kiểu TypeScript (`tsc --noEmit`) rồi đóng gói
toàn bộ mã nguồn + thư viện Firebase thành một file `www/app.js` duy nhất bằng
esbuild. Build sạch sẽ in ra dòng `www\app.js  650kb`.

> **Trong lúc vừa code vừa thử:** chạy `npm run watch` để esbuild tự build lại
> mỗi khi bạn lưu file `.ts`.

---

## 9. Chạy thử trên máy tính (nhanh nhất để kiểm tra)

Mở **hai** cửa sổ PowerShell:

```bash
cd fall-guard-app
npm run serve
```

```bash
cd healthcare-map
npm run serve
```

Cửa sổ đầu chiếm cổng `5173`; cửa sổ thứ hai sẽ tự nhảy sang cổng khác (thường
`5174`) — đọc dòng `Available on:` để biết địa chỉ chính xác.

Mở trình duyệt:
* Fall Guard → <http://localhost:5173>
* Healthcare Map → cổng còn lại

> ⚠️ Mở bằng **2 cửa sổ ẩn danh khác nhau** (hoặc 2 trình duyệt khác nhau, ví dụ
> Chrome và Edge). Nếu mở 2 tab cùng cửa sổ, cả hai sẽ chia sẻ chung một phiên
> đăng nhập Firebase và bạn sẽ bị lẫn tài khoản.
>
> **Đừng** mở thẳng file `www/index.html` bằng cách nhấp đúp — giao thức `file://`
> chặn Firebase Auth. Bắt buộc phải qua `http://localhost`.

---

## 10. Kiểm thử luồng hoàn chỉnh

Làm theo đúng thứ tự, tích vào từng ô:

**Bên Fall Guard (người té ngã)**

- [ ] Bấm **Đăng ký tài khoản** → nhập họ tên, email thật, mật khẩu ≥ 6 ký tự.
- [ ] Mở hộp thư (kể cả **Spam**), lấy mã 6 số → nhập vào app → tài khoản được tạo.
- [ ] Màn hình **Thiết lập thiết bị**: nhập tên hiển thị → bấm **Tạo mã thiết bị**.
- [ ] Ghi lại **mã 12 số** hiện ra.
- [ ] Vào trang chủ, **bật công tắc "Giám sát cảm biến"** → cho phép trình duyệt
      truy cập **vị trí** khi được hỏi. Ba chấm GPS / gia tốc / con quay chuyển xanh.
- [ ] Chuyển sang tab **Kết nối** → đọc **mã OTP 6 số** (tự đổi sau mỗi 5 phút).
- [ ] **Để nguyên màn hình này**, đừng đóng app.

**Bên Healthcare Map (người thân)**

- [ ] Đăng ký một tài khoản **khác** (email khác).
- [ ] Tab **Thiết bị** → **+ Thêm thiết bị**.
- [ ] Nhập mã 12 số, mã OTP 6 số, đặt tên gợi nhớ (vd: "Ông nội") → **Kết nối**.
- [ ] Sau 1–2 giây hiện "Đã kết nối với Ông nội" và nhảy sang **Tổng quan**.
- [ ] Kiểm tra: trạng thái **Online**, có **pin**, có **toạ độ**, bản đồ thu nhỏ đúng chỗ.

**Thử báo té ngã**

- [ ] Bên Fall Guard → trang chủ → bấm **⚠️ Giả lập té ngã**.
- [ ] Đợi hết đếm ngược (mặc định 10 giây; đổi được thành 5/10/15 trong Cài đặt) — **đừng** bấm huỷ.
- [ ] Bên Healthcare Map: **Lịch sử** xuất hiện sự kiện mới, **Số cảnh báo** tăng 1.
- [ ] Bấm **Xem** ở sự kiện đó → nhảy sang bản đồ đúng vị trí té ngã.
- [ ] Thử lại lần nữa nhưng bấm **"Tôi ổn, huỷ cảnh báo"** → **không có gì được gửi đi**:
      lịch sử hai bên đều không thêm dòng nào, số cảnh báo không tăng. Báo động giả
      không bao giờ làm phiền người thân.
- [ ] Khi màn hình cảnh báo đỏ hiện ra, máy phải **hú còi**. Vào **Cài đặt → Cảnh báo**
      tắt công tắc "Hú còi khi phát hiện té ngã" rồi thử lại → im lặng nhưng cảnh báo
      **vẫn** gửi đi bình thường.
- [ ] Bên Healthcare Map, khi nhận cảnh báo mới phải **kêu chuông + rung**. Tắt được
      trong **Cài đặt → Thông báo → Kêu chuông khi có cảnh báo té ngã**.
- [ ] Tắt công tắc **"Giám sát cảm biến"** → nút "Giả lập té ngã" bị khoá xám, và
      bên Healthcare Map hiện cảnh báo "Người dùng đang TẮT giám sát cảm biến".
      Lúc này té ngã sẽ **không** được phát hiện — đó là hành vi đúng.

**Kiểm tra dữ liệu thật trên Firebase**

- [ ] Firebase Console → **Firestore Database** → tab **Data**.
- [ ] Thấy 3 collection: `users`, `devices`, `guardians`.
- [ ] Mở `devices/{mã 12 số}` → thấy `lat`, `lng`, `battery`, `lastSeen` đang tự cập nhật
      mỗi 30 giây, và `guardianUids` có đúng 1 phần tử.

**Thử ngắt kết nối**

- [ ] Bên Fall Guard → tab **Kết nối** → bấm **Ngắt** ở người thân.
- [ ] Bên Healthcare Map hiện thông báo mất quyền xem, dữ liệu ngừng cập nhật.

---

## 11. Build APK Android

Thư mục `android/` của **cả hai app đã được tạo sẵn và biên dịch thành công**,
bạn chỉ cần chạy một lệnh.

```bash
cd fall-guard-app
npm run apk
```

```bash
cd ../healthcare-map
npm run apk
```

APK nằm ở `<tên app>/android/app/build/outputs/apk/debug/app-debug.apk`.

> Mỗi lần sửa code TypeScript, `npm run apk` tự chạy lại `npm run build` và
> `cap sync android` trước khi đóng gói, nên không cần gõ thêm lệnh nào.

### 11.1. Vì sao không cần cài JDK 21

Capacitor 7 mặc định đòi JDK 21, còn máy bạn đang cài JDK 17. Thay vì bắt bạn cài
thêm, file `android/build.gradle` của cả hai app đã có một khối hạ mức biên dịch
xuống Java 17 cho mọi module. Đã kiểm chứng: cả `capacitor-android` lẫn mã nguồn
dự án đều biên dịch sạch ở mức 17. Nếu sau này bạn cài JDK 21 thì xoá khối đó đi
cũng được.

Nếu chuyển sang máy khác, nhớ tạo file `android/local.properties` trỏ tới Android SDK:

```
sdk.dir=C\:\Users\<TEN_MAY>\AppData\Local\Android\Sdk
```

### 11.2. Chạy ngầm khi tắt màn hình (chỉ app Fall Guard)

Android **dừng JavaScript của WebView** khi app vào nền, nên bản web thuần không
thể dò té ngã lúc màn hình tắt. Bản APK giải quyết bằng một **Foreground Service
viết bằng Java**:

| Thành phần | File | Nhiệm vụ |
|---|---|---|
| Dịch vụ nền | `android/…/FallGuardSensorService.java` | Giữ CPU chạy bằng `PARTIAL_WAKE_LOCK`, đọc cảm biến bằng `SensorManager` ở ~50 Hz, dò ngưỡng va đập, hú còi, bật màn hình |
| Cầu nối | `android/…/FallGuardSensorPlugin.java` | Đưa dữ liệu và sự kiện sang TypeScript |
| Bên TypeScript | `src/native.ts`, `src/app.ts` | Đếm ngược, ghi Firestore, phát dạng sóng, giao diện |

Nghiệp vụ vẫn nằm trọn trong TypeScript; Java chỉ lo đúng phần mà hệ điều hành
không cho JavaScript làm.

Thứ tự ưu tiên nguồn cảm biến do `startMonitoring()` quyết định:

1. **Dịch vụ nền native** — bản APK, chạy cả khi màn hình tắt
2. **`devicemotion` của WebView** — chỉ chạy khi app đang mở trên màn hình
3. **Mock sensor** — trên trình duyệt máy tính, để demo giao diện

### 11.3. Cấp quyền khi chạy trên điện thoại

Lần đầu bật **"Giám sát cảm biến"**, Android sẽ hỏi lần lượt:

- [ ] **Vị trí** → chọn **"Khi dùng ứng dụng"**
- [ ] **Thông báo** (Android 13+) → chọn **Cho phép**, không thì không thấy thông báo thường trực

Sau đó vào **Cài đặt → Chạy nền khi tắt màn hình → 🔋 Miễn trừ tiết kiệm pin** và
chọn **Cho phép**. Bước này **rất quan trọng** với máy Xiaomi, Oppo, Vivo, Samsung:
các hãng này tự giết dịch vụ nền sau vài phút nếu app không được miễn trừ.

> **Kiểm thử chạy ngầm:** bật giám sát → tắt màn hình → đợi 1 phút → lắc mạnh
> điện thoại. Máy phải hú còi và tự bật màn hình lên màn hình cảnh báo đỏ.

### 11.4. Điều tôi chưa kiểm chứng được

Máy phát triển không có điện thoại Android nào cắm vào, nên phần native mới chỉ
được kiểm chứng tới mức **biên dịch sạch và đóng gói đúng vào APK** (đã xác nhận
service `specialUse` và đủ 10 quyền nằm trong file APK). Hành vi khi màn hình tắt
thật thì **bạn phải tự thử trên điện thoại** theo checklist ở mục 11.3.

Nếu dò không ăn, thứ tự kiểm tra:

1. Thông báo thường trực **"Fall Guard đang bảo vệ bạn"** có hiện trên thanh trạng thái không?
   Không có nghĩa là dịch vụ chưa chạy → kiểm tra lại quyền Thông báo.
2. Đã miễn trừ tiết kiệm pin chưa?
3. Cắm cáp USB, chạy `adb logcat -s FallGuardSensor` để xem log của dịch vụ.

---

## 11b. Bật Realtime Database để xem dạng sóng cảm biến

Phần này **không bắt buộc**. Chưa làm thì hai app vẫn chạy đủ mọi chức năng, chỉ
là web `sensor-viewer` không có dữ liệu.

### Vì sao không dùng Firestore cho dạng sóng?

Firestore gói miễn phí cho **20.000 lượt ghi/ngày**. Đẩy một gói mẫu mỗi giây là
**86.400 lượt/ngày** — vượt gấp hơn 4 lần. Realtime Database tính theo dung lượng
(1 GB lưu trữ, 10 GB/tháng tải về) chứ không theo lượt ghi, nên hợp với luồng dữ
liệu dày và ngắn hạn như dạng sóng. Hai cơ sở dữ liệu chạy song song trong cùng
một dự án Firebase, không xung đột gì.

### Bước 1 — Tạo Realtime Database

1. Firebase Console → **Build** → **Realtime Database** → **Create Database**.
2. **Location:** chọn **Singapore (asia-southeast1)**.
3. Chọn **Start in locked mode** → **Enable**.
4. Ở tab **Data**, copy đường dẫn hiện trên đầu bảng, dạng
   `https://fall-guard-gps-default-rtdb.asia-southeast1.firebasedatabase.app`

### Bước 2 — Dán luật bảo mật

Tab **Rules** → xoá sạch nội dung cũ → dán toàn bộ file `database.rules.json` ở
thư mục gốc dự án → **Publish**.

Luật này đã được kiểm thử 11 tình huống trên Firebase Emulator:

| Ai | Làm gì | Kết quả |
|---|---|---|
| Chưa đăng nhập | đọc dạng sóng | **chặn** |
| Người thân chưa được cấp quyền | đọc dạng sóng | **chặn** |
| Người lạ | tự thêm mình vào danh sách xem | **chặn** |
| Người lạ | đổi chủ sở hữu luồng | **chặn** |
| Người thân đã được cấp quyền | đọc dạng sóng | cho phép |
| Người thân | giả mạo dữ liệu sóng | **chặn** |
| Chủ máy | ghi dữ liệu, cấp quyền xem | cho phép |

> Realtime Database **không đọc được** Firestore, nên danh sách người thân được
> app Fall Guard tự sao chép sang `live/{deviceId}/meta/viewers`. Chỉ chủ máy ghi
> được khối đó.

### Bước 3 — Điền `databaseURL`

Mở **`fall-guard-app/src/firebase-config.ts`** (chỉ file này — web xem sóng dùng
lại cấu hình từ đây, không phải điền lần nữa) và thay:

```ts
databaseURL: 'https://fall-guard-gps-default-rtdb.asia-southeast1.firebasedatabase.app',
```

Rồi build lại:

```bash
cd fall-guard-app && npm run build
cd ../sensor-viewer && npm install && npm run build
```

### Bước 4 — Mở web xem sóng

```bash
cd sensor-viewer
   npm run serve
```

Mở <http://localhost:5180>, đăng nhập bằng tài khoản Fall Guard (xem máy của mình)
hoặc tài khoản người thân (xem các máy đã ghép cặp).

Bật **"Giám sát cảm biến"** trên điện thoại thì sóng bắt đầu chạy. Trên web có:

- Chọn thiết bị, chọn cửa sổ thời gian **5s / 10s / 30s / 60s**
- Bật tắt từng kênh **ax ay az gx gy gz**
- **⏸ Tạm dừng** để soi kỹ một đoạn
- **⬇ Xuất CSV** — cột `timestamp_ms, iso_time, ax, ay, az, gx, gy, gz`, đưa thẳng
  cho đồng đội làm dữ liệu huấn luyện model

### Dữ liệu trên Realtime Database

```
live/{deviceId}/meta
    ownerUid   : uid chủ máy (dùng cho luật bảo mật)
    viewers    : { uid: true } bản sao guardianUids từ Firestore
    name       : tên hiển thị
    streaming  : đang phát hay đã dừng
    hz         : tần số lấy mẫu của luồng (25)
    updatedAt  : mốc thời gian máy chủ

live/{deviceId}/chunks/{pushId}     ← mỗi gói đúng 1 giây dữ liệu
    t0 : mốc thời gian mẫu đầu tiên
    hz : 25
    ax, ay, az, gx, gy, gz : mảng 25 số
```

App chỉ giữ **60 gói gần nhất (~60 giây)** rồi tự xoá, nên dung lượng luôn ở mức
vài chục KB và không bao giờ chạm hạn mức 1 GB.

---

## 12. Cấu trúc dữ liệu trên Firestore

```
users/{uid}
    email          string      email đăng nhập
    displayName    string      họ tên
    role           string      'faller' (người té ngã) | 'guardian' (người thân)
    deviceId       string?     mã 12 số — chỉ có ở tài khoản 'faller'
    createdAt      timestamp

devices/{deviceId}                      ← deviceId CHÍNH LÀ mã 12 chữ số
    ownerUid           string           uid chủ máy
    name               string           tên hiển thị của người té ngã
    guardianUids       string[]         uid những người thân đã được duyệt
    guardianInfo       map              { uid: {email, name, pairedAt} } — để hiển thị
    monitoringEnabled  boolean          đang bật giám sát cảm biến hay không
    battery            number|null      phần trăm pin
    lat, lng           number|null      toạ độ GPS mới nhất
    accuracy           number|null      sai số GPS (mét)
    alertCount         number           tổng số lần đã gửi cảnh báo
    lastSeen           timestamp        nhịp tim 30 giây/lần → dùng để tính online/offline
    locationUpdatedAt  timestamp
    createdAt          timestamp

devices/{deviceId}/events/{eventId}     ← mỗi lần phát hiện té ngã
    status       string      'sent' (đã gửi) | 'cancelled' (người dùng bấm huỷ)
    confidence   number      độ tin cậy AI, 0-100
    lat, lng     number      vị trí lúc té ngã (0,0 nếu người dùng tắt gửi GPS)
    source       string      'sensor' | 'demo'
    createdAt    timestamp

devices/{deviceId}/requests/{guardianUid}   ← yêu cầu ghép cặp, xoá sau khi xong
    guardianUid, guardianEmail, guardianName
    code         string      mã OTP người thân GÕ VÀO (không phải mã thật)
    state        string      'pending' | 'approved' | 'rejected'
    message      string      lý do từ chối / lời báo thành công
    createdAt    timestamp

guardians/{guardianUid}/links/{deviceId}    ← danh sách máy mà người thân theo dõi
    deviceId     string
    alias        string      TÊN NGƯỜI THÂN TỰ ĐẶT (vd "Ông nội") — riêng tư từng tài khoản
    pairedAt     timestamp
```

Nhờ tách `guardians/{uid}/links`, **một người thân theo dõi được nhiều máy**, và
**một máy cũng được nhiều người thân theo dõi** — đúng yêu cầu đề tài.

---

## 13. Xử lý sự cố

| Hiện tượng | Nguyên nhân & cách sửa |
|---|---|
| Không nghe thấy tiếng còi / chuông | Trình duyệt chặn phát tiếng cho tới khi người dùng chạm màn hình lần đầu — app tự mở khoá ở lần chạm đầu tiên, nên hãy bấm vào màn hình một cái rồi mới thử. Kiểm tra tiếp công tắc trong Cài đặt và âm lượng máy. |
| Tắt màn hình thì không dò được té ngã | Chỉ bản **APK** mới chạy ngầm được, bản web trên trình duyệt thì không. Xem mục 11.2 và 11.3, nhớ bấm "Miễn trừ tiết kiệm pin". |
| Web xem sóng báo "Chưa bật Realtime Database" | Chưa làm mục 11b, hoặc điền `databaseURL` rồi mà quên build lại **cả** `fall-guard-app` lẫn `sensor-viewer`. |
| Web xem sóng không có thiết bị nào | Đăng nhập sai tài khoản. Dùng tài khoản Fall Guard (xem máy mình) hoặc tài khoản người thân đã ghép cặp. |
| Sóng đứng im dù đã đăng nhập | Điện thoại chưa bật "Giám sát cảm biến" — dữ liệu chỉ được phát khi công tắc đó đang bật. |
| `invalid source release: 21` khi build APK | Máy thiếu JDK 21. Dự án đã có sẵn cách xử lý, xem mục 11.1 — nếu vẫn lỗi thì kiểm tra `android/build.gradle` còn khối hạ mức Java 17 không. |
| `npm.ps1 cannot be loaded ... not digitally signed` | PowerShell chặn script chưa ký. Làm mục 8.0: chạy `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`, hoặc gõ `npm.cmd` thay cho `npm`. |
| Banner vàng "Chưa cấu hình Firebase" | Chưa dán config ở mục 6, hoặc dán rồi mà **quên chạy lại `npm run build`**. |
| `auth/api-key-not-valid` | `apiKey` copy thiếu ký tự, hoặc còn dính dấu ngoặc kép thừa. |
| `auth/operation-not-allowed` | Chưa bật Email/Password ở mục 2. |
| `auth/email-already-in-use` | Email đã đăng ký rồi. Dùng "Quên mật khẩu", hoặc xoá user trong **Authentication → Users**. |
| Không nhận được mail OTP | ① Kiểm tra **Spam**. ② Sai `To Email` trong template (phải là `{{email}}`). ③ Hết hạn mức 200 mail/tháng. ④ Mở **F12 → Console** đọc lỗi EmailJS trả về. |
| EmailJS lỗi `403 ... non-browser applications` | Làm mục 7.5 — bật "Allow EmailJS API for non-browser applications". |
| "Mã thiết bị không tồn tại" dù gõ đúng | Hai app đang dùng **hai `projectId` khác nhau**. So lại 2 file `firebase-config.ts`. |
| "Máy người dùng không phản hồi sau 60 giây" | App Fall Guard phải **đang mở và có mạng**. Đây là thiết kế cố ý: chỉ máy người té ngã mới duyệt được yêu cầu. |
| "Mã OTP không đúng hoặc đã hết hạn" | Mã tự đổi mỗi 5 phút. Đọc lại mã mới đang hiện trên tab **Kết nối**. |
| `Missing or insufficient permissions` | Chưa Publish rules ở mục 4, hoặc dán thiếu. Vào **Firestore → Rules** kiểm tra lại. |
| Dashboard luôn hiện **Offline** | Máy Fall Guard chưa gửi nhịp tim: app bị đóng, mất mạng, hoặc chưa đăng nhập. Coi là offline khi > 90 giây không có tin. |
| Không có toạ độ GPS | Chưa bật công tắc "Giám sát cảm biến", hoặc từ chối quyền vị trí. Trên Chrome: 🔒 cạnh thanh địa chỉ → Vị trí → Cho phép. |
| Bản đồ trắng trong app Android | `capacitor.config.ts` của `healthcare-map` đã có `allowNavigation` cho `maps.google.com` — nếu sửa file này nhớ giữ lại dòng đó. |

---

## 14. Hạn mức gói miễn phí (Spark)

| Hạng mục | Hạn mức/ngày | Đồ án dùng thực tế |
|---|---|---|
| Firestore — đọc | 50.000 | Mỗi người thân mở app ~vài trăm lượt đọc |
| Firestore — ghi | 20.000 | Mỗi máy té ngã: **2.880 lượt/ngày** (nhịp tim 30 giây/lần) |
| Firestore — dung lượng | 1 GB | Không đáng kể |
| Authentication | Không giới hạn | |
| Realtime Database — lưu trữ | 1 GB | Chỉ giữ 60 giây sóng gần nhất, vài chục KB |
| Realtime Database — tải về | 10 GB/**tháng** | ~1,5 KB/giây khi đang mở web xem sóng |
| EmailJS | 200 email/**tháng** | Mỗi lần đăng ký tốn 1 email |

Với 2–3 máy demo thì dùng chưa tới 20% hạn mức. Nếu muốn tiết kiệm hơn nữa, sửa
hằng số `HEARTBEAT_MS` trong `fall-guard-app/src/app.ts` từ `30_000` lên `60_000`.

---

## 15. Sau này: gắn model AI thật (.pkl / .pt)

Hiện tại việc xác nhận té ngã do hàm `confirmFallWithAI()` trong
`fall-guard-app/src/app.ts` đảm nhiệm — đây là **bản giả lập**, chỉ tính biên độ
đỉnh gia tốc rồi quy ra độ tin cậy.

Khi có model thật, **giữ nguyên chữ ký hàm** và chỉ thay phần thân:

```ts
async function confirmFallWithAI(sensorWindow: SensorWindow): Promise<FallAiResult>
```

Hai hướng tuỳ framework đồng đội dùng để huấn luyện:

* **Keras / TensorFlow** (`.h5`, `.pkl`) → chuyển sang TensorFlow.js bằng
  `tensorflowjs_converter`, chạy trên máy bằng `npm install @tensorflow/tfjs`.
* **PyTorch** (`.pt`, `.pth`) → xuất ONNX bằng `torch.onnx.export`, chạy bằng
  `npm install onnxruntime-web`.

Cả hai thư viện đều viết bằng TypeScript/JavaScript, chạy **ngay trên điện thoại**,
không cần máy chủ. Cần hỏi đồng đội 3 thông tin để viết đúng bước tiền xử lý:

1. Model ăn vào **bao nhiêu mẫu** và **tần số bao nhiêu Hz**? (hiện code đệm ~2 giây ở 20 Hz)
2. Thứ tự kênh đầu vào là gì? (`[ax, ay, az, gx, gy, gz]` hay khác?)
3. Có chuẩn hoá dữ liệu khi train không (mean/std)? Nếu có thì lấy đúng bộ số đó.
