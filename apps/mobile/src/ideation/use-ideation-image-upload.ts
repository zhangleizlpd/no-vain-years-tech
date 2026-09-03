// useIdeationImageUpload — 036 ideation 图片 client 直传 OSS（B2-3 US1/US3）。
//
// 架构 = 复用 profile-image 的 client 直传 OSS 4 步流（PostObject 表单直传），后端只签发
// 一次性 scope 受限凭证 + 不碰图片字节。与 profile-image 的唯一差异 = **签名 EP 换 ideation
// 凭证 fn**（`attachmentCredentialControllerIssue(sessionId, {contentType})`，T008 生成）：
//   1. 凭证 EP 拿 PostObject 凭证 { host, objectKey, fields }（后端算 V4 签名）
//   2. 组 FormData（fields.* 先 append、`file` 字段**必须最后** —— OSS 官方明文的顺序要求,
//      出处见 server `integrations/oss/oss-post-object.adapter.ts` 的 EVIDENCE）
//   3. fetch(host, POST) 直传 OSS（native {uri,name,type} / web Blob）
//   4. 返回 objectKey（带图 turn 用 attachmentKeys 引用，T012/T014 发送时调）
//
// 与 profile-image 不同：ideation **无 confirm EP**（不落 account 表）—— 直传成功即拿
// objectKey，落库在带图 turn（clarify-turn fn，server T006）。压缩走 expo-image-manipulator
// → webp ≤10MB（对齐 M3 视觉，server keyPrefix `ideation/<accountId>/` size 上限）。
//
// 纯逻辑（executeIdeationUpload / buildIdeationUploadFormData / mapIdeationUploadError /
// compressForUpload 参数）抽顶层导出供 vitest 直测；native 选图/烧录图来源由调用方传入
// （T009 上传 hook 不选图 —— 暂存图 localUri 来自 use-ideation-attachments；烧录图来自
// som-flatten，T012）。
import { useCallback, useRef, useState } from 'react';
import {
  attachmentCredentialControllerIssue,
  type AttachmentCredentialRequestContentType,
  type AttachmentCredentialFieldsResponse,
  type AttachmentCredentialResponse,
} from '@nvy/api-client';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

// client 先行兜底白名单（与后端 policy `in $content-type` 互为兜底）。
export const IDEATION_IMAGE_WHITELIST: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

// 上传上限（对齐 M3 视觉 + server keyPrefix size 上限 10MB）。client 先拦 + 后端 policy 二次拦。
export const IDEATION_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// 压缩目标宽（等比，长边收敛省带宽）+ webp 压缩率。压缩后恒 webp。
export const IDEATION_RESIZE_WIDTH = 1280;
const WEBP_COMPRESS = 0.82;
const PROCESSED_CONTENT_TYPE: AttachmentCredentialRequestContentType = 'image/webp';

// 处理后待传图：file = FormData `file` 字段值（native 对象 / web Blob）。压缩后恒 webp。
export interface ProcessedIdeationImage {
  file: { uri: string; name: string; type: string } | Blob;
  filename: string;
  contentType: AttachmentCredentialRequestContentType;
}

// 直传 OSS 非 2xx（签名 / CORS / size 被 OSS 服务端拒）—— turn 不发、不脏写（FR-011 降级）。
export class IdeationOssUploadError extends Error {
  constructor(public readonly status: number) {
    super(`OSS direct upload failed: ${status}`);
    this.name = 'IdeationOssUploadError';
  }
}

const TOAST = {
  upload: '图片上传失败，请重试',
  rateLimit: '操作过于频繁，请稍后再试',
  network: '网络异常，请重试',
  unknown: '上传失败，请稍后重试',
} as const;

// 错误 → 友好文案（FR-011 不泄露 vendor / 凭证细节）。OSS 自定义错误优先，再 axios 分支。
export function mapIdeationUploadError(error: unknown): string {
  if (error instanceof IdeationOssUploadError) return TOAST.upload;
  const e = error as {
    isAxiosError?: boolean;
    response?: { status?: number };
    name?: string;
    message?: string;
  };
  if (e?.isAxiosError) {
    const status = e.response?.status;
    if (status === undefined) return TOAST.network;
    if (status === 429) return TOAST.rateLimit;
    if (status >= 500) return TOAST.network;
    return TOAST.unknown;
  }
  // RN fetch 直传到 OSS 连接层失败（无 response）= 网络错误（DNS / 无外网 / 超时 / TLS），
  // 表现为 `TypeError: Network request failed` → 给「网络异常」文案（提示用户查网络，真机实证）。
  if (e?.name === 'TypeError' || /network request failed/i.test(e?.message ?? '')) {
    return TOAST.network;
  }
  return TOAST.unknown;
}

// 组 PostObject 表单。fields.* 全部先 append、`file` **最后**
// （OSS 官方明文的顺序要求, 出处见 server `oss-post-object.adapter.ts` 的 EVIDENCE）。
// 与 profile-image buildUploadFormData 同构（OSS PostObject 表单规格不因业务模块而异）。
export function buildIdeationUploadFormData(
  fields: AttachmentCredentialFieldsResponse,
  processed: ProcessedIdeationImage,
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

export interface IdeationUploadDeps {
  issueCredential: (req: {
    sessionId: string;
    contentType: AttachmentCredentialRequestContentType;
  }) => Promise<AttachmentCredentialResponse>;
  ossPost: (host: string, form: FormData) => Promise<number>;
}

// 纯编排（依赖注入，vitest 直测）：凭证 EP → OSS POST → 返 objectKey。
// 直传失败 throw IdeationOssUploadError（turn 不发、不脏写，FR-011）。**无 confirm**（不落 account 表）。
export async function executeIdeationUpload(
  sessionId: string,
  processed: ProcessedIdeationImage,
  deps: IdeationUploadDeps,
): Promise<string> {
  const credential = await deps.issueCredential({ sessionId, contentType: processed.contentType });
  const form = buildIdeationUploadFormData(credential.fields, processed);
  const status = await deps.ossPost(credential.host, form);
  if (status < 200 || status >= 300) throw new IdeationOssUploadError(status);
  return credential.objectKey;
}

// expo-image-manipulator 压缩 → webp（resize 长边到 IDEATION_RESIZE_WIDTH，对齐 M3 + 省带宽）。
// 入参 uri = 暂存图 localUri（use-ideation-attachments）/ 烧录图 uri（som-flatten，T012）。
export async function compressForUpload(uri: string): Promise<ProcessedIdeationImage> {
  const context = ImageManipulator.manipulate(uri);
  context.resize({ width: IDEATION_RESIZE_WIDTH });
  const ref = await context.renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.WEBP, compress: WEBP_COMPRESS });
  return {
    file: { uri: out.uri, name: 'ideation-upload.webp', type: 'image/webp' },
    filename: 'ideation-upload.webp',
    contentType: PROCESSED_CONTENT_TYPE,
  };
}

async function defaultOssPost(host: string, form: FormData): Promise<number> {
  const res = await fetch(host, { method: 'POST', body: form });
  return res.status;
}

export interface UseIdeationImageUpload {
  /** 压缩 → 直传 → 返 objectKey（带图 turn 用）。失败 throw（错误映射由调用方走 mapIdeationUploadError）。 */
  uploadImage: (uri: string) => Promise<string>;
  /** 顺序上传多张（多图轮提交，顺序与缩略条一致，FR-010）；任一失败即整体 throw。 */
  uploadImages: (uris: string[]) => Promise<string[]>;
  isUploading: boolean;
}

/**
 * @param sessionId 目标会话 id（凭证 EP scope 到 `ideation/<accountId>/`，归属随 session）。
 */
export function useIdeationImageUpload(sessionId: string): UseIdeationImageUpload {
  const [isUploading, setIsUploading] = useState(false);
  // 忙态同步重入闸（ref 防两次快速触发在 re-render 前都读到 isUploading=false）。
  const busyRef = useRef(false);

  const runUpload = useCallback(
    async (uri: string): Promise<string> => {
      const processed = await compressForUpload(uri);
      return executeIdeationUpload(sessionId, processed, {
        issueCredential: (req) =>
          attachmentCredentialControllerIssue(req.sessionId, {
            contentType: req.contentType,
          }).then((r) => r.data),
        ossPost: defaultOssPost,
      });
    },
    [sessionId],
  );

  const uploadImage = useCallback(
    async (uri: string): Promise<string> => {
      if (busyRef.current) throw new Error('upload already in flight');
      busyRef.current = true;
      setIsUploading(true);
      try {
        return await runUpload(uri);
      } finally {
        busyRef.current = false;
        setIsUploading(false);
      }
    },
    [runUpload],
  );

  const uploadImages = useCallback(
    async (uris: string[]): Promise<string[]> => {
      if (busyRef.current) throw new Error('upload already in flight');
      busyRef.current = true;
      setIsUploading(true);
      try {
        // 顺序上传（保 FR-010 提交顺序与缩略条一致；不并发，避免 OSS 限流 + 顺序错乱）。
        const keys: string[] = [];
        for (const uri of uris) keys.push(await runUpload(uri));
        return keys;
      } finally {
        busyRef.current = false;
        setIsUploading(false);
      }
    },
    [runUpload],
  );

  return { uploadImage, uploadImages, isUploading };
}
