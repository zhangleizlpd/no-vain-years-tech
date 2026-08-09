// 030 T014 — 联网检索中间态 + 编号来源列表 + 降级标识（翻 spec FR-004/005/009）。
//
// 三件展示物（assistant 气泡周边，态由 chat-reducer 驱动、use-chat 透出）：
//   ① SearchProgress —— 检索阶段「已阅读 N 个网页」中间态（FR-004，N=累计原始页数 F3）。
//      answer token 一开始即清（reducer token handler 置 searchProgress=null），故由屏级
//      在 streaming 且 searchProgress!=null 时渲染。
//   ② WebSearchSources —— 答案下方编号来源列表（FR-005/006/007）。「N 个网页来源 ›」可折叠头
//      （N=去重后来源数），展开后编号行 tap → expo-web-browser in-app 打开（http(s) 校验防注入）。
//   ③ DegradedNotice —— 检索失败降级标识「本次未联网，基于已有知识作答」（FR-009）。
//
// 🚨 URL scheme 校验（防注入，FR-005）：仅 http/https 放行，拒 javascript:/file:/data: 等。
// 校验抽成纯函数 isSafeHttpUrl（vitest 覆盖），渲染端 tap 前过一道；非法 url 不打开（no-op）。
//
// 开关 tap 驱动（折叠头 tap 展开/收起，per RNGH web 手势非确定 memory）；每交互元素带
// testID/a11y label 供 T015 e2e 驱动。复用 ~/theme + ~/ui（0 新 token）。
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import * as WebBrowser from 'expo-web-browser';

import { colors } from '~/theme';
import { CHAT_COPY } from './chat-copy';
import { isSafeHttpUrl } from './web-search-url';
import type { NumberedSource } from './sse-parse';

// ─────────────────────── ① 检索中间态「已阅读 N 个网页」（FR-004） ───────────────────────

/** 检索阶段中间态。屏级在 streaming 且 searchProgress!=null 时渲染（answer 开始即被清）。 */
export function SearchProgress({ count }: { count: number }) {
  return (
    <View
      className="flex-row items-center gap-2 self-start rounded-full bg-brand-soft px-3 py-1.5"
      testID="chat-search-progress"
    >
      <GlobeIcon />
      <Text className="text-sm text-brand-500" testID="chat-search-progress-text">
        {`${CHAT_COPY.searchProgressPrefix}${count}${CHAT_COPY.searchProgressSuffix}`}
      </Text>
    </View>
  );
}

// ─────────────────────── ② 编号来源列表（FR-005/006/007，可折叠） ───────────────────────

/** 答案下方来源区：「N 个网页来源 ›」可折叠头 + 展开编号行（tap in-app 打开）。 */
export function WebSearchSources({ sources }: { sources: NumberedSource[] }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((e) => !e), []);

  const openSource = useCallback((url: string) => {
    // 🚨 http(s) 校验防注入：非法 scheme（javascript:/file: 等）静默不打开。
    if (!isSafeHttpUrl(url)) return;
    void WebBrowser.openBrowserAsync(url);
  }, []);

  if (sources.length === 0) return null;

  return (
    <View className="gap-1.5" testID="chat-sources">
      {/* 折叠头：tap 展开/收起。N = 去重后来源数（与中间态原始页数 F3 不同）。 */}
      <Pressable
        className="flex-row items-center gap-1 self-start"
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${sources.length}${CHAT_COPY.sourcesHeaderSuffix}`}
        testID="chat-sources-toggle"
      >
        <GlobeIcon small />
        <Text className="text-xs text-ink-muted">
          {`${sources.length}${CHAT_COPY.sourcesHeaderSuffix}`}
        </Text>
        <ChevronIcon expanded={expanded} />
      </Pressable>

      {expanded ? (
        <View className="gap-1 pl-0.5" testID="chat-sources-list">
          {sources.map((s) => (
            <Pressable
              key={s.index}
              className="flex-row items-start gap-1.5 py-1"
              onPress={() => openSource(s.url)}
              accessibilityRole="link"
              accessibilityLabel={s.title}
              testID={`chat-source-${s.index}`}
            >
              <Text className="text-xs font-medium text-brand-500">{`[${s.index}]`}</Text>
              <Text className="flex-1 text-xs text-ink-muted" numberOfLines={2}>
                {s.title}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ─────────────────────── ③ 降级标识「本次未联网」（FR-009） ───────────────────────

/** 检索失败降级标识。挂在 assistant 气泡（message.degraded）下方。 */
export function DegradedNotice() {
  return (
    <View
      className="flex-row items-center gap-1.5 self-start rounded-md bg-warn-soft px-2.5 py-1"
      testID="chat-degraded-notice"
    >
      <View className="h-1.5 w-1.5 rounded-full bg-warn" />
      <Text className="text-xs text-ink-muted">{CHAT_COPY.degradedNotice}</Text>
    </View>
  );
}

// ─────────────────────────── icons（屏内一次性，不抽 ~/ui） ───────────────────────────

function GlobeIcon({ small }: { small?: boolean }) {
  const size = small ? 13 : 15;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={small ? colors.ink.muted : colors.brand[500]}
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
      <Path d="M3 12h18" />
      <Path d="M12 3c2.5 2.5 3.5 5.7 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.7-3.5-9s1-6.5 3.5-9Z" />
    </Svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <Svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.ink.subtle}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
    >
      <Path d="M9 6l6 6-6 6" />
    </Svg>
  );
}
