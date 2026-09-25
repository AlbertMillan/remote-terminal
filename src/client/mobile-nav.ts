export interface MobileNavHost {
  hasCurrentSession(): boolean;
  sendTerminalData(data: string): void;
  fitTerminal(): void;
}

/** The mobile on-screen navigation bar: show/hide toggle and arrow/Escape/Enter key buttons. */
export class MobileNav {
  // Mobile navigation state
  private mobileNavVisible = true;

  constructor(private readonly host: MobileNavHost) {}

  setupMobileNavigation(): void {
    const navToggle = document.getElementById('mobile-nav-toggle');
    const navBar = document.getElementById('mobile-nav-bar');

    if (!navToggle || !navBar) return;

    // Load saved preference (default to visible)
    const savedPref = localStorage.getItem('mobileNavVisible');
    this.mobileNavVisible = savedPref === null ? true : savedPref === 'true';
    this.updateMobileNavVisibility();

    // Toggle button handlers
    navToggle.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.toggleMobileNav();
    }, { passive: false });

    navToggle.addEventListener('click', () => this.toggleMobileNav());

    // Navigation key button handlers
    const navKeys = navBar.querySelectorAll('.mobile-nav-key');
    navKeys.forEach((btn) => {
      const handleKeyPress = () => {
        const key = (btn as HTMLElement).dataset.key;
        if (key) {
          this.sendKeyToTerminal(key);
        }
      };

      // Touch events for mobile
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        this.preventTerminalKeyboard();
        (document.activeElement as HTMLElement)?.blur();
        (btn as HTMLElement).classList.add('active');
      }, { passive: false });

      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        (btn as HTMLElement).classList.remove('active');
        handleKeyPress();
        setTimeout(() => this.allowTerminalKeyboard(), 300);
      }, { passive: false });

      btn.addEventListener('touchcancel', () => {
        (btn as HTMLElement).classList.remove('active');
        setTimeout(() => this.allowTerminalKeyboard(), 300);
      });

      // Mouse events for desktop
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', handleKeyPress);
    });
  }

  private toggleMobileNav(): void {
    this.mobileNavVisible = !this.mobileNavVisible;
    localStorage.setItem('mobileNavVisible', String(this.mobileNavVisible));
    this.updateMobileNavVisibility();
  }

  private updateMobileNavVisibility(): void {
    const navToggle = document.getElementById('mobile-nav-toggle');
    const navBar = document.getElementById('mobile-nav-bar');
    const mainContent = document.getElementById('main-content');

    if (this.mobileNavVisible) {
      navBar?.classList.add('visible');
      navToggle?.classList.add('hidden');
      mainContent?.classList.add('mobile-nav-active');
    } else {
      navBar?.classList.remove('visible');
      navToggle?.classList.remove('hidden');
      mainContent?.classList.remove('mobile-nav-active');
    }

    // Trigger terminal resize after visibility change
    setTimeout(() => {
      this.host.fitTerminal();
    }, 350); // Wait for CSS transition to complete
  }

  private sendKeyToTerminal(key: string): void {
    if (!this.host.hasCurrentSession()) return;

    // Map key names to ANSI escape sequences
    const keyMap: Record<string, string> = {
      'Escape': '\x1b',
      'ArrowUp': '\x1b[A',
      'ArrowDown': '\x1b[B',
      'ArrowRight': '\x1b[C',
      'ArrowLeft': '\x1b[D',
      'Enter': '\r',
    };

    const sequence = keyMap[key];
    if (sequence) {
      this.host.sendTerminalData(sequence);
    }
  }

  private preventTerminalKeyboard(): void {
    // Find xterm's helper textarea and prevent it from showing keyboard
    const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    if (textarea) {
      textarea.setAttribute('readonly', 'true');
      textarea.setAttribute('inputmode', 'none');
    }
  }

  private allowTerminalKeyboard(): void {
    // Re-enable xterm's helper textarea
    const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    if (textarea) {
      textarea.removeAttribute('readonly');
      textarea.removeAttribute('inputmode');
    }
  }
}
