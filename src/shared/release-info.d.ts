export const APP_VERSION: "1.0.0";
export const MCP_SERVER_VERSION: typeof APP_VERSION;
export const MCP_PROTOCOL_VERSION: "1.2.0";
export const PROFILE_SCHEMA_VERSION: 1;
export const RUNTIME_METADATA_VERSION: 3;
export const MINIMUM_EDGE_MAJOR_VERSION: 109;

export interface CodexBrowserReleaseInfo {
  appVersion: string;
  mcpServerVersion: string;
  protocolVersion: string;
  profileSchemaVersion: number;
  runtimeMetadataVersion: number;
  minimumEdgeMajorVersion: number;
}

export const RELEASE_INFO: Readonly<CodexBrowserReleaseInfo>;
