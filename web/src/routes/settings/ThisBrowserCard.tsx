import { useId, useState } from 'react';
import { Button, Card, SegmentedControl } from '../../components/kit';
import { useShell, type Theme } from '../../app/ShellState';
import { sendTestNotification, statusLine } from '../../lib/notifications';
import { useNotifyState } from '../shared/useNotifyState';

/**
 * This browser (UI_SPEC §6.7, §6.7a): the "Desktop notifications" switch,
 * its status line ("On", "Off", "Blocked by the browser. …") and *Send a
 * test notification*, then the theme.
 */
export function ThisBrowserCard() {
  const { theme, setTheme } = useShell();
  const switchId = useId();
  const { pref, perm, on, off } = useNotifyState();
  const [tested, setTested] = useState<string | null>(null);
  const enabled = pref === 'on' && perm === 'granted';
  const host = typeof window === 'undefined' ? '127.0.0.1:7420' : window.location.host;
  return (
    <section aria-labelledby="settings-browser" className="settings-sec">
      <h2 id="settings-browser">This browser</h2>
      <Card padded data-card="this-browser">
        <div className="row wrap">
          <label htmlFor={switchId} className="grow">
            Desktop notifications
          </label>
          <input
            id={switchId}
            type="checkbox"
            role="switch"
            checked={enabled}
            aria-checked={enabled}
            disabled={perm === 'denied' || perm === 'unsupported'}
            aria-describedby={`${switchId}-status`}
            onChange={(e) => (e.target.checked ? void on() : off())}
          />
        </div>
        <div className="src" id={`${switchId}-status`} data-notify-status="">
          {statusLine(pref, perm, host)}
        </div>
        {enabled && (
          <div className="row wrap" style={{ marginTop: 8 }}>
            <Button
              size="sm"
              onClick={() =>
                setTested(sendTestNotification() ? 'Sent.' : 'The browser didn’t show it.')
              }
            >
              Send a test notification
            </Button>
            {tested && (
              <span className="src" role="status">
                {tested}
              </span>
            )}
          </div>
        )}
        <div className="row wrap" style={{ marginTop: 12 }}>
          <span className="grow">Theme</span>
          <SegmentedControl<Theme>
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { key: 'system', label: 'System' },
              { key: 'light', label: 'Light' },
              { key: 'dark', label: 'Dark' },
            ]}
          />
        </div>
      </Card>
    </section>
  );
}
