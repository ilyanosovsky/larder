/**
 * The one string the upload cap's refusal is recognized by, shared so the
 * thrower and the reader cannot drift (task 4.3).
 *
 * **Why a message and not a code.** UploadThing's default `errorFormatter`
 * puts only `{ message }` in the response body — `code` and `data` are
 * dropped — and the client derives its own `code` from the HTTP status. Our
 * cap and our "you are not in a household" refusal are both 403, so on the
 * client they are the same `FORBIDDEN` and the message is the only thing that
 * tells them apart. Hence a prefix, pinned by a test on the server's own
 * throw rather than trusted to stay in step by eye.
 */
export const UPLOAD_LIMIT_MESSAGE_PREFIX = "Upload limit reached";

/** Whether an upload failure is the per-user cap rather than a real failure. */
export function isUploadLimitMessage(message: string): boolean {
  return message.startsWith(UPLOAD_LIMIT_MESSAGE_PREFIX);
}
