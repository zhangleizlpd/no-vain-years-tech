#!/usr/bin/env bash
# 访客侧一键安装器。四个子命令，按顺序跑：
#   ./setup.sh keygen         生成密钥对 → 打印公钥（发回给对方）
#   ./setup.sh configure      填入对方给的两个值 → 落 wg2.conf + token
#   ./setup.sh check          验通路（/healthz，不用 wg show）
#   ./setup.sh install-skill  装 OpenClaw skill
#
# 设计约束（改之前先读）：
#  1. **私钥永不覆盖** —— 重跑 keygen 拿到的是同一对密钥。覆盖 = 对方那侧配的 peer
#     公钥瞬间失效，而他不会自动知道，表现为「昨天还好好的，今天全不通」。
#  2. **不自己 sudo** —— `wg-quick up` 需要密码，非交互环境下会挂死。本脚本只负责把
#     配置落好，起隧道那条命令交给人跑（README 第 4 步）。
#  3. **token 不过终端回显** —— 直接落 0600 文件；check 从文件读，不接受命令行传值。
set -euo pipefail

WG_DIR="${WG_DIR:-$HOME/.config/wireguard}"
TOKEN_DIR="${TOKEN_DIR:-$HOME/.config/nvy-futu}"
WG_CONF="$WG_DIR/wg2.conf"
TOKEN_FILE="$TOKEN_DIR/token"

# 访客地址。本包默认发给访客 2；再加访客 3 时改这里（须与服务端 peer 的 AllowedIPs 一致）。
GUEST_ADDR="${GUEST_ADDR:-10.90.0.3/24}"
# 服务端 endpoint 由对方随公钥/token 一并给出（本仓面向公开，真值不入库 ——
# per docs/conventions/information-boundary.md）。configure 时校验非空。
SERVER_ENDPOINT="${SERVER_ENDPOINT:-}"
SERVER_VIP="${SERVER_VIP:-10.90.0.1}"
BASE="${BASE:-http://$SERVER_VIP:8811}"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { printf '\n❌ %s\n' "$*" >&2; exit 1; }
ok()  { printf '✅ %s\n' "$*"; }

need_bin() {
  command -v "$1" >/dev/null 2>&1 && return 0
  printf '\n❌ 缺少 %s。安装方式：\n' "$1" >&2
  case "$(uname -s)" in
    Darwin) printf '   brew install %s\n' "${2:-$1}" >&2 ;;
    Linux)  printf '   sudo apt install %s   # 或对应发行版的包管理器\n' "${2:-$1}" >&2 ;;
    *)      printf '   请自行安装 %s\n' "${2:-$1}" >&2 ;;
  esac
  exit 1
}

cmd_keygen() {
  need_bin wg wireguard-tools
  need_bin curl

  mkdir -p "$WG_DIR"
  chmod 700 "$WG_DIR"

  if [ -f "$WG_DIR/wg2.key" ]; then
    # 不覆盖（见文件头约束 1）。已有密钥就直接复用并打印公钥。
    ok "已存在密钥对，复用（未覆盖）"
  else
    ( umask 077; wg genkey > "$WG_DIR/wg2.key" )
    wg pubkey < "$WG_DIR/wg2.key" > "$WG_DIR/wg2.pub"
    chmod 600 "$WG_DIR/wg2.key"
    ok "已生成密钥对 → $WG_DIR/wg2.{key,pub}"
  fi

  printf '\n'
  printf '════════ 把下面这一行发回给对方（公钥，不是秘密）════════\n'
  cat "$WG_DIR/wg2.pub"
  printf '════════════════════════════════════════════════════════\n\n'
  printf '🚨 %s 是私钥，永远留在本机 —— 不要发给任何人。\n' "$WG_DIR/wg2.key"
}

cmd_configure() {
  need_bin wg wireguard-tools
  [ -f "$WG_DIR/wg2.key" ] || die "还没有密钥对。先跑：./setup.sh keygen"

  [ -n "${SERVER_PUBKEY:-}" ] || die "缺 SERVER_PUBKEY。跑法见 README 第 3 步：
   SERVER_PUBKEY='<对方给的公钥>' GUEST_TOKEN='<对方给的 token>' ./setup.sh configure"
  [ -n "${GUEST_TOKEN:-}" ]   || die "缺 GUEST_TOKEN。同上。"
  [ -n "$SERVER_ENDPOINT" ]   || die "缺 SERVER_ENDPOINT（形如 <对方公网地址>:<端口>）。同上，三个值一起给。"

  # 形状自检：公钥是 44 字符 base64 且以 = 结尾。粘错窗口/漏字时这里就拦下，
  # 而不是等到隧道起不来再回头查（那时症状是「无响应」，最难定位的一种）。
  case "$SERVER_PUBKEY" in
    *[!A-Za-z0-9+/=]*) die "SERVER_PUBKEY 含非 base64 字符，八成是粘贴时带进了空格或引号" ;;
  esac
  [ ${#SERVER_PUBKEY} -eq 44 ] || die "SERVER_PUBKEY 长度是 ${#SERVER_PUBKEY}，应为 44 —— 粘漏了？"

  mkdir -p "$WG_DIR" "$TOKEN_DIR"
  chmod 700 "$WG_DIR" "$TOKEN_DIR"

  if [ -f "$WG_CONF" ] && [ "${FORCE:-}" != "1" ]; then
    die "$WG_CONF 已存在。确要重写：FORCE=1 SERVER_PUBKEY=… GUEST_TOKEN=… ./setup.sh configure"
  fi

  ( umask 077; cat > "$WG_CONF" <<EOF
# NVY 美股 K 线访客通道。由 setup.sh 生成，不要手改。
[Interface]
PrivateKey = $(cat "$WG_DIR/wg2.key")
Address = $GUEST_ADDR
# 不设 DNS：本隧道只用来访问一个固定 IP，不接管你的解析。

[Peer]
PublicKey = $SERVER_PUBKEY
Endpoint = $SERVER_ENDPOINT
# 🚨 只路由这一个地址。写成 0.0.0.0/0 会把你整机流量都灌进这条隧道
# （连日常上网都走对方服务器），既慢又没必要 —— 你需要的只有那一个服务。
AllowedIPs = $SERVER_VIP/32
# 家宽/移动网络多在 NAT 后，25s 心跳维持映射，否则隧道会「看着通、实际收不到包」。
PersistentKeepalive = 25
EOF
  )
  chmod 600 "$WG_CONF"

  ( umask 077; printf '%s' "$GUEST_TOKEN" > "$TOKEN_FILE" )
  chmod 600 "$TOKEN_FILE"

  # 自证没漏填 —— 必须无输出（同 77 侧 runbook 的那条纪律）。
  if grep -qE '__FILL_|^[A-Za-z]+ *= *$' "$WG_CONF"; then
    die "$WG_CONF 里有未填/空值的字段，拒绝交付。内容已保留，请检查后重跑。"
  fi

  ok "已落 $WG_CONF ($(perm_of "$WG_CONF"))"
  ok "已落 $TOKEN_FILE ($(perm_of "$TOKEN_FILE"))"
  printf '\n下一步 🙋 需要你本人在终端里执行（需要 sudo 密码，模型不要代跑）：\n'
  printf '   sudo wg-quick up %s\n' "$WG_CONF"
  printf '然后回来跑：./setup.sh check\n'
}

perm_of() {
  case "$(uname -s)" in
    Darwin) stat -f '%Lp' "$1" ;;
    *)      stat -c '%a'  "$1" ;;
  esac
}

cmd_check() {
  need_bin curl
  # 变量放句末：裸变量后紧跟全角字符（这里原本是「。」）在 CJK locale 下会被 bash
  # 吞进变量名 → `set -u` 炸。本脚本跑在访客机器上，locale 不可控，一律避开该形态。
  [ -f "$TOKEN_FILE" ] || die "找不到 token 文件，先跑 ./setup.sh configure —— 期望路径 $TOKEN_FILE"

  # 🚨 判连通一律用 /healthz，不要用 `wg show`：macOS 上接口真名是 utun<N> 不是 wg2，
  #    且 wg show 需要 sudo ⇒ 不带 sudo 必然误报「隧道没起」。也别用 ping（只放 8811）。
  # ⚠️ 别写成 `... || echo 000`：curl 在连不上时**自己就会输出 `000`**，再补一个
  #    就成了 `000000`，匹配不上下面的 `000)` 分支 → 掉进兜底，把「隧道没起」误报成
  #    「对方没给你开通」。访客会照着去骚扰对方，而他其实只需要起隧道。
  #    （2026-08-04 组包自测实撞，此注释是那次的产物。）
  local st
  st="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $(cat "$TOKEN_FILE")" "$BASE/healthz" 2>/dev/null)" || st="000"

  case "$st" in
    200) ok "通路 OK（$BASE/healthz → 200）"; printf '\n下一步：./setup.sh install-skill\n' ;;
    000) die "隧道没起（无响应）。🙋 让**用户本人**跑：sudo wg-quick up $WG_CONF" ;;
    401) die "token 不对（401）。找对方核对 GUEST_TOKEN，不要重试。" ;;
    *)   die "得到 HTTP $st —— 多半是对方那侧还没给你开通。联系对方，不要重试。" ;;
  esac
}

cmd_install_skill() {
  need_bin openclaw
  [ -f "$SELF_DIR/openclaw-skill/SKILL.md" ] || die "包不完整：缺 openclaw-skill/SKILL.md"

  # 🚨 只走 `skills install`，不要手工拷进 ~/.openclaw/plugin-skills/ —— 那个目录是
  #    OpenClaw 独占的，手放的东西会被覆盖。用户 skill 的正确落点是 workspace/skills，
  #    由本命令管理。
  # 已装时 install 会拒绝覆盖 ⇒ 重跑用 FORCE=1（升级 skill 走的也是这条）。
  if [ "${FORCE:-}" = "1" ]; then
    openclaw skills install "$SELF_DIR/openclaw-skill" --as nvy-futu-kline --force
  else
    openclaw skills install "$SELF_DIR/openclaw-skill" --as nvy-futu-kline
  fi

  ok "已装 skill。自证："
  printf '   openclaw skills info nvy-futu-kline\n'
  printf '   期望：✓ Ready · Visible to model: yes · 依赖 curl / wg 均 ✓\n'
}

case "${1:-}" in
  keygen)        cmd_keygen ;;
  configure)     cmd_configure ;;
  check)         cmd_check ;;
  install-skill) cmd_install_skill ;;
  *)
    cat >&2 <<'USAGE'
用法：./setup.sh <子命令>

  keygen         生成密钥对 → 打印公钥（发回给对方）
  configure      SERVER_PUBKEY=… GUEST_TOKEN=… ./setup.sh configure
  check          验通路（/healthz）
  install-skill  装 OpenClaw skill

完整步骤见同目录 README.md。
USAGE
    exit 2 ;;
esac
