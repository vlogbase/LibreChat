const express = require('express');
const router = express.Router();
const { updateUserKey, deleteUserKey, getUserKeyExpiry } = require('../services/UserService');
const { requireJwtAuth } = require('../middleware/');

router.put('/', requireJwtAuth, async (req, res) => {
  // Prevent users from setting OpenAI keys as we're exclusively using OpenRouter
  if (req.body.name === 'openAI') {
    return res.status(403).send({ error: 'OpenAI API keys are managed by the system administrator' });
  }
  await updateUserKey({ userId: req.user.id, ...req.body });
  res.status(201).send();
});

router.delete('/:name', requireJwtAuth, async (req, res) => {
  const { name } = req.params;
  await deleteUserKey({ userId: req.user.id, name });
  res.status(204).send();
});

router.delete('/', requireJwtAuth, async (req, res) => {
  const { all } = req.query;

  if (all !== 'true') {
    return res.status(400).send({ error: 'Specify either all=true to delete.' });
  }

  await deleteUserKey({ userId: req.user.id, all: true });

  res.status(204).send();
});

router.get('/', requireJwtAuth, async (req, res) => {
  const { name } = req.query;
  const response = await getUserKeyExpiry({ userId: req.user.id, name });
  res.status(200).send(response);
});

module.exports = router;
