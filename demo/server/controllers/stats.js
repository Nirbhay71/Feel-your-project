import { stats } from '../data.js';

export function getStats(req, res) {
  res.json(stats);
}
