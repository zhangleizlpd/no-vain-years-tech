import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * POST /ideation/asr/transcribe request body (035 T003, FR-001 / US1) —— 整段录音 base64
 * 一次性上传转写 (听写式 dictation, B2-2)。
 *
 * 音频是**透明瞬态字节**: 服务端只 base64 包裹 + 拼 client 声明的 mimeType 转发 vendor,
 * **永不落库 / 不上 OSS / 无 IdeaAttachment** (FR-012)。transcript 经既有 turns 端点落库。
 *
 * 🚨 体积闸: `audioBase64` `@MaxLength` ~14MB (≈ vendor 10MB 文件上限 + base64 膨胀),
 * 是真正干净的 413/400 ProblemDetail 闸; 该路由 Fastify bodyLimit 略高于此 (main.ts per-route
 * onRoute hook, 其余端点维持 1MB 默认), 保证 DTO 先拦而非 Fastify raw 413。`mimeType` 白名单
 * = nitro-sound 录制容器 (aac/mp4) + WAV/MP3 fallback。
 */
const AUDIO_BASE64_MAX = 14 * 1024 * 1024;

export class AsrTranscribeRequest {
  @ApiProperty({
    description: '整段录音的 base64 (无 data-URL 前缀; 服务端拼 data:<mime>;base64 转发 vendor)',
    minLength: 1,
    maxLength: AUDIO_BASE64_MAX,
    example: 'AAAAGGZ0eXBNNEEg...',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(AUDIO_BASE64_MAX)
  audioBase64!: string;

  @ApiProperty({
    description: '音频容器 MIME (vendor 据此自检容器); nitro-sound 默认 audio/aac',
    enum: ['audio/aac', 'audio/mp4', 'audio/wav', 'audio/mpeg'],
    example: 'audio/aac',
  })
  @IsIn(['audio/aac', 'audio/mp4', 'audio/wav', 'audio/mpeg'])
  mimeType!: string;
}
