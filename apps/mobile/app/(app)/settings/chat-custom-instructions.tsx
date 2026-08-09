// Expo Router route for the chat custom-instruction editor (031 D8). The screen
// component lives in the chat feature domain (~/chat); this route file is a thin
// re-export so navigation registers under the settings shell (entry row in
// settings/index → push here) while data + behavior stay chat-owned.
export { default } from '~/chat/custom-instruction-screen';
