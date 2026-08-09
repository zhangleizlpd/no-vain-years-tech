import { AnchorListScreen } from '~/optionsdesk';

// 锚管理列表（二级页，雷达题头 ⚙ 进入）。薄 route —— 屏体在 ~/optionsdesk
// （per fe-directory-structure，app/ 下任何 .tsx 都被当 route）。
// 整栈的 markets 门控在 optionsdesk/_layout（公开版深链直达被重定向）。
export default function OptionsdeskAnchorsScreen() {
  return <AnchorListScreen />;
}
