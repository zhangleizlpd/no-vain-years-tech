// OSS 图片即时派生缩略（009 FR-C04）。public-read URL append `?x-oss-process=image/resize`
// 让 OSS 服务端按需算缩略（CDN 后续），客户端零下载原图。配 expo-image `cacheKey` 分尺寸缓存。
export interface OssThumbSpec {
  width: number;
  height: number;
}

// 生成缩略 URL：m_lfit 等比不超框 + 转 webp + 质量 80。已带 query 的 URL 用 `&` 续接。
export function ossThumbUrl(url: string, { width, height }: OssThumbSpec): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}x-oss-process=image/resize,m_lfit,w_${width},h_${height}/format,webp/quality,q_80`;
}

// expo-image 缓存键：按 (原图 URL, 尺寸) 分桶，换图后 URL 变（含新 uuid）→ 键变 → 不命中旧缓存。
export function ossThumbCacheKey(url: string, { width, height }: OssThumbSpec): string {
  return `${url}@${width}x${height}`;
}
