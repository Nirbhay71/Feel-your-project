const db = require('../db');

exports.listUsers = async (req, res) => {
  const { rows } = await db.query('SELECT id, email FROM users');
  res.json(rows);
};
