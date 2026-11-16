import { useCallback, useEffect, useState } from 'react';
import {
  onPrefChange,
  permission,
  readPref,
  turnOff,
  turnOn,
  type NotifyPref,
  type Permission,
} from '../../lib/notifications';

/**
 * The desktop-notification choice and the browser permission, kept in sync
 * across the Needs you callout, Settings and other tabs (UI_SPEC §6.7a).
 */
export function useNotifyState(): {
  pref: NotifyPref | null;
  perm: Permission;
  on: () => Promise<void>;
  off: () => void;
} {
  const [state, setState] = useState(() => ({ pref: readPref(), perm: permission() }));
  const refresh = useCallback(() => setState({ pref: readPref(), perm: permission() }), []);
  useEffect(() => {
    const stop = onPrefChange(refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      stop();
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  return {
    ...state,
    on: async () => {
      await turnOn();
      refresh();
    },
    off: () => {
      turnOff();
      refresh();
    },
  };
}
