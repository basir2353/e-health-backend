const User = require('../models/User');
const Call = require('../models/Call');

// In-memory storage
const activeUsers = new Map(); // socketId -> user info
const activeCalls = new Map(); // callId -> call info

function socketHandler(io) {
  console.log('🔌 Socket.IO handler initialized');
  
  io.on('connection', (socket) => {
    console.log('✅ New client connected:', socket.id);

    // User joins with their info
    socket.on('user-joined', async (userData) => {
      try {
        console.log('👤 User joining:', userData);
        activeUsers.set(socket.id, userData);

        // Update user online status
        await User.findByIdAndUpdate(userData.id, { 
          isOnline: true, 
          socketId: socket.id 
        });

        // Fetch updated user info and emit to frontend (for doctor dashboard update)
        if (userData.role === 'doctor') {
          const updatedDoctor = await User.findById(userData.id).select('name email role isOnline');
          io.to(socket.id).emit('doctor-info', updatedDoctor);
        }

        // Notify admins of user status
        broadcastToAdmins(io, activeUsers, 'user-status-update', {
          userId: userData.id,
          username: userData.username || userData.name || userData.email,
          role: userData.role,
          isOnline: true
        });

        // Emit active users to all clients
        io.emit('active-users', Array.from(activeUsers.values()));

        console.log(`✅ ${userData.username || userData.name || userData.email} (${userData.role}) joined successfully`);
      } catch (error) {
        console.error('❌ Error in user-joined:', error);
      }
    });

    // Initiate call
    socket.on('initiate-call', async (data) => {
      try {
        console.log('📞 Call initiation request:', data);
        const { callerId, calleeId, callerName } = data;

        // Find callee's socket
        const callee = await User.findById(calleeId);
        if (!callee || !callee.socketId) {
          console.log('❌ User is offline:', calleeId);
          socket.emit('call-error', { message: 'User is offline' });
          return;
        }

        // Find caller's info for name fallback
        let callerUser = null;
        try {
          callerUser = await User.findById(callerId);
        } catch (err) {
          console.log('⚠️ Could not fetch caller info:', err.message);
        }

        // Create call record
        const call = new Call({
          caller: callerId,
          callee: calleeId,
          status: 'initiated'
        });
        await call.save();

        const callId = call._id.toString();

        // Store active call
        const callInfo = {
          callId,
          caller: { 
            id: callerId, 
            name: callerName || (callerUser && (callerUser.username || callerUser.name || callerUser.email)) || 'Unknown', 
            socketId: socket.id 
          },
          callee: { 
            id: calleeId, 
            name: callee.username || callee.name || callee.email || 'Unknown', 
            socketId: callee.socketId 
          },
          status: 'initiated',
          startTime: new Date()
        };
        
        activeCalls.set(callId, callInfo);

        // Notify callee
        io.to(callee.socketId).emit('incoming-call', {
          callId,
          callerId,
          callerName: callerName || (callerUser && (callerUser.username || callerUser.name || callerUser.email)) || 'Unknown',
          callerSocketId: socket.id
        });

        // Notify admins
        broadcastToAdmins(io, activeUsers, 'new-call', callInfo);

        console.log(`📞 Call initiated: ${callInfo.caller.name} -> ${callInfo.callee.name}`);
      } catch (error) {
        console.error('❌ Error in initiate-call:', error);
        socket.emit('call-error', { message: 'Failed to initiate call' });
      }
    });

    // Accept call
    socket.on('accept-call', async (data) => {
      try {
        console.log('✅ Call acceptance:', data);
        const { callId } = data;
        const callInfo = activeCalls.get(callId);

        if (!callInfo) {
          console.log('❌ Call not found:', callId);
          socket.emit('call-error', { message: 'Call not found' });
          return;
        }

        // Update call status
        callInfo.status = 'accepted';
        activeCalls.set(callId, callInfo);

        // Update database
        await Call.findByIdAndUpdate(callId, { status: 'accepted' });

        // Notify caller that call was accepted
        io.to(callInfo.caller.socketId).emit('call-accepted', { callId });

        // Notify admins
        broadcastToAdmins(io, activeUsers, 'call-status-update', callInfo);

        console.log(`✅ Call accepted: ${callInfo.caller.name} <-> ${callInfo.callee.name}`);
      } catch (error) {
        console.error('❌ Error in accept-call:', error);
      }
    });

    // Reject call
    socket.on('reject-call', async (data) => {
      try {
        console.log('❌ Call rejection:', data);
        const { callId } = data;
        const callInfo = activeCalls.get(callId);

        if (!callInfo) return;

        // Update database
        await Call.findByIdAndUpdate(callId, { 
          status: 'rejected',
          endTime: new Date()
        });

        // Notify caller
        io.to(callInfo.caller.socketId).emit('call-rejected', { callId });

        // Remove from active calls
        activeCalls.delete(callId);

        // Notify admins
        broadcastToAdmins(io, activeUsers, 'call-ended', { callId, reason: 'rejected' });

        console.log(`❌ Call rejected: ${callInfo.caller.name} -> ${callInfo.callee.name}`);
      } catch (error) {
        console.error('❌ Error in reject-call:', error);
      }
    });

    // End call
    socket.on('end-call', async (data) => {
      try {
        console.log('🔚 Call ending:', data);
        const { callId } = data;
        const callInfo = activeCalls.get(callId);

        if (!callInfo) return;

        const endTime = new Date();
        const duration = Math.floor((endTime - callInfo.startTime) / 1000);

        // Update database
        await Call.findByIdAndUpdate(callId, { 
          status: 'ended',
          endTime,
          duration
        });

        // Notify both parties
        io.to(callInfo.caller.socketId).emit('call-ended', { callId });
        io.to(callInfo.callee.socketId).emit('call-ended', { callId });

        // Remove from active calls
        activeCalls.delete(callId);

        // Notify admins
        broadcastToAdmins(io, activeUsers, 'call-ended', { callId, duration });

        console.log(`🔚 Call ended: ${callInfo.caller.name} <-> ${callInfo.callee.name} (${duration}s)`);
      } catch (error) {
        console.error('❌ Error in end-call:', error);
      }
    });

    // WebRTC signaling
    socket.on('offer', (data) => {
      console.log('📡 WebRTC offer received');
      socket.to(data.target).emit('offer', {
        offer: data.offer,
        caller: socket.id
      });
    });

    socket.on('answer', (data) => {
      console.log('📡 WebRTC answer received');
      socket.to(data.target).emit('answer', {
        answer: data.answer,
        callee: socket.id
      });
    });

    socket.on('ice-candidate', (data) => {
      console.log('🧊 ICE candidate received');
      socket.to(data.target).emit('ice-candidate', {
        candidate: data.candidate,
        sender: socket.id
      });
    });

    // Admin requests active calls
    socket.on('get-active-calls', () => {
      const userData = activeUsers.get(socket.id);
      if (userData && userData.role === 'admin') {
        console.log('👨‍💼 Admin requesting active calls');
        socket.emit('active-calls', Array.from(activeCalls.values()));
      }
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
      try {
        const userData = activeUsers.get(socket.id);
        if (userData) {
          console.log(`👋 User disconnecting: ${userData.username || userData.name || userData.email}`);
          
          // Update user offline status
          await User.findByIdAndUpdate(userData.id, { 
            isOnline: false, 
            socketId: null 
          });

          // End any active calls involving this user
          for (const [callId, callInfo] of activeCalls.entries()) {
            if (callInfo.caller.socketId === socket.id || callInfo.callee.socketId === socket.id) {
              const endTime = new Date();
              const duration = Math.floor((endTime - callInfo.startTime) / 1000);

              await Call.findByIdAndUpdate(callId, { 
                status: 'ended',
                endTime,
                duration
              });

              // Notify the other party
              const otherSocketId = callInfo.caller.socketId === socket.id 
                ? callInfo.callee.socketId 
                : callInfo.caller.socketId;

              io.to(otherSocketId).emit('call-ended', { callId, reason: 'disconnect' });

              activeCalls.delete(callId);
              broadcastToAdmins(io, activeUsers, 'call-ended', { callId, reason: 'disconnect' });
              
              console.log(`🔚 Call terminated due to disconnect: ${callId}`);
            }
          }

          // Notify admins of user status
          broadcastToAdmins(io, activeUsers, 'user-status-update', {
            userId: userData.id,
            username: userData.username || userData.name || userData.email,
            role: userData.role,
            isOnline: false
          });

          activeUsers.delete(socket.id);
          console.log(`👋 ${userData.username || userData.name || userData.email} disconnected`);
        } else {
          console.log('👋 Unknown user disconnected:', socket.id);
        }
      } catch (error) {
        console.error('❌ Error in disconnect:', error);
      }
    });
  });

  // Log current status
  setInterval(() => {
    console.log(`📊 Status - Active Users: ${activeUsers.size}, Active Calls: ${activeCalls.size}`);
  }, 30000); // Log every 30 seconds
}

// Helper function to broadcast to all admins
function broadcastToAdmins(io, activeUsers, event, data) {
  let adminCount = 0;
  for (const [socketId, userData] of activeUsers.entries()) {
    if (userData.role === 'admin') {
      io.to(socketId).emit(event, data);
      adminCount++;
    }
  }
  if (adminCount > 0) {
    console.log(`👨‍💼 Broadcast to ${adminCount} admin(s): ${event}`);
  }
}

module.exports = socketHandler;