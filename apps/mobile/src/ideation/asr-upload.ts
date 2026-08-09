// 035 T006 — 整段录音文件 → base64 → 一次性识别上传（IO 层，无 vitest；契约冒烟 T009 覆盖）。
//
// 录音文件（nitro-sound stopRecorder 的 URI）经 expo-file-system 读为 base64，调**生成 fn**
// `asrTranscribeControllerTranscribeAudio`（禁手写 fetch/axios，per api-contract-trigger invariant）
// 一次性识别，返整段 transcript。音频是瞬态字节：服务端只 base64 包裹转发、永不落库（FR-012）。
//
// 错误语义（交 use-ideation-recording 编排分流）：
//   - 转写成功非空 → 返回文本（落 insert-at-cursor）。
//   - 静音/未识别 → 返回 ''（服务端 200 空串，FR-008）→ 上层走「未识别到语音」轻提示。
//   - 读文件失败 / 503 转写失败（AxiosError）→ 抛出 → 上层降级 toast（FR-007/009）。
import { File } from 'expo-file-system';
import {
  asrTranscribeControllerTranscribeAudio,
  AsrTranscribeRequestMimeType,
} from '@nvy/api-client';

/** nitro-sound 默认录 AAC（MPEG_4 容器）；mimeType 让 vendor 自检容器（DashScope 原生接受 AAC）。 */
export const ASR_MIME_TYPE = AsrTranscribeRequestMimeType['audio/aac'];

/**
 * 读录音 URI 为 base64（无 data-URL 前缀）。`file://`（nitro 原生录音文件）走 expo-file-system；
 * `data:<mime>;base64,<b64>`（内联载荷，如 web MediaRecorder blob / e2e seam fixture）直接切尾段。
 */
async function readBase64(fileUri: string): Promise<string> {
  if (fileUri.startsWith('data:')) {
    const comma = fileUri.indexOf(',');
    return comma >= 0 ? fileUri.slice(comma + 1) : '';
  }
  return new File(fileUri).base64();
}

/**
 * 录音文件一次性识别。读文件失败 / 转写失败抛出（上层 catch 降级）；静音返 ''。
 *
 * @param fileUri nitro-sound `stopRecorder` 的 `file://` URI（或内联 `data:` 载荷）。
 * @returns 整段 transcript（'' = 静音/未识别）。
 */
export async function transcribeRecording(fileUri: string): Promise<string> {
  const audioBase64 = await readBase64(fileUri);
  const res = await asrTranscribeControllerTranscribeAudio({
    audioBase64,
    mimeType: ASR_MIME_TYPE,
  });
  return res.data.text;
}
