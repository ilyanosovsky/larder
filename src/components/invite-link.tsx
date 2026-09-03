"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import styles from "./invite-link.module.css";

/**
 * A minted invite link, read-only field + «Скопировать» (task 7.1a).
 *
 * Extracted out of `/onboarding`'s «Пригласи своих» step, which built this
 * exact field/copy pair inline — the Settings «Дом» section (task 7.1a)
 * needed the identical piece, and a second copy of the clipboard fallback
 * logic is exactly the kind of drift AGENTS.md's "reuse, don't duplicate"
 * rule exists to prevent. Onboarding's behaviour is unchanged: same field,
 * same button, same copy-failed hint.
 *
 * Deliberately **not** where «Поделиться» or the expiry line live — neither
 * existed on the onboarding step this was extracted from, so both stay with
 * each caller instead of growing this component a prop for something only
 * one of its two users needs.
 *
 * Keyed by the caller on `url` (`<InviteLink key={url} .../>`): a fresh link
 * needs a fresh "not yet copied" state, and remounting is simpler than a
 * `useEffect` that resets it by hand.
 */
export function InviteLink({ url }: { url: string }) {
  const t = useTranslations("inviteLink");
  const fieldId = useId();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy() {
    setCopyFailed(false);
    // A later attempt on the same mounted instance can fail after an
    // earlier one succeeded (a permission revoked mid-session, say) — reset
    // both flags so «Скопировано» never sits on the button next to the
    // failure alert it should have replaced.
    setCopied(false);

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard permission, or an insecure context — the link stays
      // visible and selectable, so this is a nudge rather than a failure.
      setCopyFailed(true);
    }
  }

  return (
    <div className={styles.block}>
      <label className={styles.label} htmlFor={fieldId}>
        {t("label")}
      </label>
      <input
        id={fieldId}
        className={styles.field}
        type="text"
        value={url}
        readOnly
        onFocus={(event) => event.target.select()}
      />
      <button
        type="button"
        className={styles.copyButton}
        onClick={() => void copy()}
      >
        {copied ? t("copied") : t("copy")}
      </button>
      {copyFailed ? (
        <p className={styles.error} role="alert">
          {t("copyFailed")}
        </p>
      ) : null}
    </div>
  );
}
