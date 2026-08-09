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
}

export interface ObjectExistsProbe {
  head(url: string): Promise<ObjectHeadResult>;
}

export const OBJECT_EXISTS_PROBE = Symbol('OBJECT_EXISTS_PROBE');

/**
 * Default impl: anonymous HTTP HEAD via the global `fetch`. Network / non-2xx
 * → `{ exists: false }` (treated as "object not there", confirm rejects).
 */
export class HttpObjectExistsProbe implements ObjectExistsProbe {
  async head(url: string): Promise<ObjectHeadResult> {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok) {
        return { exists: false, contentType: null };
      }
      return { exists: true, contentType: res.headers.get('content-type') };
    } catch {
      return { exists: false, contentType: null };
    }
  }
}
