import { useId } from 'react';
import { Card, SegmentedControl } from '../../components/kit';
import { useShell, type Theme } from '../../app/ShellState';

/**
 * This browser (UI_SPEC §6.7): the "Desktop notifications" switch, its
 * status line and *Send a test notification* (T085 fills them), and the theme.
 */
export function ThisBrowserCard() {
  const { theme, setTheme } = useShell();
  const switchId = useId();
  return (
    <section aria-labelledby="settings-browser" className="settings-sec">
      <h2 id="settings-browser">This browser</h2>
      <Card padded data-card="this-browser">
        <div className="row wrap">
          <label htmlFor={switchId} className="grow">
            Desktop notifications
          </label>
          <input id={switchId} type="checkbox" role="switch" disabled title="Lands with T085" />
        </div>
        <div className="src">Off</div>
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
