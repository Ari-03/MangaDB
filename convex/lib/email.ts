// Administrator alert email (ticket #37, spec §6: runs & failure), sent via
// the Resend HTTP API — the one email this app sends in v1, so a provider
// SDK would be overkill. Configuration is three Convex env vars (README):
//
//   RESEND_API_KEY            the Resend API key
//   IMPORT_ALERT_EMAIL_TO     the Administrator's address
//   IMPORT_ALERT_EMAIL_FROM   verified sender (default alerts@mangadb.org)
//
// Unconfigured deployments (dev, tests, pre-launch) skip the send and say
// so — never a thrown error, so a missing key can't fail an import run.

import { sleep } from "./http";

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "MangaDB imports <alerts@mangadb.org>";

export type SendResult =
  | { sent: true }
  | { sent: false; reason: string };

/**
 * Send one plain-text email to the Administrator. Transient failures (5xx,
 * network) retry with backoff inside the call; exactly-once delivery per
 * transition is the caller's job — the mutation that detects the health
 * transition schedules exactly one send.
 */
export async function sendAdminEmail(args: {
  subject: string;
  text: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.IMPORT_ALERT_EMAIL_TO;
  if (!apiKey || !to) {
    return {
      sent: false,
      reason:
        "unconfigured (set RESEND_API_KEY and IMPORT_ALERT_EMAIL_TO — see README)",
    };
  }
  const from = process.env.IMPORT_ALERT_EMAIL_FROM ?? DEFAULT_FROM;

  let lastReason = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    try {
      const res = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to, subject: args.subject, text: args.text }),
      });
      if (res.ok) return { sent: true };
      lastReason = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      // Client errors (bad key, unverified sender) won't heal on retry.
      if (res.status >= 400 && res.status < 500) break;
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e);
    }
  }
  return { sent: false, reason: lastReason };
}
