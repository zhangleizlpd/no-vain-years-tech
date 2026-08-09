import type { Config } from 'tailwindcss';
import nativewindPreset from 'nativewind/preset';
// Tailwind config is loaded by Node directly (no tsconfig paths honored at
// config-load time), so use a relative import for tokens.
import { tokens } from './src/theme';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  // NativeWind v4 web 默认 darkMode='media'（CSS @media），与 RN Web 的
  // Appearance API setColorScheme 冲突会抛 "Cannot manually set color scheme"。
  // 改 class-based 后由我们决定是否加 `.dark`，不加即常亮模式（M1 不做 dark）。
  darkMode: 'class',
  // nativewind/preset 上游 types 是 unknown（见 nativewind-env.d.ts），cast 为 Config 兼容。
  presets: [nativewindPreset as Config],
  theme: {
    extend: {
      colors: tokens.colors,
      spacing: tokens.spacing,
      borderRadius: tokens.borderRadius,
      fontFamily: tokens.fontFamily,
      boxShadow: tokens.boxShadow,
    },
  },
};

export default config;
