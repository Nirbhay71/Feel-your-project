const { Router } = require('express');
const { listUsers } = require('../controllers/users');

const router = Router();

router.get('/', listUsers);

module.exports = router;
