import { readFileSync } from 'node:fs';
import { defineConfig } from 'orval';

/**
 * Orval codegen — generates TS types + React Query hooks + Axios client
 * functions from the local OpenAPI 3.1 JSON snapshot.
 *
 * Per ADR-0027 (Frontend Data + Test Layer):
 *   - mode: tags-split          one service file per OpenAPI tag
 *   - client: react-query       emits useQuery/useMutation hooks + raw
 *                               queryFn functions per operation
 *   - httpClient: axios         shared axios instance for actual calls
 *
 * Workflow:
 *   pnpm -C apps/server export-openapi      # → apps/server/openapi.json
 *   pnpm -C packages/api-client api:gen
 *
 * Override input via OPENAPI_INPUT env (e.g. point at live /docs-json).
 *
 * PR-5c will introduce a custom axios mutator (override.mutator.path) to
 * register x-trace-id request header + ProblemDetail response interceptor.
 * For PR-5b the generated code uses the default axios instance.
 */
const input = process.env['OPENAPI_INPUT'] ?? '../../apps/server/openapi.json';

// `clean: true` wipes src/generated BEFORE orval parses the input, so reject a
// missing / empty / non-OpenAPI local file here, while the config loads.
if (!/^https?:\/\//.test(input)) {
  let spec: { openapi?: unknown } | null = null;
  try {
    spec = JSON.parse(readFileSync(input, 'utf8')) as { openapi?: unknown } | null;
  } catch {
    throw new Error(`OpenAPI input is missing or not valid JSON: ${input}`);
  }
  if (typeof spec?.openapi !== 'string') {
    throw new Error(`OpenAPI input has no "openapi" version field: ${input}`);
  }
}

export default defineConfig({
  api: {
    input: {
      target: input,
    },
    output: {
      mode: 'tags-split',
      target: 'src/generated/api.ts',
      schemas: 'src/generated/models',
      client: 'react-query',
      httpClient: 'axios',
      clean: true,
      prettier: false,
    },
  },
});
