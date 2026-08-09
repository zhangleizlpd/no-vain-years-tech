import { ApiProperty } from '@nestjs/swagger';

/**
 * POST /ideation/asr/transcribe 响应 (035 T003, FR-001 / FR-008 / US1)。
 *
 * `text` 非 null: 识别文本; **空串 `''` = 静音 / 未识别到语音** (200, 非错误 —— client 据空串
 * 落「未识别到语音」+ 不回填, FR-008)。转写失败 (超时/非2xx/vendor) 不走此响应而是 503
 * ProblemDetail (FR-007/009)。client 把 `text` 经 insert-at-cursor 合并进输入框 (不自动发)。
 */
export class AsrTranscribeResponse {
  @ApiProperty({
    description: '识别文本; 空串 = 静音 / 未识别到语音 (非错误)',
    example: '我想做一个带验证码的登录工具',
  })
  text!: string;
}
