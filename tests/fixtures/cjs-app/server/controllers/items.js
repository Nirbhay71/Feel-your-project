const db = require('../db');

const list = async (req, res) => {
  const { rows } = await db.query('SELECT id, name FROM items ORDER BY id');
  res.json(rows);
};

const get = async (req, res) => {
  const { rows } = await db.query('SELECT * FROM items WHERE id = $1', [req.params.id]);
  res.json(rows[0]);
};

module.exports = { list, get };
