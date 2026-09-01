// pages/api/schedule.js
// GET  -> current schedule { enabled, hour, minute }
// POST -> update schedule (body: { enabled?, hour?, minute? })
//
// Reminder: updating hour/minute here does NOT move the Vercel Cron time,
// which is fixed in vercel.json at deploy time. `enabled` is the live gate
// checked by /api/cron. See README for changing the actual cron time.

import { getSchedule, setSchedule } from '../../lib/db.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const schedule = await getSchedule();
      return res.status(200).json(schedule);
    }

    if (req.method === 'POST') {
      const { enabled, hour, minute } = req.body || {};
      const schedule = await setSchedule({ enabled, hour, minute });
      return res.status(200).json(schedule);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('schedule handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
