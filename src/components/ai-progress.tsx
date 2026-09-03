import styles from "./ai-progress.module.css";

/**
 * The «Разбираю рецепт…» state (DESIGN_BRIEF S8.2): a thumbnail of what is
 * being read, one line of what is happening, a moving rule, and — the part
 * that matters most — an honest estimate underneath it.
 *
 * **The estimate is the point.** A vision parse takes five to fifteen
 * seconds, which is long enough that a bare spinner reads as "stuck". Saying
 * «обычно 5–10 секунд» costs nothing and turns a wait into a wait with a
 * shape.
 *
 * **A determinate-looking bar would be a lie**, so the rule animates as a
 * travelling segment rather than filling toward a percentage nothing can
 * measure. Under `prefers-reduced-motion` it stops moving and simply sits
 * there — the text is the real status, and the CSS says so.
 *
 * `role="status"` on the whole block, mounted *with* its text: this component
 * appears as a result of a tap, so it is a new node in the accessibility tree
 * rather than a live region being written into, and screen readers announce
 * it on insertion. (The permanent-empty-region rule the forms follow is for
 * regions that outlive their messages; this one is the message.)
 */
export function AiProgress({
  label,
  hint,
  photoUrl,
  photoAlt,
}: {
  /** «Разбираю рецепт…» */
  label: string;
  /** «обычно 5–10 секунд» */
  hint?: string;
  /** The screenshot being read, when there is one. */
  photoUrl?: string | null;
  photoAlt?: string;
}) {
  return (
    <div className={styles.block} role="status">
      {photoUrl ? (
        // Not `next/image`: the file lives on UploadThing and the alternative
        // is a `remotePatterns` entry plus Vercel's optimization quota for a
        // thumbnail shown for ten seconds.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.photo}
          src={photoUrl}
          alt={photoAlt ?? ""}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      ) : null}

      <p className={styles.label}>{label}</p>

      <div className={styles.rule} aria-hidden="true">
        <span className={styles.fill} />
      </div>

      {hint === undefined ? null : <p className={styles.hint}>{hint}</p>}
    </div>
  );
}
