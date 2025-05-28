// routes/polls.js
const express = require('express');
const router = express.Router();
const Poll = require('../models/poll');

// GET /api/polls — fetch all polls
router.get('/', async (req, res) => {
  try {
    const polls = await Poll.find({});
    res.json({ polls });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch polls', error });
  }
});

// POST /api/add_poll — create new poll
router.post('/add_poll', async (req, res) => {
  const { question, choices } = req.body;

  if (!question || !choices || !Array.isArray(choices) || choices.length < 2) {
    return res.status(400).json({ message: 'Invalid poll data' });
  }

  try {
    // Create poll with choices as objects { text, votes }
    const poll = new Poll({
      question,
      choices: choices.map(choice => ({ text: choice, votes: 0 })),
    });

    await poll.save();

    res.status(201).json({ message: 'Poll created successfully', poll });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create poll', error });
  }
});

module.exports = router;
