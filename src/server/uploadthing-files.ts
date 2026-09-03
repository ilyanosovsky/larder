import "server-only";

/**
 * Deleting blobs from the upload store (task 4.3).
 *
 * Its own module, and reached through the tRPC context rather than imported
 * directly by the router, for exactly the reason `ctx.openai` exists: a
 * procedure that talks to a paid third party has to be testable without one,
 * and a unit test that forgets to inject a fake must fail loudly instead of
 * quietly dialing out. `discardPhoto` used to call this directly, and the
 * whole deletion branch was therefore untestable — a test either reached the
 * network or (with the token unset) skipped the call entirely.
 */
export interface UploadedFileStore {
  /** Best-effort, never throws — see `deleteUploadedFiles`. */
  deleteFiles(fileKeys: readonly string[]): Promise<void>;
}

/**
 * The real store.
 *
 * The token is read **inside** the call and the SDK is imported lazily, for
 * the reason every other env reader in this codebase is lazy: `pnpm build`
 * runs with no environment at all. With no token there is no UploadThing to
 * talk to, so the call is skipped outright rather than attempted and failed.
 *
 * **It never throws**, and that is deliberate rather than lazy: an orphaned
 * blob is hygiene, not correctness (R5) — the `photo_uploads` row is already
 * gone by the time this runs, so the key can never be spent again, and
 * refusing to move on because a third-party delete failed would be a dead end
 * over nothing. Callers therefore do not wrap it.
 */
export const uploadedFileStore: UploadedFileStore = {
  async deleteFiles(fileKeys) {
    const token = process.env.UPLOADTHING_TOKEN;
    if (fileKeys.length === 0 || token === undefined || token.length === 0) {
      return;
    }

    try {
      const { UTApi } = await import("uploadthing/server");
      await new UTApi({ token }).deleteFiles([...fileKeys]);
    } catch {
      // See the note above: hygiene, not correctness.
    }
  },
};
