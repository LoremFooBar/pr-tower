import { useState } from "react";
import type { Status } from "@/core/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyRound, Loader2, TowerControl } from "lucide-react";

interface SetupProps {
  status: Status;
  onSave(input: {
    githubToken?: string;
    linearKey?: string;
    org: string;
    mergedDays: number;
  }): Promise<void>;
  error?: string;
  busy?: boolean;
  onCancel?(): void;
}

function Field({
  id,
  label,
  hint,
  ...input
}: {
  id: string;
  label: string;
  hint: React.ReactNode;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <p className="text-muted-foreground text-xs leading-relaxed">{hint}</p>
      <input
        id={id}
        className="border-input bg-background focus-visible:ring-ring/50 focus-visible:border-ring h-9 w-full rounded-md border px-3 font-mono text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:opacity-50"
        {...input}
      />
    </div>
  );
}

export function Setup({ status, onSave, error, busy, onCancel }: SetupProps) {
  const [githubToken, setGithubToken] = useState("");
  const [linearKey, setLinearKey] = useState("");
  const [org, setOrg] = useState(status.org);
  const [mergedDays, setMergedDays] = useState(String(status.mergedDays));

  const first = !status.githubToken;

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-1 flex items-center gap-2">
            <TowerControl className="text-primary size-5" />
            <span className="font-semibold tracking-tight">PR Tower</span>
          </div>
          <CardTitle>{first ? "Two keys and you're in" : "Keys"}</CardTitle>
          <CardDescription>
            These are held by the container, not by this page. The browser never receives them, and
            every call to GitHub and Linear is made server-side.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {error ? (
            <div className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
              {error}
            </div>
          ) : null}

          <Field
            id="gh"
            label="GitHub token"
            hint={
              status.pinned.githubToken ? (
                <>
                  Set by the environment in <b>docker-compose.yml</b>. Change it there.
                </>
              ) : (
                <>
                  A classic personal access token with the <b>repo</b> scope. Fine-grained tokens
                  cannot search issues, so they will not work.
                  {status.githubToken ? " A token is saved — type to replace it." : ""}
                </>
              )
            }
            type="password"
            placeholder={status.githubToken ? "•••••••• saved" : "ghp_…"}
            value={githubToken}
            disabled={status.pinned.githubToken}
            onChange={(event) => setGithubToken(event.target.value)}
          />

          <Field
            id="ln"
            label="Linear key"
            hint={
              status.pinned.linearKey ? (
                <>
                  Set by the environment in <b>docker-compose.yml</b>. Change it there.
                </>
              ) : (
                <>
                  A personal API key from Linear, under Settings, Security &amp; access. Without it
                  you still get every PR, but no ticket, priority, or grouping.
                  {status.linearKey ? " A key is saved — type to replace it." : ""}
                </>
              )
            }
            type="password"
            placeholder={status.linearKey ? "•••••••• saved" : "lin_api_…"}
            value={linearKey}
            disabled={status.pinned.linearKey}
            onChange={(event) => setLinearKey(event.target.value)}
          />

          <Field
            id="org"
            label="Organization"
            hint="Limits everything to one GitHub org. Leave blank for all of them."
            type="text"
            placeholder="acme"
            value={org}
            onChange={(event) => setOrg(event.target.value)}
          />

          <Field
            id="days"
            label="Merged window"
            hint="How many days of merged PRs the strip keeps. Anything not yet live stays past it."
            type="number"
            min={1}
            max={90}
            placeholder="7"
            value={mergedDays}
            onChange={(event) => setMergedDays(event.target.value)}
          />

          <div className="flex justify-end gap-2 pt-1">
            {onCancel ? (
              <Button variant="outline" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
            ) : null}
            <Button
              className="gap-1.5"
              onClick={() =>
                onSave({
                  ...(githubToken.trim() ? { githubToken: githubToken.trim() } : {}),
                  ...(linearKey.trim() ? { linearKey: linearKey.trim() } : {}),
                  org: org.trim(),
                  mergedDays: Number(mergedDays) || status.mergedDays,
                })
              }
              disabled={busy || (first && !githubToken.trim())}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
              {busy ? "Checking…" : first ? "Connect" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
