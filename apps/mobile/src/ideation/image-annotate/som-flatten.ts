// 036 T012 — SoM（Set-of-Marks）烧录：把「图 + 编号 pin overlay」展平为单图（IO 薄壳）。
//
// `react-native-view-shot` `captureRef` 截取标注视图引用（图 + 编号 pin overlay）→ 展平为单
// 文件 uri → 交 T009 上传 hook（useIdeationImageUpload.uploadImage）拿 ossKey → 带图轮提交。
//
// 🟢 react-native-view-shot 是 PRE-DECIDED 唯一新依赖（research.md Gate 0.2 6Q card 已锁，
//    否决 skia 理由在案）—— 原生模块需 app rebuild（T017 PR flag）。
//
// 🚨 e2e seam（035 同款 `__NVY_*` 铁律）：调 captureRef 前先查 `globalThis.__NVY_VIEWSHOT_E2E__`
//    —— 存在则用它返回的既定烧录图（Playwright web 无真原生 captureRef）。**仅 e2e harness 注入、
//    生产 bundle 永不存在**。运行时取（非 import 期），让 harness 在首次调用前注入。T015 负责设此
//    global，本 task 只留 seam 检查点。
import { type ComponentRef, type RefObject } from 'react';
import { type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

/** captureRef 可接受的视图引用（标注画布根 View 引用）。 */
export type CaptureViewRef = RefObject<ComponentRef<typeof View> | null>;

/**
 * e2e 展平替身 seam（hermetic）：web 无真原生 captureRef → 经 `globalThis.__NVY_VIEWSHOT_E2E__`
 * 注入确定性烧录图 uri。返回 null = 无 seam（生产路径走真 captureRef）。
 */
export function getViewShotSeam(): (() => Promise<string>) | null {
  return (
    (globalThis as { __NVY_VIEWSHOT_E2E__?: () => Promise<string> }).__NVY_VIEWSHOT_E2E__ ?? null
  );
}

/**
 * SoM 烧录配置：png 无损（view-shot 不支持 webp；编号 overlay 锐利不糊）。下游
 * useIdeationImageUpload.compressForUpload 会再压成 webp ≤10MB，故此处只求锐利保真。
 */
const CAPTURE_OPTIONS = { format: 'png', quality: 1 } as const;

/**
 * 把标注视图引用展平为单图 uri。
 *
 * - e2e：`__NVY_VIEWSHOT_E2E__` 存在 → 返其既定烧录图 uri（hermetic）。
 * - 生产：`captureRef(viewRef, {format:'png'})` 真截图 → 返本地 uri。
 *
 * 返回的 uri 交 useIdeationImageUpload.uploadImage 压缩上传（som-flatten 不上传，只产烧录图）。
 */
export async function flattenAnnotatedImage(viewRef: CaptureViewRef): Promise<string> {
  const seam = getViewShotSeam();
  if (seam) return seam();
  return captureRef(viewRef, CAPTURE_OPTIONS);
}
