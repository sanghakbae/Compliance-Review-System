import { initializeApp, getApps, getApp } from "firebase/app";
import type { FirebaseApp } from "firebase/app";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";
import type { Auth } from "firebase/auth";
import { getAnalytics, isSupported as analyticsIsSupported } from "firebase/analytics";
import type { Analytics } from "firebase/analytics";

// Firebase web config values are public client identifiers (not secrets), but we
// still read them from VITE_ env vars to mirror the existing Supabase convention.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let analyticsInstance: Analytics | null = null;
let persistenceConfigured = false;

export function hasFirebaseEnv(): boolean {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.appId,
  );
}

export function getFirebaseApp(): FirebaseApp {
  if (firebaseApp) {
    return firebaseApp;
  }

  if (!hasFirebaseEnv()) {
    throw new Error(
      "Missing Firebase environment. Set VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID, and VITE_FIREBASE_APP_ID.",
    );
  }

  firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  return firebaseApp;
}

export function getFirebaseAuth(): Auth {
  if (firebaseAuth) {
    return firebaseAuth;
  }

  firebaseAuth = getAuth(getFirebaseApp());

  if (!persistenceConfigured) {
    persistenceConfigured = true;
    // Keep the user signed in across reloads, matching Supabase's persistSession.
    void setPersistence(firebaseAuth, browserLocalPersistence).catch(() => undefined);
  }

  return firebaseAuth;
}

// Analytics is browser-only and may be unsupported (SSR, some privacy modes).
// Initialize lazily and never throw on failure.
export async function initFirebaseAnalytics(): Promise<Analytics | null> {
  if (analyticsInstance) {
    return analyticsInstance;
  }

  if (typeof window === "undefined" || !firebaseConfig.measurementId) {
    return null;
  }

  try {
    if (await analyticsIsSupported()) {
      analyticsInstance = getAnalytics(getFirebaseApp());
    }
  } catch {
    analyticsInstance = null;
  }

  return analyticsInstance;
}
