import { describe, expect, it } from 'vitest';
import { extractBlocks, findBarePlaceholders, findNonAscii } from './check-skill-snippets';

describe('extractBlocks — fenced block 提取（纯函数，无磁盘 I/O）', () => {
  it('取到语言标注与块内首行的原文行号', () => {
    const md = ['# t', '', '```bash', 'echo hi', '```', ''].join('\n');
    expect(extractBlocks(md)).toEqual([{ lang: 'bash', code: 'echo hi', startLine: 4 }]);
  });

  it('多块各自独立，行号互不串味', () => {
    const md = ['```bash', 'a', '```', 'prose', '```powershell', 'b', 'c', '```'].join('\n');
    expect(extractBlocks(md)).toEqual([
      { lang: 'bash', code: 'a', startLine: 2 },
      { lang: 'powershell', code: 'b\nc', startLine: 6 },
    ]);
  });

  it('缩进栅栏（列表内代码块）照样取到', () => {
    const md = ['1. 步骤', '', '   ```bash', '   echo hi', '   ```'].join('\n');
    expect(extractBlocks(md)).toEqual([{ lang: 'bash', code: '   echo hi', startLine: 4 }]);
  });

  it('语言标注大小写归一', () => {
    expect(extractBlocks('```PowerShell\nx\n```')[0].lang).toBe('powershell');
  });

  it('无语言标注 → lang 为空串（后续按语言分派时天然跳过）', () => {
    expect(extractBlocks('```\nx\n```')[0].lang).toBe('');
  });

  it('未闭合栅栏不静默丢弃（否则漏扫最后一块）', () => {
    expect(extractBlocks('```bash\necho hi')).toEqual([
      { lang: 'bash', code: 'echo hi', startLine: 2 },
    ]);
  });
});

describe('findNonAscii — PowerShell 载荷纯度', () => {
  it('纯 ASCII（含 tab）→ 无发现', () => {
    expect(findNonAscii("Write-Output 'ok'\n\tfsutil volume diskfree C:")).toEqual([]);
  });

  it('emoji → 报出码位（真机上这会让投递路径静默失败）', () => {
    // 变体选择符 U+FE0F 不单独报：逐行只报首个非 ASCII 码位，定位够用
    const warn = String.fromCharCode(0x26a0, 0xfe0f);
    const expected = `U+26A0 ${JSON.stringify(String.fromCharCode(0x26a0))}`;
    expect(findNonAscii(`# ${warn} note`)).toEqual([[1, expected]]);
  });

  it('CJK 也报（注释必须写英文）', () => {
    expect(findNonAscii('Write-Output "x"\n# 中文注释')).toEqual([[2, 'U+4E2D "中"']]);
  });

  it('BOM 单独成条，且不再以 U+FEFF 重复报一遍', () => {
    expect(findNonAscii(`${String.fromCharCode(0xfeff)}Write-Output 1`)).toEqual([
      [1, 'UTF-8 BOM'],
    ]);
  });

  it('同一行多个非 ASCII 只报一个（定位够用，避免刷屏）', () => {
    expect(findNonAscii('# 中文注释很长')).toHaveLength(1);
  });
});

describe('findBarePlaceholders — 照抄即语法错误的占位符', () => {
  it('裸占位符 → 报（bash 会当成重定向）', () => {
    expect(findBarePlaceholders('PS=<script.ps1>')).toEqual([[1, '<script.ps1>']]);
  });

  it('单引号包住 → 放行（这正是修法）', () => {
    expect(findBarePlaceholders("fsutil hardlink list '<biggest-file>'")).toEqual([]);
  });

  it('双引号包住 → 放行', () => {
    expect(findBarePlaceholders('Get-Content "<path>"')).toEqual([]);
  });

  it('注释里讲解占位符 → 放行（文档句子不是可执行片段）', () => {
    expect(findBarePlaceholders('# NOTE: bash parses <x> as redirections')).toEqual([]);
  });

  it('先剥引号再剥注释：引号内的 # 不得把后面的裸占位符藏起来', () => {
    expect(findBarePlaceholders('echo "a # b" <foo>')).toEqual([[1, '<foo>']]);
  });

  it('重定向 / heredoc / 比较符不误报', () => {
    expect(
      findBarePlaceholders(['aliyun x 2>&1', "cat <<'EOF'", 'base64 -D < "$F"'].join('\n')),
    ).toEqual([]);
  });

  it('多行各自定位', () => {
    expect(findBarePlaceholders(['ok', 'run <cmd>', 'ok', 'PS=<f.ps1>'].join('\n'))).toEqual([
      [2, '<cmd>'],
      [4, '<f.ps1>'],
    ]);
  });
});
