// pages/api/access.js
// Manage who can log in. Owner only.
// GET  -> { ownerEmail, allowed }
// POST { action: 'add'|'remove', email } -> updated list

import { requireOwner, getAccess, addAllowed, removeAllowed } from '../../lib/auth.js';

export default async function handler(req, res) {
  const session = await requireOwner(req, res);
  if (!session) return;

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await getAccess());
    }
    if (req.method === 'POST') {
      const { action, email } = req.body || {};
      if (action === 'add') return res.status(200).json(await addAllowed(email));
      if (action === 'remove') return res.status(200).json(await removeAllowed(email));
      return res.status(400).json({ error: 'Unknown action' });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
