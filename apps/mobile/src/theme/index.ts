// Design tokens — single source of truth for native (now) + web (M2 Next.js).
//
// Imported by:
// - apps/native/tailwind.config.ts (theme.extend)
// - apps/web/tailwind.config.ts (M2)
// - packages/ui/src/index.ts (re-export to consumers)
//
// Naming convention: semantic / domain (ink / line / surface / ok / warn / err / accent / brand),
// mirrored from Claude Design handoff at apps/native/specs/auth/phone-sms-auth/design/source/tailwind.config.js
// (per ADR-0015 + handoff.md § Token decisions, 2026-05-03).
//
// Tokens are typed loosely (no `as const`) so Tailwind v3's mutable
// KeyValuePair types accept them via `theme.extend`.

export const colors = {
  brand: {
    50: '#EEF3FE',
    100: '#D5E0FC',
    200: '#ABC1F9',
    300: '#7DA0F5',
    400: '#4F7EEF',
    500: '#2456E5',
    600: '#1D47C2',
    700: '#173BA0',
    800: '#122E7C',
    900: '#0E2461',
    soft: '#E8EEFD',
  },
  accent: {
    DEFAULT: '#FF8C00',
    soft: '#FFF1DE',
  },
  ink: {
    DEFAULT: '#1A1A1A',
    muted: '#666666',
    subtle: '#999999',
  },
  line: {
    DEFAULT: '#E5E7EB',
    strong: '#D1D5DB',
    soft: '#EEF0F3',
  },
  surface: {
    DEFAULT: '#FFFFFF',
    alt: '#F9F9F9',
    sunken: '#F2F4F7',
  },
  ok: {
    DEFAULT: '#10B981',
    soft: '#E7F8F1',
  },
  warn: {
    DEFAULT: '#F59E0B',
    soft: '#FEF3DC',
  },
  err: {
    DEFAULT: '#EF4444',
    soft: '#FDECEC',
  },
  // 013-watchlist 行情涨跌色（A股 红涨绿跌，per spec SC-M06 + design handoff WatchlistKit.jsx）。
  // 刻意区别于 err #EF4444 / ok #10B981：up 更偏品红、更醒目，down 是更纯的绿，
  // flat 中性灰。0 既有 token 重设（不复用 err/ok 表达涨跌）。
  quote: {
    up: '#F5333D',
    down: '#06A561',
    flat: '#8E9094',
  },
  // 013-watchlist 自选项颜色标记调色板（FR-M08，mockup WatchlistKit PALETTE 对齐）。
  // 刻意避开红 / 绿 → 不与上面的 quote 涨跌色冲突。存储值 = key（'blue'…），
  // 经 ~/portfolio/watchlist-palette.ts 的 key→`bg-tag-*` class 静态映射渲染。
  tag: {
    blue: '#2456E5',
    teal: '#14B8A6',
    purple: '#7C5CFC',
    pink: '#EC4899',
    orange: '#FF8C00',
    gray: '#94A3B8',
  },
  // my-profile alpha variants (per spec my-profile T11 / handoff.md § 4).
  // Flat keys (no ramp) — used as bg-hero-overlay / text-white-soft / text-white-strong
  // for white-on-blur legibility in Hero. Not part of any color ramp.
  'hero-overlay': 'rgba(15,18,28,0.36)',
  'white-soft': 'rgba(255,255,255,0.72)',
  'white-strong': 'rgba(255,255,255,0.92)',
  // spec C T15 — freeze modal scrim (per design/handoff.md § 4).
  // Slightly darker than hero-overlay (0.48 vs 0.36) for modal focus.
  'modal-overlay': 'rgba(15,18,28,0.48)',
};

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '32px',
  '2xl': '48px',
  '3xl': '64px',
};

export const borderRadius = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  full: '9999px',
};

export const fontFamily = {
  sans: ['Inter', 'Noto Sans SC', 'PingFang SC', 'sans-serif'],
  mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace'],
};

export const boxShadow = {
  card: '0 1px 2px 0 rgba(17,24,39,.05), 0 1px 3px 0 rgba(17,24,39,.04)',
  cta: '0 4px 12px -2px rgba(36,86,229,0.25)',
  // Avatar 圆形边缘软光（per spec my-profile T11 / handoff.md § 4）
  'hero-ring': '0 4px 16px -4px rgba(0,0,0,0.18)',
  // spec C T15 — freeze modal card elevation (per design/handoff.md § 4).
  modal: '0 12px 32px -8px rgba(15,18,28,0.28), 0 4px 12px -4px rgba(15,18,28,0.18)',
  // 005 US5 — bottom-sheet upward elevation + destructive CTA glow (ported verbatim
  // from legacy app tailwind.config; RemoveDeviceSheet 移除按钮 + sheet 容器).
  sheet: '0 -4px 24px -6px rgba(17,24,39,0.18)',
  'cta-err': '0 4px 12px -2px rgba(239,68,68,0.28)',
};

export const tokens = {
  colors,
  spacing,
  borderRadius,
  fontFamily,
  boxShadow,
};

export type Tokens = typeof tokens;
