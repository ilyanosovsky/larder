import styles from "./placeholder-screen.module.css";

/** Centered muted placeholder used by screens not built yet (task 0.5 scaffolding). */
export function PlaceholderScreen({ message }: { message: string }) {
  return (
    <div className={styles.placeholder}>
      <p>{message}</p>
    </div>
  );
}
