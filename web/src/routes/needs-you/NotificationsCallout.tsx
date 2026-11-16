import { Button } from '../../components/kit';
import { useNotifyState } from '../shared/useNotifyState';

/**
 * The one-line opt-in above the Agents strip (UI_SPEC §6.7a): *Turn on*
 * asks the browser; *Not now* hides it (Settings keeps the switch). It never
 * shows again once either is chosen.
 */
export function NotificationsCallout() {
  const { pref, perm, on, off } = useNotifyState();
  if (pref !== null || perm === 'unsupported') return null;
  return (
    <div className="callout info notifycallout" data-card="notify-optin">
      <span className="grow">Get a desktop notification when something needs you.</span>
      <Button size="sm" onClick={() => void on()}>
        Turn on
      </Button>
      <Button size="sm" variant="ghost" onClick={off}>
        Not now
      </Button>
    </div>
  );
}
