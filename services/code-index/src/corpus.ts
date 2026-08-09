import fs from 'node:fs';
import path from 'node:path';
import { EXCLUDE_RE, type RepoCfg, type SourceDir } from './config.js';

function walk(absDir: string, entry: SourceDir, root: string, acc: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(absDir, e.name);
    if (EXCLUDE_RE.test(full)) continue;
    if (e.isDirectory()) walk(full, entry, root, acc);
    else if (entry.exts.includes(path.extname(e.name))) {
      const rel = path.relative(root, full);
      if (!entry.only || entry.only(rel)) acc.push(rel);
    }
  }
}

/** Full corpus: every repo-relative source path under the configured source dirs
 *  (high-value SoT layer per ADR-0059) plus the named extra files, with
 *  generated/test/decl noise excluded. */
export function walkCorpus(repo: RepoCfg): string[] {
  const acc: string[] = [];
  for (const entry of repo.sourceDirs) {
    walk(path.join(repo.root, entry.dir), entry, repo.root, acc);
  }
  for (const rel of repo.extraFiles) {
    if (fs.existsSync(path.join(repo.root, rel))) acc.push(rel);
  }
  return [...new Set(acc)]; // dedupe in case an extra file overlaps a source tree
}

/** Does a repo-relative path belong to the indexed corpus? Used to filter a git
 *  diff down to files we actually index (a push touches plenty we ignore). */
export function inCorpus(repo: RepoCfg, relPath: string): boolean {
  if (repo.extraFiles.includes(relPath)) return true;
  if (EXCLUDE_RE.test(relPath)) return false;
  const ext = path.extname(relPath);
  for (const entry of repo.sourceDirs) {
    const prefix = entry.dir.endsWith('/') ? entry.dir : entry.dir + '/';
    if (relPath.startsWith(prefix) && entry.exts.includes(ext)) {
      if (!entry.only || entry.only(relPath)) return true;
    }
  }
  return false;
}
