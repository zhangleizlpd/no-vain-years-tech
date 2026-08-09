// useProfileImageUpload — 头像 / 主页背景图 client 直传 OSS 统一上传流（009 US3）。
//
// 架构 = client 直传 Aliyun OSS（PostObject 表单直传），后端只签发一次性 scope 受限
// 凭证 + 不碰图片字节（plan § API Contracts EP1/EP2）。一次上传 = 4 步串行：
//   1. EP1 拿 PostObject 凭证 { host, objectKey, fields }（后端算 V4 签名）
//   2. 组 FormData（fields.* 先 append、`file` 字段**必须最后** —— OSS 忽略 file 之后的字段）
//   3. fetch(host, POST) 直传 OSS（native {uri,name,type} / web Blob）
//   4. EP2 confirm(objectKey) 落库 → invalidate /me（hero / 资料卡随 useMe 刷新）
//
// 纯逻辑（executeUpload / buildUploadFormData / mapUploadError / validateImageFile）抽
// 顶层导出供 vitest 直测；选图 / resize-webp 的 native 分支（expo-image-picker +
// expo-image-manipulator）= 设备 / 手动验证（SC-006 缺口，无 web e2e）。web 选图 / 裁剪
// 在 crop modal（T010）产出 webp Blob → 经 `uploadProcessed` 走同一上传流。
import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAccountProfileControllerConfirmProfileImage,
  useAccountProfileControllerIssueUploadCredential,
  type IssueUploadCredentialRequestContentType,
  type IssueUploadCredentialRequestTarget,
  type UploadCredentialFieldsResponse,
  type UploadCredentialResponse,
} from '@nvy/api-client';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { useAuthStore } from '~/auth';
import { meQueryKey } from '~/core/api/me-query-key';

export type UploadTarget = IssueUploadCredentialRequestTarget; // 'avatar' | 'background'

// 处理后待传图：file = FormData `file` 字段值（native 对象 / web Blob）。压缩后恒 webp。
export interface ProcessedImage {
  file: { uri: string; name: string; type: string } | Blob;
  filename: string;
  contentType: IssueUploadCredentialRequestContentType;
}

// client 先行兜底白名单（与后端 policy `in $content-type` 互为兜底，FR-C08）。
export const IMAGE_WHITELIST: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

// 上传上限（client 先拦 + 后端 policy `content-length-range` 二次拦，FR-C08）。
export const MAX_UPLOAD_BYTES: Record<UploadTarget, number> = {
  avatar: 5 * 1024 * 1024,
  background: 5 * 1024 * 1024,
};

// 压缩目标宽（等比，按 target 分尺寸）+ webp 压缩率。
const RESIZE_WIDTH: Record<UploadTarget, number> = { avatar: 512, background: 1080 };
const WEBP_COMPRESS = 0.8;
const PROCESSED_CONTENT_TYPE: IssueUploadCredentialRequestContentType = 'image/webp';

export type ClientValidationReason = 'type' | 'size' | 'permission';

// client 先行拦截（非图片 / 超 size / 缺权限）—— 走友好提示，不发 EP1（FR-C08）。
export class ClientValidationError extends Error {
  constructor(public readonly reason: ClientValidationReason) {
    super(`client validation failed: ${reason}`);
    this.name = 'ClientValidationError';
  }
}

// 直传 OSS 非 2xx（签名 / CORS / size 被 OSS 服务端拒）—— confirm 不发、profile 不脏写（FR-C07）。
export class OssUploadError extends Error {
  constructor(public readonly status: number) {
    super(`OSS direct upload failed: ${status}`);
    this.name = 'OssUploadError';
  }
}

const TOAST = {
  type: '仅支持 JPG / PNG / WebP 图片',
  size: '图片过大，请选择更小的图片',
  permission: '请在系统设置中授予相册 / 相机权限',
  upload: '图片上传失败，请重试',
  rateLimit: '操作过于频繁，请稍后再试',
  network: '网络异常，请重试',
  unknown: '上传失败，请稍后重试',
} as const;

// 错误 → 友好文案。镜像 genderEditErrorToast 的 axios 分支；client/OSS 自定义错误优先。
export function mapUploadError(error: unknown): string {
  if (error instanceof ClientValidationError) return TOAST[error.reason];
  if (error instanceof OssUploadError) return TOAST.upload;
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError) {
    const status = e.response?.status;
    if (status === undefined) return TOAST.network;
    if (status === 429) return TOAST.rateLimit;
    if (status >= 500) return TOAST.network;
    return TOAST.unknown;
  }
  return TOAST.unknown;
}

// client 先行校验（FR-C08）。expo-image-picker asset 与 web File 都有 mimeType/size 形态。
export function validateImageFile(
  asset: { mimeType?: string | null; fileSize?: number | null },
  target: UploadTarget,
): void {
  const type = asset.mimeType ?? '';
  if (!IMAGE_WHITELIST.includes(type)) throw new ClientValidationError('type');
  if (asset.fileSize != null && asset.fileSize > MAX_UPLOAD_BYTES[target]) {
    throw new ClientValidationError('size');
  }
}

// 组 PostObject 表单。fields.* 全部先 append、`file` **最后**（OSS 忽略 file 之后的字段）。
export function buildUploadFormData(
  fields: UploadCredentialFieldsResponse,
  processed: ProcessedImage,
): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  // `file` 必须最后一个 append。web = Blob + filename；native = {uri,name,type} 对象。
  if (typeof Blob !== 'undefined' && processed.file instanceof Blob) {
    form.append('file', processed.file, processed.filename);
  } else {
    // RN FormData 接受 {uri,name,type}；TS 形态上当 Blob 处理。
    form.append('file', processed.file as unknown as Blob);
  }
  return form;
}

export interface UploadFlowDeps {
  issueCredential: (req: {
    target: UploadTarget;
    contentType: IssueUploadCredentialRequestContentType;
  }) => Promise<UploadCredentialResponse>;
  ossPost: (host: string, form: FormData) => Promise<number>;
  confirm: (req: { target: UploadTarget; objectKey: string }) => Promise<void>;
  onSuccess: () => Promise<unknown> | void;
}

// 纯编排（依赖注入，vitest 直测）：EP1 → OSS POST → EP2 → onSuccess。
// confirm **仅在直传 2xx 后**调（直传失败 throw OssUploadError，profile 不脏写，FR-C07）。
export async function executeUpload(
  target: UploadTarget,
  processed: ProcessedImage,
  deps: UploadFlowDeps,
): Promise<string> {
  const credential = await deps.issueCredential({ target, contentType: processed.contentType });
  const form = buildUploadFormData(credential.fields, processed);
  const status = await deps.ossPost(credential.host, form);
  if (status < 200 || status >= 300) throw new OssUploadError(status);
  await deps.confirm({ target, objectKey: credential.objectKey });
  await deps.onSuccess();
  return credential.objectKey;
}

async function defaultOssPost(host: string, form: FormData): Promise<number> {
  const res = await fetch(host, { method: 'POST', body: form });
  return res.status;
}

// native 选图（相册 / 相机）+ resize/webp。SC-006 设备 / 手动验证（vitest mock，无 web e2e）。
async function pickAndProcessNative(
  target: UploadTarget,
  source: 'library' | 'camera',
): Promise<ProcessedImage | null> {
  // 相机需 CAMERA 运行时权限（真需要且可授予）；相册 picker 由用户在系统 UI 显式选图、回传
  // scoped content-URI 授权，**app 无需持有 MEDIA_LIBRARY 读权限**。且
  // requestMediaLibraryPermissionsAsync 在 API 29–32 会申请已不可授予的 WRITE_EXTERNAL_STORAGE
  // → 误返 not-granted 卡死选图（真机 Mate50/API31 实证，见 use-ideation-attachments 同修）。
  // 故仅相机做权限前置门，相册直接调起 picker。
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new ClientValidationError('permission');
  }

  // aspect 仅 Android 生效、iOS 裁剪恒方形（背景图宽幅 iOS 不在 picker 内强裁，显示端 framing 兜）。
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: 'images',
    allowsEditing: true,
    aspect: target === 'avatar' ? [1, 1] : [16, 9],
    quality: 1,
  };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;
  validateImageFile({ mimeType: asset.mimeType, fileSize: asset.fileSize }, target);

  const context = ImageManipulator.manipulate(asset.uri);
  context.resize({ width: RESIZE_WIDTH[target] });
  const ref = await context.renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.WEBP, compress: WEBP_COMPRESS });
  return {
    file: { uri: out.uri, name: 'upload.webp', type: 'image/webp' },
    filename: 'upload.webp',
    contentType: PROCESSED_CONTENT_TYPE,
  };
}

// web crop modal 产出的 webp Blob → ProcessedImage（走同一 uploadProcessed 上传流）。
export function processedFromWebBlob(blob: Blob): ProcessedImage {
  return { file: blob, filename: 'upload.webp', contentType: PROCESSED_CONTENT_TYPE };
}

export interface UseProfileImageUpload {
  // 直接上传已处理图（web crop modal 路径）。
  uploadProcessed: (processed: ProcessedImage) => Promise<void>;
  // native 选图 → 处理 → 上传（无额外 UI）。
  pickAndUpload: (source: 'library' | 'camera') => Promise<void>;
  isUploading: boolean;
  errorToast: string | null;
  clearError: () => void;
}

export function useProfileImageUpload(target: UploadTarget): UseProfileImageUpload {
  const issue = useAccountProfileControllerIssueUploadCredential();
  const confirm = useAccountProfileControllerConfirmProfileImage();
  const queryClient = useQueryClient();
  const [isUploading, setIsUploading] = useState(false);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  // 忙态单源 + 同步重入闸（ref 防两次快速触发在 re-render 前都读到 isUploading=false，FR-C03）。
  const busyRef = useRef(false);

  const runUpload = useCallback(
    (processed: ProcessedImage) =>
      executeUpload(target, processed, {
        issueCredential: (req) => issue.mutateAsync({ data: req }).then((r) => r.data),
        ossPost: defaultOssPost,
        confirm: (req) => confirm.mutateAsync({ data: req }).then(() => undefined),
        onSuccess: () =>
          queryClient.invalidateQueries({
            queryKey: meQueryKey(useAuthStore.getState().accountId),
          }),
      }),
    [target, issue, confirm, queryClient],
  );

  // 统一忙态 / 错误包装：produce 产图（null = 用户取消）→ runUpload。重复触发忽略。
  const guarded = useCallback(
    async (produce: () => Promise<ProcessedImage | null>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setIsUploading(true);
      setErrorToast(null);
      try {
        const processed = await produce();
        if (!processed) return; // 取消
        await runUpload(processed);
      } catch (e) {
        setErrorToast(mapUploadError(e));
      } finally {
        busyRef.current = false;
        setIsUploading(false);
      }
    },
    [runUpload],
  );

  const uploadProcessed = useCallback(
    (processed: ProcessedImage) => guarded(() => Promise.resolve(processed)),
    [guarded],
  );
  const pickAndUpload = useCallback(
    (source: 'library' | 'camera') => guarded(() => pickAndProcessNative(target, source)),
    [guarded, target],
  );

  return {
    uploadProcessed,
    pickAndUpload,
    isUploading,
    errorToast,
    clearError: () => setErrorToast(null),
  };
}
