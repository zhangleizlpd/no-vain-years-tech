import { Stack } from 'expo-router';

// Anchor the (app) stack to (tabs) so a hard browser refresh / deep-link into a
// nested route (e.g. /settings) synthesizes (tabs) as the stack root underneath.
// Without this, Expo Router web rebuilds the stack from the URL alone — /settings
// lands with nothing beneath it, navigation.canGoBack() is false, and the default
// header renders no back button. With the anchor the stack genuinely holds
// [(tabs), settings] on refresh, so the back arrow works off real stack state
// (not the web-unreliable canGoBack heuristic). Only applied on deep-link/refresh;
// in-app router.push from the tabs is unaffected (tabs already in the stack).
// Routes are synchronous (app.json has no asyncRoutes) so the unstable_settings
// async-route caveat does not apply here.
export const unstable_settings = {
  initialRouteName: '(tabs)',
};

export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
