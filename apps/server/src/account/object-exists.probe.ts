/**
 * Object-existence probe — 009 EP2 confirm HEAD check (plan D3, 用户拍板必做).
 *
 * Before persisting a confirmed objectKey, the confirm use case HEADs the
 * public-read OSS URL to verify the object actually exists + its content-type
 * is an allowed image — guarding against a client confirming a key it never
 * uploaded (which would persist a dangling/bad URL).
 *
 * Interface so the integration test can stub it (no real OSS round-trip in
 * tests). The concrete impl HEADs the public URL anonymously (bucket is
 * public-read → no signing needed).
 */
export interface ObjectHeadResult {
  exists: boolean;
  contentType: string | null;
  /**
   * 探测本身没得出结论（≠「对象不在」）。仅 404 才是「确实不在」；403 / 5xx / 网络
   * 失败都只说明**我们没能查**。两者压成同一个 `exists:false` 会让用户在 OSS 侧
   * 故障时收到「你上传的对象不存在」—— 他明明传成功了。调用方必须先看这一位。
   */
  indeterminate?: boolean;
}

export interface ObjectExistsProbe {
  head(url: string): Promise<ObjectHeadResult>;
}

export const OBJECT_EXISTS_PROBE = Symbol('OBJECT_EXISTS_PROBE');

/**
 * Default impl: anonymous HTTP HEAD via the global `fetch`.
 *
 * 三分而非二分（2026-08-09 修）：
 * - 2xx            → `{ exists: true }`
 * - **404**        → `{ exists: false }` —— 唯一能断言「对象确实不在」的状态
 * - 其余非 2xx / 抛错 → `{ exists: false, indeterminate: true }` —— 没查出来
 *
 * 🚨 旧版把**所有**非 2xx 都当成「对象不在」。这在两种真实场景下会对用户说谎：
 * 一次 5xx / 网络抖动，或者桶被云厂商停用（欠费停用返回的是 **403**，不是 404）——
 * 用户明明上传成功了，却被告知「你上传的对象不存在」，于是去重传，然后再次失败。
 */
export class HttpObjectExistsProbe implements ObjectExistsProbe {
  async head(url: string): Promise<ObjectHeadResult> {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) {
        return { exists: true, contentType: res.headers.get('content-type') };
      }
      if (res.status === 404) {
        return { exists: false, contentType: null };
      }
      return { exists: false, contentType: null, indeterminate: true };
    } catch {
      return { exists: false, contentType: null, indeterminate: true };
    }
  }
}
