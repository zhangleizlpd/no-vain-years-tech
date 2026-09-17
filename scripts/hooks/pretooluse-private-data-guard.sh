#!/usr/bin/env bash
# PreToolUse(Write|Edit|Bash) hook — 私有业务数据写入闸（**阻断型**）。
#
# 判据 SoT: docs/conventions/information-boundary.md（「真值写进仓 = 再发布一遍」）
# 清单:     $NVY_PRIVATE_VALUES_FILE（默认 ~/.nvy/private-values.txt），由 ops/bin/gen-private-values.sh 生成
# 同源检查: scripts/checks/check-identifier-boundary.ts 的 L2 规则 private-business-value
#           （lefthook pre-commit --staged + commit-msg）
#
# 为什么 commit 时刻已有 L2 还要这一道：
#   · PR 正文 / issue 评论没有任何 git 侧钩子能看到 —— 只有写入时刻拦得住。
#   · 到 commit 才拦时，真值早已落进工作区文件、在上下文里被复述多轮；越早拦，扩散面越小。
#   · CLAUDE.md / rules 只是上下文，不是强制层；要硬拦只能靠 PreToolUse。
#
# ── 拦截写法（https://code.claude.com/docs/en/hooks）───────────────────────────────────
# 官方：PreToolUse `exit 2` = 阻断，stderr 回给 Claude；`hookSpecificOutput.permissionDecision:
# "deny"` + exit 0 同样阻断。两者可混用 —— exit 2 保持阻断效果，stdout 上的 JSON 仍被读取，
# 阻断消息取 JSON 的 reason。
# ⇒ 命中时**两个都做**：stdout 打 deny JSON + stderr 写同一段原因 + exit 2。理由：社区报告
# anthropics/claude-code#13744「exit 2 拦 Bash 有效、拦不住 Write/Edit」（状态未确认），双写让
# 任一通道失效时另一条仍生效。
# ⚠️ 与本目录其它 guard「NEVER exit 2」的契约**刻意不同**：那些是提示 / 防误用的软闸，误拦
# 代价高于放过；本闸放过 = 私有真值进公开仓，发布即不可撤回，故阻断。
#
# ── 检查面 ────────────────────────────────────────────────────────────────────────
#   Write → tool_input.content          ┐ 目标 file_path 不在**本仓**（同一个 git common dir，含全部
#   Edit  → tool_input.new_string       ┘ worktree）或被 git check-ignore（docs/private/** 等）→ 放行
#   Bash  → 只查发布类 / 写仓类命令，**其余一律放行**（psql / ssh 等只读取数命令不拦）：
#     · git / git-bot commit                               命令文本 + -F / --file 引用的文件
#     · gh / gh-bot pr|issue create|edit|comment|review    命令文本 + --body-file / -F 引用的文件
#     · gh / gh-bot api（带 body= / title= / --input）     命令文本 + key=@file / --input 引用的文件
#     · 重定向 > / >> / tee 写入本仓未被忽略的路径         命令文本（heredoc 正文就在命令文本里）
#   判「本仓」而不是「任意 git 工作树」：~/dotfiles、知识库这类私有仓不是公开面。
#
# ── 已知局限（明说而非掩盖）────────────────────────────────────────────────────────
#   · Bash 解析是 best-effort：按空白切词、剥引号，不做完整 shell 语义 —— 变量展开、eval、
#     `$(cat file)` 拼出来的正文、子 shell 里算出来的路径都看不到。
#   · 命令**运行时才产生**的内容看不到：`ssh … psql … > apps/x.json` 的输出执行前不存在。
#   · python / node 等解释器自己开文件写，不经 Write / Edit / 重定向 → 不拦。cp / mv / sed -i 同。
#   · 清单里没有短于 8 的值（误报太高）⇒ 短数字拦不了。
#   · 聊天正文没有工具调用 ⇒ 没有 PreToolUse，结构性不可拦。
#
# ── fail-open ─────────────────────────────────────────────────────────────────────
# 清单不存在 / 读不了 → exit 0 静默（CI、新机器、没生成过清单的人不受打扰）；输入或清单解析
# 失败 → exit 0 + stderr 一行警告。故无 `set -e` / 无 `set -u`。
#
# 性能：非发布类 Bash = 一次 jq + 几个 bash 正则。需要扫时 = 一次 perl：清单编成字面量
# alternation（perl 对纯字面量分支自动建 trie ⇒ 单遍扫描，O(内容字节)，与值个数近乎无关）。
# EVIDENCE: 2026-09-14 本机实测，清单数百个值 × 300KB 文件：perl 6ms；BSD `grep -F -f` 1072ms
# （macOS 自带 grep 多模式退化成逐模式扫）；python3 `in` 循环 52ms。⇒ 选 perl。

JQ=/usr/bin/jq
PERL=/usr/bin/perl
{ [ -x "$JQ" ] && [ -x "$PERL" ]; } || exit 0

LIST="${NVY_PRIVATE_VALUES_FILE:-$HOME/.nvy/private-values.txt}"
{ [ -f "$LIST" ] && [ -r "$LIST" ]; } || exit 0

warn() { printf 'pretooluse-private-data-guard: %s —— 已放行（fail-open）\n' "$1" >&2; }

input=$(cat) || exit 0
[ -n "$input" ] || exit 0

cmd=$("$JQ" -r '.tool_input.command // empty' <<<"$input" 2>/dev/null) || {
  warn '输入不是合法 JSON'
  exit 0
}
cwd=$("$JQ" -r '.cwd // empty' <<<"$input" 2>/dev/null) || cwd=""
[ -n "$cwd" ] || cwd=$PWD

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd) || SCRIPT_DIR=""

# 本仓内、且未被 .gitignore 忽略 → 0；否则 1。
# hook 本体不在 git 仓里（如定向变异时拷到仓外跑）时退化为「任意 git 工作树」—— 偏严一侧。
publishable_path() {
  local p=$1 d common
  case "$p" in
    "~/"*) p="$HOME/${p#"~/"}" ;;
    /*) ;;
    *) p="$cwd/$p" ;;
  esac
  d=${p%/*}
  [ -n "$d" ] || d=/
  while [ ! -d "$d" ]; do
    d=${d%/*}
    [ -n "$d" ] || d=/
  done
  common=$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  if [ -z "${self_common+x}" ]; then
    self_common=""
    [ -n "$SCRIPT_DIR" ] &&
      self_common=$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  fi
  [ -z "$self_common" ] || [ "$common" = "$self_common" ] || return 1
  git -C "$d" check-ignore -q -- "$p" 2>/dev/null && return 1
  return 0
}

TMPD=""
prepare() {
  TMPD=$(mktemp -d "${TMPDIR:-/tmp}/nvy-private-guard.XXXXXX") || exit 0
  trap 'rm -rf "$TMPD"' EXIT
}

# 清单解析与 check-identifier-boundary.ts 的 parsePrivateValues 同一口径：去首尾空白 / CR，
# `# category: <name>` 开分段，其余 # 行跳过，长度 < 8 不收。🚨 空值必须剔掉 —— 空串进
# alternation 会匹配一切。命中 → 打印「值个数<TAB>类别×个数, …」并 exit 0；零命中 exit 1；
# 读不了 exit 3。🚫 永不打印值本身。按长度降序排分支，重叠时报较长的那个。
# shellcheck disable=SC2016 # perl 源码，$ 不该被 shell 展开
MATCHER='
  my ($list, $blob) = @ARGV;
  open(my $L, "<", $list) or exit 3;
  my (%cat, @v);
  my $c = "uncategorized";
  while (my $l = <$L>) {
    $l =~ s/\r?\n\z//;
    $l =~ s/^\s+|\s+$//g;
    if ($l =~ /^#/) { $c = $1 if $l =~ /^#\s*category:\s*(\S+)/; next }
    next if length($l) < 8 || exists $cat{$l};
    $cat{$l} = $c;
    push @v, $l;
  }
  exit 1 unless @v;
  my $re = join "|", map { quotemeta } sort { length($b) <=> length($a) } @v;
  open(my $B, "<", $blob) or exit 3;
  my $t = do { local $/; <$B> };
  exit 1 unless defined $t && $t =~ /$re/;
  my %hit;
  $hit{$1} = 1 while $t =~ /($re)/g;
  my %per;
  $per{$cat{$_}}++ for keys %hit;
  printf "%d\t%s", scalar(keys %hit), join(", ", map { "$_ x$per{$_}" } sort keys %per);
  exit 0;
'

# 把可读的普通文件内容追加进待查内容（body 文件 / commit message 文件）。$1 = 命令里的原始 token
append_ref() {
  local p=${1//\"/}
  p=${p//\'/}
  case "$p" in
    '' | -) return ;;
    "~/"*) p="$HOME/${p#"~/"}" ;;
    /*) ;;
    *) p="$cwd/$p" ;;
  esac
  [ -f "$p" ] && [ -r "$p" ] || return
  head -c 5000000 "$p" >> "$TMPD/blob"
  printf '\n' >> "$TMPD/blob"
}

if [ -z "$cmd" ]; then
  # ── Write / Edit 通道 ──────────────────────────────────────────────────────
  fp=$("$JQ" -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null) || fp=""
  [ -n "$fp" ] || exit 0
  publishable_path "$fp" || exit 0
  prepare
  "$JQ" -r '[.tool_input.content, .tool_input.new_string, ((.tool_input.edits // [])[]? | .new_string)]
            | map(select(type == "string")) | join("\n")' <<<"$input" > "$TMPD/blob" 2>/dev/null || {
    warn '读不出写入内容'
    exit 0
  }
  surface="写入 ${fp}"
else
  # ── Bash 通道：先分类，非发布类 / 非写仓类直接放行 ─────────────────────────────
  flat=${cmd//\\$'\n'/ } # 折叠反斜杠续行
  re_commit='(^|[^A-Za-z0-9_-])(git|git-bot)([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+commit([[:space:]]|$)'
  re_ghbody='(^|[^A-Za-z0-9_-])(gh|gh-bot)[[:space:]]+(pr|issue)[[:space:]]+(create|edit|comment|review)([[:space:]]|$)'
  re_ghapi='(^|[^A-Za-z0-9_-])(gh|gh-bot)[[:space:]]+api([[:space:]]|$)'
  kind=""
  if [[ $flat =~ $re_commit ]] || [[ $flat =~ $re_ghbody ]]; then
    kind=publish
  elif [[ $flat =~ $re_ghapi ]] && [[ $flat == *body=* || $flat == *title=* || $flat == *--input* ]]; then
    kind=publish
  else
    # 写仓类：重定向 / tee 的目标里只要有一个落在本仓未被忽略的路径，就查命令文本。
    # `2>&1` 这类 fd 复制不算目标（`&` 被排除在目标字符集外）。
    targets=$(
      printf '%s\n' "$flat" | grep -oE '(^|[^<>])[0-9&]?>>?\|?[[:space:]]*[^[:space:]&|;<>()]+' |
        sed -E 's/^[^>]*>{1,2}\|?[[:space:]]*//'
      printf '%s\n' "$flat" | grep -oE '(^|[|[:space:]])tee([[:space:]]+-[A-Za-z-]+)*[[:space:]]+[^[:space:]&|;<>()]+' |
        awk '{ print $NF }'
    )
    set -f
    old_ifs=$IFS
    IFS=$'\n'
    for t in $targets; do
      t=${t//\"/}
      t=${t//\'/}
      case "$t" in '' | /dev/*) continue ;; esac
      if publishable_path "$t"; then
        kind=repo-write
        break
      fi
    done
    IFS=$old_ifs
    set +f
  fi
  [ -n "$kind" ] || exit 0

  prepare
  printf '%s\n' "$cmd" > "$TMPD/blob"
  if [ "$kind" = publish ]; then
    # 命令引用的正文文件：-F / --file（git commit、gh pr create）、--body-file、--input，
    # 以及 gh api 的 key=@file。按空白切词、剥引号（best-effort，见头部局限）。
    set -f
    read -ra toks <<<"$(printf '%s' "$flat" | tr '\n\t' '  ')"
    set +f
    n=${#toks[@]}
    i=0
    while [ "$i" -lt "$n" ]; do
      t=${toks[$i]}
      t=${t//\"/}
      t=${t//\'/}
      case "$t" in
        -F | --file | --body-file | --input) [ $((i + 1)) -lt "$n" ] && append_ref "${toks[$((i + 1))]}" ;;
        --file=* | --body-file=* | --input=*) append_ref "${t#*=}" ;;
      esac
      case "$t" in *=@*) append_ref "${t#*=@}" ;; esac
      i=$((i + 1))
    done
    surface="发布命令（commit / PR / issue / api）"
  else
    surface="重定向 / tee 写入仓内路径"
  fi
fi

# ── 匹配 ─────────────────────────────────────────────────────────────────────
summary=$("$PERL" -e "$MATCHER" "$LIST" "$TMPD/blob" 2>/dev/null)
case $? in
  0) ;;
  1) exit 0 ;;
  *)
    warn '清单或待查内容读取失败'
    exit 0
    ;;
esac
count=${summary%%$'\t'*}
cats=${summary#*$'\t'}
[ -n "$count" ] && [ "$count" != 0 ] || count=1
[ -n "$cats" ] && [ "$cats" != "$summary" ] || cats="未知"

reason="私有数据闸：${surface} —— 命中 ${count} 个私有业务数据值（类别：${cats}），不写入公开仓位置、不发布。
请改用合成值或定性表述，真值只放 docs/private/。
（本闸不回显值；清单 \$NVY_PRIVATE_VALUES_FILE 或 ~/.nvy/private-values.txt；判据 docs/conventions/information-boundary.md）"

"$JQ" -n --arg r "$reason" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}' 2>/dev/null
printf '%s\n' "$reason" >&2
exit 2
