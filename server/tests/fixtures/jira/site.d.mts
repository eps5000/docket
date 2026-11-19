/** Types for site.mjs, the synthetic Jira Cloud site used by the import tests. */

export interface JiraFieldFixture {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string; custom?: string };
}

export interface FixtureProject {
  key: string;
  name: string;
  // Jira's own shapes, as recorded; the importer types what it reads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  issues: { id: string; key: string; fields: Record<string, any> }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  comments: Record<string, any[]>;
  attachments: Record<string, { size: number; fail?: boolean }>;
  pageSize?: number;
  delayMs?: number;
  /** Planned throttling, by search page offset: answered once each, in order. */
  throttle?: Record<number, { status: number; retryAfter?: string }[]>;
}

export interface JiraSiteOptions {
  origin?: string;
  email?: string;
  token?: string;
  slowDelayMs?: number;
  /** The site's cloudId (`/_edge/tenant_info`). */
  cloudId?: string;
  /** False: `/_edge/tenant_info` answers 404 (not an Atlassian site). */
  tenantInfo?: boolean;
  scopedToken?: string;
  limitedToken?: string;
  projects?: FixtureProject[];
}

export interface JiraSite {
  origin: string;
  email: string;
  token: string;
  cloudId: string;
  projects: Map<string, FixtureProject>;
  /**
   * Every request seen: method, path with query (the gateway's
   * `/ex/jira/<cloudId>` prefix removed) and where it went. Never headers.
   */
  requests: { method: string; path: string; via: 'site' | 'gateway' }[];
  handle(request: Request): Promise<Response>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export const FIXTURE_ORIGIN: string;
export const FIXTURE_EMAIL: string;
export const FIXTURE_TOKEN: string;
export const GATEWAY_ORIGIN: string;
export const FIXTURE_CLOUD_ID: string;
export const FIXTURE_SCOPED_TOKEN: string;
export const FIXTURE_LIMITED_TOKEN: string;
export const FIXTURE_ORG_KEY: string;
export const LOCKED_PROJECT: string;
export const FIELDS: JiraFieldFixture[];
export function generateProject(key: string, count: number, seed?: number): FixtureProject;
export function attachmentBytes(id: string, size: number): Buffer;
export function createJiraSite(opts?: JiraSiteOptions): JiraSite;
