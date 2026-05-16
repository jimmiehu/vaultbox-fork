import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { VAULTBOX_ICON } from "./icons";
import type VaultboxPlugin from "./main";

export class VaultboxSettingTab extends PluginSettingTab {
  private statusEl: HTMLElement | null = null;

  constructor(app: App, private readonly plugin: VaultboxPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.addHeader(containerEl);
    this.statusEl = containerEl.createDiv({ cls: "vaultbox-status" });
    this.setStatus(this.plugin.isConnected() ? "Dropbox connected." : "Dropbox is not connected.");

    new Setting(containerEl)
      .setName("Connect Dropbox")
      .setDesc("Opens Dropbox OAuth. Dropbox displays a code you paste below; no client secret is stored in Vaultbox.")
      .addButton((button) => {
        button
          .setButtonText(this.plugin.isConnected() ? "Reconnect" : "Connect")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.startDropboxAuth();
              this.setStatus("Dropbox opened. Paste the authorization code after approving access.");
            } catch (error) {
              this.setStatus(error instanceof Error ? error.message : String(error));
            }
          });
      });

    new Setting(containerEl)
      .setName("Authorization code")
      .setDesc("Paste the code Dropbox shows after approval.")
      .addText((text) => {
        text.setPlaceholder("Dropbox authorization code");
      })
      .addButton((button) => {
        button
          .setButtonText("Save code")
          .onClick(async () => {
            const input = button.buttonEl.parentElement?.querySelector("input");
            const code = input instanceof HTMLInputElement ? input.value.trim() : "";
            if (!code) {
              new Notice("Paste a Dropbox authorization code first.");
              return;
            }

            try {
              await this.plugin.finishDropboxAuth(code);
              this.display();
            } catch (error) {
              this.setStatus(error instanceof Error ? error.message : String(error));
            }
          });
      });

    new Setting(containerEl)
      .setName("Dropbox vault folder")
      .setDesc("Full Dropbox access lets Vaultbox sync an existing folder already used by the Dropbox desktop app.")
      .addText((text) => {
        text
          .setPlaceholder("/Obsidian/My Vault")
          .setValue(this.plugin.settings.selectedFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.selectedFolderPath = value;
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Validate")
          .onClick(async () => {
            try {
              await this.plugin.validateSelectedFolder();
              this.display();
            } catch (error) {
              this.setStatus(error instanceof Error ? error.message : String(error));
            }
          });
      });

    this.addSyncSettings(containerEl);

    new Setting(containerEl)
      .setName("Simulate sync")
      .setDesc("Builds the full sync plan and reports what would change without writing to Dropbox or your vault.")
      .addButton((button) => {
        button
          .setButtonText("Simulate")
          .onClick(async () => {
            try {
              this.setStatus("Building sync plan...");
              this.setStatus(await this.plugin.simulateSync());
            } catch (error) {
              this.setStatus(error instanceof Error ? error.message : String(error));
            }
          });
      });
  }

  private addHeader(containerEl: HTMLElement): void {
    const header = containerEl.createDiv({ cls: "vaultbox-settings-header" });
    const icon = header.createDiv({ cls: "vaultbox-settings-logo" });
    icon.innerHTML = VAULTBOX_ICON;
    const text = header.createDiv();
    text.createEl("h2", { text: "Vaultbox" });
    text.createDiv({
      cls: "vaultbox-settings-tagline",
      text: "Dropbox folder sync for desktop and mobile vaults.",
    });
  }

  private addSyncSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Sync mode")
      .setDesc("Manual and automatic sync will use the same plan-first engine as Octosync.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("manual", "Manual")
          .addOption("automatic", "Automatic")
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value === "automatic" ? "automatic" : "manual";
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.syncMode === "automatic") {
      new Setting(containerEl)
        .setName("Sync on startup")
        .setDesc("Planned for automatic sync mode.")
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.syncOnStartup)
            .onChange(async (value) => {
              this.plugin.settings.syncOnStartup = value;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("Sync interval")
        .setDesc("Minutes between automatic sync attempts.")
        .addText((text) => {
          text
            .setValue(String(this.plugin.settings.syncIntervalMinutes))
            .onChange(async (value) => {
              this.plugin.settings.syncIntervalMinutes = Math.max(0, Number.parseInt(value, 10) || 0);
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "number";
          text.inputEl.min = "0";
          text.inputEl.step = "1";
        });
    } else {
      new Setting(containerEl)
        .setName("Confirm before sync")
        .setDesc("Build the sync plan first, then ask before applying changes.")
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.confirmBeforeManualSync)
            .onChange(async (value) => {
              this.plugin.settings.confirmBeforeManualSync = value;
              await this.plugin.saveSettings();
            });
        });
    }
  }

  private setStatus(message: string): void {
    if (this.statusEl) {
      this.statusEl.setText(message);
    }
  }
}
