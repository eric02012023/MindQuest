-- =================================================================
-- MindQuest LMS — Database Cleanup Script
-- Purpose: Delete old assessment, AI-generated module, and
--          learning cycle records so admin can upload fresh modules.
--
-- SAFE TO RUN: This script does NOT delete users, branches,
--              subjects, enrollments, or tutor assignments.
--
-- IMPORTANT: Run this on your live database ONLY after backing up.
-- =================================================================

-- 1. Delete assessment results (student answers)
DELETE FROM assessment_results;
PRINT 'Deleted all assessment_results';

-- 2. Delete AI generation logs
DELETE FROM ai_generation_logs;
PRINT 'Deleted all ai_generation_logs';

-- 3. Delete student learning cycles
DELETE FROM student_learning_cycles;
PRINT 'Deleted all student_learning_cycles';

-- 4. Delete module read tracking
DELETE FROM module_reads;
PRINT 'Deleted all module_reads';

-- 5. Delete assessment requests (tutor inbox)
DELETE FROM assessment_requests;
PRINT 'Deleted all assessment_requests';

-- 6. Delete all assessments (AI-generated + manual)
DELETE FROM assessments;
PRINT 'Deleted all assessments';

-- 7. Delete AI-generated modules from subject_resources
--    (keeps admin-uploaded and tutor-shared modules)
DELETE FROM subject_resources WHERE module_origin = 'ai_generated';
PRINT 'Deleted AI-generated modules from subject_resources';

-- 8. Delete tutor-shared copies of modules (optional — uncomment if needed)
-- DELETE FROM subject_resources WHERE created_by_role = 'tutor_share';
-- PRINT 'Deleted tutor-shared module copies';

-- 9. Reset admin-uploaded module content_text if you want fresh parsing
-- UPDATE subject_resources SET content_text = NULL WHERE module_origin = 'admin_upload';
-- PRINT 'Reset content_text for admin modules (will re-parse on next upload)';

PRINT '=== Cleanup complete! Safe tables preserved: users, branches, subjects, enrollments, tutor assignments ===';
