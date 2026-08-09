import { ThermometerScreen } from '~/optionsdesk';

// 波动温度计 P7（二级页；雷达题头 🌡 / 标的详情「全景 ›」进入）。薄 route —— 屏体在
// ~/optionsdesk（per fe-directory-structure，app/ 下任何 .tsx 都被当 route）。
// 整栈的 markets 门控在 optionsdesk/_layout（公开版深链直达被重定向，FR-022）。
export default function OptionsdeskThermometerScreen() {
  return <ThermometerScreen />;
}
