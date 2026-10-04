import type { ApprovalGate, PullRequest, RiskLevel } from "./types";

const LEVELS: RiskLevel[] = ["low", "medium", "high", "critical"];
const GATES: ApprovalGate[] = ["auto", "manual", "pending"];

// Mirrors REASON_LABELS in daylightsec/risk-assessment (src/approve/policy.ts).
// A reason added there falls back to its own label text rather than vanishing.
const REASONS: Record<string, string> = {
  "risk-level": "Risk is above the auto-approve threshold",
  "pr-size": "More than 500 hand-written lines or 15 files",
  "bugbot-open": "A Bugbot finding is open, or the author resolved it",
  "new-author": "Fewer than 3 merged PRs in this repository",
  "external-author": "Bot, fork or non-member author",
  "protected-path": "Touches a path that always needs a human",
  "self-approval": "The gate's own account wrote this PR",
};

export function gateFromLabels(
  labels: string[],
): Pick<PullRequest, "risk" | "approval" | "manualReasons"> {
  const value = (prefix: string) =>
    labels.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));

  // Two risk labels can coexist for a moment while the workflow swaps them;
  // the higher one is the one a reviewer has to answer to.
  const risk = value("risk:")
    .filter((level): level is RiskLevel => LEVELS.includes(level as RiskLevel))
    .sort((a, b) => LEVELS.indexOf(b) - LEVELS.indexOf(a))[0];
  const approval = value("approve:").find((gate): gate is ApprovalGate =>
    GATES.includes(gate as ApprovalGate),
  );
  const reasons = approval === "manual" ? value("manual-reason:") : [];

  return {
    ...(risk ? { risk } : {}),
    ...(approval ? { approval } : {}),
    ...(reasons.length > 0 ? { manualReasons: reasons } : {}),
  };
}

// The gate auto-approves only low and medium risk, so a high one needing a human
// is expected; below that, a manual decision means something else stopped it.
export function manualDespiteRisk(pr: PullRequest): boolean {
  return pr.approval === "manual" && (pr.risk === "low" || pr.risk === "medium");
}

export function reasonText(reason: string): string {
  return REASONS[reason] ?? reason.replace(/-/g, " ");
}
