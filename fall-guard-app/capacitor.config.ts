import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.fallguard.monitor',
  appName: 'Fall Guard',
  webDir: 'www',
  android: {
    // Cho phep tai tai nguyen https ben trong trang duoc phuc vu tu localhost
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
