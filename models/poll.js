// models/Poll.js
const mongoose = require('mongoose');

const choiceSchema = new mongoose.Schema({
  text: { type: String, required: true },
  votes: { type: Number, default: 0 },
});

const pollSchema = new mongoose.Schema({
  question: { type: String, required: true },
  choices: [choiceSchema],
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Poll', pollSchema);
