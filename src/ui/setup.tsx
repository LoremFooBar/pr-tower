import { useState } from "preact/hooks";
import type { Status } from "../core/api";

interface SetupProps {
  status: Status;
  onSave(input: { githubToken?: string; linearKey?: string; org: string }): Promise<void>;
  error?: string;
  busy?: boolean;
  onCancel?(): void;
}

export function Setup({ status, onSave, error, busy, onCancel }: SetupProps) {
  const [githubToken, setGithubToken] = useState("");
  const [linearKey, setLinearKey] = useState("");
  const [org, setOrg] = useState(status.org);

  const first = !status.githubToken;

  return (
    <div class="setup">
      <span class="wordmark">
        <span class="wordmark-rail">
          <i />
          <i />
          <i />
        </span>
        PR Tower
      </span>
      <h1>{first ? "Two keys and you're in." : "Keys"}</h1>
      <p>
        These are held by the container, not by this page. The browser never
        receives them, and every call to GitHub and Linear is made server-side.
      </p>

      {error && <p class="notice">{error}</p>}

      <div class="field">
        <label for="gh">GitHub token</label>
        <p class="hint">
          {status.pinned.githubToken ? (
            <>Set by the environment in <b>docker-compose.yml</b>. Change it there.</>
          ) : (
            <>
              A classic personal access token with the <b>repo</b> scope. Fine-grained
              tokens cannot search issues, so they will not work.
              {status.githubToken && " A token is saved — type to replace it."}
            </>
          )}
        </p>
        <input
          id="gh"
          type="password"
          placeholder={status.githubToken ? "•••••••• saved" : "ghp_…"}
          value={githubToken}
          disabled={status.pinned.githubToken}
          onInput={(e) => setGithubToken((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="field">
        <label for="ln">Linear key</label>
        <p class="hint">
          {status.pinned.linearKey ? (
            <>Set by the environment in <b>docker-compose.yml</b>. Change it there.</>
          ) : (
            <>
              A personal API key from Linear, under Settings, Security &amp; access.
              Without it you still get every PR, but no ticket, priority, or grouping.
              {status.linearKey && " A key is saved — type to replace it."}
            </>
          )}
        </p>
        <input
          id="ln"
          type="password"
          placeholder={status.linearKey ? "•••••••• saved" : "lin_api_…"}
          value={linearKey}
          disabled={status.pinned.linearKey}
          onInput={(e) => setLinearKey((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="field">
        <label for="org">Organization</label>
        <p class="hint">Limits everything to one GitHub org. Leave blank for all of them.</p>
        <input
          id="org"
          type="text"
          placeholder="acme"
          value={org}
          onInput={(e) => setOrg((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="dialog-actions">
        {onCancel && (
          <button class="ghost-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        <button
          class="send-btn"
          onClick={() =>
            onSave({
              ...(githubToken.trim() ? { githubToken: githubToken.trim() } : {}),
              ...(linearKey.trim() ? { linearKey: linearKey.trim() } : {}),
              org: org.trim(),
            })
          }
          disabled={busy || (first && !githubToken.trim())}
        >
          {busy ? "Checking…" : first ? "Connect" : "Save"}
        </button>
      </div>
    </div>
  );
}
