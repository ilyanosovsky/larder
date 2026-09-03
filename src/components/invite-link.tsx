"use client";

import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

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
 *
 * **The copy confirmation has its own permanently-mounted, keyed sr-only
 * `role="status"` region** (review round 2, G3) — the same shape
 * `cart-screen.tsx`'s toast uses, and for the same reason: the visible
 * change is only the button's own accessible name («Скопировать» →
 * «Скопировано»), and a name change on the element that already holds
 * focus is not reliably announced across screen readers. `copied` is a
 * sequence number, not a boolean — the same link can be copied more than
 * once in a row, and a live region only re-announces on an actual node
 * change, not an identical text update (see the comment `cart-screen.tsx`
 * carries on the same pattern).
 */
export function InviteLink({ url }: { url: string }) {
  const t = useTranslations("inviteLink");
  const fieldId = useId();
  const copySeq = useRef(0);
  const [copied, setCopied] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy() {
    setCopyFailed(false);
    // A later attempt on the same mounted instance can fail after an
    // earlier one succeeded (a permission revoked mid-session, say) — clear
    // the success state too, so «Скопировано» never sits on the button next
    // to the failure alert it should have replaced.
    setCopied(null);

    try {
      await navigator.clipboard.writeText(url);
      copySeq.current += 1;
      setCopied(copySeq.current);
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
        {copied === null ? t("copy") : t("copied")}
      </button>
      {copyFailed ? (
        <p className={styles.error} role="alert">
          {t("copyFailed")}
        </p>
      ) : null}

      {/* Mounted for the component's whole life, with a keyed child, so a
          second copy of the same link still registers as a fresh mutation
          inside the live region instead of an identical, silently-skipped
          text update. */}
      <p className={styles.srOnly} role="status">
        <span key={copied ?? "empty"}>
          {copied === null ? "" : t("copied")}
        </span>
      </p>
    </div>
  );
}
