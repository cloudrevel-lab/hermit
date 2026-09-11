/**
 * Release branches in these repos are mostly `release/<semver>` but not all:
 * there are date branches (release/2025-05-02) and ticket branches
 * (release/PROJ-96-file-upload). Sorting has to keep those visible rather
 * than dropping them, so non-semver names sort after semver ones.
 */
const SEMVER = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[.\-_+](.+))?$/

export function parseVersion (name) {
  const match = SEMVER.exec(name)
  if (!match) return { name, semver: false, parts: [], suffix: null }
  return {
    name,
    semver: true,
    parts: [Number(match[1]), Number(match[2]), Number(match[3] || 0)],
    suffix: match[4] || null
  }
}

/** Newest first. */
export function compareVersions (a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (va.semver !== vb.semver) return va.semver ? -1 : 1
  if (va.semver) {
    for (let i = 0; i < 3; i++) {
      if (va.parts[i] !== vb.parts[i]) return vb.parts[i] - va.parts[i]
    }
    // A plain x.y.z outranks x.y.z_outage and similar variants.
    if (!va.suffix && vb.suffix) return -1
    if (va.suffix && !vb.suffix) return 1
  }
  return String(b).localeCompare(String(a), undefined, { numeric: true })
}

export function stripPrefix (branch, prefix) {
  return branch.startsWith(prefix) ? branch.slice(prefix.length) : branch
}

/**
 * Collapses per-repo branch lists into one release list:
 *   [{ version, branch, repos: [repoId], missing: [repoId] }]
 */
export function collateReleases (perRepo, prefix) {
  const byVersion = new Map()
  const allRepoIds = perRepo.map(r => r.repoId)

  for (const { repoId, branches, error } of perRepo) {
    if (error) continue
    for (const branch of branches) {
      if (!branch.name.startsWith(prefix)) continue
      const version = stripPrefix(branch.name, prefix)
      if (!byVersion.has(version)) {
        byVersion.set(version, { version, branch: branch.name, repos: [], tips: {} })
      }
      const entry = byVersion.get(version)
      entry.repos.push(repoId)
      entry.tips[repoId] = branch.objectId
    }
  }

  return [...byVersion.values()]
    .map(entry => ({
      ...entry,
      missing: allRepoIds.filter(id => !entry.repos.includes(id)),
      isSemver: parseVersion(entry.version).semver
    }))
    .sort((a, b) => compareVersions(a.version, b.version))
}

/** The next release down from `version`, used to preselect a comparison base. */
export function previousRelease (versions, version) {
  const semver = versions.filter(v => parseVersion(v).semver)
  const index = semver.indexOf(version)
  return index !== -1 && index + 1 < semver.length ? semver[index + 1] : null
}
