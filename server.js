const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/db');
const { verifyEmailConnection } = require('./services/emailService');
const authRoutes = require('./routes/authRoutes');
const challengeRoutes = require('./routes/challenges');
const dr = require('./routes/doctor');
const report = require('./routes/report');
const auth = require('./middlewares/auth');

const Report = require('./models/Report');
const Challenge = require('./models/challenges');
const User = require('./models/User');
const Appointment = require('./models/Appointment');
const Call = require('./models/Call');

const http = require('http');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const socketHandler = require('./sockets/callHandlers');
const { Server } = require('socket.io');

dotenv.config();

const app = express();
const server = http.createServer(app);
connectDB();

const allowedOrigins = [
  'http://localhost:3000',
  'https://emp-health-frontend.vercel.app'
];

const corsOptions = {
  origin: function (origin, callback) {
    console.log("🌍 Incoming origin:", origin);
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// CORS handling
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // ✅ Preflight support

// Middleware
app.use(helmet());
app.use(express.json());
app.use(morgan('dev'));
verifyEmailConnection();
app.use('/uploads', express.static('uploads'));

// Poll schema
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
app.get('/api/polls', async (req, res) => {
  try {
    const polls = await Poll.find({});
    res.json({ polls });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch polls' });
  }
});

app.post('/api/add_poll', async (req, res) => {
  const { question, choices } = req.body;
  if (!question || !choices || !Array.isArray(choices) || choices.length < 2) {
    return res.status(400).json({ message: 'Question and at least two choices required.' });
  }

  try {
    const poll = new Poll({
      question,
      choices: choices.map(choiceText => ({ text: choiceText }))
    });

    await poll.save();
    res.status(201).json({ message: 'Poll created', poll });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create poll' });
  }
});

// Routes
app.get('/', (req, res) => res.send('CORS Configured!'));
app.use('/api/auth', authRoutes);
app.use('/api', challengeRoutes);
app.use('/api', dr);
app.use('/api', report);

app.use('/api/protected', auth, (req, res) => {
  res.status(200).json({ message: 'You are logged in and can access this protected route.' });
});

app.get('/health', (req, res) => res.status(200).json({ status: 'ok', message: 'Server is running' }));

app.post("/test", (req, res) => {
  res.json({ message: "Test endpoint is working", data: req.body });
});

app.get('/api/all-doctors', async (req, res) => {
  try {
    const doctors = await User.find({ role: 'doctor' });
    res.status(200).json({ doctors });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch doctors', error: error.message });
  }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const { day, date, time, type, doctorName, avatarSrc, userId } = req.body;

    if (!day || !date || !time || !type || !doctorName || !avatarSrc || !userId) {
      return res.status(400).json({ message: 'All fields are required including userId.' });
    }

    const appointment = new Appointment({
      day, date, time, type, doctorName, avatarSrc, user: userId
    });

    await appointment.save();
    await User.findByIdAndUpdate(userId, { $push: { appointments: appointment._id } });

    res.status(201).json({ message: 'Appointment created', appointment });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create appointment', error: error.message });
  }
});

app.get('/api/appointments', async (req, res) => {
  try {
    const { userId } = req.query;
    const query = userId ? { user: userId } : {};

    const appointments = await Appointment.find(query).populate('user', 'name email role');
    res.status(200).json({ appointments });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch appointments', error: error.message });
  }
});

// Socket.IO Setup
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  }
});

console.log('🔧 Initializing Socket.IO handlers...');
socketHandler(io);

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running in ${process.env.NODE_ENV || 'development'} on port ${PORT}`);
  console.log(`🌐 CORS origins: ${allowedOrigins.join(', ')}`);
  console.log('📡 Socket.IO server ready for connections');
});

process.on('unhandledRejection', (err) => {
  console.error('❌ UNHANDLED REJECTION:', err);
});
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err);
  process.exit(1); // Exit the process to avoid running in an unstable state
});   
