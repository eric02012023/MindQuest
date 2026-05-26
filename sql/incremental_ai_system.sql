-- ============================================================================
-- MindQuest AI System — Phase 1: Database Schema Migration
-- File: sql/incremental_ai_system.sql
-- Purpose: Adds all new tables and columns required for the AI-driven learning
--          cycle, anti-cheating, module reads tracking, assessment attempts,
--          student learning cycles, AI generation logs, and online payments.
-- Safety: All statements use IF OBJECT_ID / IF COL_LENGTH guards to prevent
--         data loss on existing databases.
-- ============================================================================

SET NOCOUNT ON;
GO

-- ============================================================================
-- 1. FIX: assessment_results.level — Drop old CHECK, migrate data, add new CHECK
--    (Handles Balance → Intermediate and new thresholds)
-- ============================================================================
IF OBJECT_ID('dbo.assessment_results','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_results','level') IS NOT NULL
BEGIN
  -- Drop existing CHECK constraint on 'level' column if any
  DECLARE @ck_name SYSNAME, @drop_sql NVARCHAR(MAX);
  SET @ck_name = NULL;
  SELECT TOP 1 @ck_name = dc.name
    FROM sys.check_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('dbo.assessment_results') AND c.name = 'level';
  IF @ck_name IS NOT NULL
  BEGIN
    SET @drop_sql = N'ALTER TABLE dbo.assessment_results DROP CONSTRAINT ' + QUOTENAME(@ck_name);
    BEGIN TRY EXEC sp_executesql @drop_sql; END TRY BEGIN CATCH END CATCH;
  END
END
GO

-- Migrate existing 'Balance' data to 'Intermediate'
IF OBJECT_ID('dbo.assessment_results','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_results','level') IS NOT NULL
BEGIN
  UPDATE dbo.assessment_results SET level = 'Intermediate' WHERE level = 'Balance';
END
GO

-- Re-add CHECK constraint with new valid values
IF OBJECT_ID('dbo.assessment_results','U') IS NOT NULL
   AND COL_LENGTH('dbo.assessment_results','level') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_assessment_results_level' AND parent_object_id = OBJECT_ID('dbo.assessment_results'))
BEGIN
  ALTER TABLE dbo.assessment_results ADD CONSTRAINT CK_assessment_results_level CHECK (level IN ('Beginner','Intermediate','Advance'));
END
GO


-- ============================================================================
-- 2. subject_resources — Add new AI/module columns
-- ============================================================================

-- type_of_module: Education level group (Pre School, Primary, Junior High, Senior High)
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','type_of_module') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD type_of_module NVARCHAR(60) NULL;
END
GO

-- module_origin: How the module was created (admin_upload, ai_generated, tutor_share)
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','module_origin') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD module_origin NVARCHAR(30) NOT NULL CONSTRAINT df_sr_module_origin DEFAULT 'admin_upload';
END
GO

-- difficulty_level: Beginner / Intermediate / Advance
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','difficulty_level') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD difficulty_level NVARCHAR(20) NULL;
END
GO

-- content_text: AI-generated module text content (for inline display)
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','content_text') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD content_text NVARCHAR(MAX) NULL;
END
GO

-- generated_from_assessment_id: Which assessment triggered AI module generation
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','generated_from_assessment_id') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD generated_from_assessment_id INT NULL;
END
GO

-- generated_from_result_id: Which assessment_result triggered the AI module
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','generated_from_result_id') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD generated_from_result_id INT NULL;
END
GO

-- generation_round: Cycle round number (1st attempt, 2nd attempt, etc.)
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','generation_round') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD generation_round INT NULL;
END
GO

-- next_assessment_due_at: When the next AI assessment should be generated
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','next_assessment_due_at') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD next_assessment_due_at DATETIME2 NULL;
END
GO

-- is_archived: Soft-delete flag for modules
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','is_archived') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD is_archived BIT NOT NULL CONSTRAINT df_sr_is_archived DEFAULT 0;
END
GO

-- archived_at: Timestamp when module was archived
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','archived_at') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD archived_at DATETIME2 NULL;
END
GO

-- recovered_at: Timestamp when module was recovered from archive
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','recovered_at') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD recovered_at DATETIME2 NULL;
END
GO

-- updated_at: Timestamp for general updates
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','updated_at') IS NULL
BEGIN
  ALTER TABLE dbo.subject_resources ADD updated_at DATETIME2 NOT NULL CONSTRAINT df_sr_updated_at DEFAULT DATEADD(hour, 8, GETUTCDATE());
END
GO

-- Backfill module_origin for existing admin uploads
IF OBJECT_ID('dbo.subject_resources','U') IS NOT NULL AND COL_LENGTH('dbo.subject_resources','module_origin') IS NOT NULL
BEGIN
  UPDATE dbo.subject_resources SET module_origin = 'admin_upload' WHERE created_by_role = 'admin_template' AND module_origin = 'admin_upload';
  UPDATE dbo.subject_resources SET module_origin = 'tutor_share' WHERE created_by_role = 'tutor_share' AND module_origin = 'admin_upload';
END
GO


-- ============================================================================
-- 3. users — Add education_level_group column
-- ============================================================================
IF OBJECT_ID('dbo.users','U') IS NOT NULL AND COL_LENGTH('dbo.users','education_level_group') IS NULL
BEGIN
  ALTER TABLE dbo.users ADD education_level_group NVARCHAR(60) NULL;
END
GO

-- Backfill education_level_group from existing year_level data
IF OBJECT_ID('dbo.users','U') IS NOT NULL AND COL_LENGTH('dbo.users','education_level_group') IS NOT NULL
BEGIN
  UPDATE dbo.users SET education_level_group = year_level
    WHERE education_level_group IS NULL AND year_level IS NOT NULL AND LTRIM(RTRIM(year_level)) <> '';
END
GO


-- ============================================================================
-- 4. submissions — Add education_level_group column
-- ============================================================================
IF OBJECT_ID('dbo.submissions','U') IS NOT NULL AND COL_LENGTH('dbo.submissions','education_level_group') IS NULL
BEGIN
  ALTER TABLE dbo.submissions ADD education_level_group NVARCHAR(60) NULL;
END
GO


-- ============================================================================
-- 5. assessment_questions — Add AI grading columns
-- ============================================================================

-- answer_rubric: AI grading rubric / expected criteria for essay questions
IF OBJECT_ID('dbo.assessment_questions','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_questions','answer_rubric') IS NULL
BEGIN
  ALTER TABLE dbo.assessment_questions ADD answer_rubric NVARCHAR(MAX) NULL;
END
GO

-- explanation: Correct answer explanation (shown after submission)
IF OBJECT_ID('dbo.assessment_questions','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_questions','explanation') IS NULL
BEGIN
  ALTER TABLE dbo.assessment_questions ADD explanation NVARCHAR(MAX) NULL;
END
GO


-- ============================================================================
-- 6. assessment_template_questions — Add AI grading columns
-- ============================================================================
IF OBJECT_ID('dbo.assessment_template_questions','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_template_questions','answer_rubric') IS NULL
BEGIN
  ALTER TABLE dbo.assessment_template_questions ADD answer_rubric NVARCHAR(MAX) NULL;
END
GO

IF OBJECT_ID('dbo.assessment_template_questions','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_template_questions','explanation') IS NULL
BEGIN
  ALTER TABLE dbo.assessment_template_questions ADD explanation NVARCHAR(MAX) NULL;
END
GO


-- ============================================================================
-- 7. NEW TABLE: module_reads — Track when students read/view a module
-- ============================================================================
IF OBJECT_ID('dbo.module_reads', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.module_reads (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    resource_id INT NOT NULL,
    subject_id INT NOT NULL,
    read_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_module_reads_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_module_reads_resource FOREIGN KEY (resource_id) REFERENCES dbo.subject_resources(id) ON DELETE CASCADE,
    CONSTRAINT fk_module_reads_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE NO ACTION,
    CONSTRAINT uniq_module_read UNIQUE (student_id, resource_id)
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_module_reads_student_subject' AND object_id = OBJECT_ID('dbo.module_reads'))
BEGIN
  CREATE INDEX IX_module_reads_student_subject ON dbo.module_reads(student_id, subject_id);
END
GO


-- ============================================================================
-- 8. NEW TABLE: assessment_attempts — Track each assessment attempt (retakes)
-- ============================================================================
IF OBJECT_ID('dbo.assessment_attempts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.assessment_attempts (
    id INT IDENTITY(1,1) PRIMARY KEY,
    assessment_id INT NOT NULL,
    student_id INT NOT NULL,
    attempt_number INT NOT NULL DEFAULT 1,
    score INT NOT NULL DEFAULT 0,
    total_questions INT NOT NULL DEFAULT 0,
    percentage DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    level NVARCHAR(20) NOT NULL DEFAULT 'Beginner' CHECK (level IN ('Beginner','Intermediate','Advance')),
    answers_json NVARCHAR(MAX) NULL,
    started_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    submitted_at DATETIME2 NULL,
    is_auto_submitted BIT NOT NULL DEFAULT 0,
    auto_submit_reason NVARCHAR(100) NULL,
    time_spent_seconds INT NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_attempts_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.assessments(id) ON DELETE CASCADE,
    CONSTRAINT fk_attempts_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_assessment_attempts_student' AND object_id = OBJECT_ID('dbo.assessment_attempts'))
BEGIN
  CREATE INDEX IX_assessment_attempts_student ON dbo.assessment_attempts(student_id, assessment_id);
END
GO


-- ============================================================================
-- 9. NEW TABLE: student_assessment_answers — Per-question answer detail
-- ============================================================================
IF OBJECT_ID('dbo.student_assessment_answers', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.student_assessment_answers (
    id INT IDENTITY(1,1) PRIMARY KEY,
    attempt_id INT NOT NULL,
    question_id INT NOT NULL,
    student_answer NVARCHAR(MAX) NULL,
    is_correct BIT NOT NULL DEFAULT 0,
    points_earned DECIMAL(5,2) NOT NULL DEFAULT 0,
    ai_feedback NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_saa_attempt FOREIGN KEY (attempt_id) REFERENCES dbo.assessment_attempts(id) ON DELETE CASCADE,
    CONSTRAINT fk_saa_question FOREIGN KEY (question_id) REFERENCES dbo.assessment_questions(id) ON DELETE NO ACTION
  );
END
GO


-- ============================================================================
-- 10. NEW TABLE: assessment_anti_cheat_logs — Track tab switches, blur events
-- ============================================================================
IF OBJECT_ID('dbo.assessment_anti_cheat_logs', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.assessment_anti_cheat_logs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    assessment_id INT NOT NULL,
    student_id INT NOT NULL,
    attempt_id INT NULL,
    event_type NVARCHAR(50) NOT NULL,
    event_detail NVARCHAR(MAX) NULL,
    violation_count INT NOT NULL DEFAULT 1,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_acl_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.assessments(id) ON DELETE CASCADE,
    CONSTRAINT fk_acl_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_acl_attempt FOREIGN KEY (attempt_id) REFERENCES dbo.assessment_attempts(id) ON DELETE NO ACTION
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_anti_cheat_logs_assessment' AND object_id = OBJECT_ID('dbo.assessment_anti_cheat_logs'))
BEGIN
  CREATE INDEX IX_anti_cheat_logs_assessment ON dbo.assessment_anti_cheat_logs(assessment_id, student_id);
END
GO


-- ============================================================================
-- 11. NEW TABLE: student_learning_cycles — Track AI module/assessment rotation
-- ============================================================================
IF OBJECT_ID('dbo.student_learning_cycles', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.student_learning_cycles (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    subject_id INT NOT NULL,
    resource_id INT NULL,
    assessment_id INT NULL,
    attempt_id INT NULL,
    round_number INT NOT NULL DEFAULT 1,
    status NVARCHAR(30) NOT NULL DEFAULT 'reading' CHECK (status IN ('reading','assessment_pending','assessment_taken','module_generated','completed')),
    result_level NVARCHAR(20) NULL,
    started_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    completed_at DATETIME2 NULL,
    next_due_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_slc_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_slc_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE CASCADE,
    CONSTRAINT fk_slc_resource FOREIGN KEY (resource_id) REFERENCES dbo.subject_resources(id) ON DELETE NO ACTION,
    CONSTRAINT fk_slc_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.assessments(id) ON DELETE NO ACTION,
    CONSTRAINT fk_slc_attempt FOREIGN KEY (attempt_id) REFERENCES dbo.assessment_attempts(id) ON DELETE NO ACTION
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_learning_cycles_student_subject' AND object_id = OBJECT_ID('dbo.student_learning_cycles'))
BEGIN
  CREATE INDEX IX_learning_cycles_student_subject ON dbo.student_learning_cycles(student_id, subject_id, status);
END
GO


-- ============================================================================
-- 12. NEW TABLE: ai_generation_logs — Track AI service calls and results
-- ============================================================================
IF OBJECT_ID('dbo.ai_generation_logs', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ai_generation_logs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    generation_type NVARCHAR(50) NOT NULL,
    student_id INT NULL,
    subject_id INT NULL,
    resource_id INT NULL,
    assessment_id INT NULL,
    input_summary NVARCHAR(MAX) NULL,
    output_summary NVARCHAR(MAX) NULL,
    ai_provider NVARCHAR(50) NULL,
    ai_model NVARCHAR(100) NULL,
    tokens_used INT NULL,
    success BIT NOT NULL DEFAULT 1,
    error_message NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_ailog_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_ailog_subject FOREIGN KEY (subject_id) REFERENCES dbo.subjects(id) ON DELETE NO ACTION,
    CONSTRAINT fk_ailog_resource FOREIGN KEY (resource_id) REFERENCES dbo.subject_resources(id) ON DELETE NO ACTION,
    CONSTRAINT fk_ailog_assessment FOREIGN KEY (assessment_id) REFERENCES dbo.assessments(id) ON DELETE NO ACTION
  );
END
GO


-- ============================================================================
-- 13. NEW TABLE: online_payments — Mock online billing/payment records
-- ============================================================================
IF OBJECT_ID('dbo.online_payments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.online_payments (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    billing_id INT NULL,
    amount DECIMAL(10,2) NOT NULL,
    payment_method NVARCHAR(50) NOT NULL DEFAULT 'online',
    provider NVARCHAR(100) NULL,
    provider_reference NVARCHAR(255) NULL,
    status NVARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','refunded')),
    notes NVARCHAR(MAX) NULL,
    paid_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    CONSTRAINT fk_op_student FOREIGN KEY (student_id) REFERENCES dbo.users(id) ON DELETE NO ACTION,
    CONSTRAINT fk_op_billing FOREIGN KEY (billing_id) REFERENCES dbo.billing(id) ON DELETE NO ACTION
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_online_payments_student' AND object_id = OBJECT_ID('dbo.online_payments'))
BEGIN
  CREATE INDEX IX_online_payments_student ON dbo.online_payments(student_id, status);
END
GO


-- ============================================================================
-- 14. payment_history — Add payment_method and provider_reference columns
-- ============================================================================
IF OBJECT_ID('dbo.payment_history','U') IS NOT NULL AND COL_LENGTH('dbo.payment_history','payment_method') IS NULL
BEGIN
  ALTER TABLE dbo.payment_history ADD payment_method NVARCHAR(50) NULL;
END
GO

IF OBJECT_ID('dbo.payment_history','U') IS NOT NULL AND COL_LENGTH('dbo.payment_history','provider_reference') IS NULL
BEGIN
  ALTER TABLE dbo.payment_history ADD provider_reference NVARCHAR(255) NULL;
END
GO


-- ============================================================================
-- 15. assessments — Add source columns for AI-generated assessments
-- ============================================================================

-- source_resource_id: Which module triggered this AI assessment
IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','source_resource_id') IS NULL
BEGIN
  ALTER TABLE dbo.assessments ADD source_resource_id INT NULL;
END
GO

-- assessment_origin: How the assessment was created (manual, ai_generated)
IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','assessment_origin') IS NULL
BEGIN
  ALTER TABLE dbo.assessments ADD assessment_origin NVARCHAR(30) NOT NULL CONSTRAINT df_assessments_origin DEFAULT 'manual';
END
GO

-- cycle_id: Link to student_learning_cycles
IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','cycle_id') IS NULL
BEGIN
  ALTER TABLE dbo.assessments ADD cycle_id INT NULL;
END
GO

-- time_limit_minutes: Time limit for anti-cheat auto-submit
IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','time_limit_minutes') IS NULL
BEGIN
  ALTER TABLE dbo.assessments ADD time_limit_minutes INT NULL;
END
GO

-- max_violations: Max anti-cheat violations before auto-submit
IF OBJECT_ID('dbo.assessments','U') IS NOT NULL AND COL_LENGTH('dbo.assessments','max_violations') IS NULL
BEGIN
  ALTER TABLE dbo.assessments ADD max_violations INT NOT NULL CONSTRAINT df_assessments_max_violations DEFAULT 3;
END
GO


-- ============================================================================
-- 16. user_subject_assignments — Add filtered unique index for deduplication
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_usa_unique_active' AND object_id = OBJECT_ID('dbo.user_subject_assignments'))
BEGIN
  -- Prevent duplicate active enrollments for the same student+subject
  BEGIN TRY
    CREATE UNIQUE INDEX IX_usa_unique_active
      ON dbo.user_subject_assignments(student_id, subject_id)
      WHERE is_archived = 0;
  END TRY
  BEGIN CATCH
    -- May fail if duplicates already exist; that's OK, we'll handle cleanup in code
    PRINT 'Warning: Could not create IX_usa_unique_active — possible existing duplicates.';
  END CATCH
END
GO


-- ============================================================================
-- 17. tutor_schedule_applications — Ensure table exists (from incremental)
-- ============================================================================
IF OBJECT_ID('dbo.tutor_schedule_applications', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tutor_schedule_applications (
    id INT IDENTITY(1,1) PRIMARY KEY,
    student_id INT NOT NULL,
    tutor_id INT NOT NULL,
    subject_id INT NOT NULL,
    branch_id INT NULL,
    time_slot NVARCHAR(50) NOT NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'pending',
    student_notified BIT NOT NULL DEFAULT 0,
    decided_by INT NULL,
    decided_at DATETIME2 NULL,
    created_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE()),
    updated_at DATETIME2 NOT NULL DEFAULT DATEADD(hour, 8, GETUTCDATE())
  );
END
GO

-- Ensure time_slot exists on user_subject_assignments
IF COL_LENGTH('dbo.user_subject_assignments', 'time_slot') IS NULL
BEGIN
  ALTER TABLE dbo.user_subject_assignments ADD time_slot NVARCHAR(50) NULL;
END
GO


-- ============================================================================
-- 18. assessment_results — Add attempt_id link
-- ============================================================================
IF OBJECT_ID('dbo.assessment_results','U') IS NOT NULL AND COL_LENGTH('dbo.assessment_results','attempt_id') IS NULL
BEGIN
  ALTER TABLE dbo.assessment_results ADD attempt_id INT NULL;
END
GO


-- ============================================================================
-- DONE — Phase 1 migration complete
-- ============================================================================
PRINT '=== MindQuest AI System — Phase 1 migration applied successfully ===';
GO
