// ============================================================
// chart.ts — Vẽ dạng sóng lên canvas
// ============================================================
// Tự vẽ bằng Canvas 2D thay vì kéo thêm thư viện biểu đồ: dữ liệu chỉ là mấy
// đường gấp khúc trượt theo thời gian, mà thư viện biểu đồ nào cũng nặng hơn
// toàn bộ đoạn mã dưới đây.

import type { Sample } from './stream';

export interface ChannelSpec {
  key: keyof Omit<Sample, 't'>;
  label: string;
  color: string;
}

export const ACCEL_CHANNELS: ChannelSpec[] = [
  { key: 'ax', label: 'ax', color: '#E53935' },
  { key: 'ay', label: 'ay', color: '#1E88E5' },
  { key: 'az', label: 'az', color: '#43A047' },
];

export const GYRO_CHANNELS: ChannelSpec[] = [
  { key: 'gx', label: 'gx', color: '#FB8C00' },
  { key: 'gy', label: 'gy', color: '#8E24AA' },
  { key: 'gz', label: 'gz', color: '#00ACC1' },
];

export interface DrawOptions {
  samples: Sample[];
  channels: ChannelSpec[];
  /** Kênh nào đang được bật hiển thị */
  visible: Set<string>;
  /** Bề rộng cửa sổ thời gian, tính bằng mili-giây */
  windowMs: number;
  /** Mốc thời gian ở mép PHẢI của biểu đồ */
  endTime: number;
  unit: string;
  title: string;
}

/** Màu nền / lưới, giữ đồng bộ với styles.css */
const COLOR_BG = '#0B1E3A';
const COLOR_GRID = 'rgba(255, 255, 255, 0.08)';
const COLOR_AXIS = 'rgba(255, 255, 255, 0.35)';
const COLOR_TEXT = 'rgba(255, 255, 255, 0.75)';

export function drawChart(canvas: HTMLCanvasElement, options: DrawOptions): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Canvas phải khớp kích thước thật trên màn hình, nhân thêm devicePixelRatio
  // thì đường vẽ mới sắc nét trên màn hình độ phân giải cao.
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (cssWidth === 0 || cssHeight === 0) return;

  if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const padLeft = 54;
  const padRight = 12;
  const padTop = 26;
  const padBottom = 24;
  const plotW = cssWidth - padLeft - padRight;
  const plotH = cssHeight - padTop - padBottom;

  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  ctx.fillStyle = COLOR_TEXT;
  ctx.font = '12px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${options.title} (${options.unit})`, padLeft, 6);

  const startTime = options.endTime - options.windowMs;
  const active = options.channels.filter((c) => options.visible.has(c.key));

  // Chỉ giữ mẫu nằm trong cửa sổ đang xem
  const windowSamples = options.samples.filter((s) => s.t >= startTime && s.t <= options.endTime);

  // Thang dọc tự co giãn theo dữ liệu, luôn đối xứng quanh 0 cho dễ đọc
  let maxAbs = 0;
  for (const s of windowSamples) {
    for (const c of active) {
      const v = Math.abs(s[c.key]);
      if (v > maxAbs) maxAbs = v;
    }
  }
  if (maxAbs < 1) maxAbs = 1;
  maxAbs = niceCeil(maxAbs);

  const xAt = (t: number) => padLeft + ((t - startTime) / options.windowMs) * plotW;
  const yAt = (v: number) => padTop + plotH / 2 - (v / maxAbs) * (plotH / 2);

  // --- Lưới ngang + nhãn trục dọc ---
  ctx.strokeStyle = COLOR_GRID;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = -2; i <= 2; i++) {
    const value = (maxAbs / 2) * i;
    const y = yAt(value);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.strokeStyle = i === 0 ? COLOR_AXIS : COLOR_GRID;
    ctx.stroke();
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(formatTick(value), padLeft - 8, y);
  }

  // --- Lưới dọc + nhãn trục thời gian (giây trước hiện tại) ---
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const seconds = Math.round(options.windowMs / 1000);
  const stepSec = seconds <= 10 ? 2 : seconds <= 30 ? 5 : 10;
  for (let s = 0; s <= seconds; s += stepSec) {
    const t = options.endTime - s * 1000;
    const x = xAt(t);
    if (x < padLeft) continue;
    ctx.beginPath();
    ctx.strokeStyle = COLOR_GRID;
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();
    ctx.fillStyle = COLOR_TEXT;
    ctx.fillText(s === 0 ? 'bây giờ' : `-${s}s`, x, padTop + plotH + 6);
  }

  if (windowSamples.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '13px "Segoe UI", Arial, sans-serif';
    ctx.fillText('Chưa có dữ liệu trong khoảng này', padLeft + plotW / 2, padTop + plotH / 2);
    return;
  }

  // --- Các đường tín hiệu ---
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  for (const channel of active) {
    ctx.beginPath();
    ctx.strokeStyle = channel.color;
    let started = false;
    for (const s of windowSamples) {
      const x = xAt(s.t);
      const y = yAt(s[channel.key]);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
}

/** Làm tròn lên một số "đẹp" để nhãn trục dễ đọc */
function niceCeil(value: number): number {
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const norm = value / base;
  const stepped = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return stepped * base;
}

function formatTick(value: number): string {
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
