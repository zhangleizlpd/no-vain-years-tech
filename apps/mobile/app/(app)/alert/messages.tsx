import { MessageCenterScreen } from '~/alert';

// 消息通知路由（021 屏 6）。入口：013 工具栏信封 + unread 红点（T021）。
// 屏体在 ~/alert（per fe-directory-structure：app/ 仅薄 route）。
export default function MessagesRoute() {
  return <MessageCenterScreen />;
}
