// Header back button that survives a web hard-refresh / deep-link.
//
// On a normal in-app push the navigation stack has history → router.back() pops
// as usual. But on a browser refresh Expo Router rebuilds the stack from the URL
// alone, so a nested screen lands with nothing beneath it — router.back() would
// dead-end and the default header renders no back arrow at all. This headerLeft
// always renders the native chevron and, when there is no history, router.replace()s
// to the parent route instead of dead-ending.
//
// Complements the (app) layout's `unstable_settings` anchor (which restores the
// default arrow for the common /settings refresh by synthesizing (tabs) beneath):
// this is the belt for nested-route refreshes where web canGoBack is unreliable
// (expo/expo#30977) and no per-level anchor exists.
//
// Factory injects the parent href per screen; pass the route one level up.
import { HeaderBackButton } from '@react-navigation/elements';
import { router, type Href } from 'expo-router';

// Props native-stack passes to a headerLeft render prop at runtime. The elements
// package's exported HeaderBackButtonProps omits `canGoBack`, so type it locally.
interface HeaderLeftRenderProps {
  tintColor?: string;
  canGoBack?: boolean;
  label?: string;
}

export function makeHeaderBackOrParent(parentHref: Href) {
  return function HeaderBackOrParent({ tintColor, label, canGoBack }: HeaderLeftRenderProps) {
    return (
      <HeaderBackButton
        tintColor={tintColor}
        label={label}
        onPress={() => {
          // Prefer React Navigation's per-navigator flag (reliable in headerLeft
          // render props); fall back to the global router probe only if absent.
          if (canGoBack ?? router.canGoBack()) {
            router.back();
          } else {
            router.replace(parentHref);
          }
        }}
      />
    );
  };
}
