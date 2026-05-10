// Thin wrapper for the bits of the GitHub REST API we need to open a
// move PR: read main's HEAD, create a branch, commit a file, open a PR.
//
// Auth is handled transparently by `authedFetch` — proactive refresh
// when the token is near expiry, reactive refresh on a 401. Callers
// don't pass tokens; they just call these functions.

import { authedFetch, GitHubAuthError } from './session';

export { GitHubAuthError };

const GH = 'https://api.github.com';

interface RequestInitJson extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

async function gh<T>(path: string, init: RequestInitJson = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  let body: BodyInit | undefined = undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['Content-Type'] = 'application/json';
  }
  // GitHub returns `cache-control: private, max-age=60` on most read
  // endpoints, which the browser respects — so a 1 s polling loop was
  // hitting the in-memory cache 59 out of 60 times and only seeing
  // upstream changes after a full minute. `no-cache` forces revalidation
  // against GitHub's ETag on every call: lightweight 304 most polls,
  // 200-with-fresh-bytes the moment something actually changes.
  const r = await authedFetch(`${GH}${path}`, { ...init, headers, body, cache: 'no-cache' });
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

export function getRef(repo: string, branch: string): Promise<GitRef> {
  return gh<GitRef>(`/repos/${repo}/git/ref/heads/${branch}`);
}

export function createBranch(
  repo: string,
  branchName: string,
  fromSha: string,
): Promise<GitRef> {
  return gh<GitRef>(`/repos/${repo}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${branchName}`, sha: fromSha },
  });
}

export interface GitFile {
  sha: string;
  content: string;
}

export function getFile(repo: string, path: string, ref: string): Promise<GitFile> {
  return gh<GitFile>(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
}

export function putFile(
  repo: string,
  path: string,
  branch: string,
  message: string,
  base64Content: string,
  fileSha: string,
): Promise<unknown> {
  return gh(`/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: { message, content: base64Content, sha: fileSha, branch },
  });
}

export interface PullRequest {
  number: number;
  html_url: string;
}

export function createPullRequest(
  repo: string,
  args: { title: string; body: string; head: string; base: string },
): Promise<PullRequest> {
  return gh<PullRequest>(`/repos/${repo}/pulls`, {
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

export function getPullRequest(repo: string, pullNumber: number): Promise<PullStatus> {
  return gh<PullStatus>(`/repos/${repo}/pulls/${pullNumber}`);
}

export interface IssueComment {
  body: string;
  user: { login: string };
}

export function listIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
  return gh<IssueComment[]>(`/repos/${repo}/issues/${issueNumber}/comments`);
}

/** UTF-8-safe base64 encoder for File API. */
export function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
