// 中央 + FAB 占位路由（FR-001 配套）：底部 tab 栏的「中央空槽」需要一个真实 route 撑起
// flex 槽位（expo-router 里每个 (tabs) 文件 = 一个 tab）。本路由本身永不展示——它的
// tabBarButton 是非交互空 View（见 (tabs)/_layout.tsx），中央点击交给 root 层绿色 + FAB
// 打开 CreateOverlay。故此组件渲染 null；即便直接 deep-link 落此也只是空屏（不可达路径）。
export default function FabSpacerRoute() {
  return null;
}
