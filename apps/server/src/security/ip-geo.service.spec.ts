import { beforeAll, describe, expect, it } from 'vitest';
import { IpGeoService } from './ip-geo.service';

/**
 * 真值锚定 (非 mock,per CLAUDE.md 观测纪律):加载 committed
 * apps/server/src/security/data/ip2region_v4.xdb 对真实 IP 跑库查。
 * 省市断言锚定**当前 committed xdb 版本** —— 若刷新 xdb 资产 (周期性,plan D6),
 * 这些公网 IP 的省市可能变,需同步更新本测。null 类断言为逻辑驱动 (稳定,不随数据变)。
 *
 * 经 `nx test server <file>` 跑 (cwd=apps/server,resolveXdbPath 命中 src/security/data)。
 */
describe('IpGeoService.resolve', () => {
  let service: IpGeoService;

  beforeAll(() => {
    service = new IpGeoService();
    service.onModuleInit();
  });

  it('公网中国 IP → 省+市 中文 location', async () => {
    expect(await service.resolve('114.114.114.114')).toBe('江苏省南京市');
    expect(await service.resolve('223.5.5.5')).toBe('浙江省杭州市');
  });

  it('私网 / 回环 / 链路本地 → null (不外露,无审计价值)', async () => {
    expect(await service.resolve('10.0.0.1')).toBeNull();
    expect(await service.resolve('192.168.1.1')).toBeNull();
    expect(await service.resolve('172.16.5.5')).toBeNull();
    expect(await service.resolve('127.0.0.1')).toBeNull();
    expect(await service.resolve('169.254.1.1')).toBeNull();
  });

  it('null / 空串 / 非法 IP → null', async () => {
    expect(await service.resolve(null)).toBeNull();
    expect(await service.resolve('')).toBeNull();
    expect(await service.resolve('not-an-ip')).toBeNull();
    expect(await service.resolve('999.999.999.999')).toBeNull();
  });

  it('IPv6 (v4-only xdb) → null', async () => {
    expect(await service.resolve('2001:db8::1')).toBeNull();
    expect(await service.resolve('::1')).toBeNull();
  });
});
