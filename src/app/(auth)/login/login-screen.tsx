"use client";

import { useTranslations } from "next-intl";
import { useId, useState, type FormEvent } from "react";

import { authClient } from "@/lib/auth-client";
import { HOME_PATH } from "@/lib/auth-redirect";

import styles from "./login-screen.module.css";

type Pending = "google" | "email" | null;

export function LoginScreen() {
  const t = useTranslations("auth");
  const emailFieldId = useId();

  const [email, setEmail] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);

  const busy = pending !== null;

  async function signInWithGoogle() {
    setFailed(false);
    setPending("google");

    try {
      const { error } = await authClient.signIn.social({
        provider: "google",
        callbackURL: HOME_PATH,
      });

      if (error) {
        setFailed(true);
        setPending(null);
        return;
      }
      // On success the client redirects to Google; keep the button disabled
      // until the navigation happens.
    } catch {
      setFailed(true);
      setPending(null);
    }
  }

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailed(false);
    setPending("email");

    try {
      const { error } = await authClient.signIn.magicLink({
        email,
        callbackURL: HOME_PATH,
      });

      if (error) {
        setFailed(true);
      } else {
        setSent(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  }

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.wordmark}>{t("wordmark")}</h1>
        <p className={styles.tagline}>{t("tagline")}</p>

        {sent ? (
          <div className={styles.sent} role="status">
            <p className={styles.sentTitle}>{t("emailSentTitle")}</p>
            <p className={styles.sentHint}>{t("emailSentHint")}</p>
          </div>
        ) : (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={signInWithGoogle}
              disabled={busy}
            >
              {pending === "google"
                ? t("googleSignInPending")
                : t("googleSignIn")}
            </button>

            {/* Decorative rule between the two sign-in methods. */}
            <div className={styles.divider} aria-hidden="true">
              <span>{t("or")}</span>
            </div>

            <form className={styles.form} onSubmit={sendMagicLink}>
              <label className={styles.label} htmlFor={emailFieldId}>
                {t("emailLabel")}
              </label>
              <input
                id={emailFieldId}
                className={styles.input}
                type="email"
                name="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t("emailPlaceholder")}
                autoComplete="email"
                inputMode="email"
                required
                disabled={busy}
              />
              <button
                type="submit"
                className={styles.secondaryButton}
                disabled={busy}
              >
                {pending === "email"
                  ? t("emailSignInPending")
                  : t("emailSignIn")}
              </button>
            </form>
          </div>
        )}

        {failed ? (
          <p className={styles.error} role="alert">
            {t("error")}
          </p>
        ) : null}
      </div>
    </main>
  );
}
