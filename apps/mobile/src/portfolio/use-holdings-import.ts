// 持仓导入编排（App 内入口，025 增量）。复用 server EP1 multipart 直传
// （POST /portfolio/holdings/import，server 进程内解析 xlsx）—— 非头像那套 OSS 直传。选文件
// 走平台分叉 pick-holdings-file（web DOM input / native expo-document-picker）。asOf 从文件名
// YYYYMMDD 提取（与本机同步工具 upload-holdings 同语义），缺失则交 server 兜底北京时间当日。
// 纯逻辑（asOfFromFilename / mapImportError / importedCounts）抽顶层导出供 vitest 直测；选文件
// / 上传走 Playwright e2e + 设备手验。
import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getHoldingsControllerListQueryKey,
  useHoldingsImportControllerImport,
  type ImportSummaryResponse,
} from '@nvy/api-client';

import { pickHoldingsFile } from './pick-holdings-file';
import { HOLDINGS_COPY } from './holdings-copy';

// 选中待传文件：file = FormData `file` 字段值（web File / native {uri,name,type} 当 Blob）。
export interface PickedHoldingsFile {
  file: Blob;
  filename: string;
}

const ERR = HOLDINGS_COPY.screen.import.errors;

// 文件名 YYYYMMDD → asOf YYYY-MM-DD（镜像 scripts/holdings-sync asOfFromFileName）。App 内手动
// 上传更宽松：缺日期 / 非法日期返回 undefined，交 server 兜底当日（不像同步工具抛错）。
export function asOfFromFilename(filename: string): string | undefined {
  const d = /(\d{8})/.exec(filename)?.[1];
  if (d === undefined) return undefined;
  const month = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  // 粗校验月/日范围，避免把随意 8 连数字当日期。
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// 各 sheet 入库行数 + 跳过总数（结果摘要 modal 用）。
export function importedCounts(summary: ImportSummaryResponse): {
  holdings: number;
  closed: number;
  trades: number;
  skipped: number;
} {
  return {
    holdings: summary.holdings.imported,
    closed: summary.closed.imported,
    trades: summary.trades.imported,
    skipped:
      summary.holdings.skipped.length +
      summary.closed.skipped.length +
      summary.trades.skipped.length,
  };
}

// 错误 → 友好文案。镜像 mapUploadError 的 axios status 分支（server EP1 错误码 per plan）。
export function mapImportError(error: unknown): string {
  const e = error as { isAxiosError?: boolean; response?: { status?: number } };
  if (e?.isAxiosError) {
    const status = e.response?.status;
    if (status === undefined) return ERR.network;
    if (status === 413) return ERR.tooLarge;
    if (status === 422 || status === 400) return ERR.invalid;
    if (status === 429) return ERR.rateLimit;
    if (status === 401) return ERR.auth;
    if (status >= 500) return ERR.network;
  }
  return ERR.unknown;
}

export interface UseHoldingsImport {
  /** 选文件 → 导入 → 刷新列表；用户取消 = 静默 no-op。 */
  pickAndImport: () => Promise<void>;
  isImporting: boolean;
  result: ImportSummaryResponse | null;
  errorToast: string | null;
  clearResult: () => void;
  clearError: () => void;
}

export function useHoldingsImport(): UseHoldingsImport {
  const importMutation = useHoldingsImportControllerImport();
  const queryClient = useQueryClient();
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<ImportSummaryResponse | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  // 忙态单源 + 同步重入闸（防文件选择器开启期间二次触发，镜像 useProfileImageUpload）。
  const busyRef = useRef(false);

  const pickAndImport = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setErrorToast(null);
    try {
      const picked = await pickHoldingsFile();
      if (!picked) return; // 用户取消
      setIsImporting(true);
      const asOf = asOfFromFilename(picked.filename);
      const resp = await importMutation.mutateAsync({
        data: asOf ? { file: picked.file, asOf } : { file: picked.file },
      });
      await queryClient.invalidateQueries({ queryKey: getHoldingsControllerListQueryKey() });
      setResult(resp.data);
    } catch (e) {
      setErrorToast(mapImportError(e));
    } finally {
      busyRef.current = false;
      setIsImporting(false);
    }
  }, [importMutation, queryClient]);

  return {
    pickAndImport,
    isImporting,
    result,
    errorToast,
    clearResult: () => setResult(null),
    clearError: () => setErrorToast(null),
  };
}
