import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// ssh takes anything that doesn't start with "-" as a destination; a leading dash would be read
// as an option.
const host = z
  .string()
  .trim()
  .regex(/^([^-\s]\S*)?$/, "One ssh destination, like devbox or me@devbox, with no spaces");

export const connectionSchema = z.object({
  /** ssh destination. Empty falls back to $CC_REMOTE_HOST, then ~/.config/cc-remote/host. */
  host: host.default(""),
  /** The cc-remote executable on the daemon machine. */
  command: z.string().trim().min(1, "Enter the cc-remote executable").default("cc-remote"),
  /** Becomes CC_REMOTE_SSH, like rsync's RSYNC_RSH. Empty keeps plain ssh. */
  sshCommand: z.string().trim().default(""),
});

export type Connection = z.infer<typeof connectionSchema>;

export const connectionSettings = defineSettings({
  id: "connection",
  scope: "host",
  version: 1,
  schema: connectionSchema,
});

/** Runs `cc-remote doctor` with the given, possibly unsaved, connection. */
export const doctorRpc = defineRpc({
  name: "doctor.run",
  input: connectionSchema,
  output: z.object({ ok: z.boolean(), output: z.string() }),
});
