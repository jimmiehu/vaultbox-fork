import { describe, expect, it, vi } from "vitest";
import { executeSyncPlan, SyncExecutionError, type SyncDropboxClient } from "../src/sync-executor";
import { getDropboxContentHash, normalizePathKey, type SyncPlan } from "../src/sync-plan";
import type { DropboxFileMetadata, SyncedFileState, VaultboxSyncState } from "../src/types";

describe("sync executor", () => {
  it("uploads local changes with the previous Dropbox rev and records new state", async () => {
    const vault = new FakeVault({ "Notes/A.md": "new local" });
    const remoteHash = await hash("new local");
    const dropbox = new FakeDropbox({
      uploadResult: remoteFile("/Vault/Notes/A.md", remoteHash, "rev-new"),
    });
    const previous = synced("Notes/A.md", await hash("old"), await hash("old"), "rev-old");
    const localHash = await hash("new local");

    const result = await executeSyncPlan({
      vault: vault.asVault(),
      dropbox,
      rootPath: "/Vault",
      currentState: state([previous]),
      plan: plan([
        {
          kind: "upload",
          path: "Notes/A.md",
          local: localFile("Notes/A.md", localHash),
          previous,
        },
      ]),
    });

    expect(dropbox.upload).toHaveBeenCalledWith({
      path: "/Vault/Notes/A.md",
      content: expect.any(ArrayBuffer),
      rev: "rev-old",
    });
    expect(dropbox.createFolder).toHaveBeenCalledWith("/Vault/Notes");
    expect(result.applied).toBe(1);
    expect(result.state.files["notes/a.md"]).toMatchObject({
      localContentHash: localHash,
      remoteContentHash: remoteHash,
      remoteRev: "rev-new",
    });
  });

  it("creates each remote parent folder only once per sync", async () => {
    const firstHash = await hash("first");
    const secondHash = await hash("second");
    const vault = new FakeVault({
      "Notes/First.md": "first",
      "Notes/Second.md": "second",
    });
    const dropbox = new FakeDropbox({});

    await executeSyncPlan({
      vault: vault.asVault(),
      dropbox,
      rootPath: "/Vault",
      currentState: emptyState(),
      plan: plan([
        {
          kind: "upload",
          path: "Notes/First.md",
          local: localFile("Notes/First.md", firstHash),
        },
        {
          kind: "upload",
          path: "Notes/Second.md",
          local: localFile("Notes/Second.md", secondHash),
        },
      ]),
    });

    expect(dropbox.createFolder).toHaveBeenCalledTimes(1);
    expect(dropbox.createFolder).toHaveBeenCalledWith("/Vault/Notes");
  });

  it("uploads local files with bounded concurrency", async () => {
    const vault = new FakeVault({
      "A.md": "a",
      "B.md": "b",
      "C.md": "c",
      "D.md": "d",
      "E.md": "e",
    });
    const dropbox = new FakeDropbox({ uploadDelayMs: 5 });

    const result = await executeSyncPlan({
      vault: vault.asVault(),
      dropbox,
      rootPath: "/Vault",
      currentState: emptyState(),
      uploadConcurrency: 2,
      plan: plan([
        { kind: "upload", path: "A.md", local: localFile("A.md", await hash("a")) },
        { kind: "upload", path: "B.md", local: localFile("B.md", await hash("b")) },
        { kind: "upload", path: "C.md", local: localFile("C.md", await hash("c")) },
        { kind: "upload", path: "D.md", local: localFile("D.md", await hash("d")) },
        { kind: "upload", path: "E.md", local: localFile("E.md", await hash("e")) },
      ]),
    });

    expect(result.applied).toBe(5);
    expect(dropbox.maxUploadInFlight).toBe(2);
    expect(dropbox.upload).toHaveBeenCalledTimes(5);
  });

  it("reports progress as sync operations complete", async () => {
    const firstHash = await hash("first");
    const secondHash = await hash("second");
    const vault = new FakeVault({
      "First.md": "first",
      "Second.md": "second",
    });
    const progress: Array<{ completed: number; total: number; operation: string; path: string }> = [];

    await executeSyncPlan({
      vault: vault.asVault(),
      dropbox: new FakeDropbox({}),
      rootPath: "/Vault",
      currentState: emptyState(),
      onProgress: (event) => progress.push(event),
      plan: plan([
        {
          kind: "noop",
          path: "Already.md",
        },
        {
          kind: "upload",
          path: "First.md",
          local: localFile("First.md", firstHash),
        },
        {
          kind: "upload",
          path: "Second.md",
          local: localFile("Second.md", secondHash),
        },
      ]),
    });

    expect(progress).toHaveLength(2);
    expect(progress.map((event) => event.completed)).toEqual([1, 2]);
    expect(progress.every((event) => event.total === 2)).toBe(true);
    expect(progress.map((event) => event.operation)).toEqual(["upload", "upload"]);
  });

  it("stops upload when the local file changed after planning", async () => {
    const plannedHash = await hash("planned");
    const vault = new FakeVault({ "A.md": "changed" });
    const dropbox = new FakeDropbox({
      uploadResult: remoteFile("/Vault/A.md", plannedHash, "rev-new"),
    });

    await expect(
      executeSyncPlan({
        vault: vault.asVault(),
        dropbox,
        rootPath: "/Vault",
        currentState: emptyState(),
        plan: plan([
          {
            kind: "upload",
            path: "A.md",
            local: localFile("A.md", plannedHash),
          },
        ]),
      }),
    ).rejects.toThrow(/Local file changed before upload/);
    expect(dropbox.upload).not.toHaveBeenCalled();
  });

  it("downloads remote changes after verifying the local file is still unchanged", async () => {
    const oldHash = await hash("old");
    const newHash = await hash("remote new");
    const previous = synced("Folder/A.md", oldHash, oldHash, "rev-old");
    const vault = new FakeVault({ "Folder/A.md": "old" });
    const dropbox = new FakeDropbox({
      downloadContent: bytes("remote new"),
    });

    const result = await executeSyncPlan({
      vault: vault.asVault(),
      dropbox,
      rootPath: "/Vault",
      currentState: state([previous]),
      plan: plan([
        {
          kind: "download",
          path: "Folder/A.md",
          remote: remoteFile("Folder/A.md", newHash, "rev-new"),
          previous,
        },
      ]),
    });

    expect(dropbox.download).toHaveBeenCalledWith("/Vault/Folder/A.md");
    expect(vault.text("Folder/A.md")).toBe("remote new");
    expect(result.state.files["folder/a.md"]).toMatchObject({
      localContentHash: newHash,
      remoteContentHash: newHash,
      remoteRev: "rev-new",
    });
  });

  it("creates parent folders for new remote downloads", async () => {
    const contentHash = await hash("new remote");
    const vault = new FakeVault({});
    const dropbox = new FakeDropbox({
      downloadContent: bytes("new remote"),
    });

    await executeSyncPlan({
      vault: vault.asVault(),
      dropbox,
      rootPath: "/Vault",
      currentState: emptyState(),
      plan: plan([
        {
          kind: "download",
          path: "A/B/C.md",
          remote: remoteFile("A/B/C.md", contentHash, "rev"),
        },
      ]),
    });

    expect(vault.hasFolder("A")).toBe(true);
    expect(vault.hasFolder("A/B")).toBe(true);
    expect(vault.text("A/B/C.md")).toBe("new remote");
  });

  it("guards remote deletes with the previous Dropbox rev", async () => {
    const previous = synced("A.md", await hash("old"), await hash("old"), "rev-old");
    const vault = new FakeVault({});
    const dropbox = new FakeDropbox({
      metadata: remoteFile("/Vault/A.md", await hash("old"), "rev-new"),
    });

    await expect(
      executeSyncPlan({
        vault: vault.asVault(),
        dropbox,
        rootPath: "/Vault",
        currentState: state([previous]),
        plan: plan([
          {
            kind: "delete-remote",
            path: "A.md",
            remote: remoteFile("A.md", await hash("old"), "rev-old"),
            previous,
          },
        ]),
      }),
    ).rejects.toThrow(/Dropbox file changed before delete/);
    expect(dropbox.delete).not.toHaveBeenCalled();
  });

  it("deletes local files only when Dropbox is still missing", async () => {
    const oldHash = await hash("old");
    const previous = synced("A.md", oldHash, oldHash, "rev-old");
    const vault = new FakeVault({ "A.md": "old" });
    const dropbox = new FakeDropbox({
      metadataError: new Error('Dropbox /files/get_metadata failed with 409: {"error_summary":"path/not_found/"}'),
    });

    const result = await executeSyncPlan({
      vault: vault.asVault(),
      dropbox,
      rootPath: "/Vault",
      currentState: state([previous]),
      plan: plan([
        {
          kind: "delete-local",
          path: "A.md",
          previous,
        },
      ]),
    });

    expect(vault.hasFile("A.md")).toBe(false);
    expect(result.state.files["a.md"]).toBeUndefined();
  });

  it("refuses to execute plans that still have conflicts", async () => {
    await expect(
      executeSyncPlan({
        vault: new FakeVault({}).asVault(),
        dropbox: new FakeDropbox({}),
        rootPath: "/Vault",
        currentState: emptyState(),
        plan: {
          operations: [],
          conflicts: [
            {
              kind: "conflict",
              type: "both-modified",
              path: "a.md",
              message: "conflict",
            },
          ],
          summary: {
            uploads: 0,
            downloads: 0,
            remoteDeletes: 0,
            localDeletes: 0,
            noops: 0,
            conflicts: 1,
          },
        },
      }),
    ).rejects.toThrow(/Cannot sync/);
  });

  it("returns partial state for operations completed before a later failure", async () => {
    const firstHash = await hash("first");
    const secondHash = await hash("second");
    const vault = new FakeVault({
      "First.md": "first",
      "Second.md": "changed after planning",
    });
    const dropbox = new FakeDropbox({
      uploadResult: remoteFile("/Vault/First.md", firstHash, "rev-first"),
    });

    try {
      await executeSyncPlan({
        vault: vault.asVault(),
        dropbox,
        rootPath: "/Vault",
        currentState: emptyState(),
        plan: plan([
          {
            kind: "upload",
            path: "First.md",
            local: localFile("First.md", firstHash),
          },
          {
            kind: "upload",
            path: "Second.md",
            local: localFile("Second.md", secondHash),
          },
        ]),
      });
      throw new Error("Expected sync to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SyncExecutionError);
      const syncError = error as SyncExecutionError;
      expect(syncError.applied).toBe(1);
      expect(syncError.partialState.files["first.md"]).toMatchObject({
        remoteRev: "rev-first",
      });
      expect(syncError.partialState.files["second.md"]).toBeUndefined();
    }
  });
});

class FakeDropbox implements SyncDropboxClient {
  activeUploads = 0;
  maxUploadInFlight = 0;

  upload = vi.fn(async (args: { path: string; content: ArrayBuffer; rev?: string }) => {
    this.activeUploads += 1;
    this.maxUploadInFlight = Math.max(this.maxUploadInFlight, this.activeUploads);

    try {
      if (this.options.uploadDelayMs) {
        await delay(this.options.uploadDelayMs);
      }

      return this.options.uploadResult ?? remoteFile(args.path, "", "rev");
    } finally {
      this.activeUploads -= 1;
    }
  });
  download = vi.fn(async () => this.options.downloadContent ?? bytes(""));
  delete = vi.fn(async () => remoteFile("/Vault/Deleted.md", "", "rev"));
  createFolder = vi.fn(async () => undefined);
  getMetadata = vi.fn(async () => {
    if (this.options.metadataError) {
      throw this.options.metadataError;
    }
    return this.options.metadata ?? remoteFile("/Vault/A.md", "", "rev");
  });

  constructor(private readonly options: {
    uploadResult?: DropboxFileMetadata;
    uploadDelayMs?: number;
    downloadContent?: ArrayBuffer;
    metadata?: DropboxFileMetadata;
    metadataError?: Error;
  }) {}
}

class FakeVault {
  private readonly files = new Map<string, ArrayBuffer>();
  private readonly folders = new Set<string>();

  constructor(initialFiles: Record<string, string>) {
    for (const [path, value] of Object.entries(initialFiles)) {
      this.files.set(path, bytes(value));
      this.addParentFolders(path);
    }
  }

  asVault() {
    return {
      getFileByPath: (path: string) => this.hasFile(path) ? this.file(path) : null,
      getFolderByPath: (path: string) => this.folders.has(path) ? { path } : null,
      createFolder: async (path: string) => {
        this.folders.add(path);
        return { path };
      },
      readBinary: async (file: { path: string }) => {
        const content = this.files.get(file.path);
        if (!content) {
          throw new Error(`Missing local file: ${file.path}`);
        }
        return content;
      },
      modifyBinary: async (file: { path: string }, content: ArrayBuffer) => {
        this.files.set(file.path, content);
      },
      createBinary: async (path: string, content: ArrayBuffer) => {
        this.addParentFolders(path);
        this.files.set(path, content);
        return this.file(path);
      },
      delete: async (file: { path: string }) => {
        this.files.delete(file.path);
      },
    } as never;
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  hasFolder(path: string): boolean {
    return this.folders.has(path);
  }

  text(path: string): string {
    const content = this.files.get(path);
    if (!content) {
      throw new Error(`Missing local file: ${path}`);
    }
    return new TextDecoder().decode(content);
  }

  private file(path: string) {
    return {
      path,
      stat: {
        mtime: 1,
      },
    };
  }

  private addParentFolders(path: string): void {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.folders.add(current);
    }
  }
}

function plan(operations: SyncPlan["operations"]): SyncPlan {
  return {
    operations,
    conflicts: [],
    summary: {
      uploads: operations.filter((operation) => operation.kind === "upload").length,
      downloads: operations.filter((operation) => operation.kind === "download").length,
      remoteDeletes: operations.filter((operation) => operation.kind === "delete-remote").length,
      localDeletes: operations.filter((operation) => operation.kind === "delete-local").length,
      noops: operations.filter((operation) => operation.kind === "noop").length,
      conflicts: 0,
    },
  };
}

function localFile(path: string, contentHash: string) {
  return {
    path,
    pathLower: normalizePathKey(path),
    contentHash,
    size: 1,
    mtime: 1,
  };
}

function remoteFile(path: string, contentHash: string, rev: string): DropboxFileMetadata {
  return {
    tag: "file",
    name: path.split("/").pop() ?? path,
    pathDisplay: path,
    pathLower: normalizePathKey(path),
    id: `id:${path}`,
    clientModified: "2026-01-01T00:00:00Z",
    serverModified: "2026-01-01T00:00:01Z",
    rev,
    size: 1,
    contentHash,
  };
}

function synced(path: string, localContentHash: string, remoteContentHash: string, remoteRev: string): SyncedFileState {
  return {
    path,
    pathLower: normalizePathKey(path),
    localContentHash,
    remoteContentHash,
    remoteRev,
  };
}

function state(files: SyncedFileState[]): VaultboxSyncState {
  return {
    files: Object.fromEntries(files.map((file) => [file.pathLower, file])),
    lastSyncedAt: 1,
  };
}

function emptyState(): VaultboxSyncState {
  return {
    files: {},
    lastSyncedAt: 0,
  };
}

async function hash(value: string): Promise<string> {
  return getDropboxContentHash(bytes(value));
}

function bytes(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
