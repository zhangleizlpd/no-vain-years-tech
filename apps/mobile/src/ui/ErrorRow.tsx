import { Text, View } from 'react-native';

export interface ErrorRowProps {
  text: string;
}

export function ErrorRow({ text }: ErrorRowProps) {
  return (
    <View
      className="flex-row items-center gap-1.5 mt-1.5"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View className="w-3.5 h-3.5 rounded-full bg-err items-center justify-center">
        <Text className="text-white text-[10px] font-bold leading-none">!</Text>
      </View>
      <Text className="text-xs text-err">{text}</Text>
    </View>
  );
}
