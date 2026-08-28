/**
 * api.ts — 服务端 4 端点的轻量 HTTP 客户端（025 FR-012 同步工具上传段）。
 *
 * 用 Node 22 原生 `fetch` + `FormData` + `Blob` 手写，**不依赖** `@nvy/api-client`——本工具
 * 设计为自包含、可拷到任意 Mac 跑（去 mono-repo 耦合 + `tsx --conditions` hack）。端点形态
 * 稳定；契约回归仍由仓内 contract-smoke（`apps/mobile/e2e/contract-smoke/`，用生成 client）守，
 * 本工具失配则运行期报错（fail loud）。
 */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface AuthTokens {
  accountId: string;
  accessToken: string;
  refreshToken: string;
}

export interface SkippedRowItem {
  row: number;
  reason: string;
}

export interface ImportSectionSummary {
  imported: number;
  skipped: SkippedRowItem[];
  warnings: string[];
}

export interface ImportSummary {
  asOf: string;
  holdings: ImportSectionSummary;
  closed: ImportSectionSummary;
  trades: ImportSectionSummary;
}

/** HTTP 非 2xx → 携带 status + RFC9457 problem detail（title/detail）的可读错误。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 全路径 = <baseUrl>/api<path>（server setGlobalPrefix('api')）。 */
function url(baseUrl: string, path: string): string {
  return `${baseUrl}/api${path}`;
}

async function readError(resp: Response, path: string): Promise<ApiError> {
  let detail = resp.statusText;
  try {
    const body = (await resp.json()) as { title?: string; detail?: string };
    detail = [body.title, body.detail].filter(Boolean).join(': ') || detail;
  } catch {
    // 非 JSON 错误体——保留 statusText
  }
  // 404 多半是端点根本不存在（目标 server 未部署对应版本），区分于鉴权/校验失败
  if (resp.status === 404) detail = `${detail}（端点不存在：目标 server 可能未部署对应版本）`;
  return new ApiError(`HTTP ${resp.status} ${path}: ${detail}`, resp.status, path);
}

async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  accessToken?: string,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const resp = await fetch(url(baseUrl, path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await readError(resp, path);
  return (await resp.json()) as T;
}

/** EP: 发送短信验证码（每手机号 60s/24h 限流）。 */
export function requestSmsCode(baseUrl: string, phone: string): Promise<{ ttlSec: number }> {
  return postJson(baseUrl, '/v1/accounts/sms-codes', { phone });
}

/** EP: 手机号 + 验证码登录 → access/refresh。 */
export function phoneSmsAuth(baseUrl: string, phone: string, code: string): Promise<AuthTokens> {
  return postJson(baseUrl, '/v1/accounts/phone-sms-auth', { phone, code });
}

/** EP: refresh token 单次轮转 → 新 access/refresh（失败折叠 401）。 */
export function rotateRefreshToken(baseUrl: string, refreshToken: string): Promise<AuthTokens> {
  return postJson(baseUrl, '/v1/accounts/refresh-token', { refreshToken });
}

/** EP1: multipart 导入持仓 xlsx（file part 携带 .xlsx 文件名过扩展校验 + asOf 文本字段）。 */
export async function importHoldings(
  baseUrl: string,
  accessToken: string,
  file: { bytes: Uint8Array; filename: string },
  asOf: string,
): Promise<ImportSummary> {
  const form = new FormData();
  // Blob 携带 type + 第三参 filename → @fastify/multipart 取 filename 过 server .xlsx 扩展校验
  // cast：TS 5.7 的 Uint8Array<ArrayBufferLike> 不匹配 BlobPart(ArrayBufferView<ArrayBuffer>)，运行时无碍
  form.append('file', new Blob([file.bytes as BlobPart], { type: XLSX_MIME }), file.filename);
  form.append('asOf', asOf);
  // 不手设 content-type——fetch 自动带 multipart boundary
  const path = '/v1/portfolio/holdings/import';
  const resp = await fetch(url(baseUrl, path), {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (!resp.ok) throw await readError(resp, path);
  return (await resp.json()) as ImportSummary;
}
