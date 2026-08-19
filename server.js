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
const { uploadFolder, usingExternalUploadRoot, UPLOADS_ROOT } = require('./lib/paths');

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
// Public upload folders stay mounted here, ahead of the session middleware, so
// avatars and chat attachments are served without a session lookup or a DB round
// trip per file. Study-material folders are NOT served here — they are mounted
// behind an access check below app.use(setUserLocals).
app.use('/uploads/profiles', express.static(uploadFolder('profiles')));

// Chat attachments are the one public folder that accepts arbitrary file types,
// and they are served from this app's own origin — so anything the browser will
// execute becomes stored XSS against whoever opens it. The upload filter blocks
// those extensions (lib/uploads.js), and this is the second layer for anything
// already on disk from before that filter existed:
//
//   nosniff             stops the browser guessing a dangerous type from content
//   Content-Disposition forces a download for anything that is not a plain image,
//                       so it can never render in this origin
app.use('/uploads/messages', express.static(uploadFolder('messages'), {
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const ext = path.extname(filePath).toLowerCase();
    const inlineSafe = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];
    if (!inlineSafe.includes(ext)) {
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
}));
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

// --------------------------------------------------------------------------
// Guarded /uploads mount.
//
// Folders holding study material (handouts, modules, shared resources) are not
// public: serving them from a bare express.static let anyone with a URL read a
// handout, which defeated the pre-assessment lock entirely.
//
// Login is required for all of them. On top of that, handouts/ enforces the
// per-student Pre-Assessment lock and year-level targeting, so a student cannot
// reach a handout by typing its URL (spec Section 6: server-side, not UI hiding).
//
// profiles/ and messages/ are served publicly by the earlier mount: avatars are
// embedded across the app and chat attachments come from the messaging UI.
// --------------------------------------------------------------------------
const PROTECTED_UPLOAD_DIRS = ['modules', 'resources', 'ai-modules', 'handouts'];

function requireLogin(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).type('text/plain').send('Unauthorized. Please log in to open study material.');
  }
  return next();
}

/**
 * Students may only open a handout when they are enrolled in its subject, have
 * completed that subject's Pre-Assessment, and the module targets their year
 * level. Staff (admin, assistant, tutor) are not gated.
 */
async function guardHandoutAccess(req, res, next) {
  const user = req.session.user;
  if (user.role !== 'student') return next();

  try {
    const {
      getModuleHandoutByPath, getStudentAssignments,
      hasCompletedPreAssessment, moduleTargetsStudent, getUserById
    } = require('./lib/data');

    const handout = await getModuleHandoutByPath(`/uploads/handouts${req.path}`);
    if (!handout) {
      // Not a handout we know about — nothing to authorise against.
      return res.status(404).type('text/plain').send('Handout not found.');
    }

    const assignments = await getStudentAssignments(user.id);
    if (!assignments.some((a) => Number(a.subject_id) === Number(handout.subject_id))) {
      return res.status(403).type('text/plain').send('You are not enrolled in this subject.');
    }

    const preDone = await hasCompletedPreAssessment(user.id, handout.subject_id);
    if (!preDone) {
      return res.status(403).type('text/plain')
        .send('Complete the Pre-Assessment for this subject before opening its handouts.');
    }

    // Load the student from the DB rather than the session: neither the login
    // query nor setUserLocals selects year_level/grade_level, so the session copy
    // has neither and this check would reject every student.
    const studentRecord = await getUserById(user.id);
    if (!moduleTargetsStudent(handout, studentRecord)) {
      return res.status(403).type('text/plain').send('This module is not assigned to your year level.');
    }

    return next();
  } catch (error) {
    console.error('[guardHandoutAccess]', error.message);
    return res.status(500).type('text/plain').send('Could not verify access to this handout.');
  }
}

for (const folder of PROTECTED_UPLOAD_DIRS) {
  const guards = folder === 'handouts' ? [requireLogin, guardHandoutAccess] : [requireLogin];
  app.use(
    `/uploads/${folder}`,
    ...guards,
    express.static(uploadFolder(folder))
  );
}

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
app.use('/webhook', require('./routes/webhook'));

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

  // An oversized upload is a user mistake, not a server fault: send them back
  // with a flash instead of the 500 page.
  if (error && error.code === 'LIMIT_FILE_SIZE') {
    const message = 'That file is too large. Handouts and documents may be up to 25 MB, profile photos up to 5 MB.';
    if (req.session) {
      req.session.flash = { type: 'error', message };
      return res.redirect(req.get('Referer') || '/');
    }
    return res.status(413).render('error', { pageTitle: 'File Too Large', message });
  }

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
      // Say where uploads land. On a host with an ephemeral filesystem (Render),
      // seeing the in-repo default here means every uploaded handout will be lost
      // on the next deploy — set UPLOAD_ROOT to a mounted disk.
      console.log(
        `Uploads directory: ${UPLOADS_ROOT}`
        + (usingExternalUploadRoot ? ' (persistent, from UPLOAD_ROOT)' : ' (inside the app folder)')
      );
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