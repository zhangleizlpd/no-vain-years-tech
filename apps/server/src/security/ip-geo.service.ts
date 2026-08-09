import { existsSync, readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { IPv4, newWithBuffer } from 'ip2region.js';
import { scrubPrivateIp } from './refresh-token.rules';

/**
 * ip2region.js@3.1.8 的 `.d.ts` 误标 `search(): string`,实现实为 `async search()`
 * (返回 Promise + 对非法/版本不符 IP throw)。这里声明真实运行时契约,避免
 * await-thenable lint 误报 + 让 await 类型正确。
 */
interface Ip2RegionSearcher {
  search(ip: string): Promise<string>;
}

const XDB_FILE = 'ip2region_v4.xdb';
/** ip2region 对私网/保留段返回的 country 字面值 (Reserved|Reserved|Reserved|0|0)。 */
const RESERVED_COUNTRY = 'Reserved';

/**
 * 解析 xdb 路径 —— 三上下文统一 (env 覆盖优先):
 *   - prod: SWC 编 CommonJS → __dirname = dist/security;资产经 build assets 拷到
 *     dist/security/data (output './security/data' 镜像源树) → join(__dirname,'data')。
 *   - vitest / IT: swc 编 es6/ESM (__dirname 不可用,或被 prisma client polyfill 成
 *     生成目录 → existsSync 不命中自动跳过),cwd = apps/server → src/security/data。
 *   - export-openapi 等从 apps/server cwd 跑 built artifact → dist/security/data。
 * 每候选经 existsSync 守卫:错误候选 (含被污染的 __dirname) 落空跳下一个,绝不误读。
 */
function resolveXdbPath(): string {
  const override = process.env.IP2REGION_XDB_PATH;
  if (override) return override;
  const candidates = [
    typeof __dirname !== 'undefined' ? join(__dirname, 'data', XDB_FILE) : null,
    join(process.cwd(), 'src', 'security', 'data', XDB_FILE),
    join(process.cwd(), 'dist', 'security', 'data', XDB_FILE),
  ].filter((candidate): candidate is string => candidate !== null);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`ip2region xdb not found; tried: ${candidates.join(', ')}`);
}

/**
 * IpGeoService —— 离线 IP → 中文省市解析 (platform infra, ADR-0041 例外:无 R2/R3)。
 *
 * onModuleInit 用 newWithBuffer 全量载入 ~10.6MB xdb 建内存单例 searcher
 * (并发安全,可全局复用)。resolve 把行 ipAddress 转省市 location;原始 IP 绝不外露
 * (FR-S04 反枚举),私网/回环/链路本地/null/空/非法/IPv6/不可解析一律 → null。
 *
 * IPv4-only:仅 ship v4 xdb;公网 IPv6 (含 IPv4-mapped 形式) → null (graceful,
 * 符 FR-S04 不可解析→空)。需 IPv6 时另 ship v6 xdb + 第二 searcher (独立 task)。
 */
@Injectable()
export class IpGeoService implements OnModuleInit {
  private searcher: Ip2RegionSearcher | null = null;

  onModuleInit(): void {
    const buffer = readFileSync(resolveXdbPath());
    this.searcher = newWithBuffer(IPv4, buffer) as unknown as Ip2RegionSearcher;
  }

  /**
   * IP → 中文省市 location | null。命中按新 5 字段格式 `Country|Province|City|ISP|iso`
   * 取 省(idx1)+市(idx2) 拼接 (中国境内典型 → "江苏省南京市");海外 city 多为 "0"
   * → 过滤后退化为省。Reserved/缺段/空字段 → null。
   */
  async resolve(ip: string | null): Promise<string | null> {
    const scrubbed = scrubPrivateIp(ip); // 私网/回环/链路本地/非法/null/空 → null
    if (scrubbed === null) return null;
    if (!isIPv4(scrubbed)) return null; // 公网 IPv6 / IPv4-mapped: v4-only xdb 不解析
    if (this.searcher === null) return null; // 防御:onModuleInit 未跑

    let region: string;
    try {
      region = await this.searcher.search(scrubbed);
    } catch {
      return null; // 库对非法 / 版本不符 IP throw
    }
    if (region === '') return null; // 数据缺段 (sPtr/ePtr=0)

    const parts = region.split('|');
    const country = parts[0] ?? '';
    if (country === '' || country === RESERVED_COUNTRY || country === '0') return null;
    const location = [parts[1], parts[2]]
      .filter((seg): seg is string => seg != null && seg !== '' && seg !== '0')
      .join('');
    return location === '' ? null : location;
  }
}
