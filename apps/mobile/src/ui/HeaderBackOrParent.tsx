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
// That same anchor makes `canGoBack` true on a deep link (e.g. /optionsdesk/thermometer),
// so back alone would pop to the synthesized (tabs) = the home tab, not the parent.
// Discriminator (probed on web): an ancestor container route entered by an in-app
// push/navigate carries `params.screen`; one rebuilt from the URL never does ⇒ no
// `params.screen` on the route back would pop = deep link ⇒ replace to parent instead.
//
// Factory injects the parent href per screen; pass the route one level up.
import { HeaderBackButton } from '@react-navigation/elements';
import { router, useNavigation, type Href } from 'expo-router';

// Props native-stack passes to a headerLeft render prop at runtime. The elements
// package's exported HeaderBackButtonProps omits `canGoBack`, so type it locally.
interface HeaderLeftRenderProps {
  tintColor?: string;
  canGoBack?: boolean;
  label?: string;
}

// Structural slice of the navigation object the walk below reads.
interface NavigatorLike {
  getState(): { type: string; index: number; routes: { params?: object }[] } | undefined;
  getParent(): NavigatorLike | undefined;
}

// Walk up from the screen's own navigator to the first one that could handle back.
// Own stack with history → a real page beneath; non-stack (tabs) → defer to canGoBack;
// ancestor stack with history → deep link iff the container it would pop lacks
// `params.screen`. O(d), d = navigator nesting depth.
function backPopsDeepLinkedContainer(navigation: NavigatorLike): boolean {
  let current: NavigatorLike | undefined = navigation;
  let isOwnNavigator = true;
  while (current) {
    const state = current.getState();
    if (state === undefined || state.type !== 'stack') return false;
    if (state.index > 0) {
      if (isOwnNavigator) return false;
      const popped = state.routes[state.index]?.params as { screen?: unknown } | undefined;
      return popped?.screen === undefined;
    }
    current = current.getParent();
    isOwnNavigator = false;
  }
  return false;
}

export function makeHeaderBackOrParent(parentHref: Href) {
  return function HeaderBackOrParent({ tintColor, label, canGoBack }: HeaderLeftRenderProps) {
    const navigation = useNavigation() as unknown as NavigatorLike;
    return (
      <HeaderBackButton
        tintColor={tintColor}
        label={label}
        onPress={() => {
          // Prefer React Navigation's per-navigator flag (reliable in headerLeft
          // render props); fall back to the global router probe only if absent.
          if ((canGoBack ?? router.canGoBack()) && !backPopsDeepLinkedContainer(navigation)) {
            router.back();
          } else {
            router.replace(parentHref);
          }
        }}
      />
    );
  };
}
