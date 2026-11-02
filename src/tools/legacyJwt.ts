import { z } from "zod";

/**
 * The optional raw-token argument on the authenticated tools.
 *
 * /mcp and /directory/mcp keep advertising it: agents that registered before
 * session handles existed still pass it. /plugin/mcp (the door listed in
 * OpenAI's Plugins Directory) does not: OpenAI's plugin guidelines forbid tool
 * inputs that take access credentials, and the opaque `session` handle is the
 * only way in there.
 */
export function legacyJwtField(advertise: boolean): { jwt?: z.ZodOptional<z.ZodString> } {
  return advertise
    ? { jwt: z.string().optional().describe("Legacy fallback: raw JWT token. Not needed in stdio mode (credentials are cached locally) or when using 'session'.") }
    : {};
}
