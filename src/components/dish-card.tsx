"use client";

import Link from "next/link";
import { useState } from "react";

import styles from "./dish-card.module.css";

/**
 * One tile in the S6 grid (DESIGN_BRIEF §3 DishCard): photo, title, and a
 * meta line of «{время} · {порции} · {теги}».
 *
 * Presentational on purpose — every string arrives already translated, so the
 * card never reaches for `useTranslations` and the screen keeps one place
 * where the meta line is composed.
 *
 * **The photo is a plain `<img>`, deliberately, not `next/image`.** Dish
 * photos come from UploadThing and from imported pages, so `next/image` would
 * need a `remotePatterns` entry per host we have never seen, and every tile
 * would burn Vercel's image-optimization quota for a picture the client
 * already compressed to ~300 KB on the way up (task 4.3). Fixed aspect ratio
 * in CSS keeps the grid from reflowing while it loads; `referrerPolicy` keeps
 * a third-party host from learning which of our pages is showing it.
 *
 * A missing photo — or one that fails to load — falls back to the same
 * hatched placeholder the design uses, rather than an empty frame that looks
 * like a bug.
 */
export function DishCard({
  href,
  title,
  photoUrl,
  photoAlt,
  meta,
  needsReviewLabel,
}: {
  href: string;
  title: string;
  photoUrl: string | null;
  photoAlt: string;
  /** «30 мин · 8 порций · выпечка, духовка», composed by the screen. */
  meta: string;
  /**
   * The accessible name of the quiet amber dot, or `null` when nothing on
   * this dish needs review. The dot is the only way an abandoned import is
   * ever found again, so it carries a real label rather than being decorative.
   */
  needsReviewLabel: string | null;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const showPhoto = photoUrl !== null && !photoFailed;

  return (
    <Link href={href} className={styles.card}>
      <div className={styles.frame}>
        {showPhoto ? (
          /* Arbitrary remote hosts and no optimization budget — the doc
             comment above spells out why `next/image` is the wrong tool here. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={styles.photo}
            src={photoUrl}
            alt={photoAlt}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setPhotoFailed(true)}
          />
        ) : (
          <span className={styles.placeholder} aria-hidden="true">
            🍽
          </span>
        )}
        {needsReviewLabel === null ? null : (
          <span className={styles.dot} title={needsReviewLabel}>
            <span className={styles.srOnly}>{needsReviewLabel}</span>
          </span>
        )}
      </div>
      <div className={styles.body}>
        <span className={styles.title}>{title}</span>
        {meta.length === 0 ? null : <span className={styles.meta}>{meta}</span>}
      </div>
    </Link>
  );
}
