import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.healthcaremap.tracker',
  appName: 'Healthcare Map',
  webDir: 'www',
  android: {
    // Cho phep tai tai nguyen https ben trong trang duoc phuc vu tu localhost
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
    // Cac host duoc phep dieu huong BEN TRONG WebView.
    // maps.google.com nam trong danh sach de iframe ban do hien thi ngay trong app.
    // Luu y: www.google.com KHONG nam trong danh sach, nho vay nut "Chi duong"
    // se mo ra ung dung Google Maps / trinh duyet cua he thong.
    allowNavigation: ['maps.google.com', 'maps.gstatic.com', '*.googleapis.com'],
  },
};

export default config;
