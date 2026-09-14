// ============================================================
// emailjs.ts — Gửi mã OTP 6 số qua EmailJS
// ============================================================
// Gọi thẳng REST API của EmailJS bằng fetch nên KHÔNG cần cài thêm thư viện.
// Tài liệu: https://www.emailjs.com/docs/rest-api/send/

import { emailjsConfig, isEmailjsConfigured } from './firebase-config';

const EMAILJS_ENDPOINT = 'https://api.emailjs.com/api/v1.0/email/send';

/** Sinh mã OTP 6 chữ số bằng bộ sinh số ngẫu nhiên mã hoá (an toàn hơn Math.random) */
export function generateOtp(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return (arr[0] % 1_000_000).toString().padStart(6, '0');
}

export interface SendOtpOptions {
  toEmail: string;
  toName: string;
  otp: string;
  /** Mã có hiệu lực bao nhiêu phút — chỉ để in vào nội dung email */
  expireMinutes: number;
}

/**
 * Gửi email chứa mã OTP.
 * Ném Error kèm thông báo tiếng Việt nếu thất bại để tầng UI hiển thị thẳng.
 */
export async function sendOtpEmail(options: SendOtpOptions): Promise<void> {
  if (!isEmailjsConfigured()) {
    throw new Error(
      'Chưa cấu hình EmailJS. Hãy điền serviceId / templateId / publicKey trong src/firebase-config.ts.'
    );
  }

  const expireAt = new Date(Date.now() + options.expireMinutes * 60_000);
  const timeText = expireAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

  // Gửi dư biến để template EmailJS đặt tên kiểu nào cũng nhận được.
  const templateParams: Record<string, string> = {
    email: options.toEmail,
    to_email: options.toEmail,
    user_email: options.toEmail,
    to_name: options.toName,
    passcode: options.otp,
    otp: options.otp,
    code: options.otp,
    time: timeText,
    expire_minutes: options.expireMinutes.toString(),
    app_name: 'Fall Guard',
  };

  let response: Response;
  try {
    response = await fetch(EMAILJS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: emailjsConfig.serviceId,
        template_id: emailjsConfig.templateId,
        user_id: emailjsConfig.publicKey,
        template_params: templateParams,
      }),
    });
  } catch {
    throw new Error('Không gửi được email. Kiểm tra kết nối mạng rồi thử lại.');
  }

  if (!response.ok) {
    const detail = (await response.text()).trim();
    // EmailJS trả về chuỗi lỗi dạng text, dịch vài lỗi hay gặp sang tiếng Việt.
    if (response.status === 403 && detail.includes('non-browser')) {
      throw new Error(
        'EmailJS chặn yêu cầu. Vào EmailJS → Account → Security, TẮT "Allow EmailJS API for non-browser applications" hoặc thêm domain của app vào danh sách cho phép.'
      );
    }
    throw new Error(`EmailJS báo lỗi (${response.status}): ${detail || 'không rõ nguyên nhân'}`);
  }
}
