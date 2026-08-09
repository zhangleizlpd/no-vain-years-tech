/**
 * @nvy/api-client — generated TS types + React Query hooks + Axios client
 * functions for the no-vain-years HTTP API.
 *
 * Backend: NestJS controllers + @nestjs/swagger → OpenAPI 3.1 JSON snapshot.
 * Codegen: Orval (per ADR-0027), mode tags-split / client react-query /
 *   httpClient axios. Per-tag service files re-exported from this index.
 *
 * Regenerate (from repo root):
 *   pnpm -C apps/server export-openapi          # → apps/server/openapi.json
 *   pnpm -C packages/api-client api:gen
 *
 * PR-5b (this swap): replaced @hey-api/openapi-ts. Function signatures use
 * raw axios responses (`Promise<AxiosResponse<T>>`). PR-5c will introduce
 * a custom axios mutator to register x-trace-id + ProblemDetail interceptor
 * via Orval `override.mutator`.
 */
export * from './generated/account-deletion/account-deletion';
export * from './generated/accounts/accounts';
export * from './generated/app/app';
export * from './generated/devices/devices';
export * from './generated/wechat-binding/wechat-binding';
export * from './generated/portfolio/portfolio';
// marketdata (015)：mobile 013 自选列表首个消费者（client-side /quote merge，ADR-0048）。
// 此前仅 server 侧用，barrel 未 surface；本次 PR2 加入暴露已生成的 typed hooks。
export * from './generated/marketdata/marketdata';
// alert (021)：mobile PR-3 首个消费者（8 hooks：CRUD×5 + 消息×3），同 marketdata 先例。
export * from './generated/alert/alert';
// chat (027)：建会话 / 取消息 typed hooks（SSE 发消息端点 mobile 自写 expo/fetch
// 客户端消费，不依赖此处的 orval mutation hook），同 alert 先例手动 surface barrel。
export * from './generated/chat/chat';
// ideation (032)：会话 CRUD / brief 生成·导出 typed hooks（SSE 澄清端点 mobile 自写
// expo/fetch 客户端消费，不依赖此处的 orval mutation hook），同 chat 先例手动 surface barrel。
export * from './generated/ideation/ideation';
// optionsdesk (045)：锚 CRUD + 复审 + PIT 还原 + 击球区雷达 8 端点 typed hooks
// （mobile 锚管理屏 / 雷达屏消费），同 alert / chat / ideation 先例手动 surface barrel。
export * from './generated/optionsdesk/optionsdesk';
export * from './generated/models/index';
