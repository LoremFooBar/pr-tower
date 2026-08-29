import type { MouseEvent } from "react";

// PR Hub, the Chrome extension, marks the page when it is installed. This page
// cannot reach Chrome's tab APIs, so handing the URL to the extension is the
// only way a click can land in its "My PRs" tab group.
const OPEN_PR = "prhub:open-pr";

function installed(): boolean {
  return document.documentElement.dataset.prHub === "1";
}

// A modified click means the user asked the browser for something specific —
// a new window, a background tab, a download. The anchor stays a real GitHub
// href so all of it, and copy-link, keeps working.
function plain(event: MouseEvent): boolean {
  return (
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
  );
}

export function prLink(url: string) {
  return {
    href: url,
    target: "_blank",
    rel: "noreferrer",
    onClick(event: MouseEvent<HTMLAnchorElement>) {
      if (!installed() || !plain(event)) return;
      event.preventDefault();
      window.postMessage({ type: OPEN_PR, url }, window.location.origin);
    },
  } as const;
}
