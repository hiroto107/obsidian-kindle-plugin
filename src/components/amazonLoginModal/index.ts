import { BrowserWindow, remote } from 'electron';

import { currentAmazonRegion } from '~/amazonRegion';
import { ee } from '~/eventEmitter';
import type { AmazonAccount } from '~/models';
import { settingsStore } from '~/store';

const { BrowserWindow: RemoteBrowserWindow } = remote;

// Matches amazon.com, amazon.co.jp, amazon.de, ... and their subdomains (www., read., ...)
const amazonHostPattern = /(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/;

const isAmazonUrl = (url: string): boolean => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && amazonHostPattern.test(hostname);
  } catch {
    return false;
  }
};

export default class AmazonLoginModal {
  private modal: BrowserWindow;
  private waitForSignIn: Promise<boolean>;
  private resolvePromise!: (success: boolean) => void;
  private region: AmazonAccount;

  constructor() {
    this.region = currentAmazonRegion();

    this.waitForSignIn = new Promise(
      (resolve: (success: boolean) => void) => (this.resolvePromise = resolve)
    );

    this.modal = new RemoteBrowserWindow({
      parent: remote.getCurrentWindow(),
      width: 450,
      height: 730,
      webPreferences: {
        partition: 'persist:kindle-highlights',
      },
      show: false,
    });

    // Obsidian cancels http(s) navigations in every window it creates and reopens them in the
    // system browser, ejecting the Amazon login flow. Replace that listener on the window we own
    // with one that keeps Amazon pages inside the modal and still blocks everything else.
    this.modal.webContents.removeAllListeners('will-navigate');
    this.modal.webContents.on('will-navigate', (event, url) => {
      if (!isAmazonUrl(url)) {
        event.preventDefault();
      }
    });

    // We can only change title after page is loaded since HTML page has its own title
    this.modal.once('ready-to-show', () => {
      this.modal.setTitle('Connect your Amazon account to Obsidian');
      this.modal.show();
    });

    // If user is on the read.amazon.com url, we can safely assume they are logged in
    this.modal.webContents.on('did-navigate', (_event, url) => {
      if (url.startsWith(this.region.kindleReaderUrl)) {
        this.modal.close();

        settingsStore.actions.login();

        this.resolvePromise(true);
      }
    });

    this.modal.on('closed', () => {
      ee.off('syncCancelRequested', this.handleCancelDuringLogin);
      this.resolvePromise(false);
    });

    ee.on('syncCancelRequested', this.handleCancelDuringLogin);
  }

  private handleCancelDuringLogin = (): void => {
    if (!this.modal.isDestroyed()) {
      this.modal.close();
    }
  };

  async doLogin(): Promise<boolean> {
    try {
      await this.modal.loadURL(this.region.notebookUrl);
    } catch (error) {
      // Swallow error. `loadUrl` is interrupted on successful
      // login as we immediately redirect if user is logged in
    }

    return this.waitForSignIn;
  }
}
