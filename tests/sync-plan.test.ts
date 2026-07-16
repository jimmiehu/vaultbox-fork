import { describe, expect, it } from "vitest";
import {
  createRemoteFileSnapshot,
  createSyncPlan,
  formatSyncPlan,
  getDropboxContentHash,
  normalizePathKey,
  resolveConflictsPreferRemote,
  scanLocalVault,
  shouldSyncPath,
  type LocalFileSnapshot,
  type SyncConflict,
  type SyncPlan,
  type SyncPlanSummary,
} from "../src/sync-plan";
import type { DropboxFileMetadata, SyncedFileState, VaultboxSyncState } from "../src/types";

describe("sync planner", () => {
  it("excludes Obsidian configuration files from sync", () => {
    expect(shouldSyncPath(".custom-obsidian/app.json", ".custom-obsidian")).toBe(false);
    expect(shouldSyncPath(".obsidian/app.json", ".custom-obsidian")).toBe(true);
    expect(shouldSyncPath("Notes/A.md", ".custom-obsidian")).toBe(true);
    expect(normalizePathKey("/Notes/A.md")).toBe("notes/a.md");
  });

  it("normalizes remote Dropbox paths relative to the selected folder", () => {
    const remote = createRemoteFileSnapshot(
      new Map([
        [
          "/vaults/personal/notes/a.md",
          remoteFile("/Vaults/Personal/Notes/A.md", "hash-a", "rev-a"),
        ],
      ]),
      "/Vaults/Personal",
    );

    expect([...remote.keys()]).toEqual(["notes/a.md"]);
    expect(remote.get("notes/a.md")).toMatchObject({
      pathDisplay: "Notes/A.md",
      pathLower: "notes/a.md",
    });
  });

  it("plans uploads and downloads for one-sided new files", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Local.md", "hash-local")),
      remoteFiles: remoteMap(remoteFile("Remote.md", "hash-remote", "rev-remote")),
    });

    expect(plan.summary).toMatchObject({
      uploads: 1,
      downloads: 1,
      conflicts: 0,
    });
    expect(plan.operations.map((operation) => operation.kind).sort()).toEqual(["download", "upload"]);
  });

  it("treats matching unsynced local and remote files as noops", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Same.md", "hash")),
      remoteFiles: remoteMap(remoteFile("Same.md", "hash", "rev")),
    });

    expect(plan.summary.noops).toBe(1);
    expect(plan.summary.conflicts).toBe(0);
    expect(formatSyncPlan(plan)).toContain("No sync required");
  });

  it("flags unsynced local and remote content at the same path as a conflict", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Same.md", "local")),
      remoteFiles: remoteMap(remoteFile("Same.md", "remote", "rev")),
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("both-new");
  });

  it("plans local edits, remote edits, and one-sided deletes from prior state", () => {
    const previous = state([
      synced("local-edit.md", "old", "old", "rev-old"),
      synced("remote-edit.md", "old", "old", "rev-old"),
      synced("local-delete.md", "old", "old", "rev-old"),
      synced("remote-delete.md", "old", "old", "rev-old"),
    ]);

    const plan = createSyncPlan({
      state: previous,
      localFiles: localMap(
        localFile("local-edit.md", "new-local"),
        localFile("remote-edit.md", "old"),
        localFile("remote-delete.md", "old"),
      ),
      remoteFiles: remoteMap(
        remoteFile("local-edit.md", "old", "rev-old"),
        remoteFile("remote-edit.md", "new-remote", "rev-new"),
        remoteFile("local-delete.md", "old", "rev-old"),
      ),
    });

    expect(plan.summary).toMatchObject({
      uploads: 1,
      downloads: 1,
      remoteDeletes: 1,
      localDeletes: 1,
      conflicts: 0,
    });
  });

  it("flags edit/delete and both-edited conflicts", () => {
    const previous = state([
      synced("both-edit.md", "old", "old", "rev-old"),
      synced("local-delete-remote-edit.md", "old", "old", "rev-old"),
      synced("local-edit-remote-delete.md", "old", "old", "rev-old"),
    ]);

    const plan = createSyncPlan({
      state: previous,
      localFiles: localMap(
        localFile("both-edit.md", "new-local"),
        localFile("local-edit-remote-delete.md", "new-local"),
      ),
      remoteFiles: remoteMap(
        remoteFile("both-edit.md", "new-remote", "rev-new"),
        remoteFile("local-delete-remote-edit.md", "new-remote", "rev-new"),
      ),
    });

    expect(plan.summary.conflicts).toBe(3);
    expect(plan.conflicts.map((conflict) => conflict.type).sort()).toEqual([
      "both-modified",
      "local-delete-remote-edit",
      "local-edit-remote-delete",
    ]);
  });

  it("flags case-only path mismatches before planning content changes", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Notes/A.md", "hash")),
      remoteFiles: remoteMap(remoteFile("notes/a.md", "hash", "rev")),
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("path-case-mismatch");
  });

  it("flags local files that block remote folder paths", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Notes", "local")),
      remoteFiles: remoteMap(remoteFile("Notes/A.md", "remote", "rev")),
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("path-shape-conflict");
    expect(plan.conflicts[0]?.path).toBe("notes");
    expect(plan.summary.uploads).toBe(0);
    expect(plan.summary.downloads).toBe(0);
  });

  it("flags remote files that block local folder paths", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Notes/A.md", "local")),
      remoteFiles: remoteMap(remoteFile("Notes", "remote", "rev")),
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("path-shape-conflict");
    expect(plan.conflicts[0]?.path).toBe("notes");
    expect(plan.summary.uploads).toBe(0);
    expect(plan.summary.downloads).toBe(0);
  });

  it("flags local files that differ only by case", () => {
    const plan = createSyncPlan({
      localFiles: localMap({
        ...localFile("Notes/A.md", "hash"),
        path: "Notes/A.md\nnotes/a.md",
      }),
      remoteFiles: new Map(),
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("local-case-conflict");
  });

  it("flags remote files that differ only by case", () => {
    const remote = createRemoteFileSnapshot(
      new Map([
        ["notes/a.md", remoteFile("/Vault/Notes/A.md", "hash-a", "rev-a")],
        ["notes/a-copy.md", remoteFile("/Vault/notes/a.md", "hash-b", "rev-b")],
      ]),
      "/Vault",
    );

    const plan = createSyncPlan({
      localFiles: new Map(),
      remoteFiles: remote,
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("remote-case-conflict");
  });

  it("treats matching local and remote edits as converged", () => {
    const plan = createSyncPlan({
      state: state([synced("Same.md", "old", "old", "rev-old")]),
      localFiles: localMap(localFile("Same.md", "new")),
      remoteFiles: remoteMap(remoteFile("Same.md", "new", "rev-new")),
    });

    expect(plan.summary.conflicts).toBe(0);
    expect(plan.summary.noops).toBe(1);
  });

  it("uses Dropbox content hashes for local content comparisons", async () => {
    const first = await getDropboxContentHash(new TextEncoder().encode("same").buffer);
    const second = await getDropboxContentHash(new TextEncoder().encode("same").buffer);
    const different = await getDropboxContentHash(new TextEncoder().encode("different").buffer);

    expect(first).toBe(second);
    expect(first).not.toBe(different);
  });
});

describe("selective sync excludes", () => {
  it("rejects excluded folders and files from the sync gate", () => {
    expect(shouldSyncPath("00-inbox/big.pdf", ".obsidian", ["00-inbox"])).toBe(false);
    expect(shouldSyncPath("00-inbox/nested/deep.pdf", ".obsidian", ["00-inbox/"])).toBe(false);
    expect(shouldSyncPath("00-inbox/big.pdf", ".obsidian", ["00-inbox/**"])).toBe(false);
    expect(shouldSyncPath("00-Inbox/Big.pdf", ".obsidian", ["00-inbox"])).toBe(false);
    expect(shouldSyncPath("Notes/Secret.md", ".obsidian", ["notes/secret.md"])).toBe(false);
    expect(shouldSyncPath("00-inbox2/other.md", ".obsidian", ["00-inbox"])).toBe(true);
    expect(shouldSyncPath("Notes/A.md", ".obsidian", ["00-inbox"])).toBe(true);
    expect(shouldSyncPath("Notes/A.md", ".obsidian", ["", "   "])).toBe(true);
    expect(shouldSyncPath(".obsidian/app.json", ".obsidian", ["00-inbox"])).toBe(false);
  });

  it("filters excluded paths from the local vault scan", async () => {
    const local = await scanLocalVault(
      fakeVault([
        { path: "Notes/A.md", content: "a" },
        { path: "00-inbox/big.pdf", content: "pdf" },
      ]),
      ".obsidian",
      ["00-inbox"],
    );

    expect([...local.keys()]).toEqual(["notes/a.md"]);
  });

  it("filters excluded paths from the remote Dropbox snapshot", () => {
    const remote = createRemoteFileSnapshot(
      new Map([
        ["/vault/notes/a.md", remoteFile("/Vault/Notes/A.md", "hash-a", "rev-a")],
        ["/vault/00-inbox/big.pdf", remoteFile("/Vault/00-inbox/big.pdf", "hash-b", "rev-b")],
      ]),
      "/Vault",
      { configDir: ".obsidian", excludePaths: ["00-inbox"] },
    );

    expect([...remote.keys()]).toEqual(["notes/a.md"]);
  });

  it("never uploads, downloads, or deletes one-sided excluded files", async () => {
    const excludePaths = ["00-inbox"];
    const localFiles = await scanLocalVault(
      fakeVault([
        { path: "00-inbox/local-only.pdf", content: "local" },
        { path: "Notes/Keep.md", content: "keep" },
      ]),
      ".obsidian",
      excludePaths,
    );
    const remoteFiles = createRemoteFileSnapshot(
      new Map([
        ["/vault/00-inbox/remote-only.pdf", remoteFile("/Vault/00-inbox/remote-only.pdf", "hash-r", "rev-r")],
      ]),
      "/Vault",
      { configDir: ".obsidian", excludePaths },
    );

    const plan = createSyncPlan({ localFiles, remoteFiles });

    expect(plan.operations.filter((operation) => operation.path.toLowerCase().includes("00-inbox"))).toEqual([]);
    expect(plan.summary).toMatchObject({
      uploads: 1,
      downloads: 0,
      remoteDeletes: 0,
      localDeletes: 0,
      conflicts: 0,
    });
    expect(plan.operations.map((operation) => `${operation.kind}:${operation.path}`)).toEqual([
      "upload:Notes/Keep.md",
    ]);
  });

  it("stops touching already-synced files once excluded, deleting neither side", async () => {
    const excludePaths = ["00-inbox"];
    const previous = state([synced("00-inbox/existing.pdf", "hash", "hash", "rev")]);
    const localFiles = await scanLocalVault(
      fakeVault([{ path: "00-inbox/existing.pdf", content: "pdf" }]),
      ".obsidian",
      excludePaths,
    );
    const remoteFiles = createRemoteFileSnapshot(
      new Map([
        ["/vault/00-inbox/existing.pdf", remoteFile("/Vault/00-inbox/existing.pdf", "hash", "rev")],
      ]),
      "/Vault",
      { configDir: ".obsidian", excludePaths },
    );

    const plan = createSyncPlan({ state: previous, localFiles, remoteFiles });

    expect(plan.summary).toMatchObject({
      uploads: 0,
      downloads: 0,
      remoteDeletes: 0,
      localDeletes: 0,
      conflicts: 0,
    });
    expect(plan.operations).toEqual([
      { kind: "noop", path: "00-inbox/existing.pdf", previous: previous.files["00-inbox/existing.pdf"] },
    ]);
  });

  it("keeps syncing excluded paths when the exclude list is empty", async () => {
    const localFiles = await scanLocalVault(
      fakeVault([{ path: "00-inbox/big.pdf", content: "pdf" }]),
      ".obsidian",
    );

    const plan = createSyncPlan({ localFiles, remoteFiles: new Map() });

    expect(plan.summary.uploads).toBe(1);
  });
});

function fakeVault(files: Array<{ path: string; content: string }>): Parameters<typeof scanLocalVault>[0] {
  return {
    getFiles: () => files.map((file) => ({ path: file.path, stat: { mtime: 1 } })),
    readBinary: async (file: { path: string }) => {
      const match = files.find((candidate) => candidate.path === file.path);
      if (!match) {
        throw new Error(`Missing local file: ${file.path}`);
      }

      return new TextEncoder().encode(match.content).buffer;
    },
  } as never;
}

describe("resolveConflictsPreferRemote", () => {
  it("resolves a both-new content conflict by overwriting local with the Dropbox version", () => {
    const remote = remoteFile("cities/kyiv.md", "remote-hash", "rev-r");
    const startingPlan: SyncPlan = {
      operations: [{ kind: "noop", path: "notes/a.md" }],
      conflicts: [conflict("both-new", "cities/kyiv.md", { remote })],
      summary: summary({ noops: 1, conflicts: 1 }),
    };

    const resolved = resolveConflictsPreferRemote(startingPlan);

    expect(resolved.conflicts).toHaveLength(0);
    expect(resolved.summary.conflicts).toBe(0);
    expect(resolved.summary.downloads).toBe(1);
    expect(resolved.operations.find((operation) => operation.path === "cities/kyiv.md")).toMatchObject({
      kind: "download",
      overwriteLocal: true,
      remote,
    });
  });

  it("never auto-deletes local: a file Dropbox has deleted still blocks", () => {
    const startingPlan: SyncPlan = {
      operations: [],
      conflicts: [conflict("local-edit-remote-delete", "a.md", { previous: synced("a.md", "h", "h", "rev") })],
      summary: summary({ conflicts: 1 }),
    };

    const resolved = resolveConflictsPreferRemote(startingPlan);

    expect(resolved.conflicts).toHaveLength(1);
    expect(resolved.operations).toHaveLength(0);
  });

  it("leaves structural case/path conflicts untouched", () => {
    const startingPlan: SyncPlan = {
      operations: [],
      conflicts: [conflict("path-shape-conflict", "A", {}), conflict("path-case-mismatch", "b.md", {})],
      summary: summary({ conflicts: 2 }),
    };

    const resolved = resolveConflictsPreferRemote(startingPlan);

    expect(resolved.conflicts).toHaveLength(2);
    expect(resolved.summary.downloads).toBe(0);
  });

  it("returns the plan unchanged when there are no conflicts", () => {
    const startingPlan: SyncPlan = { operations: [], conflicts: [], summary: summary({}) };
    expect(resolveConflictsPreferRemote(startingPlan)).toBe(startingPlan);
  });
});

function conflict(type: SyncConflict["type"], path: string, extras: Partial<SyncConflict>): SyncConflict {
  return { kind: "conflict", type, path, message: `conflict ${path}`, ...extras };
}

function summary(partial: Partial<SyncPlanSummary>): SyncPlanSummary {
  return { uploads: 0, downloads: 0, remoteDeletes: 0, localDeletes: 0, noops: 0, conflicts: 0, ...partial };
}

function localMap(...files: LocalFileSnapshot[]): Map<string, LocalFileSnapshot> {
  return new Map(files.map((file) => [file.pathLower, file]));
}

function remoteMap(...files: DropboxFileMetadata[]): Map<string, DropboxFileMetadata> {
  return new Map(files.map((file) => [file.pathLower, file]));
}

function localFile(path: string, contentHash: string): LocalFileSnapshot {
  return {
    path,
    pathLower: normalizePathKey(path),
    contentHash,
    size: 1,
    mtime: 1,
  };
}

function remoteFile(path: string, contentHash: string, rev: string): DropboxFileMetadata {
  const normalized = normalizePathKey(path);
  return {
    tag: "file",
    name: path.split("/").pop() ?? path,
    pathDisplay: path,
    pathLower: normalized,
    id: `id:${normalized}`,
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
