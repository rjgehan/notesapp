// The quick-capture dialog (DESIGN §6.27): opened from the palette, Mod-Shift-Space anywhere in
// the app, the ribbon, the drawer and the phone's "+" button. Eager, so its field takes the focus
// inside the opening tap (iOS keyboard, §6.13).
import { announceCapture } from '../../features/captureSync';
import { useUi } from '../../state/ui';
import { Modal } from '../overlays/Modal';
import { CaptureForm } from './CaptureForm';

export function CaptureDialog() {
  const close = () => useUi.getState().setOverlay(null);
  return (
    <Modal label="Quick capture" onClose={close} className="capture-dialog">
      <CaptureForm
        onCancel={close}
        onDone={(outcome, input) => {
          close();
          announceCapture(outcome, input);
        }}
      />
    </Modal>
  );
}
