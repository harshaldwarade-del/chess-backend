import { Router } from 'express';
import { optionalUser, requireUser } from '../middleware/auth.js';
import { HttpError, route } from '../middleware/http.js';
import { live } from '../live/socket.js';

/* Games between players: the live state of one game, and the games you're in right now. */
const router = Router();

router.get(
  '/active',
  requireUser,
  route(async (req, res) => res.json({ active: live.activeFor(req.user._id) })),
);

router.get(
  '/:id',
  optionalUser,
  route(async (req, res) => {
    if (!/^[a-f0-9]{24}$/.test(req.params.id)) throw new HttpError(404, 'not_found', 'No such game.');
    const state = await live.state(req.params.id);
    if (!state) throw new HttpError(404, 'not_found', 'No such game.');
    res.json({ match: state });
  }),
);

export default router;
