import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, ErrorState } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { ApiError } from '../../lib/api';

/** Only same-app paths are followed after unlocking (no open redirect). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/unlock'))
    return '/';
  return next;
}

/**
 * Unlock (UI_SPEC §6.8): a centred card; the owner key goes to the real
 * `POST /api/session/unlock` (B2). On success, go to the requested page.
 */
export function Unlock() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputId = useId();
  const errId = useId();
  const [key, setKey] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setMismatch(false);
    setFailure(null);
    try {
      await apiClient['session.unlock']({ body: { key: key.trim() } });
      queryClient.clear();
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setMismatch(true);
      else setFailure(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="unlock">
      <form className="card" onSubmit={submit} aria-labelledby="unlock-title">
        <div className="logo" style={{ padding: 0 }}>
          <i aria-hidden="true">TL</i>
          <span>Task Lite</span>
        </div>
        <h1 id="unlock-title">Unlock Task Lite</h1>
        <p className="src" style={{ margin: 0 }}>
          Paste the owner key. Get it with:{' '}
          <code>docker compose exec tasklite tasklite owner-key</code>
        </p>
        <label className="f" htmlFor={inputId}>
          Owner key
        </label>
        <input
          id={inputId}
          className="input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-invalid={mismatch || undefined}
          aria-describedby={mismatch ? errId : undefined}
        />
        {mismatch && (
          <div className="field-err" id={errId} role="alert">
            That key didn’t match.
          </div>
        )}
        {failure !== null && <ErrorState error={failure} />}
        <div>
          <Button type="submit" variant="primary" disabled={busy}>
            Unlock
          </Button>
        </div>
      </form>
    </main>
  );
}
