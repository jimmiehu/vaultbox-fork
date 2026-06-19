import { describe, expect, it } from "vitest";
import {
  createRemoteFileSnapshot,
  createSyncPlan,
  formatSyncPlan,
  getDropboxContentHash,
  normalizePathKey,
  shouldSyncPath,
  type LocalFileSnapshot,
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
