import type { CommentAlert, StateAlert } from "./types";
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
  /** Where clicking lands: the comment itself, or the PR that moved. */
  url: string;
}

export function unseen(notices: Notice[], seen: Set<string>): Notice[] {
  return notices.filter((notice) => !seen.has(notice.tag));
}

/** Everything one snapshot asks the desktop to show, in one list. */
export function noticesFor(data: {
  alerts?: CommentAlert[];
  stateAlerts?: StateAlert[];
}): Notice[] {
  return [
    ...(data.alerts ?? []).map(noticeFor),
    ...(data.stateAlerts ?? []).map(stateNotice),
  ];
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

export function stateNotice(alert: StateAlert): Notice {
  const where = `${alert.repo} #${alert.number}`;
  const who = alert.by ?? [];
  const title =
    alert.kind === "merged"
      ? `${where} was merged`
      : who.length > 0
        ? `${who.join(", ")} approved ${where}`
        : `${where} was approved`;
  return { tag: alert.id, title, body: stripTicketPrefix(alert.title), url: alert.url };
}
