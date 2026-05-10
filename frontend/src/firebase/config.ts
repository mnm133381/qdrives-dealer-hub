/**
 * Firebase project configuration extracted from google-services.json.
 *
 * - Native (Android/iOS) builds DO NOT use this — they read the
 *   bundled google-services.json / GoogleService-Info.plist via the
 *   @react-native-firebase config plugin.
 * - Web preview builds use this object to initialise the Firebase JS
 *   SDK so phone auth works inside the browser preview too. The values
 *   are public client identifiers (Google explicitly states the
 *   `apiKey` is safe to ship) — no secret material here.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyDxcQHdrMgK0x9P5jtd2PHk2V4P9d368Lc',
  authDomain: 'autobid-platform.firebaseapp.com',
  projectId: 'autobid-platform',
  storageBucket: 'autobid-platform.firebasestorage.app',
  messagingSenderId: '4782680239',
  // The android appId works for phone auth + reCAPTCHA on web because
  // they share the same project. If a dedicated Web App is later
  // registered in Firebase Console, swap this to the web appId.
  appId: '1:4782680239:android:a5ecff343ed8f8c3350c5a',
};
