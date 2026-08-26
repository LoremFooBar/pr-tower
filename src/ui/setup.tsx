import { useState } from "preact/hooks";
import type { Config } from "../core/store";

interface SetupProps {
  initial: Config;
  onSave(config: Config): Promise<void>;
  error?: string;
  busy?: boolean;
  onCancel?(): void;
}

export function Setup({ initial, onSave, error, busy, onCancel }: SetupProps) {
  const [draft, setDraft] = useState<Config>(initial);

  const set = <K extends keyof Config>(key: K, value: Config[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

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
      <h1>Two keys and you're in.</h1>
      <p>
        Both are stored in this browser only, and every request goes straight from this page
        to GitHub and Linear. Nothing passes through a server.
      </p>

      {error && <p class="notice">{error}</p>}

      <div class="field">
        <label for="gh">GitHub token</label>
        <p class="hint">
          A classic personal access token with the <b>repo</b> scope. Fine-grained tokens
          cannot search issues, so they will not work here.
        </p>
        <input
          id="gh"
          type="password"
          placeholder="ghp_…"
          value={draft.githubToken}
          onInput={(e) => set("githubToken", (e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="field">
        <label for="ln">Linear key</label>
        <p class="hint">
          A personal API key from Linear, under Settings, Security &amp; access. Without it
          you still get every PR, but no ticket, priority, or grouping.
        </p>
        <input
          id="ln"
          type="password"
          placeholder="lin_api_…"
          value={draft.linearKey}
          onInput={(e) => set("linearKey", (e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="field">
        <label for="org">Organization</label>
        <p class="hint">Limits everything to one GitHub org. Leave blank for all of them.</p>
        <input
          id="org"
          type="text"
          placeholder="acme"
          value={draft.org}
          onInput={(e) => set("org", (e.target as HTMLInputElement).value)}
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
          onClick={() => onSave({ ...draft, org: draft.org.trim() })}
          disabled={busy || !draft.githubToken.trim()}
        >
          {busy ? "Checking…" : "Connect"}
        </button>
      </div>
    </div>
  );
}
