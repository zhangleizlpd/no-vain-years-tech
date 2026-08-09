/// <reference types="nativewind/types" />

// nativewind/preset has empty .d.ts upstream; declare ambient module so
// tailwind.config.ts can import it without TS2306 "not a module" error.
declare module 'nativewind/preset' {
  const preset: unknown;
  export default preset;
}
