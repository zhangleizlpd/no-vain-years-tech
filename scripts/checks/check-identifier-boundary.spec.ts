import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  deriveValueLiterals,
  EMPTY_ALLOWLIST,
  isNonPublicIpv4,
  scanForValues,
  scanText,
  trackedPaths,
  type Allowlist,
} from './check-identifier-boundary';

/**
 * E-级 1（detector 单测）—— 判据 SoT: docs/conventions/information-boundary.md § 验证纪律。
 *
 * 🚨 **负控制比正例更重要。** 只测「坏输入翻红」等于什么都没验：一个恒 `return [找到了]`
 * 的 detector 也能全过。而 detector 在合法输入上误报 → 它会被人关掉 → 等于零保护。
 * 所以下面每个 ✅ 用例都是一种真实存在于本仓的合法形态，要求它**不**被命中。
 *
 * 🚨 **本文件里的正例串一律运行时拼接，不写字面量。** 否则全仓扫描会命中本 spec 自己
 * （detector 的采集端是 `git ls-files` 全集、零 skip-dirs，本文件也在其中）。若图省事写成
 * 字面量再去 allowlist 豁免，就等于为了让测试过而在生产判据上开洞 —— 那是本末倒置。
 */

/** 由八位组拼出点分串，避免本文件出现 IPv4 字面量。 */
const ip = (a: number, b: number, c: number, d: number): string => [a, b, c, d].join('.');

/** 拼接得到的假标识符 —— 每个都刻意在源码里断开，使本行不匹配对应规则。 */
const FAKE = {
  publicIp: ip(93, 184, 216, 34), //         公网（example.com 历史地址段）
  instanceId: 'i-' + 'uf6abcdef0123456789', //  云主机实例 ID 形状
  registryId: 'crpi-' + '0123456789abcdef', //  镜像仓实例 ID 形状
  vpcId: 'vpc-' + 'uf6abcdef01234', //          网络资源 ID 形状
  sgId: 'sg-' + 'uf6abcdef01234',
  accountUid: '1234567890' + '123456', //       16 位云账号 UID 形状
  hex32: '0123456789abcdef' + '0123456789abcdef', // 32 位 hex
};

const found = (text: string, relPath = 'ops/runbook/x.md', allow: Allowlist = EMPTY_ALLOWLIST) =>
  scanText(relPath, text, allow).map((f) => f.rule);

describe('L1 正例 —— 每类标识符都必须被抓', () => {
  it('🚨 公网 IPv4', () => {
    expect(found(`ssh admin@${FAKE.publicIp}`)).toContain('public-ipv4');
  });

  it('🚨 云主机实例 ID', () => {
    expect(found(`instance: ${FAKE.instanceId}`)).toContain('cloud-instance-id');
  });

  it('🚨 镜像仓实例 ID', () => {
    expect(found(`registry: ${FAKE.registryId}.cn-x.personal.cr.aliyuncs.com`)).toContain(
      'registry-instance-id',
    );
  });

  it('🚨 VPC / 安全组资源 ID', () => {
    expect(found(`net: ${FAKE.vpcId} ${FAKE.sgId}`)).toContain('network-resource-id');
  });

  it('🚨 16 位云账号 UID（含被冒号包围的 ARN 形态）', () => {
    expect(found(`uid ${FAKE.accountUid}`)).toContain('cloud-account-uid');
    expect(found(`acs:oss:*:${FAKE.accountUid}:bucket/*`)).toContain('cloud-account-uid');
  });

  it('🚨 句末带句点的 UID 仍被抓 —— 边界写法刻意不把后缀 `.` 算作抑制条件', () => {
    expect(found(`账号是 ${FAKE.accountUid}。`)).toContain('cloud-account-uid');
    expect(found(`account is ${FAKE.accountUid}.`)).toContain('cloud-account-uid');
  });

  it('🚨 32 位 hex 在部署 / 配置面上被抓', () => {
    expect(found(`account_id = ${FAKE.hex32}`, '.github/workflows/deploy-web.yml')).toContain(
      'hex32-account-id',
    );
  });

  it('🚨 commit message 也走同一 detector —— 文件扫描对它完全无效', () => {
    // 历史上真实发生过的泄漏形态：标识符只在 message 里，文件干净。
    expect(found(`fix(repo): 修正 ${FAKE.publicIp} 的 runbook`, '<commit-msg>')).toContain(
      'public-ipv4',
    );
  });
});

describe('L1 负控制 —— 本仓真实存在的合法形态，一个都不许误报', () => {
  it('✅ 非公网 IPv4 段按 RFC 结构排除（不靠 allowlist）', () => {
    const benign = [
      ip(127, 0, 0, 1), //      loopback
      ip(0, 0, 0, 0), //        「本网络」
      ip(10, 89, 0, 1), //      RFC1918 —— 本仓隧道地址，刻意保持公开
      ip(172, 17, 195, 20), //  RFC1918
      ip(192, 168, 1, 1), //    RFC1918
      ip(169, 254, 1, 1), //    link-local
      ip(100, 64, 0, 1), //     RFC6598 CGNAT
      ip(192, 0, 2, 1), //      RFC5737 文档段
      ip(198, 51, 100, 7), //   RFC5737 文档段
      ip(203, 0, 113, 5), //    RFC5737 文档段
      ip(198, 18, 0, 1), //     RFC2544 基准测试段
      ip(224, 0, 0, 1), //      组播
    ];
    for (const v of benign) {
      expect(found(`addr ${v}`), `不该命中 ${v}`).not.toContain('public-ipv4');
    }
  });

  it('✅ 5 段以上的点分数字不是 IP —— 章节号那类被边界排除', () => {
    // 本仓真实假阳性来源：`per § 5.3.15.8.2` 里嵌着 4 段合法八位组
    expect(found('per § 5.3.15.8.2 的口径')).not.toContain('public-ipv4');
    expect(found('spec § 1.63.6.6.1')).not.toContain('public-ipv4');
  });

  it('✅ 八位组超 255 的点分数字不是 IP', () => {
    expect(found('999.999.999.999')).not.toContain('public-ipv4');
    expect(found('256.1.1.1')).not.toContain('public-ipv4');
  });

  it('🚨 但恰好 4 段的版本号**会**被判为 IP —— 这是刻意的 fail-closed，不是缺陷', () => {
    // 结构上无法区分 4 段版本号与公网 IP：每段都 ≤255、也不落任何保留段。刻意**不**加
    // 「行内含 version / bump 就放过」的上下文抑制 —— 那会立刻变成绕过通道（把真 IP 写在
    // `version` 旁边即隐形）。撞上就按值登记 allowlist 并写理由，一次性成本。
    //
    // 💡 这条用例本身踩过一次：初版把版本号写成字面量，被守门在 pre-commit 当场拦下
    //    —— 违反的正是本文件头那条「正例串一律运行时拼接」。守门自我印证了一次。
    expect(found(`bump ${ip(3, 15, 8, 1)}`)).toContain('public-ipv4');
  });

  it('✅ 小数尾数恰好 16 位 —— 结构性排除，非 allowlist', () => {
    // 波动率 fixture 的真实形态：0.<16 位>
    expect(found('const iv = 0.3377492957220201;')).not.toContain('cloud-account-uid');
    expect(found('[-2.2996515679442586, 0.3267671516225093]')).not.toContain('cloud-account-uid');
  });

  it('✅ 长标识符内嵌的 16 位数字 —— 结构性排除', () => {
    // 本仓真实形态：mock openid 与 git SHA 里恰好出现 16 位连续数字
    expect(found("const OPENID = 'oMOCKDEV0000000000000000abcd';")).not.toContain(
      'cloud-account-uid',
    );
    expect(found('commit/9df7663277007700457c258e7c8fc51e778ec2e8')).not.toContain(
      'cloud-account-uid',
    );
  });

  it('✅ 32 位 hex 在非部署面不报 —— 那里多是 md5 / 完整性摘要', () => {
    expect(found(`integrity ${FAKE.hex32}`, 'apps/server/src/x.spec.ts')).not.toContain(
      'hex32-account-id',
    );
  });

  it('✅ 短于阈值的 `i-` / `sg-` 前缀串不是资源 ID', () => {
    expect(found('i-am-a-branch-name')).not.toContain('cloud-instance-id');
    expect(found('sg-short')).not.toContain('network-resource-id');
  });
});

describe('allowlist —— 按值豁免，且刻意无路径维度', () => {
  it('登记过的值被豁免', () => {
    const allow: Allowlist = { values: { 'public-ipv4': [FAKE.publicIp] } };
    expect(found(`dns ${FAKE.publicIp}`, 'ops/runbook/x.md', allow)).not.toContain('public-ipv4');
  });

  it('🚨 豁免只对登记的那个值生效，同文件里的别的值照样红', () => {
    const allow: Allowlist = { values: { 'public-ipv4': [FAKE.publicIp] } };
    const other = ip(93, 184, 216, 35);
    expect(found(`a ${FAKE.publicIp} b ${other}`, 'ops/runbook/x.md', allow)).toContain(
      'public-ipv4',
    );
  });

  it('🚨 豁免不跨规则 —— 同一串登记在 A 规则下不影响 B 规则', () => {
    const allow: Allowlist = { values: { 'cloud-account-uid': [FAKE.publicIp] } };
    expect(found(`ip ${FAKE.publicIp}`, 'ops/runbook/x.md', allow)).toContain('public-ipv4');
  });
});

describe('isNonPublicIpv4 —— RFC 边界逐个钉住', () => {
  it('RFC1918 172.16-31 的两端与外侧一格', () => {
    expect(isNonPublicIpv4(172, 15, 0, 1)).toBe(false); // 下界外
    expect(isNonPublicIpv4(172, 16, 0, 1)).toBe(true);
    expect(isNonPublicIpv4(172, 31, 255, 254)).toBe(true);
    expect(isNonPublicIpv4(172, 32, 0, 1)).toBe(false); // 上界外 —— 本仓有测试刻意取此值
  });

  it('CGNAT 100.64-127 的边界', () => {
    expect(isNonPublicIpv4(100, 63, 0, 1)).toBe(false);
    expect(isNonPublicIpv4(100, 64, 0, 1)).toBe(true);
    expect(isNonPublicIpv4(100, 127, 0, 1)).toBe(true);
    expect(isNonPublicIpv4(100, 128, 0, 1)).toBe(false);
  });

  it('组播下界 224', () => {
    expect(isNonPublicIpv4(223, 255, 255, 254)).toBe(false);
    expect(isNonPublicIpv4(224, 0, 0, 1)).toBe(true);
  });
});

describe('L2 值层 —— 从 fleet.env 派生，仓内不留 denylist', () => {
  const fleet = [
    '# 注释行应被忽略',
    'NVY_APP_SSH=admin@' + ip(93, 184, 216, 34),
    'NVY_APP_HOST=' + ip(93, 184, 216, 34),
    'NVY_UNSET=', //                    空值不派生
    'NVY_PLACEHOLDER=<公网IP>:<port>', // 占位符不派生
    'OTHER_VAR=should-be-ignored', //   非 NVY_ 前缀不派生
    'NVY_APP_SSH_ALIAS=mbw-somealias', //   alias 本身是代号 → 不派生
    'NVY_APP_REPO_DIR=/home/x/some-repo', // 文件系统路径 → 不派生
  ].join('\n');

  it('提取真值，并从 user@host 里额外拆出宿主部分', () => {
    const lits = deriveValueLiterals(fleet);
    expect(lits).toContain('admin@' + ip(93, 184, 216, 34));
    expect(lits).toContain(ip(93, 184, 216, 34));
  });

  it('✅ 空值 / 占位符 / 非 NVY_ 变量不进派生集', () => {
    const lits = deriveValueLiterals(fleet);
    expect(lits.some((l) => l.startsWith('<'))).toBe(false);
    expect(lits).not.toContain('should-be-ignored');
    expect(lits).not.toContain('');
  });

  it('✅ _SSH_ALIAS 与 _REPO_DIR 不派生 —— 它们不是标识符', () => {
    // 2026-08-08 首次启用 L2 时实测：这两类当初被误划进「仓外解析」层，制造了一大批
    // 假阳性（仓路径出现在 systemd WorkingDirectory=、alias 出现在 shell 与文档里，
    // 都是本该公开的）。假阳性会教人忽略 L2 告警 → 等于把这一层废掉。
    const lits = deriveValueLiterals(fleet);
    expect(lits).not.toContain('mbw-somealias');
    expect(lits).not.toContain('/home/x/some-repo');
  });

  it('✅ 绝对路径值一律不派生 —— 键名兜不住时的结构性兜底', () => {
    expect(deriveValueLiterals('NVY_SOMETHING_ELSE=/opt/whatever')).not.toContain('/opt/whatever');
  });

  it('🚨 命中 fleet 真值的行被抓，且报告里不回显真值', () => {
    const lits = deriveValueLiterals(fleet);
    const hits = scanForValues({ 'ops/bin/x.sh': `ssh admin@${ip(93, 184, 216, 34)}` }, lits);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].rule).toBe('fleet-value-leak');
    // 报告本身不能成为泄漏渠道 —— CI 日志是公开的
    expect(hits[0].snippet).not.toContain('93');
  });
});

describe('E-级 2 的机械化断言 —— 采集端全开', () => {
  it('trackedPaths() 与 `git ls-files` 逐条相等：零路径过滤', () => {
    // ⚠️ nx test 的 cwd 是 project 目录（scripts/checks），裸跑 git 会得到相对该目录的
    // 路径 —— 必须显式对齐到仓根，否则这条断言比的是两套基准（首次写就踩中）。
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const raw = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    expect(trackedPaths()).toEqual(raw);
  });

  it('docs/ 与 .claude/ 确实在采集集内 —— 反例：给扫描器配 skip-dirs 会让标识符永远看不见', () => {
    const paths = trackedPaths();
    expect(paths.some((p) => p.startsWith('docs/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('.claude/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('ops/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('specs/'))).toBe(true);
  });
});
