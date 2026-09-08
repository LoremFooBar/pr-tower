import type { CommentAlert } from "./types";
import { stripTicketPrefix } from "./link";

// What the desktop is asked to show. Kept separate from the Notification API so
// the wording is testable without a browser.
export interface Notice {
  /**
   * Two windows of the board see the same alert and both raise it. A shared tag
   * makes the operating system replace rather than stack, so one arrival is one
   * notification however many copies of the app are open.
   */
  tag: string;
  title: string;
  body: string;
  /** The comment itself, so clicking lands on what was said. */
  url: string;
}

export function unseen(alerts: CommentAlert[], seen: Set<string>): CommentAlert[] {
  return alerts.filter((alert) => !seen.has(alert.id));
}

export function noticeFor(alert: CommentAlert): Notice {
  const who = alert.kind === "bugbot" ? "Bugbot" : alert.author;
  const many = alert.count > 1 ? ` (${alert.count})` : "";
  return {
    tag: alert.id,
    title: `${who} commented on ${alert.repo} #${alert.number}${many}`,
    // A Bugbot finding leads with its own heading, so its excerpt says more than
    // the PR title ever could.
    body: alert.excerpt || stripTicketPrefix(alert.title),
    url: alert.url,
  };
}
