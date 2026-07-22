const { cors, safeErr } = require('./_lib/db');
const { sendPush } = require('./_lib/push');

// POST /api/send-push
// Headers: x-push-secret: <PUSH_SECRET>
// Body: { title, body, url?, image?, token? | userKey? | role? | topic? }
// Precedence: token > userKey > role > topic. None given → broadcasts to
// 'all_users'. See NOTIFICATION_PROTOCOL.md §3.
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const secret = req.headers['x-push-secret'];
    if (!process.env.PUSH_SECRET || secret !== process.env.PUSH_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const { title, body, url, image, token, userKey, role, topic } = req.body || {};
    if (!title || !body) return res.status(400).json({ ok: false, error: 'title ও body প্রয়োজন' });

    const result = await sendPush({ title, body, url, image, token, userKey, role, topic });
    return res.json(result);
  } catch (e) {
    res.json({ ok: false, error: safeErr(e) });
  }
};
