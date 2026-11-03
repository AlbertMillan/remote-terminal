import type { JobOverlay, OverlayPlacement } from './job-overlay.js';
import { ServerRestartControl } from './server-restart.js';
import { SessionLimitSetting } from './session-limit-setting.js';
import type { NotificationPreferencesPayload } from './session-types.js';

/** What the Settings modal reads from and writes back to the session manager. */
export interface SettingsModalHost {
  notificationPreferences(): NotificationPreferencesPayload;
  setNotificationPreferences(prefs: NotificationPreferencesPayload): void;
  /** Asks the browser if it hasn't been asked yet; resolves to the permission now held. */
  notificationPermission(): Promise<'default' | 'granted' | 'denied'>;
  jobOverlay: Pick<JobOverlay, 'isEnabled' | 'getPlacement' | 'setPreferences'>;
  syncJobOverlay(): void;
}

/**
 * The Settings modal: notification and display preferences (applied on Save, so Cancel
 * genuinely cancels), the server's session limit, and Restart.
 */
export class SettingsModal {
  /** Restart / Build & restart in the Settings modal. */
  private serverRestart = new ServerRestartControl();
  private sessionLimit = new SessionLimitSetting();
  /** Bumped on every open and close: a save applies its local part only if it still matches. */
  private openId = 0;
  private saving = false;

  constructor(private readonly host: SettingsModalHost) {}

  /** Wires the modal's own buttons and backdrop; Escape is handled with the other modals. */
  bind(): void {
    document.getElementById('settings-btn')?.addEventListener('click', () => void this.show());
    document.getElementById('settings-cancel')?.addEventListener('click', () => this.hide());
    document.getElementById('settings-save')?.addEventListener('click', () => void this.save());
    document
      .getElementById('setting-job-overlay')
      ?.addEventListener('change', () => this.updatePlacementEnabled());
    document.getElementById('settings-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hide();
    });
  }

  async show(): Promise<void> {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;

    // Request browser notification permission if not yet granted
    const permission = await this.host.notificationPermission();

    // Update permission status display
    const permissionStatus = document.getElementById('notification-permission-status');
    if (permissionStatus) {
      if (permission === 'granted') {
        permissionStatus.textContent = 'Browser notifications enabled';
        permissionStatus.className = 'permission-status granted';
      } else if (permission === 'denied') {
        permissionStatus.textContent = 'Browser notifications blocked';
        permissionStatus.className = 'permission-status denied';
      } else {
        permissionStatus.textContent = 'Browser notifications not enabled';
        permissionStatus.className = 'permission-status default';
      }
    }

    this.openId++;
    this.updateUI();
    this.updateSaveEnabled();
    modal.classList.remove('hidden');
    void this.serverRestart.refresh();
    void this.sessionLimit.refresh();
  }

  /** Settings, scrolled to its Server section: where the build chip's restart is confirmed. */
  async showServer(): Promise<void> {
    await this.show();
    document.getElementById('server-restart-section')?.scrollIntoView({ block: 'nearest' });
  }

  hide(): void {
    const modal = document.getElementById('settings-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    // A save still in flight finishes on the server, but no longer applies the rest.
    this.openId++;
    modal.classList.add('hidden');
  }

  /** Shows the preferences as they stand; called on open and when the server sends new ones. */
  updateUI(): void {
    const prefs = this.host.notificationPreferences();
    const browserCheckbox = document.getElementById('setting-browser-notifications') as HTMLInputElement;
    const visualCheckbox = document.getElementById('setting-visual-badges') as HTMLInputElement;
    const inputCheckbox = document.getElementById('setting-notify-input') as HTMLInputElement;
    const completedCheckbox = document.getElementById('setting-notify-completed') as HTMLInputElement;

    if (browserCheckbox) browserCheckbox.checked = prefs.browserEnabled;
    if (visualCheckbox) visualCheckbox.checked = prefs.visualEnabled;
    if (inputCheckbox) inputCheckbox.checked = prefs.notifyOnInput;
    if (completedCheckbox) completedCheckbox.checked = prefs.notifyOnCompleted;

    // Display prefs live in localStorage (per device), not in the server's
    // notification row -- a phone and a desktop want different answers here.
    const overlayCheckbox = document.getElementById('setting-job-overlay') as HTMLInputElement;
    if (overlayCheckbox) overlayCheckbox.checked = this.host.jobOverlay.isEnabled();
    const placement = this.host.jobOverlay.getPlacement();
    for (const radio of this.placementRadios()) radio.checked = radio.value === placement;
    this.updatePlacementEnabled();
  }

  private placementRadios(): HTMLInputElement[] {
    return [
      ...document.querySelectorAll<HTMLInputElement>('input[name="job-overlay-placement"]'),
    ];
  }

  /** The placement choice means nothing while the panel is switched off. */
  private updatePlacementEnabled(): void {
    const on = (document.getElementById('setting-job-overlay') as HTMLInputElement)?.checked ?? true;
    document.getElementById('setting-job-overlay-placement')?.classList.toggle('disabled', !on);
    for (const radio of this.placementRadios()) radio.disabled = !on;
  }

  /** Save stays disabled while a save is in flight, even one started before a close and reopen. */
  private updateSaveEnabled(): void {
    const saveButton = document.getElementById('settings-save') as HTMLButtonElement | null;
    if (saveButton) saveButton.disabled = this.saving;
  }

  private async save(): Promise<void> {
    if (this.saving) return;
    const openId = this.openId;
    // First: if the server refuses it, the modal stays open with nothing else applied.
    this.saving = true;
    this.updateSaveEnabled();
    const saved = await this.sessionLimit.save();
    this.saving = false;
    this.updateSaveEnabled();
    // Closed (or closed and reopened) while the server answered: Cancel means the
    // preferences below stay as they were. The limit is the server's either way.
    if (!saved || openId !== this.openId) return;

    const browserCheckbox = document.getElementById('setting-browser-notifications') as HTMLInputElement;
    const visualCheckbox = document.getElementById('setting-visual-badges') as HTMLInputElement;
    const inputCheckbox = document.getElementById('setting-notify-input') as HTMLInputElement;
    const completedCheckbox = document.getElementById('setting-notify-completed') as HTMLInputElement;

    this.host.setNotificationPreferences({
      browserEnabled: browserCheckbox?.checked ?? true,
      visualEnabled: visualCheckbox?.checked ?? true,
      notifyOnInput: inputCheckbox?.checked ?? true,
      notifyOnCompleted: completedCheckbox?.checked ?? true,
    });

    // Applied on Save rather than on change, so Cancel genuinely cancels.
    const overlayCheckbox = document.getElementById('setting-job-overlay') as HTMLInputElement;
    const placement: OverlayPlacement = this.placementRadios().find((r) => r.checked)?.value === 'header'
      ? 'header'
      : 'below';
    this.host.jobOverlay.setPreferences(overlayCheckbox?.checked ?? true, placement);
    this.host.syncJobOverlay();

    this.hide();
  }
}
