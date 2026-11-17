import { showToast } from '../../../lib/undo';

/** Copy to the clipboard, with a toast either way. */
export function copyText(text: string, what: string): void {
  const fail = () => showToast('Couldn’t copy. Select the text instead.');
  if (!navigator.clipboard) {
    fail();
    return;
  }
  void navigator.clipboard.writeText(text).then(() => showToast(`Copied ${what}.`), fail);
}
