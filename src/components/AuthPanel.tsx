import { useState } from "react";
import {
  signInWithGoogle,
  signOutUser,
  clearFirebaseAuthArtifacts,
  normalizeFirebaseAuthError,
  type AppAuthSession,
} from "../lib/firebaseAuth";

interface AuthPanelProps {
  session: AppAuthSession | null;
  allowedDomain?: string | null;
}

export function AuthPanel({ session, allowedDomain = null }: AuthPanelProps) {
  const [message, setMessage] = useState(
    allowedDomain
      ? `Google OAuth 로그인을 사용합니다. 허용 도메인: ${allowedDomain}`
      : "Google OAuth 로그인을 사용합니다.",
  );
  const accountEmail = session?.user.email ?? "Google OAuth";
  const accountHint = session
    ? "현재 로그인된 계정입니다."
    : "로그인 시 사용될 외부 인증 계정입니다.";

  async function handleGoogleSignIn() {
    try {
      await signInWithGoogle(allowedDomain);
      setMessage("Google 로그인이 완료되었습니다.");
    } catch (error) {
      setMessage(
        normalizeFirebaseAuthError(error instanceof Error ? error.message : undefined),
      );
    }
  }

  async function handleSignOut() {
    try {
      await signOutUser();
      clearFirebaseAuthArtifacts();
      setMessage("로그아웃되었습니다.");
    } catch (error) {
      setMessage(
        normalizeFirebaseAuthError(error instanceof Error ? error.message : undefined),
      );
    }
  }

  return (
    <section className="auth-panel">
      <div className="auth-panel-brand">
        <span className="auth-panel-brand-mark">CR</span>
        <span className="auth-panel-brand-text">Compliance Review System</span>
      </div>

      <div className="section-header auth-panel-header">
        <h2>준거성 검토 시스템</h2>
        <p>Google 계정으로 로그인합니다.</p>
      </div>

      <div className="stack auth-panel-stack">
        <div className="info-card auth-method-card">
          <span className="muted-label">로그인 방식</span>
          <strong>{accountEmail}</strong>
          <p className="helper-text">{accountHint}</p>
        </div>

        {session ? (
          <div className="auth-action-group">
            <button className="button secondary auth-primary-button" onClick={handleSignOut}>
              로그아웃
            </button>
          </div>
        ) : (
          <div className="auth-action-group">
            <button className="button auth-google-button" onClick={handleGoogleSignIn}>
              <span className="auth-google-button-copy">
                <span className="auth-google-button-label">선택 계정 사용</span>
                <span className="auth-google-button-email">Google OAuth</span>
              </span>
              <span className="auth-google-button-icon" aria-hidden="true">
                G
              </span>
            </button>
          </div>
        )}
      </div>

      <p className="helper-text auth-panel-message">{message}</p>
    </section>
  );
}
