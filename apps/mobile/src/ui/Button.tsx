import { Pressable, Text } from 'react-native';
import { Spinner } from './Spinner';

export interface ButtonProps {
  label: string;
  loading?: boolean;
  /** disabled when form is invalid or during loading — bg-brand-300, no press response */
  disabled?: boolean;
  onPress?: () => void;
}

export function Button({ label, loading, disabled, onPress }: ButtonProps) {
  const inactive = !!loading || !!disabled;
  return (
    <Pressable
      disabled={inactive}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: !!loading }}
      accessibilityLabel={label}
      className={`h-12 rounded-full items-center justify-center flex-row gap-2.5 shadow-cta ${
        inactive ? 'bg-brand-300' : 'bg-brand-500 active:bg-brand-600'
      }`}
    >
      {loading ? <Spinner size={15} tone="white" /> : null}
      <Text className="text-base font-medium text-white">{label}</Text>
    </Pressable>
  );
}
