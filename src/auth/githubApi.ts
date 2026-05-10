// Thin wrapper for the bits of the GitHub REST API we need to open a
// move PR: read main's HEAD, create a branch, commit a file, open a PR.
//
// We use a GitHub App User-to-Server token (the `Authorization: Bearer`
// header). Tokens are scoped to whatever repositories the app is installed
// on (theatrum) and last 8 hours; on 401 we throw GitHubAuthError so the
// UI can prompt the user to sign in again.

const GH = 'https://api.github.com';

/** Thrown when GitHub returns 401 — token expired or revoked. */
export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

interface RequestInitJson extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

async function gh<T>(token: string, path: string, init: RequestInitJson = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  let body: BodyInit | null | undefined = undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(`${GH}${path}`, { ...init, headers, body });
  if (r.status === 401) {
    throw new GitHubAuthError('GitHub session expired (token rejected).');
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${r.status}: ${text}`);
  }
  return (await r.json()) as T;
}

export interface GitRef {
  ref: string;
  object: { sha: string };
}

export function getRef(token: string, repo: string, branch: string): Promise<GitRef> {
  return gh<GitRef>(token, `/repos/${repo}/git/ref/heads/${branch}`);
}

export function createBranch(
  token: string,
  repo: string,
  branchName: string,
  fromSha: string,
): Promise<GitRef> {
  return gh<GitRef>(token, `/repos/${repo}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${branchName}`, sha: fromSha },
  });
}

export interface GitFile {
  sha: string;
  content: string;
}

export function getFile(token: string, repo: string, path: string, ref: string): Promise<GitFile> {
  return gh<GitFile>(token, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
}

export function putFile(
  token: string,
  repo: string,
  path: string,
  branch: string,
  message: string,
  base64Content: string,
  fileSha: string,
): Promise<unknown> {
  return gh(token, `/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: {
      message,
      content: base64Content,
      sha: fileSha,
      branch,
    },
  });
}

export interface PullRequest {
  number: number;
  html_url: string;
}

export function createPullRequest(
  token: string,
  repo: string,
  args: { title: string; body: string; head: string; base: string },
): Promise<PullRequest> {
  return gh<PullRequest>(token, `/repos/${repo}/pulls`, {
    method: 'POST',
    body: args,
  });
}

export interface PullStatus {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  html_url: string;
}

export function getPullRequest(
  token: string,
  repo: string,
  pullNumber: number,
): Promise<PullStatus> {
  return gh<PullStatus>(token, `/repos/${repo}/pulls/${pullNumber}`);
}

export interface IssueComment {
  body: string;
  user: { login: string };
}

export function listIssueComments(
  token: string,
  repo: string,
  issueNumber: number,
): Promise<IssueComment[]> {
  return gh<IssueComment[]>(token, `/repos/${repo}/issues/${issueNumber}/comments`);
}

/** UTF-8-safe base64 encoder for File API. */
export function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
