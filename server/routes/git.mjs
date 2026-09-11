import { Router } from 'express'
import { branchesFor, CHERRY_PICK_MODES, cherryPick, compareAcrossRepos, compareRefs, releaseOverview } from '../lib/git-service.mjs'
import { getDb } from '../lib/db.mjs'

export const gitRouter = Router()

gitRouter.get('/releases', async (req, res, next) => {
  try {
    res.json(await releaseOverview({ refresh: req.query.refresh === '1' }))
  } catch (err) { next(err) }
})

gitRouter.post('/compare', async (req, res, next) => {
  try {
    const { base, target, repoIds, refresh } = req.body || {}
    if (!base || !target) return res.status(400).json({ error: 'base and target branches are required' })
    if (base === target) return res.status(400).json({ error: 'Pick two different branches' })
    res.json(await compareAcrossRepos({ base, target, repoIds, refresh: Boolean(refresh) }))
  } catch (err) { next(err) }
})

gitRouter.post('/compare-refs', async (req, res, next) => {
  try {
    const { repoId, left, right, refresh } = req.body || {}
    if (!repoId || !left || !right) return res.status(400).json({ error: 'repoId, left and right are required' })
    if (left === right) return res.status(400).json({ error: 'Pick two different refs' })
    res.json(await compareRefs({ repoId, left, right, refresh: Boolean(refresh) }))
  } catch (err) { next(err) }
})

gitRouter.get('/repos/:id/branches', async (req, res, next) => {
  try {
    res.json(await branchesFor(req.params.id, { refresh: req.query.refresh === '1' }))
  } catch (err) { next(err) }
})

/**
 * Cherry-picks are a write against the user's repo, so they are off unless
 * explicitly enabled in Settings, and only providers that declare the
 * capability accept them. The commits always land on a NEW topic branch first —
 * the target branch is never rewritten. `mode` then says how far to carry them:
 * "branch" stops there, "pr" opens the pull request, and "auto" also sets it to
 * complete itself, which is a merge into the target and so gated separately.
 */
gitRouter.post('/cherry-pick', async (req, res, next) => {
  try {
    const db = await getDb()
    if (!db.data.settings.allowCherryPickWrites) {
      return res.status(403).json({
        error: 'Cherry-pick writes are disabled',
        hint: 'Enable "Allow cherry-pick writes" in Settings first.'
      })
    }
    const { repoId, commitIds, ontoRef, topicBranch, mode = 'branch' } = req.body || {}
    if (!repoId || !commitIds?.length || !ontoRef) {
      return res.status(400).json({ error: 'repoId, commitIds and ontoRef are required' })
    }
    if (!CHERRY_PICK_MODES.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of ${CHERRY_PICK_MODES.join(', ')}` })
    }
    if (mode === 'auto' && !db.data.settings.allowCherryPickAutoComplete) {
      return res.status(403).json({
        error: 'Completing the pull request automatically is disabled',
        hint: 'Enable "Let the console complete the pull request" in Settings, or choose a mode that stops at the pull request.'
      })
    }
    res.json(await cherryPick({ repoId, commitIds, ontoRef, topicBranch, mode }))
  } catch (err) { next(err) }
})
