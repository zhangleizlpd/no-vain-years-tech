import { describe, expect, it } from 'vitest';
import { scanCjkVarFold } from './check-cjk-var-fold';

const scan = (files: Record<string, string>) => scanCjkVarFold(files);
const hits = (sh: string) => scan({ 'scripts/x.sh': sh });

describe('check-cjk-var-fold — 命中（会在 CJK locale 下折字节）', () => {
  it('全角右括号紧跟变量（#865 的真实形态）→ 命中', () => {
    const v = hits('echo "--time 格式应为 HH:MM（收到 $TIME）" >&2');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ varName: 'TIME', nextChar: '）', line: 1 });
  });

  it('全角左括号紧跟变量（#865 rubric test 的形态）→ 命中', () => {
    expect(hits('echo "❌ $name — exit=$code（fail-open 契约要求恒 0）"')).toMatchObject([
      { varName: 'code', nextChar: '（' },
    ]);
  });

  it('汉字紧跟变量 → 命中', () => {
    expect(hits('echo "共 $n条"')).toMatchObject([{ varName: 'n', nextChar: '条' }]);
  });

  it('emoji 紧跟变量 → 命中，且 nextChar 是完整码点（非孤立代理）', () => {
    const v = hits('echo "$MSG🚨"');
    expect(v).toHaveLength(1);
    expect(v[0].nextChar).toBe('🚨');
  });

  it('拉丁扩展 / 度量符号紧跟变量 → 命中（不只全角标点会折）', () => {
    expect(hits('echo "$T°C"')).toMatchObject([{ varName: 'T', nextChar: '°' }]);
    expect(hits('echo "caf$Xé"')).toMatchObject([{ varName: 'X', nextChar: 'é' }]);
  });

  it('同一行多处 → 逐条报出，行号正确', () => {
    const v = scan({ 'ops/y.sh': 'a=1\necho "$A（ $B）"' });
    expect(v.map((x) => [x.line, x.varName])).toEqual([
      [2, 'A'],
      [2, 'B'],
    ]);
  });
});

describe('check-cjk-var-fold — 放行（三种修法 + 实测不折的形态）', () => {
  it('修法一：${VAR} 花括号 → 放行', () => {
    expect(hits('echo "--time 格式应为 HH:MM（收到 ${TIME}）" >&2')).toHaveLength(0);
  });

  it('修法二：printf 参数化 → 放行', () => {
    expect(hits(`printf '收到 %s）\\n' "$TIME"`)).toHaveLength(0);
  });

  it('修法三：变量放句末 → 放行', () => {
    expect(hits('echo "格式应为 HH:MM，收到 $TIME"')).toHaveLength(0);
  });

  it('位置参数 / 特殊参数紧跟全角 → 不拦（实测不折）', () => {
    expect(hits('echo "未知参数：$1）"')).toHaveLength(0);
    expect(hits('echo "退出码 $?）"')).toHaveLength(0);
    expect(hits('echo "个数 $#）"')).toHaveLength(0);
  });

  it('变量后跟 ASCII → 放行', () => {
    expect(hits('echo "path=$DIR/sub, code=$c."')).toHaveLength(0);
  });

  it('$(...) / ${#arr[@]} 等非裸变量形态 → 放行', () => {
    expect(hits('echo "时间 $(date +%s)（好）"')).toHaveLength(0);
    expect(hits('echo "样本 ${#CODES[@]} 支（好）"')).toHaveLength(0);
  });
});

describe('check-cjk-var-fold — 扫描面', () => {
  it('整行注释（含缩进）→ 跳过：注释永不展开，且仓内有蓄意展示坏形态的说明注释', () => {
    expect(hits('# ─ 导出（SSH 流式落 $TMP_DIR；列有序派生）─')).toHaveLength(0);
    expect(hits('  # 🚨 不要写成 "…$first（…" —— 会被折进变量名')).toHaveLength(0);
  });

  it('代码行的行尾注释仍扫（宁可误报，不放过）', () => {
    expect(hits('echo ok   # 说明 $VAR（示例）')).toMatchObject([{ varName: 'VAR' }]);
  });

  it('非 .sh 文件不扫（本检查器自身 / spec 夹具都含坏形态）', () => {
    expect(scan({ 'scripts/checks/check-cjk-var-fold.ts': 'const x = "$TIME）";' })).toHaveLength(
      0,
    );
    expect(scan({ 'ops/runbook/x.md': '示例 `$TIME）`' })).toHaveLength(0);
  });

  it('干净仓 → 零违反', () => {
    expect(
      scan({
        'scripts/a.sh': 'set -euo pipefail\necho "收到 ${TIME}）"',
        'ops/lib/b.sh': 'printf "共 %s 条\\n" "$n"',
        'services/c.sh': '# 注释里的 $VAR） 不算\nexit 0',
      }),
    ).toHaveLength(0);
  });
});
