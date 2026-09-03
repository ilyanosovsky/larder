import { describe, expect, it } from "vitest";

import {
  isUploadLimitMessage,
  UPLOAD_LIMIT_MESSAGE_PREFIX,
} from "@/lib/images/upload-errors";

describe("isUploadLimitMessage", () => {
  it.each(["minute", "day"])(
    "recognizes the %s-window refusal the route throws",
    (reason) => {
      expect(
        isUploadLimitMessage(`${UPLOAD_LIMIT_MESSAGE_PREFIX} (${reason})`),
      ).toBe(true);
    },
  );

  it("does not claim an unrelated refusal", () => {
    // The non-member throw is also a 403, and the client derives its `code`
    // from the status — so the message is the only thing that separates them.
    expect(isUploadLimitMessage("FORBIDDEN")).toBe(false);
    expect(isUploadLimitMessage("UNAUTHORIZED")).toBe(false);
    expect(isUploadLimitMessage("Failed to fetch")).toBe(false);
  });
});
