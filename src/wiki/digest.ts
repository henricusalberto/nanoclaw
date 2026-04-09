/**
 * Build the agent-digest.json + claims.jsonl machine caches.
 *
 * Schema matches OpenClaw's `extensions/memory-wiki/src/compile.ts:694-742`
 * exactly so the openclaw CLI can read our digest as if it had compiled it.
 *
 * agent-digest.json structure:
 *   {
 *     pageCounts: { entity: N, concept: N, ... },
 *     claimCount: N,
 *     claimHealth: { freshness: {...}, contested, lowConfidence, missingEvidence },
 *     contradictionClusters: [{ key, label, kind, entryCount, paths }],
 *     pages: [{
 *       id, title, kind, path, sourceIds, questions, contradictions,
 *       confidence, freshnessLevel, lastTouchedAt, claimCount,
 *       topClaims: [...max 5]
 *     }]
 *   }
 *
 * claims.jsonl: one JSON object per line, one per claim across the vault.
 */

import fs from 'fs';
import path from 'path';

import {
  assessClaimFreshness,
  assessPageFreshness,
  FreshnessLevel,
  isContestedClaim,
  isLowConfidence,
  isMissingEvidence,
  sortClaims,
  CONTESTED_STATUSES,
} from './claim-health.js';
import {
  parseWikiPage,
  WikiClaim,
  WikiPageFrontmatter,
  WikiPageKind,
} from './markdown.js';

const DIGEST_PATH = '.openclaw-wiki/cache/agent-digest.json';
const CLAIMS_JSONL_PATH = '.openclaw-wiki/cache/claims.jsonl';

interface DigestPageEntry {
  id: string;
  title: string;
  kind: WikiPageKind;
  path: string;
  sourceIds: string[];
  questions: string[];
  contradictions: string[];
  confidence?: number;
  freshnessLevel: FreshnessLevel;
  lastTouchedAt?: string;
  claimCount: number;
  topClaims: DigestClaimEntry[];
}

interface DigestClaimEntry {
  id?: string;
  text: string;
  status?: string;
  confidence?: number;
  evidenceCount: number;
  missingEvidence: boolean;
  evidence: WikiClaim['evidence'];
  freshnessLevel: FreshnessLevel;
  lastTouchedAt?: string;
}

interface ContradictionCluster {
  key: string;
  label: string;
  kind: 'claim-id' | 'page-note';
  entryCount: number;
  paths: string[];
}

export interface AgentDigest {
  pageCounts: Record<string, number>;
  claimCount: number;
  claimHealth: {
    freshness: Record<FreshnessLevel, number>;
    contested: number;
    lowConfidence: number;
    missingEvidence: number;
  };
  contradictionClusters: ContradictionCluster[];
  pages: DigestPageEntry[];
}

interface PageInput {
  filePath: string;
  relativePath: string;
  frontmatter: WikiPageFrontmatter;
}

// =============================================================================
// Digest builder
// =============================================================================

export function buildAgentDigest(pages: PageInput[]): AgentDigest {
  const pageCounts: Record<string, number> = {};
  let claimCount = 0;
  const freshness: Record<FreshnessLevel, number> = {
    fresh: 0,
    aging: 0,
    stale: 0,
    unknown: 0,
  };
  let contestedClaims = 0;
  let lowConfidenceClaims = 0;
  let missingEvidenceClaims = 0;

  // Contradiction tracking
  const claimsById = new Map<string, { page: PageInput; claim: WikiClaim }[]>();
  const contradictionPagesByKey = new Map<string, Set<string>>();

  const pageEntries: DigestPageEntry[] = [];

  for (const page of pages) {
    const fm = page.frontmatter;
    const kind = fm.pageType;
    if (!kind || !fm.id) continue;
    pageCounts[kind] = (pageCounts[kind] || 0) + 1;

    const pageFreshness = assessPageFreshness(fm.updatedAt);
    freshness[pageFreshness]++;

    const claims = Array.isArray(fm.claims) ? fm.claims : [];
    claimCount += claims.length;
    for (const claim of claims) {
      if (isContestedClaim(claim)) contestedClaims++;
      if (isLowConfidence(claim.confidence)) lowConfidenceClaims++;
      if (isMissingEvidence(claim)) missingEvidenceClaims++;
      if (claim.id) {
        const arr = claimsById.get(claim.id) || [];
        arr.push({ page, claim });
        claimsById.set(claim.id, arr);
      }
    }

    // Page-level contradictions (frontmatter array)
    if (Array.isArray(fm.contradictions) && fm.contradictions.length > 0) {
      for (const note of fm.contradictions) {
        const key = `page-note:${note}`;
        const set = contradictionPagesByKey.get(key) || new Set();
        set.add(page.relativePath);
        contradictionPagesByKey.set(key, set);
      }
    }

    const sortedClaims = sortClaims(claims);
    const topClaims: DigestClaimEntry[] = sortedClaims.slice(0, 5).map((c) => ({
      ...(c.id !== undefined && { id: c.id }),
      text: c.text,
      ...(c.status !== undefined && { status: c.status }),
      ...(c.confidence !== undefined && { confidence: c.confidence }),
      evidenceCount: c.evidence.length,
      missingEvidence: isMissingEvidence(c),
      evidence: c.evidence,
      freshnessLevel: assessClaimFreshness(c, fm.updatedAt),
      ...(c.updatedAt !== undefined && { lastTouchedAt: c.updatedAt }),
    }));

    pageEntries.push({
      id: fm.id,
      title: fm.title || fm.id,
      kind,
      path: page.relativePath,
      sourceIds: Array.isArray(fm.sourceIds) ? fm.sourceIds : [],
      questions: Array.isArray(fm.questions) ? fm.questions : [],
      contradictions: Array.isArray(fm.contradictions) ? fm.contradictions : [],
      ...(fm.confidence !== undefined && { confidence: fm.confidence }),
      freshnessLevel: pageFreshness,
      ...(fm.updatedAt !== undefined && { lastTouchedAt: fm.updatedAt }),
      claimCount: claims.length,
      topClaims,
    });
  }

  // Build contradiction clusters from claim-id collisions
  const contradictionClusters: ContradictionCluster[] = [];
  for (const [claimId, entries] of claimsById) {
    if (entries.length < 2) continue;
    // A cluster forms when claims share an id but differ in text or status
    const distinctKeys = new Set(
      entries.map((e) => `${e.claim.text}|${e.claim.status || ''}`),
    );
    if (distinctKeys.size < 2) continue;
    const paths = entries.map((e) => e.page.relativePath).sort();
    contradictionClusters.push({
      key: `claim-id:${claimId}`,
      label: claimId,
      kind: 'claim-id',
      entryCount: entries.length,
      paths,
    });
  }
  for (const [key, set] of contradictionPagesByKey) {
    if (set.size < 1) continue;
    contradictionClusters.push({
      key,
      label: key.replace(/^page-note:/, ''),
      kind: 'page-note',
      entryCount: set.size,
      paths: [...set].sort(),
    });
  }

  return {
    pageCounts,
    claimCount,
    claimHealth: {
      freshness,
      contested: contestedClaims,
      lowConfidence: lowConfidenceClaims,
      missingEvidence: missingEvidenceClaims,
    },
    contradictionClusters,
    pages: pageEntries.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

// =============================================================================
// claims.jsonl builder
// =============================================================================

interface ClaimsJsonlLine {
  id?: string;
  pageId: string;
  pageTitle: string;
  pageKind: WikiPageKind;
  pagePath: string;
  text: string;
  status?: string;
  confidence?: number;
  sourceIds: string[];
  evidenceCount: number;
  missingEvidence: boolean;
  evidence: WikiClaim['evidence'];
  freshnessLevel: FreshnessLevel;
  lastTouchedAt?: string;
}

export function buildClaimsJsonlLines(pages: PageInput[]): string[] {
  const lines: string[] = [];
  for (const page of pages) {
    const fm = page.frontmatter;
    const kind = fm.pageType;
    if (!kind || !fm.id) continue;
    const claims = Array.isArray(fm.claims) ? fm.claims : [];
    for (const claim of claims) {
      const line: ClaimsJsonlLine = {
        ...(claim.id !== undefined && { id: claim.id }),
        pageId: fm.id,
        pageTitle: fm.title || fm.id,
        pageKind: kind,
        pagePath: page.relativePath,
        text: claim.text,
        ...(claim.status !== undefined && { status: claim.status }),
        ...(claim.confidence !== undefined && { confidence: claim.confidence }),
        sourceIds: Array.isArray(fm.sourceIds) ? fm.sourceIds : [],
        evidenceCount: claim.evidence.length,
        missingEvidence: isMissingEvidence(claim),
        evidence: claim.evidence,
        freshnessLevel: assessClaimFreshness(claim, fm.updatedAt),
        ...(claim.updatedAt !== undefined && { lastTouchedAt: claim.updatedAt }),
      };
      lines.push(JSON.stringify(line));
    }
  }
  return lines;
}

// =============================================================================
// Disk writers
// =============================================================================

export function writeAgentDigest(vaultPath: string, digest: AgentDigest): void {
  const p = path.join(vaultPath, DIGEST_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(digest, null, 2) + '\n');
}

export function writeClaimsJsonl(vaultPath: string, lines: string[]): void {
  const p = path.join(vaultPath, CLAIMS_JSONL_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
}

export function getDigestPath(vaultPath: string): string {
  return path.join(vaultPath, DIGEST_PATH);
}

export function getClaimsJsonlPath(vaultPath: string): string {
  return path.join(vaultPath, CLAIMS_JSONL_PATH);
}
