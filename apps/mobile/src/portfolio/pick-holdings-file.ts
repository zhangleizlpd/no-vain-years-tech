// native 选 xlsx：expo-document-picker（系统文件 App / iCloud / 云盘）。RN FormData 接受
// {uri,name,type} 对象 → TS 形态上当 Blob 处理（镜像 profile-image buildUploadFormData native
// 分支）。此文件无 `.web` 后缀 = native / 默认实现（Metro 按平台解析 pick-holdings-file.web.ts）。
import * as DocumentPicker from 'expo-document-picker';

import type { PickedHoldingsFile } from './use-holdings-import';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function pickHoldingsFile(): Promise<PickedHoldingsFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: XLSX_MIME,
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return {
    // RN multipart：{uri,name,type}，TS 当 Blob（同 profile-image native 上传形态）。
    file: {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType ?? XLSX_MIME,
    } as unknown as Blob,
    filename: asset.name,
  };
}
