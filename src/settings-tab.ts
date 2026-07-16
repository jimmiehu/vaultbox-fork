import { App, Modal, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type { DropboxFolderMetadata } from "./types";
import type VaultboxPlugin from "./main";

const SUPPORT_LINKS = {
  githubSponsors: "https://github.com/sponsors/grumpydev",
  koFi: "https://ko-fi.com/grumpydev",
};

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

    if (!this.plugin.isConnected()) {
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
    }

    new Setting(containerEl)
      .setName("Dropbox vault folder")
      .setDesc(
        this.plugin.settings.selectedFolderPath ||
        "Choose an existing Dropbox folder. The Dropbox root cannot be used.",
      )
      .addButton((button) => {
        button
          .setButtonText("Choose")
          .setCta()
          .onClick(() => {
            if (!this.plugin.isConnected()) {
              new Notice("Connect Dropbox before choosing a folder.");
              return;
            }

            new DropboxFolderPickerModal(this.app, this.plugin, async (folderPath) => {
              this.plugin.settings.selectedFolderPath = folderPath;
              await this.plugin.saveSettings();
              this.display();
            }).open();
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
    this.addDebugSettings(containerEl);
    this.addSupport(containerEl);
    this.addActions(containerEl);
  }

  private addHeader(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Dropbox sync")
      .setHeading();

    const header = containerEl.createDiv({ cls: "vaultbox-settings-header" });
    const icon = header.createDiv({ cls: "vaultbox-settings-logo" });
    icon.setAttr("aria-hidden", "true");
    setIcon(icon, "vaultbox-logo");
    header.createDiv({
      cls: "vaultbox-settings-tagline",
      text: "Dropbox folder sync for desktop and mobile vaults.",
    });
  }

  private addSyncSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Sync mode")
      .setDesc("Manual runs only when you start a sync. Automatic also syncs on startup and on a timed interval.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("manual", "Manual")
          .addOption("automatic", "Automatic")
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value === "automatic" ? "automatic" : "manual";
            await this.plugin.saveSettings();
            this.plugin.reconfigureAutoSync();
            this.display();
          });
      });

    if (this.plugin.settings.syncMode === "automatic") {
      new Setting(containerEl)
        .setName("Sync on startup")
        .setDesc("Run a sync after Obsidian finishes loading.")
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.syncOnStartup)
            .onChange(async (value) => {
              this.plugin.settings.syncOnStartup = value;
              await this.plugin.saveSettings();
              this.plugin.reconfigureAutoSync();
            });
        });

      new Setting(containerEl)
        .setName("Sync interval")
        .setDesc("Minutes between automatic syncs while Obsidian is open. Set 0 to sync only on startup.")
        .addText((text) => {
          text
            .setValue(String(this.plugin.settings.syncIntervalMinutes))
            .onChange(async (value) => {
              this.plugin.settings.syncIntervalMinutes = Math.max(0, Number.parseInt(value, 10) || 0);
              await this.plugin.saveSettings();
              this.plugin.reconfigureAutoSync();
            });
          text.inputEl.type = "number";
          text.inputEl.min = "0";
          text.inputEl.step = "1";
        });
    }

    new Setting(containerEl)
      .setName("Confirm before sync")
      .setDesc(
        "Build the sync plan first, then ask before applying changes. With automatic sync, pending changes only show a notification and are applied when you run a manual sync.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.confirmBeforeManualSync)
          .onChange(async (value) => {
            this.plugin.settings.confirmBeforeManualSync = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc(
        "One vault-relative path per line. Each entry excludes that folder (or file) and everything under it, e.g. 00-inbox. Matching is case-insensitive; a trailing / or /** is allowed, other wildcards are not supported. Excluded files are invisible to sync: never uploaded, downloaded, or deleted on either side.",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("00-inbox\nAttachments/Large")
          .setValue(this.plugin.settings.excludePaths.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.excludePaths = value
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName("Last sync")
      .setDesc(this.plugin.settings.lastSyncSummary || "No completed sync yet.");

    new Setting(containerEl)
      .setName("Reset sync tracking")
      .setDesc(
        "Clears Vaultbox's local sync metadata without changing local files or Dropbox. Use this after clearing or replacing the Dropbox folder so the next sync starts fresh.",
      )
      .addButton((button) => {
        button
          .setButtonText("Reset tracking")
          .onClick(async () => {
            const confirmed = window.confirm(
              [
                "Reset Vaultbox sync tracking?",
                "",
                "This will not delete local files or Dropbox files.",
                "The next sync will treat this vault and the selected Dropbox folder as a fresh setup.",
              ].join("\n"),
            );
            if (!confirmed) {
              return;
            }

            await this.plugin.resetSyncState();
            new Notice("Vaultbox sync tracking reset.");
            this.display();
          });
      });
  }

  private addDebugSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Store a small rolling sync log in plugin data. Tokens are redacted.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (!this.plugin.settings.debugLogging && this.plugin.getDebugLogCount() === 0) {
      return;
    }

    new Setting(containerEl)
      .setName("Debug log")
      .setDesc(`${this.plugin.getDebugLogCount()} entries. The log is shown below and can be selected manually.`)
      .addButton((button) => {
        button
          .setButtonText("Clear")
          .onClick(async () => {
            await this.plugin.clearDebugLog();
            new Notice("Vaultbox debug log cleared.");
            this.display();
          });
      });

    const preview = containerEl.createEl("textarea", {
      cls: "vaultbox-debug-log",
    });
    preview.readOnly = true;
    preview.value = this.plugin.getDebugLogText();
  }

  private addActions(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Simulate sync")
      .setDesc("Scans the vault and Dropbox, builds the sync plan, and reports what would happen without changing files or metadata.")
      .addButton((button) => {
        button
          .setButtonText("Simulate")
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Simulating...");
            await this.plugin.simulateSync();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Manual sync")
      .setDesc("Run a sync now.")
      .addButton((button) => {
        button
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Syncing...");
            await this.plugin.runSync("manual");
            this.display();
          });
      });
  }

  private addSupport(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Support Vaultbox")
      .setDesc(
        "Vaultbox is free to use. If it saves you time, you can support ongoing development with a voluntary tip.",
      )
      .addButton((button) => {
        button
          .setButtonText("GitHub Sponsors")
          .onClick(() => {
            window.open(SUPPORT_LINKS.githubSponsors, "_blank", "noopener,noreferrer");
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Ko-fi")
          .onClick(() => {
            window.open(SUPPORT_LINKS.koFi, "_blank", "noopener,noreferrer");
          });
      });
  }

  private setStatus(message: string): void {
    if (this.statusEl) {
      this.statusEl.setText(message);
    }
  }
}

class DropboxFolderPickerModal extends Modal {
  private currentPath = "";
  private statusEl: HTMLElement | null = null;
  private foldersEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: VaultboxPlugin,
    private readonly onChoose: (folderPath: string) => Promise<void>,
  ) {
    super(app);
    this.currentPath = this.plugin.settings.selectedFolderPath;
  }

  onOpen(): void {
    this.titleEl.setText("Choose Dropbox folder");
    this.render();
    void this.loadFolders();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      cls: "vaultbox-modal-copy",
      text: "Choose the Dropbox folder that contains this vault. The Dropbox root cannot be selected.",
    });

    const current = this.contentEl.createDiv({ cls: "vaultbox-picker-current" });
    current.createSpan({ text: "Current folder" });
    current.createSpan({ text: this.currentPath || "Dropbox root" });

    this.statusEl = this.contentEl.createDiv({ cls: "vaultbox-status" });
    this.foldersEl = this.contentEl.createDiv({ cls: "vaultbox-folder-list" });

    const newFolder = this.contentEl.createDiv({ cls: "vaultbox-new-folder" });
    const input = newFolder.createEl("input", {
      attr: {
        placeholder: "New folder name",
        type: "text",
      },
    });
    const createButton = newFolder.createEl("button", { text: "Create folder" });
    const createFromInput = async () => {
      await this.createFolder(input.value);
    };
    createButton.addEventListener("click", createFromInput);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void createFromInput();
      }
    });

    const actions = this.contentEl.createDiv({ cls: "vaultbox-modal-actions" });
    actions.createEl("button", { text: "Up" }).addEventListener("click", () => {
      this.currentPath = getParentPath(this.currentPath);
      this.render();
      void this.loadFolders();
    });

    const chooseButton = actions.createEl("button", {
      cls: "mod-cta",
      text: "Choose this folder",
    });
    chooseButton.disabled = !this.currentPath;
    chooseButton.addEventListener("click", async () => {
      if (!this.currentPath) {
        this.setStatus("Choose a folder below the Dropbox root.");
        return;
      }

      await this.onChoose(this.currentPath);
      this.close();
    });

    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
      this.close();
    });
  }

  private async loadFolders(): Promise<void> {
    try {
      this.setStatus("Loading folders...");
      const folders = await this.plugin.createDropboxClient().listFolders(this.currentPath);
      this.renderFolders(folders);
      this.setStatus(folders.length === 0 ? "No child folders found." : `Loaded ${folders.length} folder${folders.length === 1 ? "" : "s"}.`);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  private renderFolders(folders: DropboxFolderMetadata[]): void {
    if (!this.foldersEl) {
      return;
    }

    this.foldersEl.empty();
    for (const folder of folders) {
      const button = this.foldersEl.createEl("button", {
        cls: "vaultbox-folder-option",
        text: folder.name,
      });
      button.addEventListener("click", () => {
        this.currentPath = folder.pathDisplay || folder.pathLower;
        this.render();
        void this.loadFolders();
      });
    }
  }

  private async createFolder(name: string): Promise<void> {
    const folderName = name.trim();

    if (!folderName) {
      this.setStatus("Enter a folder name first.");
      return;
    }

    if (folderName.includes("/") || folderName.includes("\\")) {
      this.setStatus("Folder names cannot contain slashes.");
      return;
    }

    const folderPath = `${this.currentPath}/${folderName}`.replace(/\/+/g, "/");
    try {
      this.setStatus("Creating folder...");
      await this.plugin.createDropboxClient().createFolder(folderPath);
      this.currentPath = folderPath;
      this.render();
      await this.loadFolders();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  private setStatus(message: string): void {
    this.statusEl?.setText(message);
  }
}

function getParentPath(folderPath: string): string {
  if (!folderPath) {
    return "";
  }

  const parts = folderPath.split("/").filter(Boolean);
  parts.pop();
  return parts.length === 0 ? "" : `/${parts.join("/")}`;
}
