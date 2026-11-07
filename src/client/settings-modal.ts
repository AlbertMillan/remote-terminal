import type { JobOverlay, OverlayPlacement } from './job-overlay.js';
import { ServerRestartControl } from './server-restart.js';
import { SessionLimitSetting } from './session-limit-setting.js';
import type { NotificationPreferencesPayload } from './session-types.js';
import { KEEP_STOPPED_IN_PLACE_KEY, readFlag, writeFlag } from './session-list-view.js';

/** What the Settings modal reads from and writes back to the session manager. */
export interface SettingsModalHost {
  notificationPreferences(): NotificationPreferencesPayload;
  setNotificationPreferences(prefs: NotificationPreferencesPayload): void;
  /** Asks the browser if it hasn't been asked yet; resolves to the permission now held. */
  notificationPermission(): Promise<'default' | 'granted' | 'denied'>;
  jobOverlay: Pick<JobOverlay, 'isEnabled' | 'getPlacement' | 'setPreferences'>;
  syncJobOverlay(): void;
  /** Re-render the session list after a sidebar preference changed. */
  renderSessionList(): void;
  /** The running build is behind (BuildIndicator): the gear then opens on the Server tab. */
  buildBehind(): boolean;
}

export type SettingsTab = 'notifications' | 'display' | 'sessions' | 'server';

/** In strip order; ←/→ move through them. Each tab's button is `settings-tab-<id>`, its panel `settings-panel-<id>`. */
const TABS: readonly SettingsTab[] = ['notifications', 'display', 'sessions', 'server'];
/** How a tab is named in the unsaved-changes summary and the restart warning. */
const TAB_LABELS: Record<SettingsTab, string> = {
  notifications: 'Notifications',
  display: 'Display',
  sessions: 'Sessions',
  server: 'Server',
};

/**
 * The Settings modal, in tabs: Notifications and Display (applied on Save, so Cancel
 * genuinely cancels), Sessions (the server's session limits) and Server (Restart, which acts
 * on its own: that tab has no Save/Cancel). A dot marks each tab with unsaved changes.
 */
export class SettingsModal {
  /** Restart / Build & restart on the Server tab; it warns about the unsaved changes a restart drops. */
  private serverRestart = new ServerRestartControl(() => this.unsavedTabs().map((tab) => TAB_LABELS[tab]));
  private sessionLimit = new SessionLimitSetting();
  /** Bumped on every open and close: a save applies its local part only if it still matches. */
  private openId = 0;
  private saving = false;
  private tab: SettingsTab = 'notifications';
  /**
   * Each field's value as last loaded: a tab has unsaved changes while one of its fields
   * differs. A field not in here yet (a session limit still loading) counts as unchanged.
   */
  private loaded = new Map<HTMLInputElement, string | boolean>();

  constructor(private readonly host: SettingsModalHost) {}

  /** Wires the modal's own buttons, tabs and backdrop; Escape is handled with the other modals. */
  bind(): void {
    document
      .getElementById('settings-btn')
      ?.addEventListener('click', () => void this.show(this.host.buildBehind() ? 'server' : 'notifications'));
    document.getElementById('settings-cancel')?.addEventListener('click', () => this.hide());
    document.getElementById('settings-close')?.addEventListener('click', () => this.hide());
    document.getElementById('settings-save')?.addEventListener('click', () => void this.save());
    document
      .getElementById('setting-job-overlay')
      ?.addEventListener('change', () => this.updatePlacementEnabled());
    document.getElementById('settings-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hide();
    });
    const panels = document.getElementById('settings-panels');
    panels?.addEventListener('input', () => this.refreshDirty());
    panels?.addEventListener('change', () => this.refreshDirty());
    for (const tab of TABS) {
      const button = this.tabButton(tab);
      button?.addEventListener('click', () => this.select(tab, true));
      button?.addEventListener('keydown', (e) => this.onTabKey(e, tab));
    }
  }

  async show(tab: SettingsTab = 'notifications'): Promise<void> {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;

    // Request browser notification permission if not yet granted; say so only when it isn't.
    const permission = await this.host.notificationPermission();
    const warning = document.getElementById('setting-browser-notifications-warning');
    if (warning) {
      warning.classList.toggle('hidden', permission === 'granted');
      warning.textContent =
        permission === 'denied'
          ? 'Blocked by this browser. Allow notifications for this site to get them.'
          : 'Not allowed by this browser yet. Allow notifications for this site to get them.';
    }

    const openId = ++this.openId;
    // Until the limits reload, what their fields hold is the last open's: no dot for it.
    for (const input of this.fields('sessions')) this.loaded.delete(input);
    this.updateUI();
    this.updateSaveEnabled();
    this.select(tab, false);
    modal.classList.remove('hidden');
    void this.serverRestart.refresh();
    void this.sessionLimit.refresh().then(() => {
      // Loaded values are the baseline for the Sessions dot; a later open has its own.
      if (openId !== this.openId) return;
      this.remember('sessions');
      this.refreshDirty();
    });
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
    const keepStopped = document.getElementById('setting-keep-stopped') as HTMLInputElement | null;
    if (keepStopped) keepStopped.checked = readFlag(KEEP_STOPPED_IN_PLACE_KEY);

    // What was just shown is what Save would leave alone.
    this.remember('notifications');
    this.remember('display');
    this.refreshDirty();
  }

  private tabButton(tab: SettingsTab): HTMLElement | null {
    return document.getElementById(`settings-tab-${tab}`);
  }

  private panel(tab: SettingsTab): HTMLElement | null {
    return document.getElementById(`settings-panel-${tab}`);
  }

  private fields(tab: SettingsTab): HTMLInputElement[] {
    return [...(this.panel(tab)?.querySelectorAll<HTMLInputElement>('input') ?? [])];
  }

  private static valueOf(input: HTMLInputElement): string | boolean {
    return input.type === 'checkbox' || input.type === 'radio' ? input.checked : input.value;
  }

  private remember(tab: SettingsTab): void {
    for (const input of this.fields(tab)) this.loaded.set(input, SettingsModal.valueOf(input));
  }

  /** The tabs with a field changed since it was loaded, in strip order. */
  private unsavedTabs(): SettingsTab[] {
    return TABS.filter((tab) =>
      this.fields(tab).some((input) => this.loaded.has(input) && this.loaded.get(input) !== SettingsModal.valueOf(input))
    );
  }

  /** The dot on each tab with unsaved changes, and the footer's summary of them. */
  private refreshDirty(): void {
    const unsaved = this.unsavedTabs();
    for (const tab of TABS) {
      const dirty = unsaved.includes(tab);
      const button = this.tabButton(tab);
      button?.querySelector('.settings-tab-dirty')?.classList.toggle('hidden', !dirty);
      const spoken = button?.querySelector('.settings-tab-dirty-label');
      if (spoken) spoken.textContent = dirty ? ' (unsaved changes)' : '';
    }
    const summary = document.getElementById('settings-unsaved');
    if (summary) summary.textContent = unsaved.length ? `Unsaved: ${unsaved.map((tab) => TAB_LABELS[tab]).join(', ')}` : '';
  }

  /** Shows one tab's panel. The Server tab has nothing to save, so it has no Save/Cancel. */
  private select(tab: SettingsTab, focus: boolean): void {
    this.tab = tab;
    for (const each of TABS) {
      const on = each === tab;
      const button = this.tabButton(each);
      if (button) {
        button.setAttribute('aria-selected', String(on));
        button.tabIndex = on ? 0 : -1;
      }
      // `hidden`, not removed: every panel keeps sizing the modal, so switching never resizes it.
      const panel = this.panel(each);
      if (panel) panel.hidden = !on;
    }
    document.getElementById('settings-actions')?.classList.toggle('hidden', tab === 'server');
    document.getElementById('settings-panels')?.scrollTo?.({ top: 0 });
    if (focus) this.tabButton(tab)?.focus();
  }

  /** ←/→ move between tabs, Home/End jump to the ends (the WAI-ARIA tabs pattern). */
  private onTabKey(e: KeyboardEvent, tab: SettingsTab): void {
    const i = TABS.indexOf(tab);
    const next =
      e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length]
      : e.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length]
      : e.key === 'Home' ? TABS[0]
      : e.key === 'End' ? TABS[TABS.length - 1]
      : null;
    if (!next) return;
    e.preventDefault();
    this.select(next, true);
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
    if (!saved || openId !== this.openId) {
      // A refused limit keeps its dot; say which tab holds the reason.
      if (!saved && openId === this.openId && this.tab !== 'sessions') this.select('sessions', false);
      return;
    }

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
    const keepStopped = document.getElementById('setting-keep-stopped') as HTMLInputElement | null;
    if (keepStopped) writeFlag(KEEP_STOPPED_IN_PLACE_KEY, keepStopped.checked);
    this.host.renderSessionList();

    this.hide();
  }
}
