const User = require('../models/User');
const Call = require('../models/Call');

// In-memory storage
function socketHandler(io) {
  console.log('🔌 Socket.IO handler initialized');

  // Store active users and rooms
  const users = new Map();
  const rooms = new Map();

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Join room
    socket.on('join-room', ({ roomId, userId }) => {
      socket.join(roomId);
      users.set(socket.id, { userId, roomId });

      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }

      // Get current users in room (excluding the new user)
      const currentUsers = Array.from(rooms.get(roomId))
        .map(socketId => {
          const user = users.get(socketId);
          return user ? user.userId : null;
        })
        .filter(Boolean)
        .filter(existingUserId => existingUserId !== userId);

      rooms.get(roomId).add(socket.id);

      // Send current users to the new user
      socket.emit('room-users', currentUsers);

      // Notify others in the room about the new user
      socket.to(roomId).emit('user-connected', userId);

      console.log(`User ${userId} joined room ${roomId}. Users in room: ${Array.from(rooms.get(roomId)).length}`);
    });

    // WebRTC signaling events
    socket.on('offer', ({ offer, to }) => {
      socket.to(to).emit('offer', {
        offer,
        from: socket.id
      });
    });

    socket.on('answer', ({ answer, to }) => {
      socket.to(to).emit('answer', {
        answer,
        from: socket.id
      });
    });

    socket.on('ice-candidate', ({ candidate, to }) => {
      socket.to(to).emit('ice-candidate', {
        candidate,
        from: socket.id
      });
    });

    // Call events
    socket.on('call-user', ({ userToCall, signalData, from, name }) => {
      // Find the socket ID for the user
      let targetSocketId = null;
      for (let [socketId, userData] of users.entries()) {
        if (userData.userId === userToCall) {
          targetSocketId = socketId;
          break;
        }
      }

      if (targetSocketId) {
        io.to(targetSocketId).emit('call-made', {
          signal: signalData,
          from: socket.id,
          name
        });
      }
    });

    socket.on('answer-call', ({ signal, to }) => {
      io.to(to).emit('call-accepted', signal);
    });

    socket.on('reject-call', ({ to }) => {
      io.to(to).emit('call-rejected');
    });

    socket.on('end-call', ({ to }) => {
      io.to(to).emit('call-ended');
    });

    // Disconnect handling
    socket.on('disconnect', () => {
      const user = users.get(socket.id);
      if (user) {
        const { roomId, userId } = user;
        socket.to(roomId).emit('user-disconnected', userId);

        if (rooms.has(roomId)) {
          rooms.get(roomId).delete(socket.id);
          if (rooms.get(roomId).size === 0) {
            rooms.delete(roomId);
          }
        }

        users.delete(socket.id);
        console.log(`User ${userId} disconnected from room ${roomId}`);
      }
    });
  });
}

module.exports = socketHandler;
