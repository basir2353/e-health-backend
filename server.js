const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/db');
const { verifyEmailConnection } = require('./services/emailService');
const authRoutes = require('./routes/authRoutes');
const Report = require('./models/Report');
const auth = require('./middlewares/auth');
const Challenge = require('./models/challenges');
const User = require('./models/User');
const Call = require('./models/Call');
const http = require('http');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const socketHandler = require('./sockets/callHandlers');
const { Server } = require('socket.io');
const challengeRoutes = require('./routes/challenges');
const dr = require('./routes/doctor');
const Appointment = require('./models/Appointment');
const report = require('./routes/report');

const mongoose = require('mongoose'); // Add mongoose for schema/model

const allowedOrigins = [
  'http://localhost:3000',
  'https://emp-health-frontend.vercel.app'
];

// Load environment variables
dotenv.config();

// Create express app
const app = express();

// Create HTTP server for Socket.IO
const server = http.createServer(app);

// Connect to database
connectDB();

app.use(cors({
  origin: function (origin, callback) {
    console.log("🌍 Incoming origin:", origin);
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Middleware
app.use(helmet());
app.use(express.json());
app.use(morgan('dev'));

// Verify email service
verifyEmailConnection();

// Static files
app.use('/uploads', express.static('uploads'));

// Poll Schema & Model
const choiceSchema = new mongoose.Schema({
  text: { type: String, required: true },
  votes: { type: Number, default: 0 }
});

const pollSchema = new mongoose.Schema({
  question: { type: String, required: true },
  choices: [choiceSchema],
  createdAt: { type: Date, default: Date.now }
});

const Poll = mongoose.model('Poll', pollSchema);

// Poll routes

// GET /api/polls - get all polls
app.get('/api/polls', async (req, res) => {
  try {
    const polls = await Poll.find({});
    res.json({ polls });
  } catch (error) {
    console.error('Error fetching polls:', error);
    res.status(500).json({ message: 'Failed to fetch polls' });
  }
});

// POST /api/add_poll - create new poll
app.post('/api/add_poll', async (req, res) => {
  const { question, choices } = req.body;

  if (!question || !choices || !Array.isArray(choices) || choices.length < 2) {
    return res.status(400).json({ message: 'Invalid poll data. Question and at least two choices are required.' });
  }

  try {
    const poll = new Poll({
      question,
      choices: choices.map(choiceText => ({ text: choiceText, votes: 0 }))
    });

    await poll.save();

    res.status(201).json({ message: 'Poll created successfully', poll });
  } catch (error) {
    console.error('Error creating poll:', error);
    res.status(500).json({ message: 'Failed to create poll' });
  }
});

// Your existing routes

app.get('/', (req, res) => {
  res.send('CORS Configured!');
});

app.use('/api/auth', authRoutes);
app.use('/api', challengeRoutes);
app.use('/api', dr);
app.use('/api', report);

app.use('/api/protected', auth, (req, res) => {
  res.status(200).json({ message: 'You are logged in and can access this protected route.' });
});

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

app.post("/test", (req, res) => {
  res.json({
    message: "Test endpoint is working",
    data: req.body
  });
});

// Get all doctors
app.get('/api/all-doctors', async (req, res) => {
  try {
    const doctors = await User.find({ role: 'doctor' });
    res.status(200).json({ doctors });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch doctors', error: error.message });
  }
});

// Create appointment
app.post('/api/appointments', async (req, res) => {
  try {
    const { day, date, time, type, doctorName, avatarSrc, userId } = req.body;

    if (!day || !date || !time || !type || !doctorName || !avatarSrc || !userId) {
      return res.status(400).json({ message: 'All fields are required including userId.' });
    }

    const appointment = new Appointment({
      day,
      date,
      time,
      type,
      doctorName,
      avatarSrc,
      user: userId
    });

    await appointment.save();

    await User.findByIdAndUpdate(userId, {
      $push: { appointments: appointment._id }
    });

    res.status(201).json({ message: 'Appointment created successfully', appointment });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create appointment', error: error.message });
  }
});

// Get appointments
app.get('/api/appointments', async (req, res) => {
  try {
    const { userId } = req.query;
    let query = {};

    if (userId) {
      query.user = userId;
    }

    const appointments = await Appointment.find(query).populate('user', 'name email role');
    res.status(200).json({ appointments });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch appointments', error: error.message });
  }
});

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Initialize socket handlers
console.log('🔧 Initializing Socket.IO handlers...');
socketHandler(io);

// Start server
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
  console.log(`🌐 CORS origins: ${allowedOrigins.join(', ')}`);
  console.log('📡 Socket.IO server ready for connections');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('❌ UNHANDLED REJECTION:', err);
});
