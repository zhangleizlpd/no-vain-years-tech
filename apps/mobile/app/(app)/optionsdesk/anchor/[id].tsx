import { useLocalSearchParams } from 'expo-router';

import { AnchorFormScreen } from '~/optionsdesk';

// 编辑锚表单（锚列表行点击 / EC-7「去编辑既有锚」进入）。薄 route —— 屏体在 ~/optionsdesk。
export default function OptionsdeskAnchorEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AnchorFormScreen anchorId={id} />;
}
