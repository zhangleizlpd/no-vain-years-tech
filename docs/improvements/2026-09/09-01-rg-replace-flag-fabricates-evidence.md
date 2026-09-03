# `rg -r` 是 `--replace`：一条静默改写取证输出的 flag

> 2026-09-01。起因：073 T016 的读侧穷尽扫描里，本人（Claude）把 `rg -rn` 当成「递归 + 行号」用，
> 输出里每一个匹配都被替换成字面量 `n` —— 差点据此认定仓里有个类叫 `nAdapter`、有一列叫 `"n"`。
> 同一 session 内、把这条写进个人 memory **一小时后又犯了第二次**（核 prod 的
> `MARKETDATA_TICK_ENABLED`，读到 `MARKETDATA_n=true`）。
> 本文记录复现、可见破绽与病根，是
> [`09-01-comment-provenance-probe.md`](09-01-comment-provenance-probe.md) §8「取证管道翻车」的**同属第五例**。

## 1. 复现（ripgrep 14.1.1）

```text
$ cat rgfix.txt
INSERT INTO "sync_dependency" ("upstream", "downstream", "mode")
export class EodBackedQuoteAdapter implements QuotePort {
MARKETDATA_TICK_ENABLED=true
```

```console
$ rg -rn 'upstream|downstream|EodBackedQuote|TICK_ENABLED' rgfix.txt
INSERT INTO "sync_dependency" ("n", "n", "mode")
export class nAdapter implements QuotePort {
MARKETDATA_n=true
exit=0

$ rg -n 'upstream|downstream|EodBackedQuote|TICK_ENABLED' rgfix.txt
1:INSERT INTO "sync_dependency" ("upstream", "downstream", "mode")
2:export class EodBackedQuoteAdapter implements QuotePort {
3:MARKETDATA_TICK_ENABLED=true
exit=0
```

`-r` 吃掉紧随其后的 `n` 当**替换串**，于是 `--replace n` 生效、`--line-number` 从未生效。

## 2. 三个变体的实测

| 命令                   | 输出                                             | 退出码 | 性质                    |
| ---------------------- | ------------------------------------------------ | ------ | ----------------------- |
| `rg -rn 'pat' <dir>`   | `path:MARKETDATA_n=true`（匹配被换、**无行号**） | **0**  | 🚨 静默改写，看起来正常 |
| `rg -nr 'pat' <dir>`   | 零输出（`<dir>` 被当成 pattern）                 | 1      | 失败可见                |
| `grep -rn 'pat' <dir>` | `path:3:MARKETDATA_TICK_ENABLED=true`            | 0      | 肌肉记忆的来源          |

顺序一换（`-nr`）反而**安全**：替换串吃掉了 pattern，路径成了 pattern，零命中 + 退出码 1，一眼能看出不对。
危险的恰恰是最顺手的那个写法。

## 3. 唯一可见的破绽是**行号消失**

第一次记录这条时我把破绽写反了 —— 记成「不报错、退出码 0、**行号与文件名全对**，只有匹配被改写」。
实测推翻：`-n` 被当成替换串吃掉 ⇒ 输出**根本没有行号**，只有 `path:content`。

⇒ 判据固化成一句可执行的：**看到 `rg` 输出只有 `path:` 没有 `path:line:`，先怀疑自己的 flag**。
这比「注意反常标识符」可靠 —— 后者依赖你恰好认得那个标识符本该长什么样。

## 4. 为什么它比「命令失败」重

替换串是单个字母，产出的东西**长得像标识符**：`nAdapter` / `("n", "n", "mode")` / `MARKETDATA_n=true`。
读的人（人或 agent）拿到的不是「命令坏了」的信号，而是一条**语法合理、可被引用的假观测值**。

与 [`comment-provenance.md`](../../conventions/comment-provenance.md) 的关系是直接的：那条约定把
「实测日期 + **观测值**」列为最强的一档出处，理由是「给出可复算的数比给一个日期更强」。
而本坑污染的**正是观测值本身** —— 出处形式完全合规，内容是伪造的。

同属的前四例（探针 §8）都是「反例存在但管道看不见」= **缺**；本例是「看见了一个不存在的东西」= **错**。
按该文 §6 的外部证据（错注释实质降低模型表现、缺失注释影响相对轻微），这一档更重。

## 5. 病根与固化

病根是 `grep -rn` 的肌肉记忆：**grep 需要 `-r` 才递归；rg 默认递归，于是把 `-r` 让给了 `--replace`**。
两次踩中都发生在「顺手核一个值」的低注意力时刻，不是复杂命令 —— 复杂命令反而会去查 `--help`。

- 🚫 **rg 永远别写 `-r`**。要递归：什么都不加。要行号：`-n` 单独写。
- 🚨 凡「命令输出要当证据引用」的场合，先看**有没有行号**；再看有没有反常的短标识符。
- 落回上一条纪律：**否定性/肯定性结论的仪器都要先过一次已知阳性** —— 本例里「已知阳性」
  就是随便挑一行你已经知道内容的文本，看它有没有被原样打出来。

📌 **第二次踩中的时刻值得单记**：它发生在把第一次的教训写进个人 memory **之后一小时**，
与探针 §9 测到的是同一件事 —— 起作用的是「落笔前那一刻手边有没有这条」，不是「记过没有」。
⇒ 本条的实际防线不是「记住」，而是上面那个**只看一眼输出格式**的判据。
