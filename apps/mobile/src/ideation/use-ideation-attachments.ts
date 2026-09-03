// useIdeationAttachments — 033 多模态壳本地暂存附件 hook（B2-1 US2/US3）。
//
// 🚨 client-only：选/拍后的图片仅以 { id, localUri } 形态存在客户端会话内存态——
// **不入库、不上 OSS、不进 turn、不 resize/webp**（FR-011）。复用 profile-image 的
// expo-image-picker 权限/选图调用范式，但**不接其上传链路**（上传 + 随消息发送(vision)
// + 标注 = B2-3）。权限被拒走友好 toast（去系统设置），不抛错不崩（SC-004）。
import { useCallback, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';

import { IDEATION_COPY } from './ideation-copy';

/**
 * 036 T015 — 图片选取 e2e seam（hermetic）：web 无真系统相册/相机 → 经
 * `globalThis.__NVY_IMAGE_PICKER_E2E__` 注确定性 fixture 图（返 `{ granted, uris }`）。
 * 035 ASR / T012 viewshot 同款 `__NVY_*` 铁律：**仅 e2e harness 注入、生产 bundle 永不存在**；
 * 运行时取（非 import 期），令 harness 在首次调用前注入。返回 null = 无 seam（走真 ImagePicker）。
 */
interface ImagePickerSeamResult {
  granted: boolean;
  uris: string[];
}
function getImagePickerSeam(): (() => Promise<ImagePickerSeamResult>) | null {
  return (
    (globalThis as { __NVY_IMAGE_PICKER_E2E__?: () => Promise<ImagePickerSeamResult> })
      .__NVY_IMAGE_PICKER_E2E__ ?? null
  );
}

/** 本地暂存附件（client-only，非持久化）。 */
export interface StagedAttachment {
  /** 进程内唯一 id（递增计数，vitest 可控）。 */
  id: string;
  /** 系统 picker / 相机返回的本地 uri（file:// / content://）。 */
  localUri: string;
}

export interface UseIdeationAttachments {
  attachments: StagedAttachment[];
  /** 系统相册 picker（多选）→ 本地缩略图带回。 */
  pickFromLibrary: () => Promise<void>;
  /** 相机拍照 → 本地缩略图带回。 */
  captureFromCamera: () => Promise<void>;
  /** 移除单个附件（不影响其它）。 */
  remove: (id: string) => void;
  /** 清空全部。 */
  clear: () => void;
}

/**
 * @param fireToast 权限被拒时的友好提示回调（去系统设置引导，由父屏 ClarifyChatScreen 下传）。
 */
export function useIdeationAttachments(fireToast: (msg: string) => void): UseIdeationAttachments {
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  // 递增 id 计数（crypto.randomUUID 在 vitest 不可控，用单调计数：可测 + 进程内唯一即足够）。
  const seqRef = useRef(0);

  const append = useCallback((uris: string[]) => {
    if (uris.length === 0) return;
    setAttachments((prev) => [
      ...prev,
      ...uris.map((localUri) => ({ id: `att-${seqRef.current++}`, localUri })),
    ]);
  }, []);

  const pickFromLibrary = useCallback(async () => {
    // e2e seam（仅 web harness 注入、生产无）：返确定性 fixture 图，跳过真权限/系统相册。
    const seam = getImagePickerSeam();
    if (seam) {
      const r = await seam();
      if (!r.granted) {
        fireToast(IDEATION_COPY.permissionDenied);
        return;
      }
      append(r.uris);
      return;
    }
    // 系统相册 picker 由用户在系统 UI 显式选图、回传 scoped content-URI 授权，**app 无需持有
    // MEDIA_LIBRARY 读权限**（picker 不靠它）。而 expo-image-picker 的
    // requestMediaLibraryPermissionsAsync 在 API 29–32 仍会申请其 manifest 里 maxSdkVersion=28
    // 的 WRITE_EXTERNAL_STORAGE → 该权限在 API≥29 已不可授予 → 聚合恒返 not-granted → 旧的
    // `if(!granted) return` 把选图永久卡死。故移除权限前置门直接调起。
    // EVIDENCE: 机制的一半有官方明文 —— `writeOnly` 「Defaults to false」(= 同时请求读**和写**),
    // 且权限表把 WRITE_EXTERNAL_STORAGE 列为「automatically added through AndroidManifest.xml」,
    // https://docs.expo.dev/versions/latest/sdk/imagepicker/ (2026-09-03 复核)。
    // 卡死这一半是**实测**: 真机 Mate50 / **API 31** 复现。
    // 🚨 但「API 29–32」这个**区间是外推** —— 实测只有 31 这一个点, 29/30/32 是按
    // 「maxSdkVersion=28 + API≥29 不可授予」的机制推的, 文档没有逐版本记载。要拿它论证
    // 别的 API 级行为之前, 先补那一级的实测。
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsMultipleSelection: true,
    });
    if (result.canceled) return;
    append(result.assets.map((a) => a.uri));
  }, [append, fireToast]);

  const captureFromCamera = useCallback(async () => {
    // e2e seam（同 pickFromLibrary）：相机路径在 web 亦经 fixture 注入。
    const seam = getImagePickerSeam();
    if (seam) {
      const r = await seam();
      if (!r.granted) {
        fireToast(IDEATION_COPY.permissionDenied);
        return;
      }
      append(r.uris);
      return;
    }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      fireToast(IDEATION_COPY.permissionDenied);
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images' });
    if (result.canceled) return;
    append(result.assets.map((a) => a.uri));
  }, [append, fireToast]);

  const remove = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback(() => setAttachments([]), []);

  return { attachments, pickFromLibrary, captureFromCamera, remove, clear };
}
