// 首页第一个 tab = AI 对话主干（027 FR-001）。屏组件全在 ~/chat（翻 mockup 5 状态）；
// 本文件仅 route 入口，零业务逻辑（per fe-directory-structure：app/ 路由薄、src/ 承载实现）。
import { ChatHomeScreen } from '~/chat';

export default function HomeTab() {
  return <ChatHomeScreen />;
}
