const path = require('path');
const express = require('express');
const http = require('http');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Simple in-memory room store (prototype only)
const rooms = {};

// Multer storage for uploads
const uploadDir = path.join(__dirname, 'uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({ storage });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));
app.use(express.urlencoded({ extended: true }));

// Landing page for creating a room
app.get('/', (req, res) => {
  res.render('index');
});

// Handle room creation and file uploads
const fieldsUpload = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'art', maxCount: 1 },
  { name: 'subtitle', maxCount: 1 },
]);

app.post('/create', fieldsUpload, (req, res) => {
  const roomId = uuidv4();

  const videoFile = req.files.video?.[0];
  const artFile = req.files.art?.[0];
  const subtitleFile = req.files.subtitle?.[0];

  if (!videoFile || !artFile) {
    return res.status(400).send('Video and art are required.');
  }

  rooms[roomId] = {
    videoPath: `/uploads/${path.basename(videoFile.path)}`,
    artPath: `/uploads/${path.basename(artFile.path)}`,
    subtitlePath: subtitleFile ? `/uploads/${path.basename(subtitleFile.path)}` : null,
    hostSocketId: null,
    state: {
      playing: false,
      currentTime: 0,
      lastUpdate: Date.now(),
    },
    clients: new Set(),
  };

  return res.redirect(`/room/${roomId}`);
});

// Room view
app.get('/room/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).send('Room not found or expired.');
  }
  res.render('room', {
    roomId: req.params.roomId,
    videoPath: room.videoPath,
    artPath: room.artPath,
    subtitlePath: room.subtitlePath,
  });
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, asHost }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('room-error', { message: 'Room not found.' });
      return;
    }

    // Limit to two clients
    if (room.clients.size >= 2 && !room.clients.has(socket.id)) {
      socket.emit('room-error', { message: 'Room is full (2 users max).' });
      return;
    }

    socket.join(roomId);
    room.clients.add(socket.id);

    if (asHost || !room.hostSocketId) {
      room.hostSocketId = socket.id;
      socket.emit('role', { role: 'host' });
    } else {
      socket.emit('role', { role: 'guest' });
      // Send current state to new guest
      socket.emit('sync-state', {
        state: room.state,
        serverTime: Date.now(),
        hostSocketId: room.hostSocketId,
      });
    }
  });

  socket.on('control', ({ roomId, action, currentTime }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Only host is authoritative
    if (socket.id !== room.hostSocketId) return;

    const now = Date.now();

    if (action === 'play') {
      room.state.playing = true;
      room.state.currentTime = currentTime;
      room.state.lastUpdate = now;
    } else if (action === 'pause') {
      room.state.playing = false;
      room.state.currentTime = currentTime;
      room.state.lastUpdate = now;
    } else if (action === 'seek') {
      room.state.currentTime = currentTime;
      room.state.lastUpdate = now;
    }

    io.to(roomId).emit('control', {
      action,
      currentTime,
      serverTime: now,
      playing: room.state.playing,
    });
  });

  socket.on('request-sync', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const now = Date.now();
    io.to(socket.id).emit('sync-state', {
      state: room.state,
      serverTime: now,
      hostSocketId: room.hostSocketId,
    });
  });

  socket.on('disconnect', () => {
    // Remove from rooms
    Object.entries(rooms).forEach(([roomId, room]) => {
      if (room.clients.has(socket.id)) {
        room.clients.delete(socket.id);
        if (room.hostSocketId === socket.id) {
          room.hostSocketId = [...room.clients][0] || null;
        }
        if (room.clients.size === 0) {
          delete rooms[roomId];
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`FriendWatch server listening on http://localhost:${PORT}`);
});

