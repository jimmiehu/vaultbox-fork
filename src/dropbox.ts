import { requestUrl } from "obsidian";
import type {
  DropboxFileMetadata,
  DropboxFolderMetadata,
  DropboxListResult,
  DropboxMetadata,
} from "./types";

const API_URL = "https://api.dropboxapi.com/2";
const CONTENT_URL = "https://content.dropboxapi.com/2";

export interface DropboxTokenProvider {
  getAccessToken(): Promise<string>;
}

export class DropboxClient {
  constructor(private readonly tokenProvider: DropboxTokenProvider) {}

  async listFolder(path: string): Promise<DropboxListResult> {
    const result = await this.rpc<{ entries: unknown[]; cursor: string; has_more: boolean }>(
      "/files/list_folder",
      {
        path,
        recursive: false,
        include_deleted: false,
        include_has_explicit_shared_members: false,
        include_mounted_folders: true,
        include_non_downloadable_files: false,
      },
    );

    return normalizeListResult(result);
  }

  async listFolderContinue(cursor: string): Promise<DropboxListResult> {
    const result = await this.rpc<{ entries: unknown[]; cursor: string; has_more: boolean }>(
      "/files/list_folder/continue",
      { cursor },
    );

    return normalizeListResult(result);
  }

  async listAllFiles(path: string): Promise<Map<string, DropboxFileMetadata>> {
    const files = new Map<string, DropboxFileMetadata>();
    let result = await this.listFolder(path);

    while (true) {
      for (const entry of result.entries) {
        if (entry.tag === "file") {
          files.set(entry.pathLower, entry);
        }
      }

      if (!result.hasMore) {
        return files;
      }

      result = await this.listFolderContinue(result.cursor);
    }
  }

  async download(path: string): Promise<ArrayBuffer> {
    return this.content<ArrayBuffer>("/files/download", { path }, undefined, "arrayBuffer");
  }

  async upload(args: {
    path: string;
    content: ArrayBuffer;
    rev?: string;
  }): Promise<DropboxFileMetadata> {
    const mode = args.rev ? { ".tag": "update", update: args.rev } : { ".tag": "add" };
    const result = await this.content<unknown>(
      "/files/upload",
      {
        path: args.path,
        mode,
        autorename: false,
        mute: false,
        strict_conflict: true,
      },
      args.content,
    );

    return normalizeMetadata(result) as DropboxFileMetadata;
  }

  async delete(path: string): Promise<DropboxMetadata> {
    const result = await this.rpc<unknown>("/files/delete_v2", { path });
    return normalizeMetadata((result as { metadata: unknown }).metadata);
  }

  async getMetadata(path: string): Promise<DropboxMetadata> {
    const result = await this.rpc<unknown>("/files/get_metadata", {
      path,
      include_deleted: false,
      include_media_info: false,
    });

    return normalizeMetadata(result);
  }

  private async rpc<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await requestUrl({
      url: `${API_URL}${endpoint}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.tokenProvider.getAccessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Dropbox ${endpoint} failed with ${response.status}: ${response.text}`);
    }

    return response.json as T;
  }

  private async content<T>(
    endpoint: string,
    args: unknown,
    body?: ArrayBuffer,
    responseType: "json" | "arrayBuffer" = "json",
  ): Promise<T> {
    const response = await requestUrl({
      url: `${CONTENT_URL}${endpoint}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.tokenProvider.getAccessToken()}`,
        "Content-Type": body ? "application/octet-stream" : "",
        "Dropbox-API-Arg": JSON.stringify(args),
      },
      body: body ? arrayBufferToBinaryString(body) : undefined,
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Dropbox ${endpoint} failed with ${response.status}: ${response.text}`);
    }

    if (responseType === "arrayBuffer") {
      return stringToArrayBuffer(response.text) as T;
    }

    return response.json as T;
  }
}

export function normalizeDropboxPath(path: string): string {
  const trimmed = path.trim();

  if (!trimmed || trimmed === "/") {
    return "";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function normalizeListResult(result: {
  entries: unknown[];
  cursor: string;
  has_more: boolean;
}): DropboxListResult {
  return {
    entries: result.entries.map(normalizeMetadata),
    cursor: result.cursor,
    hasMore: result.has_more,
  };
}

function normalizeMetadata(entry: unknown): DropboxMetadata {
  const raw = entry as Record<string, unknown>;
  const tag = raw[".tag"];

  if (tag === "file") {
    return {
      tag: "file",
      name: String(raw.name ?? ""),
      pathDisplay: String(raw.path_display ?? ""),
      pathLower: String(raw.path_lower ?? ""),
      id: String(raw.id ?? ""),
      clientModified: String(raw.client_modified ?? ""),
      serverModified: String(raw.server_modified ?? ""),
      rev: String(raw.rev ?? ""),
      size: Number(raw.size ?? 0),
      contentHash: String(raw.content_hash ?? ""),
    };
  }

  if (tag === "folder") {
    return {
      tag: "folder",
      name: String(raw.name ?? ""),
      pathDisplay: String(raw.path_display ?? ""),
      pathLower: String(raw.path_lower ?? ""),
      id: String(raw.id ?? ""),
    };
  }

  throw new Error(`Unsupported Dropbox metadata tag: ${String(tag)}`);
}

function arrayBufferToBinaryString(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return binary;
}

function stringToArrayBuffer(value: string): ArrayBuffer {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes.buffer;
}
