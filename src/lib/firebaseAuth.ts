import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  onIdTokenChanged,
} from "firebase/auth";
import type { User } from "firebase/auth";
import { getFirebaseAuth } from "./firebaseClient";

// Normalized session shape that mirrors the parts of a Supabase Session the app
// relies on (user.id, user.email, access_token). This lets the rest of the app
// swap auth providers with minimal churn.
export interface AppAuthUser {
  id: string;
  email: string | null;
}

export interface AppAuthSession {
  user: AppAuthUser;
  access_token: string;
}

export async function buildAppSession(user: User): Promise<AppAuthSession> {
  // Firebase ID token; mirrors Supabase access_token used to authorize the
  // backend (DB/RLS today, Cloudflare Workers after the backend migration).
  const access_token = await user.getIdToken();
  return {
    user: { id: user.uid, email: user.email },
    access_token,
  };
}

export async function getCurrentAppSession(): Promise<AppAuthSession | null> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) {
    return null;
  }
  return buildAppSession(user);
}

/** Force-refresh and return the current Firebase ID token, or null when signed out. */
export async function getFreshIdToken(): Promise<string | null> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) {
    return null;
  }
  return user.getIdToken(true);
}

export async function signInWithGoogle(allowedDomain?: string | null): Promise<void> {
  const auth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: "select_account",
    ...(allowedDomain ? { hd: allowedDomain } : {}),
  });
  await signInWithPopup(auth, provider);
}

export async function signOutUser(): Promise<void> {
  const auth = getFirebaseAuth();
  await signOut(auth);
}

/**
 * Subscribe to sign-in/sign-out transitions. The callback receives a normalized
 * session (or null). Returns an unsubscribe function. Mirrors
 * supabase.auth.onAuthStateChange.
 */
export function onAppAuthChange(
  callback: (session: AppAuthSession | null) => void | Promise<void>,
): () => void {
  const auth = getFirebaseAuth();
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      await callback(null);
      return;
    }
    await callback(await buildAppSession(user));
  });
}

/**
 * Subscribe to ID-token refreshes (token rotation, not just sign-in/out).
 * Useful for keeping cached access tokens fresh. Returns an unsubscribe function.
 */
export function onAppIdTokenChange(
  callback: (session: AppAuthSession | null) => void | Promise<void>,
): () => void {
  const auth = getFirebaseAuth();
  return onIdTokenChanged(auth, async (user) => {
    if (!user) {
      await callback(null);
      return;
    }
    await callback(await buildAppSession(user));
  });
}

export function clearFirebaseAuthArtifacts(): void {
  // Firebase stores its session in IndexedDB / localStorage under keys prefixed
  // with "firebase:". signOut() clears the active session; this is a hard reset
  // mirroring clearSupabaseAuthStorage for recovery paths.
  if (typeof window === "undefined") {
    return;
  }
  for (const storage of [window.localStorage, window.sessionStorage]) {
    const keysToRemove: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && key.startsWith("firebase:")) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => storage.removeItem(key));
  }
}

export function normalizeFirebaseAuthError(message?: string): string {
  if (!message) {
    return "인증 상태를 확인할 수 없습니다. 다시 로그인하세요.";
  }
  const lower = message.toLowerCase();
  if (lower.includes("popup-closed") || lower.includes("cancelled-popup")) {
    return "로그인 창이 닫혔습니다. 다시 시도하세요.";
  }
  if (lower.includes("popup-blocked")) {
    return "브라우저가 로그인 팝업을 차단했습니다. 팝업을 허용한 뒤 다시 시도하세요.";
  }
  if (lower.includes("network")) {
    return "네트워크 오류로 로그인하지 못했습니다. 연결을 확인하세요.";
  }
  return message;
}
