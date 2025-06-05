const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/db');
const { verifyEmailConnection } = require('./services/emailService');
const authRoutes = require('./routes/authRoutes');
const challengeRoutes = require('./routes/challenges');
const doctorRoutes = require('./routes/doctor');
const reportRoutes = require('./routes/report');

const Report = require('./models/Report');
const auth = require('./middlewares/auth');
const Challenge = require('./models/challenges');
const User = require('./models/User');
const Call = require('./models/Call');
const Appointment = require('./models/Appointment');
const http = require('http');
const mongoose = require('mongoose');
const socketHandler = require('./sockets/callHandlers');
const { Server } = require('socket.io');

// Load environment variables
dotenv.config();

// Allowed CORS origins
const allowedOrigins = [
  'http://localhost:3000',
  'https://emp-health-frontend.vercel.app'
];

// Create express app and HTTP server
const app = express();
const server = http.createServer(app);

// Connect to MongoDB
connectDB();

// CORS configuration
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Middlewares
app.use(helmet());
app.use(express.json());
app.use(morgan('dev'));

// Email service check
verifyEmailConnection();

// Serve static files
app.use('/uploads', express.static('uploads'));

// Poll model
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

// --- ROUTES ---

app.get('/', (req, res) => res.send('CORS Configured!'));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok', message: 'Server is running' }));

app.post('/test', (req, res) => res.json({ message: 'Test endpoint is working', data: req.body }));

// Polls
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
    return res.status(400).json({ message: 'Invalid poll data. Question and at least two choices are required.' });
  }

  try {
    const poll = new Poll({
      question,
      choices: choices.map(text => ({ text }))
    });

    await poll.save();
    res.status(201).json({ message: 'Poll created successfully', poll });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create poll' });
  }
});

// Protected route example
app.use('/api/protected', auth, (req, res) => {
  res.status(200).json({ message: 'You are logged in and can access this protected route.' });
});

// Mount external route files (double-checking path prefixes)
app.use('/api/auth', authRoutes);
app.use('/api/challenges', challengeRoutes);
app.use('/api/doctors', doctorRoutes);
app.use('/api/reports', reportRoutes);

// Doctors list
app.get('/api/all-doctors', async (req, res) => {
  try {
    const doctors = await User.find({ role: 'doctor' });
    res.status(200).json({ doctors });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch doctors', error: error.message });
  }
});

// Appointments
app.post('/api/appointments', async (req, res) => {
  try {
    const { day, date, time, type, doctorName, avatarSrc, userId } = req.body;

    if (!day || !date || !time || !type || !doctorName || !avatarSrc || !userId) {
      return res.status(400).json({ message: 'All fields are required including userId.' });
    }

    const appointment = new Appointment({ day, date, time, type, doctorName, avatarSrc, user: userId });
    await appointment.save();

    await User.findByIdAndUpdate(userId, {
      $push: { appointments: appointment._id }
    });

    res.status(201).json({ message: 'Appointment created successfully', appointment });
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

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Socket handler
console.log('🔧 Initializing Socket.IO handlers...');
socketHandler(io);

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 CORS allowed: ${allowedOrigins.join(', ')}`);
  console.log('📡 Socket.IO ready for connections');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('❌ UNHANDLED REJECTION:', err);
});
