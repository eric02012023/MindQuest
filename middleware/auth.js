/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: middleware/auth.js
 * Purpose: Authentication and authorization middleware. This file protects routes, exposes current user data to views, and manages reusable flash/session helpers.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

// Function: ensureGuest

// Role: Provides helper logic for this file.

function ensureGuest(req, res, next) {
  if (req.session?.user) {
    return res.redirect(getRoleHome(req.session.user.role));
  }
  next();
}

// Function: ensureAuthenticated

// Role: Provides helper logic for this file.

function ensureAuthenticated(req, res, next) {
  if (!req.session?.user) {
    req.session.flash = { type: 'error', message: 'Please log in first.' };
    return res.redirect('/login');
  }
  next();
}

// Function: authorize

// Role: Provides helper logic for this file.

function authorize(roles = []) {
  return (req, res, next) => {
    const user = req.session?.user;
    if (!user) {
      req.session.flash = { type: 'error', message: 'Please log in first.' };
      return res.redirect('/login');
    }
    if (!roles.includes(user.role)) {
      req.session.flash = { type: 'error', message: 'You are not allowed to access that page.' };
      return res.redirect(getRoleHome(user.role));
    }
    next();
  };
}

const { query } = require('../config/db');

// Function: setUserLocals

// Role: Handles a reusable server-side operation used by this module.

async function setUserLocals(req, res, next) {
  try {
    if (req.session?.user?.id) {
      const rows = await query(
        `SELECT TOP 1 id, user_id, role, branch_id, assistant_scope_branch_id,
                first_name, middle_name, last_name, email, image_path
         FROM users
         WHERE id = ? AND is_archived = 0`,
        [req.session.user.id]
      );
      if (rows[0]) {
        req.session.user = { ...req.session.user, ...rows[0] };
      }
    }
  } catch (error) {
    console.error('Failed to refresh session user.', error);
  }
  res.locals.currentUser = req.session?.user || null;
  res.locals.flash = req.session?.flash || null;
  delete req.session?.flash;
  next();
}

// Function: setFlash

// Role: Provides helper logic for this file.

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

// Function: getRoleHome

// Role: Provides helper logic for this file.

function getRoleHome(role) {
  switch (role) {
    case 'admin':
      return '/admin';
    case 'admin_assistant':
      return '/assistant';
    case 'student':
      return '/student';
    case 'tutor':
      return '/tutor';
    default:
      return '/login';
  }
}

module.exports = {
  ensureGuest,
  ensureAuthenticated,
  authorize,
  setUserLocals,
  setFlash,
  getRoleHome
};
