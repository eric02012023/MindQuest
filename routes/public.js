/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: routes/public.js
 * Purpose: Public-facing routes for landing page and registration. This file handles learner/tutor registration, validation, duplicate checking, image upload, and post-registration flow.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

const express = require('express');
const { ensureGuest } = require('../middleware/auth');
const { createUploader } = require('../lib/uploads');
const {
  getBranches,
  getSubjects,
  isEmailTaken,
  createSubmission,
  isDuplicatePersonName
} = require('../lib/data');
const { validateStrongPassword } = require('../lib/utils');

const router = express.Router();
const profileUpload = createUploader('profiles');
const TUTOR_YEAR_LEVEL_OPTIONS = ['Preschool', 'Primary School', 'Junior High School', 'Senior High School'];

// Function: computeAge

// Role: Provides helper logic for this file.

function computeAge(birthDateString) {
  if (!birthDateString) return null;
  const birthDate = new Date(birthDateString);
  if (Number.isNaN(birthDate.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age -= 1;
  return age > 0 ? age : null;
}

// Function: normalizeTutorYearLevels

// Role: Provides helper logic for this file.

function normalizeTutorYearLevels(input) {
  const values = Array.isArray(input) ? input : input ? [input] : [];
  return [...new Set(values.map((value) => String(value || '').trim()).filter((value) => TUTOR_YEAR_LEVEL_OPTIONS.includes(value)))];
}

// Function: buildDetailsPayload

// Role: Provides helper logic for this file.

function buildDetailsPayload(req, submissionType) {
  const body = req.body;
  const subjects = Array.isArray(body.subjects) ? body.subjects : body.subjects ? [body.subjects] : [];
  const supports = Array.isArray(body.supports) ? body.supports : body.supports ? [body.supports] : [];
  const tutorYearLevels = normalizeTutorYearLevels(body.tutor_year_levels || body.year_level);
  const sharedContactNumber = String(body.contact_number || '').trim();
  const parentGuardianName = String(body.parent_guardian_name || body.guardian_name || '').trim();
  const parentContactNumber = String(body.parent_contact_number || sharedContactNumber).trim();
  return {
    submission_type: submissionType,
    branch_id: body.branch_id || null,
    first_name: body.first_name,
    middle_name: body.middle_name,
    last_name: body.last_name,
    birth_date: body.birth_date,
    age: body.age || computeAge(body.birth_date),
    gender: body.gender,
    contact_number: sharedContactNumber,
    email: body.email,
    facebook_account: body.facebook_account,
    address: body.address,
    year_level: submissionType === 'tutor' ? tutorYearLevels.join(', ') : body.year_level,
    grade_level: body.grade_level,
    parent_guardian_name: submissionType === 'student' ? parentGuardianName : '',
    parent_contact_number: submissionType === 'student' ? parentContactNumber : '',
    parent_email: body.parent_email,
    parent_facebook: body.parent_facebook,
    image_path: req.file ? `/uploads/profiles/${req.file.filename}` : (body.existing_image_path || null),
    subjects,
    supports,
    extra: {
      note: body.note || '',
      experience: body.experience || '',
      preferred_schedule: body.preferred_schedule || '',
      target_goals: body.target_goals || '',
      emergency_contact: body.emergency_contact || '',
      year_levels: submissionType === 'tutor' ? tutorYearLevels : []
    }
  };
}

// Function: getPendingRegistration

// Role: Provides helper logic for this file.

function getPendingRegistration(req, type) {
  const pending = req.session.pendingRegistration;
  if (!pending || pending.type !== type) return null;
  return pending.formData || null;
}

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/', ensureGuest, async (req, res, next) => {
  try {
    const [branches, subjects] = await Promise.all([getBranches(), getSubjects(false)]);
    res.render('landing', {
      pageTitle: 'MindQuest Tutorial Center',
      branches,
      subjects,
      phoneNumber: process.env.PHONE_NUMBER || '+639099879424',
      facebookUrl: process.env.FACEBOOK_URL || 'https://www.facebook.com/mindquesttutorialcenter'
    });
  } catch (error) {
    next(error);
  }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/register/:type', ensureGuest, async (req, res, next) => {
  try {
    const type = req.params.type === 'tutor' ? 'tutor' : 'student';
    const [branches, subjects] = await Promise.all([getBranches(), getSubjects(false)]);
    res.render('register', {
      pageTitle: type === 'student' ? 'Learner Registration' : 'Tutor Registration',
      type,
      branches,
      subjects,
      formData: getPendingRegistration(req, type) || {}
    });
  } catch (error) {
    next(error);
  }
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/register/:type/details', ensureGuest, profileUpload.single('image'), async (req, res, next) => {
  try {
    const type = req.params.type === 'tutor' ? 'tutor' : 'student';
    const payload = buildDetailsPayload(req, type);
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirm_password || '');

    req.session.pendingRegistration = {
      type,
      formData: {
        ...payload,
        email,
        tutor_year_levels: normalizeTutorYearLevels(req.body.tutor_year_levels || req.body.year_level)
      }
    };

    const age = Number(payload.age || computeAge(payload.birth_date) || 0);
    const selectedSubjects = Array.isArray(payload.subjects) ? payload.subjects.filter(Boolean) : [];
    const strongPassword = validateStrongPassword(password);

    if (type === 'student') {
      const missingStudentFields = [
        payload.first_name,
        payload.last_name,
        payload.birth_date,
        payload.branch_id,
        payload.parent_guardian_name,
        payload.contact_number,
        payload.year_level,
        payload.grade_level,
        email,
        password,
        confirmPassword
      ].some((value) => !String(value || '').trim());
      if (missingStudentFields || !String(payload.grade_level || '').trim() || !selectedSubjects.length) {
        req.session.flash = { type: 'error', message: 'Please complete all required learner fields before submitting.' };
        return res.redirect(`/register/${type}`);
      }
      if (age < 3) {
        req.session.flash = { type: 'error', message: 'Learner registration is only allowed for 3 years old and above.' };
        return res.redirect(`/register/${type}`);
      }
    } else {
      const selectedTutorYearLevels = normalizeTutorYearLevels(req.body.tutor_year_levels || req.body.year_level);
      const missingTutorFields = [
        payload.first_name,
        payload.last_name,
        payload.birth_date,
        payload.address,
        payload.branch_id,
        payload.contact_number,
        payload.year_level,
        email,
        password,
        confirmPassword
      ].some((value) => !String(value || '').trim());
      if (missingTutorFields || !selectedSubjects.length || !selectedTutorYearLevels.length) {
        req.session.flash = { type: 'error', message: 'Please complete all required tutor fields before submitting.' };
        return res.redirect(`/register/${type}`);
      }
      if (age < 18) {
        req.session.flash = { type: 'error', message: 'Tutor registration is only allowed for 18 years old and above.' };
        return res.redirect(`/register/${type}`);
      }
      payload.extra.year_levels = selectedTutorYearLevels;
      payload.year_level = selectedTutorYearLevels.join(', ');
    }

    if (password !== confirmPassword) {
      req.session.flash = { type: 'error', message: 'Password and confirm password must match.' };
      return res.redirect(`/register/${type}`);
    }
    if (!strongPassword.ok) {
      req.session.flash = { type: 'error', message: strongPassword.message };
      return res.redirect(`/register/${type}`);
    }
    if (await isDuplicatePersonName(payload.first_name, payload.middle_name, payload.last_name)) {
      req.session.flash = { type: 'error', message: 'A student or tutor with the same complete name already exists. Please use a different complete name.' };
      return res.redirect(`/register/${type}`);
    }
    if (await isEmailTaken(email)) {
      req.session.flash = { type: 'error', message: 'Email already exists. Please use another email.' };
      return res.redirect(`/register/${type}`);
    }

    if (!email.endsWith('@gmail.com')) {
      req.session.flash = { type: 'error', message: 'Please use a valid Gmail address ending in @gmail.com.' };
      return res.redirect(`/register/${type}`);
    }

    await createSubmission({
      ...payload,
      submission_type: type,
      email,
      password
    });
    delete req.session.pendingRegistration;
    req.session.flash = { type: 'success', message: 'Registration submitted successfully. Wait for admin approval before logging in.' };
    return res.redirect(`/register/${type}/done`);
  } catch (error) {
    next(error);
  }
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/register/:type/verify', ensureGuest, (req, res) => {
  const type = req.params.type === 'tutor' ? 'tutor' : 'student';
  req.session.flash = { type: 'error', message: 'Registration OTP is disabled. Please wait for admin approval after registration.' };
  return res.redirect(`/register/${type}`);
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/register/:type/verify', ensureGuest, (req, res) => {
  const type = req.params.type === 'tutor' ? 'tutor' : 'student';
  req.session.flash = { type: 'error', message: 'Registration OTP is disabled. Please wait for admin approval after registration.' };
  return res.redirect(`/register/${type}`);
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/register/:type/resend-otp', ensureGuest, (req, res) => {
  const type = req.params.type === 'tutor' ? 'tutor' : 'student';
  req.session.flash = { type: 'error', message: 'Registration OTP is disabled. Please wait for admin approval after registration.' };
  return res.redirect(`/register/${type}`);
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/register/:type/account', ensureGuest, async (req, res) => {
  const type = req.params.type === 'tutor' ? 'tutor' : 'student';
  return res.redirect(`/register/${type}`);
});

// Route handler: POST request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.post('/register/:type/account', ensureGuest, async (req, res) => {
  const type = req.params.type === 'tutor' ? 'tutor' : 'student';
  return res.redirect(`/register/${type}`);
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/register/:type/done', ensureGuest, (req, res) => {
  const type = req.params.type === 'tutor' ? 'tutor' : 'student';
  res.render('register-done', {
    pageTitle: 'Submitted',
    type
  });
});

// Route handler: GET request

// Purpose: Processes this endpoint and returns the correct view or action result.

router.get('/register/check-name', ensureGuest, async (req, res, next) => {
  try {
    const exists = await isDuplicatePersonName(req.query.first_name, req.query.middle_name, req.query.last_name);
    res.json({ exists });
  } catch (error) { next(error); }
});

module.exports = router;
