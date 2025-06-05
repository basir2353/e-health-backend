const User = require('../models/User');
const Call = require('../models/Call');
const Joi = require('joi'); // For input validation

const activeUsers = new Map(); // socket.id => userData
const activeCalls = new Map(); // callId => callInfo

// Simple in-memory rate limiter per socketId & event
const rateLimiter = new Map();

function socketHandler(io) {
  io.use(async (socket, next) => {
    // Middleware to authenticate user on connection
    // For example, validate a JWT token or session sent as a query param or header
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication error: No token'));
    }
    try {
      // Validate token, find userId from token (replace with your auth logic)
      const userId = await verifyToken(token);
      if (!userId) throw new Error('Invalid token');
      
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');
      
      // Attach user info to socket for future use
      socket.user = {
        id: user._id.toString(),
        name: user.name || user.username || user.email,
        role: user.role,
      };
      next();
    } catch (err) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    const { id: socketId, user } = socket;
    console.log(`✅ [${new Date().toISOString()}] User connected: ${user.name} (${user.role}) SocketID: ${socketId}`);

    // Save active user info with socketId
    activeUsers.set(socketId, {
      ...user,
      socketId,
    });

    // Mark user online in DB (atomic update)
    User.findByIdAndUpdate(user.id, { isOnline: true, socketId }, { new: true }).exec().catch(console.error);

    // Send own info back to user
    socket.emit('your-info', { ...user, socketId });

    // Notify other users based on role
    updateUserAvailability(socket, io);

    // Rate limiting helper
    function checkRateLimit(eventName) {
      const key = `${socketId}:${eventName}`;
      const now = Date.now();
      const windowMs = 1000; // 1 second window
      const maxCalls = 5;

      const record = rateLimiter.get(key) || { count: 0, start: now };
      if (now - record.start > windowMs) {
        // reset window
        rateLimiter.set(key, { count: 1, start: now });
        return true;
      } else {
        if (record.count >= maxCalls) {
          return false;
        }
        rateLimiter.set(key, { count: record.count + 1, start: record.start });
        return true;
      }
    }

    // -------------------- Event Handlers --------------------

    socket.on('get-available-users', () => {
      if (!checkRateLimit('get-available-users')) {
        return socket.emit('error', { message: 'Rate limit exceeded' });
      }
      const role = user.role === 'doctor' ? 'employee' : user.role === 'employee' ? 'doctor' : null;
      if (!role) return;

      const availableUsers = getOnlineUsersByRole(role);
      socket.emit('available-users', availableUsers);
    });

    socket.on('initiate-call', async ({ calleeId }) => {
      if (!checkRateLimit('initiate-call')) {
        return socket.emit('call-error', { message: 'Rate limit exceeded' });
      }

      // Validate input with Joi
      const schema = Joi.object({
        calleeId: Joi.string().length(24).required(), // MongoDB ObjectId length
      });
      const { error } = schema.validate({ calleeId });
      if (error) {
        return socket.emit('call-error', { message: 'Invalid callee ID' });
      }

      try {
        if (calleeId === user.id) {
          return socket.emit('call-error', { message: 'Cannot call yourself' });
        }

        const callee = await User.findById(calleeId);
        if (!callee || !callee.isOnline || !callee.socketId) {
          return socket.emit('call-error', { message: 'User is offline' });
        }

        // Prevent duplicate calls if there is an active call between these users
        for (const call of activeCalls.values()) {
          if (
            (call.caller.id === user.id && call.callee.id === calleeId && call.status === 'initiated') ||
            (call.caller.id === calleeId && call.callee.id === user.id && call.status === 'initiated')
          ) {
            return socket.emit('call-error', { message: 'Call already in progress' });
          }
        }

        const call = new Call({ caller: user.id, callee: calleeId, status: 'initiated' });
        await call.save();

        const callId = call._id.toString();
        const callInfo = {
          callId,
          caller: { id: user.id, name: user.name, socketId },
          callee: { id: calleeId, name: callee.name || callee.email, socketId: callee.socketId },
          status: 'initiated',
          startTime: new Date()
        };

        activeCalls.set(callId, callInfo);

        io.to(callee.socketId).emit('incoming-call', {
          callId,
          callerId: user.id,
          callerName: user.name,
          callerSocketId: socketId
        });

        broadcastToAdmins(io, activeUsers, 'new-call', callInfo);
      } catch (err) {
        console.error(`❌ initiate-call error [${socketId}]:`, err);
        socket.emit('call-error', { message: 'Failed to initiate call' });
      }
    });

    socket.on('accept-call', async ({ callId }) => {
      if (!checkRateLimit('accept-call')) {
        return socket.emit('call-error', { message: 'Rate limit exceeded' });
      }
      if (!callId || typeof callId !== 'string') {
        return socket.emit('call-error', { message: 'Invalid call ID' });
      }

      try {
        const call = activeCalls.get(callId);
        if (!call) return socket.emit('call-error', { message: 'Call not found' });

        // Only callee can accept the call
        if (call.callee.id !== user.id) {
          return socket.emit('call-error', { message: 'Not authorized to accept this call' });
        }

        call.status = 'accepted';
        await Call.findByIdAndUpdate(callId, { status: 'accepted' });

        io.to(call.caller.socketId).emit('call-accepted', { callId });
        io.to(call.callee.socketId).emit('call-accepted', { callId });

        broadcastToAdmins(io, activeUsers, 'call-status-update', call);
      } catch (err) {
        console.error(`❌ accept-call error [${socketId}]:`, err);
      }
    });

    socket.on('reject-call', async ({ callId }) => {
      if (!checkRateLimit('reject-call')) {
        return socket.emit('call-error', { message: 'Rate limit exceeded' });
      }
      if (!callId || typeof callId !== 'string') return;

      try {
        const call = activeCalls.get(callId);
        if (!call) return;

        // Only callee can reject
        if (call.callee.id !== user.id) return;

        await Call.findByIdAndUpdate(callId, { status: 'rejected', endTime: new Date() });

        io.to(call.caller.socketId).emit('call-rejected', { callId });
        activeCalls.delete(callId);

        broadcastToAdmins(io, activeUsers, 'call-ended', { callId, reason: 'rejected' });
      } catch (err) {
        console.error(`❌ reject-call error [${socketId}]:`, err);
      }
    });

    socket.on('end-call', async ({ callId }) => {
      if (!checkRateLimit('end-call')) {
        return socket.emit('call-error', { message: 'Rate limit exceeded' });
      }
      if (!callId || typeof callId !== 'string') return;

      try {
        const call = activeCalls.get(callId);
        if (!call) return;

        // Only caller or callee can end the call
        if (![call.caller.id, call.callee.id].includes(user.id)) {
          return socket.emit('call-error', { message: 'Not authorized to end this call' });
        }

        const endTime = new Date();
        const duration = Math.floor((endTime - call.startTime) / 1000);

        await Call.findByIdAndUpdate(callId, { status: 'ended', endTime, duration });

        io.to(call.caller.socketId).emit('call-ended', { callId });
        io.to(call.callee.socketId).emit('call-ended', { callId });

        activeCalls.delete(callId);
        broadcastToAdmins(io, activeUsers, 'call-ended', { callId, duration });
      } catch (err) {
        console.error(`❌ end-call error [${socketId}]:`, err);
      }
    });

    // WebRTC signaling events (offer, answer, ice-candidate)
    socket.on('offer', ({ offer, target }) => {
      if (!target || typeof target !== 'string') return;
      io.to(target).emit('offer', { offer, from: socketId });
    });

    socket.on('answer', ({ answer, target }) => {
      if (!target || typeof target !== 'string') return;
      io.to(target).emit('answer', { answer, from: socketId });
    });

    socket.on('ice-candidate', ({ candidate, target }) => {
      if (!target || typeof target !== 'string') return;
      io.to(target).emit('ice-candidate', { candidate, from: socketId });
    });

    socket.on('get-active-calls', () => {
      if (user.role !== 'admin') return;
      socket.emit('active-calls', Array.from(activeCalls.values()));
    });

    socket.on('disconnect', async () => {
      try {
        console.log(`👋 [${new Date().toISOString()}] User disconnected: ${user.name} (${user.role}) SocketID: ${socketId}`);

        activeUsers.delete(socketId);
        await User.findByIdAndUpdate(user.id, { isOnline: false, socketId: null });

        // End any active calls involving this user
        for (const [callId, call] of activeCalls.entries()) {
          if (call.caller.socketId === socketId || call.callee.socketId === socketId) {
            const otherSocketId = call.caller.socketId === socketId ? call.callee.socketId : call.caller.socketId;
            io.to(otherSocketId).emit('call-ended', { callId, reason: 'disconnect' });
            await Call.findByIdAndUpdate(callId, { status: 'ended', endTime: new Date() });
            activeCalls.delete(callId);
          }
        }

        // Notify others about this user going offline
        const notifyRole = user.role === 'doctor' ? 'employee' : user.role === 'employee' ? 'doctor' : null;
        if (notifyRole) {
          broadcastToRole(io, activeUsers, notifyRole, 'user-disconnected', {
            id: user.id,
            name: user.name,
            role: user.role
          });
        }

        broadcastToAdmins(io, activeUsers, 'user-status-update', {
          userId: user.id,
          username: user.name,
          role: user.role,
          isOnline: false
        });

      } catch (err) {
        console.error(`❌ disconnect error [${socketId}]:`, err);
      }
    });
  });

  // Status log every 30s
  setInterval(() => {
    console.log(`📊 [${new Date().toISOString()}] Active Users: ${activeUsers.size}, Active Calls: ${activeCalls.size}`);
    console.log('Users by role:', {
      doctors: getOnlineUsersByRole('doctor').length,
      employees: getOnlineUsersByRole('employee').length,
      admins: getOnlineUsersByRole('admin').length
    });
  }, 30000);
}

// Helper functions

function getOnlineUsersByRole(role) {
  const users = [];
  for (const userData of activeUsers.values()) {
    if (userData.role === role) {
      users.push(getUserInfo(userData));
    }
  }
  return users;
}

function getUserInfo(userData) {
  return {
    id: userData.id,
    name: userData.name,
    role: userData.role,
    socketId: userData.socketId
  };
}

function broadcastToRole(io, activeUsers, targetRole, event, data) {
  for (const [socketId, user] of activeUsers.entries()) {
    if (user.role === targetRole) {
      io.to(socketId).emit(event, data);
    }
  }
}

function broadcastToAdmins(io, activeUsers, event, data) {
  for (const [socketId, user] of activeUsers.entries()) {
    if (user.role === 'admin') {
      io.to(socketId).emit(event, data);
    }
  }
}

// Dummy token verifier for demo - replace with your actual verification method
async function verifyToken(token) {
  // e.g. decode JWT and return userId or null
  return token === 'validtoken' ? 'someUserId' : null;
}

module.exports = socketHandler;
