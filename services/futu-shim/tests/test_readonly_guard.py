"""只读 AST 守卫（082 T003，FR-004）。

shim 的交易面**只查不下单**：`src/**/*.py` 里任一 `ast.Attribute.attr` 或 `ast.Name.id` 落在
`FORBIDDEN`（下单 / 改单 / 撤单 / 解锁交易）即红，失败信息列出文件与行号。按调用名而不是按 import
判 —— SDK 方法经 context 对象调用（`ctx.place_order(...)`），根本不需要 import 那个名字。
（`trade.TradeSupervisor.call` 收可调用对象而不收方法名字符串，就是为了让调用点对本守卫可见。）

sabotage 臂（2026-09-14，testing.md §7.1 第二形态）：
  临时在 `src/futu_shim/trade.py` 末尾加一行 `ctx.place_order`
  → 本文件红（rc=1）：`test_src_contains_no_order_placing_or_unlocking_calls` 报
    `Left contains one more item: 'futu_shim/trade.py:260 place_order'`
  → 还原（文件哈希比对一致）→ 本文件绿（rc=0），shim 全量 pytest 绿。
复跑：services/futu-shim/venv/bin/python -m pytest -q services/futu-shim/tests/test_readonly_guard.py
"""

import ast
from pathlib import Path

SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
FORBIDDEN = frozenset(
    {"unlock_trade", "place_order", "modify_order", "place_combo_order", "cancel_all_order"}
)


def _violations(root: Path) -> list[str]:
    hits: list[str] = []
    for path in sorted(root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute):
                name = node.attr
            elif isinstance(node, ast.Name):
                name = node.id
            else:
                continue
            if name in FORBIDDEN:
                hits.append(f"{path.relative_to(root).as_posix()}:{node.lineno} {name}")
    return hits


def test_src_contains_no_order_placing_or_unlocking_calls():
    assert list(SRC_ROOT.rglob("*.py")), f"守卫在 {SRC_ROOT} 下没扫到任何源文件 —— 路径错了时断言恒真"
    assert _violations(SRC_ROOT) == []


def test_guard_sees_both_the_attribute_and_the_bare_name_form(tmp_path):
    """对照臂：守卫本身两种写法都看得见，防它被改成只看一种而恒绿。"""
    package = tmp_path / "pkg"
    package.mkdir()
    (package / "bad.py").write_text("ctx.place_order(1)\nunlock_trade()\n", encoding="utf-8")
    assert _violations(tmp_path) == ["pkg/bad.py:1 place_order", "pkg/bad.py:2 unlock_trade"]
