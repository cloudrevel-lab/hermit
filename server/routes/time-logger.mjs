import { Router } from 'express'
import {
  deleteWorklogEntry, getContext, insertWorklog, rangeReport, updateWorklog, updateWorklogEntry
} from '../lib/time-logger.mjs'

// Jira worklogs for the Time logger page. Reads are harmless; the POST/PUT
// endpoints write to the signed-in user's own worklogs and are the only place
// outside cherry-pick where Hermit changes anything remote.
export const timeLoggerRouter = Router()

timeLoggerRouter.get('/context', async (req, res, next) => {
  try { res.json(await getContext()) } catch (err) { next(err) }
})

timeLoggerRouter.get('/range', async (req, res, next) => {
  try { res.json(await rangeReport(req.query.from, req.query.to)) } catch (err) { next(err) }
})

// Insert: add hours on top of what is already logged.
timeLoggerRouter.post('/worklog', async (req, res, next) => {
  try { res.json(await insertWorklog(req.body || {})) } catch (err) { next(err) }
})

// Update: make the day's total for the ticket exactly `hours` (0 deletes it).
timeLoggerRouter.put('/worklog', async (req, res, next) => {
  try { res.json(await updateWorklog(req.body || {})) } catch (err) { next(err) }
})

// Update one worklog by id, leaving the day's other entries for that ticket alone.
timeLoggerRouter.put('/worklog/:id', async (req, res, next) => {
  try { res.json(await updateWorklogEntry({ ...(req.body || {}), id: req.params.id })) } catch (err) { next(err) }
})

// Delete one worklog by id, leaving the day's other entries for that ticket alone.
timeLoggerRouter.delete('/worklog/:id', async (req, res, next) => {
  try {
    res.json(await deleteWorklogEntry({
      ticket: req.query.ticket, date: req.query.date, id: req.params.id
    }))
  } catch (err) { next(err) }
})
