import { type ComponentProps } from 'react';
import { SafeAreaView as RNSafeAreaView } from 'react-native-safe-area-context';

export type SafeAreaViewProps = ComponentProps<typeof RNSafeAreaView>;

// Thin pass-through over react-native-safe-area-context's SafeAreaView
// (legacy onboarding convention; built-in RN SafeAreaView is deprecated since 0.65).
export function SafeAreaView(props: SafeAreaViewProps) {
  return <RNSafeAreaView {...props} />;
}
