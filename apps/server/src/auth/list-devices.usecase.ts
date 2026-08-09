import { Injectable } from '@nestjs/common';
import { MAX_DEVICE_PAGE_SIZE, RefreshTokenService } from '../security/refresh-token.service';
import { IpGeoService } from '../security/ip-geo.service';
import { DeviceListResponse } from './device-list.response';

/**
 * 设备列表编排 query (per ADR-0032 auth = 编排层)。
 *
 * security.listActiveByAccount 取本账号活跃行 (R2 只读) → 逐行 enrich:
 *   - location ← ipGeo.resolve(row.ipAddress) (platform infra; 私网/不可解析 → null)
 *   - isCurrent ← row.deviceId === currentDeviceId (x-device-id 头比对, clarify 2026-05-26)
 *   - **剥 ipAddress** (FR-S04: 原始 IP 绝不进响应)
 * → 分页 envelope。currentDeviceId 缺失 (无 x-device-id 头) → isCurrent 全 false,列表仍返。
 */
@Injectable()
export class ListDevicesUseCase {
  constructor(
    // CROSS-CONTEXT-SYNC: auth→security 读 refresh_token 设备列表 (R2 只读, 经 security 服务方法非直读表)
    private readonly refreshTokenService: RefreshTokenService,
    // platform infra (ADR-0041): 离线 geo 解析, 无 R2/R3
    private readonly ipGeo: IpGeoService,
  ) {}

  async execute(
    accountId: bigint,
    currentDeviceId: string | null,
    page: number,
    size: number,
  ): Promise<DeviceListResponse> {
    const { rows, total } = await this.refreshTokenService.listActiveByAccount(
      accountId,
      page,
      size,
    );

    const items = await Promise.all(
      rows.map(async (row) => ({
        id: row.id.toString(),
        deviceId: row.deviceId,
        deviceName: row.deviceName,
        deviceType: row.deviceType,
        location: await this.ipGeo.resolve(row.ipAddress),
        loginMethod: row.loginMethod,
        lastActiveAt: row.createdAt.toISOString(),
        isCurrent: currentDeviceId !== null && row.deviceId === currentDeviceId,
      })),
    );

    // 与 security.listActiveByAccount 共享同一上限算生效页大小 → totalPages 一致。
    const effectiveSize = Math.min(Math.max(Math.trunc(size), 1), MAX_DEVICE_PAGE_SIZE);
    const totalPages = total === 0 ? 0 : Math.ceil(total / effectiveSize);
    return { page, size: effectiveSize, totalElements: total, totalPages, items };
  }
}
