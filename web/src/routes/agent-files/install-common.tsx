import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Button } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { showToast } from '../../lib/undo';

/* Pieces the Install dialog, the install log and the push folder card share. */

export function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(
    () => showToast(`Copied the ${what}.`),
    () => showToast('Couldn’t copy. Select the text instead.'),
  );
}

/** A command or snippet with its *Copy* button. */
export function CopyBlock({ text, label, what }: { text: string; label: string; what: string }) {
  const id = useId();
  return (
    <div className="incopy">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span id={id} className="src">
          {label}
        </span>
        <Button size="sm" icon="copy" onClick={() => copy(text, what)} aria-describedby={id}>
          Copy
        </Button>
      </div>
      <pre className="code incode" aria-labelledby={id} tabIndex={0}>
        {text}
      </pre>
    </div>
  );
}

export const errorText = (err: unknown) =>
  err instanceof Error ? err.message : 'Something went wrong. Try again.';

export function usePushTarget() {
  return useQuery({
    queryKey: queryKeys.pushTarget(),
    queryFn: () => apiClient['pushTarget.get']({}),
  });
}
