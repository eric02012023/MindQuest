/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: server.js
 * Purpose: Main server entry point. This file configures Express, sessions, static folders, view engine, route mounting, error handling, Socket.IO events, and the startup/bootstrap sequence.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

require('dotenv').config();
const http = require('http');
const path = require('path');
const os = require('os');
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const { Server } = require('socket.io');
const { setUserLocals } = require('./middleware/auth');
const { bootstrapDatabase } = require('./lib/bootstrap');

const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const assistantRoutes = require('./routes/assistant');
const studentRoutes = require('./routes/student');
const tutorRoutes = require('./routes/tutor');
const { formatDate, formatDateTime, money, fullName, toInputDate, safeJsonArray, branchAddress, titleCaseName } = require('./lib/utils');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.locals.formatDate = formatDate;
app.locals.formatDateTime = formatDateTime;
app.locals.money = money;
app.locals.fullName = fullName;
app.locals.toInputDate = toInputDate;
app.locals.safeJsonArray = safeJsonArray;
app.locals.branchAddress = branchAddress;
app.locals.titleCaseName = titleCaseName;

// Middleware/route mount: attaches shared behavior or a route group to the application.

// SEO: Serve robots.txt and sitemap.xml from root
app.get('/robots.txt', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use(express.urlencoded({ extended: true }));
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use(express.json());
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use(methodOverride('_method'));
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use(session({
  secret: process.env.SESSION_SECRET || 'MindQuestTutorialCenterSecret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use(setUserLocals);

// Middleware/route mount: attaches shared behavior or a route group to the application.

app.use('/', publicRoutes);
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use('/', authRoutes);
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use('/admin', adminRoutes);
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use('/assistant', assistantRoutes);
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use('/student', studentRoutes);
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use('/tutor', tutorRoutes);
// Middleware/route mount: attaches shared behavior or a route group to the application.
app.use('/download', require('./routes/download'));

// Middleware/route mount: attaches shared behavior or a route group to the application.

app.use((req, res) => {
  res.status(404).render('error', {
    pageTitle: 'Page Not Found',
    message: 'The page you are looking for does not exist.'
  });
});

// Middleware/route mount: attaches shared behavior or a route group to the application.

app.use((error, req, res, _next) => {
  console.error(error);
  res.status(500).render('error', {
    pageTitle: 'Server Error',
    message: error.message || 'Something went wrong.'
  });
});

const onlineUsers = new Map();

// Make io accessible to routes for real-time notifications
app.set('io', io);
app.set('onlineUsers', onlineUsers);

// Socket.IO event registration: enables real-time communication features.

io.on('connection', (socket) => {
  socket.on('register-user', (userId) => {
    if (!userId) return;
    onlineUsers.set(String(userId), socket.id);
    socket.join(`user:${userId}`);
    io.emit('online-users', Array.from(onlineUsers.keys()));
  });

  socket.on('call-offer', ({ toUserId, fromUserId, offer, callType }) => {
    const targetSocketId = onlineUsers.get(String(toUserId));
    if (targetSocketId) {
      io.to(targetSocketId).emit('call-offer', { fromUserId, offer, callType });
    }
  });

  socket.on('call-answer', ({ toUserId, answer }) => {
    const targetSocketId = onlineUsers.get(String(toUserId));
    if (targetSocketId) {
      io.to(targetSocketId).emit('call-answer', { answer });
    }
  });

  socket.on('ice-candidate', ({ toUserId, candidate }) => {
    const targetSocketId = onlineUsers.get(String(toUserId));
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice-candidate', { candidate });
    }
  });

  socket.on('end-call', ({ toUserId }) => {
    const targetSocketId = onlineUsers.get(String(toUserId));
    if (targetSocketId) {
      io.to(targetSocketId).emit('end-call');
    }
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) onlineUsers.delete(userId);
    }
    io.emit('online-users', Array.from(onlineUsers.keys()));
  });
});

const port = Number(process.env.PORT || 3000);

// Function: getLocalIP

// Role: Provides helper logic for this file.

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// Function: start

// Role: Handles a reusable server-side operation used by this module.

async function start() {
  try {
    const { dbName } = await bootstrapDatabase();
    const localIP = getLocalIP();

    server.listen(port, '0.0.0.0', () => {
      console.log(`MindQuest web system is running on:`);
      console.log(`- Local:   http://localhost:${port}`);
      console.log(`- Network: http://${localIP}:${port}`);
      console.log(`Connected database: ${dbName}`);
      console.log('Default admin email: admin@mindquest.local');
      console.log('Default admin password: Admin@12345');
      console.log('SMTP Configuration Status:', {
        host: process.env.SMTP_HOST || 'NOT SET',
        port: process.env.SMTP_PORT || 'NOT SET',
        user: process.env.SMTP_USER || 'NOT SET',
        pass: process.env.SMTP_PASS ? 'SET (hidden)' : 'NOT SET',
        from: process.env.SMTP_FROM || 'NOT SET'
      });
    });
  } catch (error) {
    console.error('Failed to bootstrap the database before start.');
    console.error(error);
    process.exit(1);
  }
}

start();