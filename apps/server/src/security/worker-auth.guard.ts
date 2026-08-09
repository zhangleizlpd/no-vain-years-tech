import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { agentBridgeConfig, type AgentBridgeConfig } from '../config/index.js';
import { extractBearerToken, isWorkerAuthorized } from './worker-auth.rules.js';

/**
 * 通道层鉴权 guard (P1.2 首建): 校验远程 worker 是否有资格碰 worker-token 端点。
 * `Authorization: Bearer <AGENT_WORKER_TOKEN>` constant-time 比对, fail-closed
 * (token 未配 / 缺失 / 不符 → 401)。
 *
 * **平台层共享落点 (security/, 037 自 agent-bridge/ 提升, platform infra per ADR-0041)**:
 * worker-token 鉴权与具体业务 ctx 无关, 故落 security 平台基座供 agent-bridge (agent-queue)
 * + ideation (mockup 凭证/写记录) 单向 import 复用; 各 ctx 自挂 `@UseGuards(WorkerAuthGuard)`
 * 到其 worker-token 端点 (无单一挂载点假设)。
 *
 * **零用户 principal**: 不验 account、不设 `request.user` — worker 只有队列权限, 无任何
 * 用户 API 权限。拉取层鉴权 (能不能拿某条 bizId 数据) 由事件内嵌委托 token 另管 (P1.3),
 * 与本 guard 正交。
 *
 * 失败一律裸 401 (UnauthorizedException), 不泄原因 (token 未配 vs 不符不可区分)。
 */
@Injectable()
export class WorkerAuthGuard implements CanActivate {
  constructor(@Inject(agentBridgeConfig.KEY) private readonly cfg: AgentBridgeConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    const presented = extractBearerToken(request.headers.authorization);
    if (!isWorkerAuthorized(presented, this.cfg.workerToken)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
