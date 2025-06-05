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
const report = require('./routes/report');
const Appointment = require('./models/Appointment');

// Updated allowedOrigins
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

// Middleware
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
app.use(helmet());
app.use(express.json());
app.use(morgan('dev'));

// Verify email service
verifyEmailConnection();

// Static files
app.use('/uploads', express.static('uploads'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api', challengeRoutes);
app.use('/api', dr);
app.use('/api', report);

app.use('/api/protected', auth, (req, res) => {
  res.status(200).json({ message: 'You are logged in and can access this protected route.' });
});

// Updated Socket.IO CORS origin
const io = new Server(server, {
  cors: {
    origin: "https://emp-health-frontend.vercel.app",
    methods: ["GET", "POST"]
  }
});
socketHandler(io);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

// Test route
app.post("/test", (req, res) => {
  res.json({
    message: "Test endpoint is working",
    data: req.body
  });
});

// Add Poll (optional model Poll needs to be uncommented and imported if used)
// const Poll = require('./models/Poll');
// app.post('/api/add_poll', async (req, res) => { ... });

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

// Get appointments (optionally filtered by userId)
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

// Start server
const PORT = process.env.PORT;
server.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});
